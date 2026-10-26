import { execFileSync } from "node:child_process";

export type ProcessIdentityState = "alive" | "gone" | "unknown";

const selfStartToken = readProcessStartToken(process.pid);

export function currentProcessStartToken(): string | undefined {
  return selfStartToken;
}

function normalizeWindowsCreationDate(value: string): string | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  // CIM may emit DMTF datetime: yyyyMMddHHmmss.mmmmmm+UUU.
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d{3}([+-])(\d{3})$/.exec(raw);
  if (!match) return undefined;
  const localUtc = Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!, +match[7]!);
  const offset = +match[9]! * 60_000 * (match[8] === "+" ? 1 : -1);
  return new Date(localUtc - offset).toISOString();
}

/** One PowerShell/CIM process launch for an entire recovery or maintenance batch. */
export function readProcessStartTokens(pids: readonly number[]): Map<number, string> | undefined {
  const valid = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!valid.length) return new Map();
  if (process.platform !== "win32") {
    const result = new Map<number, string>();
    for (const pid of valid) {
      const token = readProcessStartToken(pid);
      if (token) result.set(pid, token);
    }
    return result;
  }
  try {
    const filter = valid.map((pid) => `ProcessId=${pid}`).join(" OR ");
    const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToUniversalTime().ToString('o'))\" }`;
    const output = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 2_000,
    });
    const result = new Map<number, string>();
    for (const line of output.split(/\r?\n/)) {
      const separator = line.indexOf("|");
      if (separator < 1) continue;
      const pid = Number(line.slice(0, separator));
      const token = normalizeWindowsCreationDate(line.slice(separator + 1));
      if (Number.isInteger(pid) && token) result.set(pid, token);
    }
    return result;
  } catch {
    return undefined;
  }
}

export function readProcessStartToken(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "win32") return readProcessStartTokens([pid])?.get(pid);
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function processIdentityState(
  pid: number | undefined,
  recordedStartToken?: string,
  recordedAt?: number,
  tokens?: Map<number, string> | undefined,
): ProcessIdentityState {
  if (!pid || pid <= 0) return "gone";
  if (process.platform === "win32") {
    const observed = tokens ?? readProcessStartTokens([pid]);
    if (!observed) return "unknown";
    const current = observed.get(pid);
    if (!current) return "gone";
    if (recordedStartToken) {
      const recorded = normalizeWindowsCreationDate(recordedStartToken) ?? recordedStartToken;
      return recorded === current ? "alive" : "gone";
    }
    if (recordedAt !== undefined && Date.parse(current) > recordedAt + 2_000) return "gone";
    return "alive";
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return "gone";
  }
  const current = tokens?.get(pid) ?? readProcessStartToken(pid);
  if (recordedStartToken && current) return recordedStartToken === current ? "alive" : "gone";
  if (!recordedStartToken && current && recordedAt !== undefined) {
    const currentStartedAt = Date.parse(current);
    if (Number.isFinite(currentStartedAt) && currentStartedAt > recordedAt + 2_000) return "gone";
  }
  return "alive";
}

/** Compatibility boolean: an inconclusive probe must not declare a live task dead. */
export function processIdentityAlive(pid: number | undefined, recordedStartToken?: string, recordedAt?: number): boolean {
  return processIdentityState(pid, recordedStartToken, recordedAt) !== "gone";
}