import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDir as ensureSharedDir, readJsonSafe, writeJsonAtomic } from "../_shared/json-io";

export const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const AGENT_SKILLS_DIR = path.join(os.homedir(), ".agents", "skills");
export const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");
export const SYNC_CONFIG_DIR = path.join(AGENT_DIR, "config");
export const SYNC_CONFIG_PATH = path.join(SYNC_CONFIG_DIR, "sync.json");
export const LEGACY_SYNC_CONFIG_PATH = path.join(AGENT_DIR, "sync_config.json");
export const AGENT_ROOT_MARKDOWN_FILES = ["SYSTEM.md", "AGENTS.md", "APPEND_SYSTEM.md"] as const;
export const MEMORY_MARKDOWN_FILES = ["USER.md", "MEMORY.md", "failures.md"] as const;

export type ManifestFile = { archive: string; source: string };

export interface SyncConfig {
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
  backupProviders: boolean;
  backupSkills: boolean;
  backupExtensions: boolean;
  backupSessions: boolean;
  sessionProjects: string[];
  liveSessionBackup: boolean;
  liveBackupDebounceMs: number;
  syncIntervalTurns: number;
  syncSessionOnExit: boolean;
  backupMemory: boolean;
  backupAgentSkills: boolean;
  sessionProjectMode: "whitelist" | "blacklist";
  maxBackups: number;
}

export function ensureDir(dir: string): void {
  ensureSharedDir(dir);
}

export function loadConfig(): SyncConfig {
  if (!fs.existsSync(SYNC_CONFIG_PATH) && fs.existsSync(LEGACY_SYNC_CONFIG_PATH)) {
    ensureDir(SYNC_CONFIG_DIR);
    try { fs.copyFileSync(LEGACY_SYNC_CONFIG_PATH, SYNC_CONFIG_PATH); } catch { /* best effort migration */ }
  }
  const data = readJsonSafe<Partial<SyncConfig>>(SYNC_CONFIG_PATH, {});
  const normalizeList = (value: unknown): string[] => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  return {
    webdavUrl: data.webdavUrl || "",
    webdavUser: data.webdavUser || "",
    webdavPass: data.webdavPass || "",
    backupProviders: data.backupProviders !== false,
    backupSkills: data.backupSkills !== false,
    backupExtensions: data.backupExtensions !== false,
    backupSessions: data.backupSessions === true,
    sessionProjects: normalizeList(data.sessionProjects),
    liveSessionBackup: data.liveSessionBackup === true,
    liveBackupDebounceMs: typeof data.liveBackupDebounceMs === "number" && data.liveBackupDebounceMs > 0 ? data.liveBackupDebounceMs : 3000,
    syncIntervalTurns: typeof data.syncIntervalTurns === "number" && data.syncIntervalTurns >= 0 ? Math.floor(data.syncIntervalTurns) : 0,
    syncSessionOnExit: data.syncSessionOnExit !== false,
    backupMemory: data.backupMemory !== false,
    backupAgentSkills: data.backupAgentSkills !== false,
    sessionProjectMode: data.sessionProjectMode === "blacklist" ? "blacklist" : "whitelist",
    maxBackups: typeof data.maxBackups === "number" && data.maxBackups >= 0 ? Math.floor(data.maxBackups) : 10,
  };
}

export function saveConfig(config: SyncConfig, ctx?: Pick<ExtensionContext, "ui">): void {
  ensureDir(path.dirname(SYNC_CONFIG_PATH));
  writeJsonAtomic(SYNC_CONFIG_PATH, config, { backup: true });
  if (ctx) refreshFooterStatusFromConfig(ctx, config);
}

/** Refresh footer status from an already-loaded config (avoids re-reading the file). */
export function refreshFooterStatusFromConfig(ctx: Pick<ExtensionContext, "ui">, config: SyncConfig): void {
  const parts: string[] = [];
  if (config.liveSessionBackup) parts.push("⚡");
  if (config.syncIntervalTurns > 0) parts.push(`🔄${config.syncIntervalTurns}`);
  if (config.syncSessionOnExit) parts.push("📤");
  ctx.ui.setStatus("pi-sync", parts.length ? `sync:${parts.join("")}` : undefined);
}

export function isProjectAllowed(projectDir: string | undefined, config: SyncConfig): boolean {
  if (!projectDir) return false;
  if (config.sessionProjects.length === 0) return true;
  const listed = config.sessionProjects.includes(projectDir);
  return config.sessionProjectMode === "blacklist" ? !listed : listed;
}

export function resolvePassword(pass: string): string {
  return pass.startsWith("$") ? process.env[pass.slice(1)] ?? pass : pass;
}
