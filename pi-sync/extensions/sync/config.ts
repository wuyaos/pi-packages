import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDir as ensureSharedDir, readJsonSafe, writeJsonAtomic } from "../_shared/json-io";
import { normalizeLanguage, type SyncLanguage } from "./i18n";

export const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const AGENT_SKILLS_DIR = path.join(os.homedir(), ".agents", "skills");
export const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");
export const SYNC_CONFIG_DIR = path.join(AGENT_DIR, "config");
export const SYNC_CONFIG_PATH = path.join(SYNC_CONFIG_DIR, "sync.json");
export const LEGACY_SYNC_CONFIG_PATH = path.join(AGENT_DIR, "sync_config.json");
export const DEFAULT_PI_EXCLUDE_PATHS = ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"] as const;
const LEGACY_DEFAULT_PI_EXCLUDE_PATH_SETS = [
  ["npm", "git", "sessions", "state", "vstack"],
  ["npm", "git", "sessions", "state", "tmp", "vstack"],
] as const;

export type ManifestFile = { archive: string; source: string };

export interface SyncConfig {
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
  language: SyncLanguage;
  backupProviders: boolean;
  backupSessions: boolean;
  backupAgentSkills: boolean;
  piExcludePaths: string[];
  backupOnExit: boolean;
  sessionProjects: string[];
  sessionProjectMode: "whitelist" | "blacklist";
  maxBackups: number;
}

export function ensureDir(dir: string): void {
  ensureSharedDir(dir);
}

export function normalizePiExcludePaths(value: unknown): string[] {
  const source = Array.isArray(value) ? value : DEFAULT_PI_EXCLUDE_PATHS;
  const normalized = new Set<string>();
  for (const raw of source) {
    const candidate = String(raw).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!candidate || candidate.startsWith("/") || /^[a-zA-Z]:\//.test(candidate)) continue;
    if (candidate.split("/").includes("..")) continue;
    normalized.add(candidate);
  }
  return [...normalized];
}

function isLegacyDefaultPiExcludePaths(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const normalized = normalizePiExcludePaths(value);
  return LEGACY_DEFAULT_PI_EXCLUDE_PATH_SETS.some((legacy) => (
    normalized.length === legacy.length && legacy.every((entry) => normalized.includes(entry))
  ));
}

function defaultLanguage(): SyncLanguage {
  const settings = readJsonSafe<{ piSwitch?: { language?: unknown } }>(path.join(AGENT_DIR, "settings.json"), {});
  return normalizeLanguage(settings.piSwitch?.language);
}

/** In-memory config cache, invalidated on saveConfig. Avoids per-hook disk reads. */
let configCache: SyncConfig | null = null;

export function loadConfig(): SyncConfig {
  if (configCache) return configCache;
  if (!fs.existsSync(SYNC_CONFIG_PATH) && fs.existsSync(LEGACY_SYNC_CONFIG_PATH)) {
    ensureDir(SYNC_CONFIG_DIR);
    try {
      fs.copyFileSync(LEGACY_SYNC_CONFIG_PATH, SYNC_CONFIG_PATH);
    } catch (error) {
      console.warn(`[pi-sync] Failed to migrate legacy sync config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const data = readJsonSafe<Partial<SyncConfig>>(SYNC_CONFIG_PATH, {});
  const normalizeList = (value: unknown): string[] => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  const result: SyncConfig = {
    webdavUrl: data.webdavUrl || "",
    webdavUser: data.webdavUser || "",
    webdavPass: data.webdavPass || "",
    language: data.language ? normalizeLanguage(data.language) : defaultLanguage(),
    backupProviders: data.backupProviders !== false,
    backupSessions: data.backupSessions !== false,
    backupAgentSkills: data.backupAgentSkills === true,
    piExcludePaths: isLegacyDefaultPiExcludePaths(data.piExcludePaths)
      ? [...DEFAULT_PI_EXCLUDE_PATHS]
      : normalizePiExcludePaths(data.piExcludePaths),
    backupOnExit: data.backupOnExit !== false,
    sessionProjects: normalizeList(data.sessionProjects),
    sessionProjectMode: data.sessionProjectMode === "whitelist" ? "whitelist" : "blacklist",
    maxBackups: typeof data.maxBackups === "number" && data.maxBackups >= 0 ? Math.floor(data.maxBackups) : 10,
  };
  configCache = result;
  return result;
}

export function saveConfig(config: SyncConfig, ctx?: Pick<ExtensionContext, "ui">): void {
  ensureDir(path.dirname(SYNC_CONFIG_PATH));
  writeJsonAtomic(SYNC_CONFIG_PATH, config, { backup: true });
  configCache = config;
  if (ctx) refreshFooterStatusFromConfig(ctx, config);
}

/** Refresh footer status from an already-loaded config (avoids re-reading the file). */
export function refreshFooterStatusFromConfig(ctx: Pick<ExtensionContext, "ui">, config: SyncConfig): void {
  ctx.ui.setStatus("pi-sync", config.backupOnExit ? "backup:exit" : undefined);
}

export function isProjectAllowed(projectDir: string | undefined, config: SyncConfig): boolean {
  if (!projectDir) return false;
  const listed = config.sessionProjects.includes(projectDir);
  // whitelist: only listed projects are backed up (empty = none)
  // blacklist: listed projects are skipped (empty = all)
  return config.sessionProjectMode === "blacklist" ? !listed : listed;
}

export function resolvePassword(pass: string): string {
  return pass.startsWith("$") ? process.env[pass.slice(1)] ?? pass : pass;
}
