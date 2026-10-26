import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { baseDir, readMeta, writeMeta } from "./registry.js";
import type { ActiveSessionProvider } from "./runtime.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta, WakeOptions, WakePending, WakeSummary } from "./types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_WAKE_WINDOW_BYTES = 64 * 1024;
const DEFAULT_COOLDOWN_SECONDS = 60;
const DEFAULT_MAX_WAKES_PER_TASK = 10;
const DEFAULT_SESSION_WAKES_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as { lockSync(path: string, options: { realpath: boolean; retries?: { retries: number; minTimeout: number; maxTimeout: number } }): () => void };

export type WakeMatch = { pattern: number; patternText: string; line: string; offset: number; generation: number; key: string };

export interface WakeScanResult {
  cursor: { generation: number; offset: number };
  matches: WakeMatch[];
}

export function validateWakePatterns(patterns: unknown): string[] | undefined {
  if (patterns === undefined || patterns === null) return undefined;
  if (!Array.isArray(patterns) || patterns.length > 16) throw new Error("wake_patterns must be an array of at most 16 regular expressions");
  const result = patterns.map((value, index) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new Error(`wake_patterns[${index}] must be a non-empty string of at most 512 bytes`);
    try { new RegExp(value); } catch (error) { throw new Error(`wake_patterns[${index}] is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
    return value;
  });
  return result;
}

export function scanWakeWindow(
  bytes: Uint8Array,
  cursor: { generation: number; offset: number },
  generation: number,
  patterns: readonly string[],
  baseOffset = 0,
): WakeScanResult {
  const start = generation === cursor.generation ? Math.max(cursor.offset, baseOffset) : baseOffset;
  const localStart = Math.max(0, start - baseOffset);
  const end = Math.min(bytes.length, localStart + MAX_WAKE_WINDOW_BYTES);
  const window = bytes.subarray(localStart, end);
  const newline = window.lastIndexOf(10);
  const consumed = newline < 0 ? window.length : newline + 1;
  const text = new TextDecoder().decode(window.subarray(0, consumed));
  const matches: WakeMatch[] = [];
  const seen = new Set<string>();
  let lineOffset = start;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineBytes = new TextEncoder().encode(`${rawLine}\n`).byteLength;
    for (let index = 0; index < patterns.length; index += 1) {
      const patternText = patterns[index]!;
      if (!new RegExp(patternText).test(line)) continue;
      const digest = createHash("sha256").update(line).digest("hex").slice(0, 24);
      const key = `${index}\0${digest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ pattern: index, patternText, line, offset: lineOffset, generation, key });
    }
    lineOffset += lineBytes;
  }
  return { cursor: { generation, offset: start + consumed }, matches };
}

function settingsValue(key: "wakePerHour" | "wakeCooldownSeconds"): unknown {
  try {
    const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as { piBgFusion?: Record<string, unknown> };
    return settings.piBgFusion?.[key];
  } catch { return undefined; }
}

function numberSetting(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function wakeOptions(meta: BackgroundTaskMeta): WakeOptions & { cooldown_seconds: number; max_wakes: number } {
  const options = meta.wakeOptions ?? {};
  return {
    cooldown_seconds: numberSetting(options.cooldown_seconds, numberSetting(process.env.PI_BG_FUSION_WAKE_COOLDOWN_SECONDS ?? settingsValue("wakeCooldownSeconds"), DEFAULT_COOLDOWN_SECONDS, 0), 0),
    max_wakes: numberSetting(options.max_wakes, DEFAULT_MAX_WAKES_PER_TASK, 1),
  };
}

function sessionCap(): number {
  return numberSetting(process.env.PI_BG_FUSION_WAKE_PER_HOUR ?? settingsValue("wakePerHour"), DEFAULT_SESSION_WAKES_PER_HOUR, 0);
}

export function budgetPath(): string { return join(baseDir(), "wake-budget.json");}

export function wakeScanCommitDecision(locked: boolean): "commit" | "pending" {
  return locked ? "commit" : "pending";
}

export interface BudgetResult<T> { allowed: T; locked: boolean }

export function withBudget<T>(sessionKey: string, requested: number, fn: (allowed: number) => T): BudgetResult<T> {
  const path = budgetPath();
  mkdirSync(baseDir(), { recursive: true });
  try { writeFileSync(path, "{\"version\":1,\"events\":{}}\n", { flag: "wx", mode: 0o600 }); } catch { /* existing */ }
  let release: (() => void) | undefined;
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        release = lockfile.lockSync(path, { realpath: false });
        break;
      } catch (error) {
        if (attempt === 5) return { allowed: fn(0), locked: false };
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ELOCKED") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, 25 * (attempt + 1)));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
    return { allowed: fn(0), locked: false };
  }
  try {
    let state: { version: 1; events: Record<string, number[]> };
    try { state = JSON.parse(readFileSync(path, "utf8")) as typeof state; } catch { state = { version: 1, events: {} }; }
    const now = Date.now();
    const prior = (state.events[sessionKey] ?? []).filter((at) => now - at < HOUR_MS);
    const allowed = Math.max(0, Math.min(requested, sessionCap() - prior.length));
    state.events[sessionKey] = [...prior, ...Array.from({ length: allowed }, () => now)];
    const temp = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeSync(fd, `${JSON.stringify(state)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { rmSync(temp, { force: true }); } catch { /* already renamed */ }
    }
    return { allowed: fn(allowed), locked: true };
  } finally { release?.(); }
}

function sessionKey(meta: BackgroundTaskMeta): string {
  const origin: BackgroundTaskCallbackOrigin = meta.callbackOrigin ?? { cwd: meta.cwd };
  return `${origin.cwd}\0${origin.sessionId ?? "process"}`;
}

function pendingKey(meta: BackgroundTaskMeta, match: WakeMatch): string {
  return `${meta.id}\0${match.pattern}\0${match.generation}\0${match.offset}`;
}

function readBytes(path: string, offset: number, maxBytes: number): Uint8Array {
  const file = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = Math.min(Math.max(0, offset), size);
    const length = Math.min(maxBytes, Math.max(0, size - start));
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = readSync(file, bytes, read, length - read, start + read);
      if (count <= 0) break;
      read += count;
    }
    return bytes.subarray(0, read);
  } finally {
    closeSync(file);
  }
}

function formatWakeContent(meta: BackgroundTaskMeta, match: WakeMatch): string {
  return `Background task ${meta.id} matched wake pattern ${JSON.stringify(match.patternText)} at log offset ${match.offset}: ${match.line}`;
}

export type WakeDisposition = "delivered" | "deferred";

export function wakeDeliveryDisposition(active: boolean, delivered: boolean): WakeDisposition {
  return active && delivered ? "delivered" : "deferred";
}

export function pendingWakeFromMatch(meta: BackgroundTaskMeta, match: WakeMatch): WakePending {
  return { key: pendingKey(meta, match), pattern: match.pattern, patternText: match.patternText, line: match.line, offset: match.offset, generation: match.generation };
}

export async function retryPendingWakes(pi: ExtensionAPI, meta: BackgroundTaskMeta, getActiveSession?: ActiveSessionProvider): Promise<void> {
  const latest = readMeta(meta.id) ?? meta;
  const pending = (latest.wakePending ?? []).filter((item): item is WakePending => typeof item !== "string");
  if (!pending.length || !isActiveOrigin(latest, getActiveSession)) return;
  for (const item of pending) {
    const match: WakeMatch = { pattern: item.pattern, patternText: item.patternText, line: item.line, offset: item.offset, generation: item.generation, key: item.key };
    if (await deliverWake(pi, latest, match, getActiveSession) !== "delivered") continue;
    const current = readMeta(meta.id);
    if (current) {
      current.wakePending = removePendingWake(current.wakePending ?? [], item.key);
      writeMeta(current);
    }
  }
}

export function pendingForBudgetFailure(meta: BackgroundTaskMeta, existing: WakePending[], matches: readonly WakeMatch[]): WakePending[] {
  return [...existing, ...matches.map((match) => pendingWakeFromMatch(meta, match))];
}

export function removePendingWake(pending: Array<WakePending | string>, key: string): Array<WakePending | string> {
  return pending.filter((item) => typeof item === "string" ? item !== key : item.key !== key);
}

function isActiveOrigin(meta: BackgroundTaskMeta, getActiveSession?: ActiveSessionProvider): boolean {
  const active = getActiveSession?.();
  const origin = meta.callbackOrigin;
  return !!active && !!origin && active.cwd === origin.cwd && (!origin.sessionId || active.sessionId === origin.sessionId);
}

async function deliverWake(pi: ExtensionAPI, meta: BackgroundTaskMeta, match: WakeMatch, getActiveSession?: ActiveSessionProvider): Promise<WakeDisposition> {
  if (!isActiveOrigin(meta, getActiveSession)) return "deferred";
  const eventId = pendingKey(meta, match);
  const batcher = getCallbackBatcher(pi);
  const result = batcher.deliverUrgent({
    source: "background-task",
    id: eventId,
    inspectId: meta.id,
    label: meta.name ? `${meta.name} (${meta.id})` : meta.id,
    status: "wake",
    customType: "background-task-wake",
    content: formatWakeContent(meta, match),
    detailTool: "bg_task_status",
    getSuppressionReason: () => {
      const active = getActiveSession?.();
      const origin = meta.callbackOrigin;
      if (!active) return "active session identity is unavailable";
      if (origin && (origin.cwd !== active.cwd || (origin.sessionId && origin.sessionId !== active.sessionId))) return "callback origin is not active";
      return undefined;
    },
  });
  return wakeDeliveryDisposition(isActiveOrigin(meta, getActiveSession), await Promise.resolve(result));
}

export async function scanTaskWake(pi: ExtensionAPI, id: string, getActiveSession?: ActiveSessionProvider): Promise<void> {
  const meta = readMeta(id);
  if (!meta || meta.status !== "running" || meta.callback === false || !meta.wakePatterns?.length || !isActiveOrigin(meta, getActiveSession)) return;
  const generation = meta.logGeneration ?? 0;
  let size: number;
  try { size = statSync(meta.logPath).size; } catch { return; }
  const cursor = meta.wakeCursor ?? { generation, offset: 0 };
  const readOffset = cursor.generation === generation ? cursor.offset : 0;
  const result = scanWakeWindow(readBytes(meta.logPath, readOffset, MAX_WAKE_WINDOW_BYTES), cursor, generation, meta.wakePatterns, readOffset);
  const actualResult = result.cursor.offset === cursor.offset && result.cursor.generation === cursor.generation
    ? result
    : { ...result, cursor: { generation, offset: Math.min(size, result.cursor.offset) } };
  const options = wakeOptions(meta);
  const summary: WakeSummary = meta.wakeSummary ?? { wakes: 0, seen: [], lastWakeAt: undefined };
  const seen = new Set(summary.seen ?? []);
  const pendingItems = (meta.wakePending ?? []).filter((item): item is WakePending => typeof item !== "string");
  const pending = new Set(pendingItems.map((item) => item.key));
  const now = Date.now();
  const pendingMatches: WakeMatch[] = pendingItems.map((item) => ({ pattern: item.pattern, patternText: item.patternText, line: item.line, offset: item.offset, generation: item.generation, key: item.key }));
  const newCandidates = actualResult.matches.filter((match) => {
    if (pending.has(pendingKey(meta, match))) return false;
    if (seen.has(`${match.pattern}\0${createHash("sha256").update(match.line).digest("hex").slice(0, 24)}`)) return false;
    seen.add(match.key);
    return true;
  });
  const cooldown = summary.lastWakeAt !== undefined && now - summary.lastWakeAt < options.cooldown_seconds * 1000;
  const remaining = Math.max(0, options.max_wakes - summary.wakes);
  const eligible = cooldown ? [] : newCandidates.slice(0, remaining);
  const budget = withBudget(sessionKey(meta), eligible.length, (count) => eligible.slice(0, count));
  const allowed = budget.allowed;
  const toDeliver = [...pendingMatches, ...allowed];
  if (!budget.locked) {
    const lockedPending = pendingForBudgetFailure(meta, pendingItems, eligible);
    meta.wakePending = lockedPending;
    writeMeta(meta);
    return;
  }
  summary.seen = [...seen].slice(-128);
  summary.wakes += allowed.length;
  if (allowed.length) summary.lastWakeAt = now;
  meta.wakeCursor = actualResult.cursor;
  meta.wakeSummary = summary;
  meta.wakePending = [...pendingItems, ...allowed.map((match) => pendingWakeFromMatch(meta, match))];
  writeMeta(meta);
  for (const match of toDeliver) {
    const disposition = await deliverWake(pi, meta, match, getActiveSession);
    if (disposition !== "delivered") continue;
    const latest = readMeta(id);
    if (!latest) continue;
    latest.wakePending = removePendingWake(latest.wakePending ?? [], pendingKey(meta, match));
    writeMeta(latest);
  }
}

export function appendWakeProbe(logPath: string, line: string): void {
  appendFileSync(logPath, line);
}
