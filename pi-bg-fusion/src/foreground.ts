import { createBashToolDefinition, type BashToolDetails, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatLaunch } from "./output.js";
import { readMeta, writeMeta } from "./registry.js";
import { notifyTerminal, spawnTask, stopTask } from "./runtime.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta } from "./types.js";

const QUICK_COMPLETION_MS = 2_000;
const DEFAULT_AUTO_BACKGROUND_SECONDS = 120;
const HINT_KEY = "pi-bg-fusion-hint";
const foreground = new Map<string, ForegroundSlot>();
const foregroundOrder: string[] = [];
const hintOwners = new Set<string>();

export function latestForegroundCall(): string | undefined {
  for (let index = foregroundOrder.length - 1; index >= 0; index -= 1) {
    const toolCallId = foregroundOrder[index];
    if (toolCallId && foreground.has(toolCallId)) return toolCallId;
  }
  return undefined;
}

export interface ForegroundSlot {
  background: () => void;
}

export function registerForegroundCall(toolCallId: string, slot: ForegroundSlot): void {
  foreground.set(toolCallId, slot);
  foregroundOrder.push(toolCallId);
}

export function unregisterForegroundCall(toolCallId: string): void {
  foreground.delete(toolCallId);
  const index = foregroundOrder.indexOf(toolCallId);
  if (index >= 0) foregroundOrder.splice(index, 1);
}

function configuredTimeoutSeconds(): number {
  const env = process.env.PI_BG_FUSION_AUTO_BACKGROUND_SECONDS;
  if (env !== undefined) {
    const value = Number(env);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  try {
    const settings = JSON.parse(readFileSync(`${getAgentDir()}/settings.json`, "utf8")) as { piBgFusion?: { autoBackgroundSeconds?: unknown } };
    const value = Number(settings.piBgFusion?.autoBackgroundSeconds);
    if (Number.isFinite(value) && value >= 0) return value;
  } catch { /* default */ }
  return DEFAULT_AUTO_BACKGROUND_SECONDS;
}

function origin(ctx: ExtensionContext): BackgroundTaskCallbackOrigin {
  return { cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId() };
}

function resultText(text: string, exitCode: number, startedAt: number) {
  return {
    content: [{ type: "text" as const, text: text || "(no output)" }],
    details: undefined,
    structuredContent: {
      output: text,
      truncated: false,
      exit_code: exitCode,
      wall_time_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    },
    ...(exitCode === 0 ? {} : { isError: true }),
  };
}

function tail(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length <= 50 * 1024 ? text : text.slice(-50 * 1024);
  } catch {
    return "";
  }
}

/** Override Pi's foreground bash with the durable task backend and hand it off in place. */
export function registerForegroundBash(pi: ExtensionAPI): void {
  const native = createBashToolDefinition(process.cwd());
  pi.registerShortcut("ctrl+b", {
    description: "Run the current foreground bash command in background",
    handler: async (ctx) => {
      const activeId = latestForegroundCall();
      const slot = activeId ? foreground.get(activeId) : undefined;
      if (!slot) {
        ctx.ui.notify("No running bash command to background.", "warning");
        return;
      }
      slot.background();
      ctx.ui.notify("▶ Backgrounded — continuing.", "info");
    },
  });

  pi.registerTool({
    ...native,
    name: "bash",
    description: "Run a bash command. Commands still running after the configured threshold (120s by default), or when Ctrl+B is pressed, continue as durable pi-bg-fusion tasks.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: native.parameters.properties.timeout,
      handoff_after_seconds: Type.Optional(Type.Number({ description: "Foreground-to-background handoff threshold in seconds; 0 disables. Defaults to pi-bg-fusion configuration (120)." })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const startedAt = Date.now();
      const activeOrigin = origin(ctx);
      // Foreground completion is already returned by this tool. Enable the durable
      // callback only at handoff, so quick commands do not generate a duplicate wakeup.
      const meta = spawnTask(pi, { command: params.command, callback: false, timeout_seconds: params.timeout }, ctx.cwd, activeOrigin, () => activeOrigin);
      // `spawnTask` schedules all of its work on unref'd handles because ordinary
      // Pi TUI sessions have other referenced handles. A print-mode foreground
      // call must itself keep the event loop alive until completion or handoff.
      const keepAlive = setInterval(() => {}, 60_000);
      let backgroundReason: "manual" | "timeout" | undefined;
      let resolveBackground!: (reason: "manual" | "timeout") => void;
      const backgroundPromise = new Promise<"manual" | "timeout">((resolve) => { resolveBackground = resolve; });
      const background = (reason: "manual" | "timeout") => {
        if (backgroundReason) return;
        backgroundReason = reason;
        const latest = readMeta(meta.id);
        if (latest) {
          latest.backgrounded = true;
          latest.callback = true;
          writeMeta(latest);
          if (latest.status !== "running") void notifyTerminal(pi, latest, () => activeOrigin);
        }
        resolveBackground(reason);
      };
      registerForegroundCall(toolCallId, { background: () => background("manual") });

      const interval = setInterval(() => {
        const latest = readMeta(meta.id);
        if (!latest || latest.status !== "running") return;
        const output = tail(latest.logPath);
        onUpdate?.({ content: [{ type: "text", text: output }], details: undefined });
      }, 250);
      interval.unref();

      let hintTimer: ReturnType<typeof setTimeout> | undefined;
      if (ctx.mode === "tui") {
        hintTimer = setTimeout(() => {
          hintOwners.add(toolCallId);
          ctx.ui.setWidget(HINT_KEY, ["(ctrl+b to run in background)"], { placement: "belowEditor" });
        }, QUICK_COMPLETION_MS);
        hintTimer.unref();
      }
      const threshold = params.handoff_after_seconds === undefined ? configuredTimeoutSeconds() : params.handoff_after_seconds;
      const timeoutTimer = threshold > 0 ? setTimeout(() => background("timeout"), threshold * 1000) : undefined;
      timeoutTimer?.unref();
      const abort = () => { if (!backgroundReason) void stopTask(pi, meta.id, () => activeOrigin); };
      signal?.addEventListener("abort", abort, { once: true });

      try {
        const completed = new Promise<BackgroundTaskMeta>((resolve) => {
          const poll = setInterval(() => {
            const latest = readMeta(meta.id);
            if (latest && latest.status !== "running") { clearInterval(poll); resolve(latest); }
          }, 50);
          poll.unref();
        });
        const outcome = await Promise.race([
          completed.then((task) => ({ kind: "completed" as const, task })),
          backgroundPromise.then((reason) => ({ kind: "backgrounded" as const, reason })),
        ]);
        if (outcome.kind === "backgrounded") {
          const latest = readMeta(meta.id) ?? meta;
          latest.backgrounded = true;
          latest.callback = true;
          writeMeta(latest);
          const suffix = outcome.reason === "timeout" ? ` after ${threshold}s` : " by Ctrl+B";
          return resultText(`${formatLaunch(latest)}\nForeground command was backgrounded${suffix}; use bg_status/bg_task_log to inspect it.`, 0, startedAt);
        }
        const output = tail(outcome.task.logPath);
        const exit = outcome.task.lastExitCode ?? (outcome.task.status === "succeeded" ? 0 : 1);
        return resultText(outcome.task.status === "timed_out" ? `${output}
Command timed out after ${params.timeout} seconds.` : output, exit, startedAt);
      } finally {
        clearInterval(keepAlive);
        clearInterval(interval);
        if (hintTimer) clearTimeout(hintTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        hintOwners.delete(toolCallId);
        if (hintOwners.size === 0) ctx.ui.setWidget(HINT_KEY, undefined);
        signal?.removeEventListener("abort", abort);
        unregisterForegroundCall(toolCallId);
      }
    },
  });
}