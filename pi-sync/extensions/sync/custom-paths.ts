import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Metadata stored in a custom-path archive's root manifest. */
export interface CustomPathArchiveEntry {
  archiveRoot: string;
  relativePath: string;
  type: "file" | "directory";
}

const AGENT_ROOT = path.resolve(os.homedir(), ".pi", "agent");

function isWithinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Normalize a user path to one relative to ~/.pi/agent. The archive never
 * records absolute host paths and cannot be used to restore outside Pi data.
 */
export function normalizeCustomPath(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Custom sync path is empty");
  const homeDir = os.homedir();
  const expanded = raw === "~" ? homeDir : raw.startsWith("~/") || raw.startsWith(`~${path.sep}`)
    ? path.join(homeDir, raw.slice(2))
    : path.isAbsolute(raw) ? raw : path.join(AGENT_ROOT, raw);
  const absolute = path.resolve(expanded);
  if (!isWithinOrEqual(AGENT_ROOT, absolute)) {
    throw new Error(`Custom sync paths must stay within ~/.pi/agent: ${input}`);
  }
  const relative = path.relative(AGENT_ROOT, absolute);
  if (!relative) throw new Error("Use a child path of ~/.pi/agent, not the entire agent directory");
  return relative;
}

/** Parse a comma/newline-separated UI value into stable, de-duplicated paths. */
/** Reject duplicate or nested selections: restoring both would make result order-dependent. */
export function validateCustomPathSet(paths: readonly string[]): void {
  for (let index = 0; index < paths.length; index += 1) {
    const current = normalizeCustomPath(paths[index]!);
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const other = normalizeCustomPath(paths[otherIndex]!);
      if (isWithinOrEqual(path.join(AGENT_ROOT, other), path.join(AGENT_ROOT, current)) ||
          isWithinOrEqual(path.join(AGENT_ROOT, current), path.join(AGENT_ROOT, other))) {
        throw new Error(`Custom sync paths cannot overlap: ${customPathDisplay(other)} and ${customPathDisplay(current)}`);
      }
    }
  }
}

export function parseCustomPathList(input: string): string[] {
  const seen = new Set<string>();
  for (const raw of input.split(/[\n,]/)) {
    const value = raw.trim();
    if (!value) continue;
    seen.add(normalizeCustomPath(value));
  }
  const paths = [...seen].sort((a, b) => a.localeCompare(b));
  validateCustomPathSet(paths);
  return paths;
}

/** Lenient form used when loading persisted configuration. */
export function normalizeCustomPathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    try { valid.add(normalizeCustomPath(entry)); } catch { /* ignore stale/unsafe config entries */ }
  }
  const paths = [...valid].sort((a, b) => a.localeCompare(b));
  const nonOverlapping: string[] = [];
  for (const candidate of paths) {
    try {
      validateCustomPathSet([...nonOverlapping, candidate]);
      nonOverlapping.push(candidate);
    } catch { /* retain the first, least-nested safe persisted path */ }
  }
  return nonOverlapping;
}

export function customPathDisplay(relativePath: string): string {
  return `~/.pi/agent/${relativePath}`;
}

function realPathIsWithinAgentRoot(absolute: string): void {
  const realAgentRoot = fs.realpathSync(AGENT_ROOT);
  const realTarget = fs.realpathSync(absolute);
  if (!isWithinOrEqual(realAgentRoot, realTarget)) {
    throw new Error(`Custom sync path resolves outside ~/.pi/agent: ${customPathDisplay(path.relative(AGENT_ROOT, absolute))}`);
  }
}

/** Resolve and validate a configured source path before archiving it. */
export function resolveCustomSource(relativePath: string): { absolute: string; type: "file" | "directory" } {
  const normalized = normalizeCustomPath(relativePath);
  const absolute = path.join(AGENT_ROOT, normalized);
  if (!fs.existsSync(absolute)) throw new Error(`Custom sync path no longer exists: ${customPathDisplay(normalized)}`);
  realPathIsWithinAgentRoot(absolute);
  const stats = fs.lstatSync(absolute);
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw new Error(`Custom sync path must be a regular file or directory: ${customPathDisplay(normalized)}`);
  }
  return { absolute, type: stats.isDirectory() ? "directory" : "file" };
}

function assertNoExistingParentEscapesAgentRoot(dest: string): void {
  const realAgentRoot = fs.realpathSync(AGENT_ROOT);
  let parent = path.dirname(dest);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error(`Cannot resolve parent for custom restore path: ${dest}`);
    parent = next;
  }
  const realParent = fs.realpathSync(parent);
  if (realParent !== realAgentRoot && !realParent.startsWith(`${realAgentRoot}${path.sep}`)) {
    throw new Error(`Custom restore path resolves outside ~/.pi/agent: ${dest}`);
  }
}

/** Validate untrusted archive metadata and produce a safe Pi-agent-relative target. */
export function resolveCustomRestoreTarget(entry: unknown): { archiveRoot: string; relativePath: string; type: "file" | "directory"; destination: string } {
  if (!entry || typeof entry !== "object") throw new Error("Invalid custom path manifest entry");
  const value = entry as Partial<CustomPathArchiveEntry>;
  if (typeof value.relativePath !== "string" || (value.type !== "file" && value.type !== "directory")) {
    throw new Error("Invalid custom path manifest entry");
  }
  const relativePath = normalizeCustomPath(value.relativePath);
  if (typeof value.archiveRoot !== "string" || !/^custom\/\d+\/data$/.test(value.archiveRoot)) {
    throw new Error("Invalid custom archive root");
  }
  const destination = path.join(AGENT_ROOT, relativePath);
  assertNoExistingParentEscapesAgentRoot(destination);
  return { archiveRoot: value.archiveRoot, relativePath, type: value.type, destination };
}
