import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDir as ensureSharedDir, readJsonSafe, writeJsonAtomic } from "../_shared/json-io";
import { normalizeLanguage, type SyncLanguage } from "./i18n";
import { platformCode, sanitizeDeviceName } from "./archive-name";

export const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const AGENT_SKILLS_DIR = path.join(os.homedir(), ".agents", "skills");
export const CORTEXKIT_CONFIG_DIR = path.join(os.homedir(), ".config", "cortexkit");
export const SYNC_CONFIG_DIR = path.join(AGENT_DIR, "config");
export const SYNC_CONFIG_PATH = path.join(SYNC_CONFIG_DIR, "sync.json");
export const LEGACY_SYNC_CONFIG_PATH = path.join(AGENT_DIR, "sync_config.json");
export const DEFAULT_PI_EXCLUDE_PATHS = ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"] as const;
const LEGACY_DEFAULT_PI_EXCLUDE_PATH_SETS = [
  ["npm", "git", "sessions", "state", "vstack"],
  ["npm", "git", "sessions", "state", "tmp", "vstack"],
] as const;

/** 远端归档根目录，每类备份位于 `<remoteBaseDir><kind>/`。 */
export const DEFAULT_REMOTE_BASE_DIR = "pibak/";

export type BackupKind = "pi" | "skills" | "cortexkit";

const BACKUP_KINDS: readonly BackupKind[] = ["pi", "skills", "cortexkit"];

export type ManifestFile = { archive: string; source: string };

export interface SyncConfig {
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
  language: SyncLanguage;
  backupProviders: boolean;
  backupAgentSkills: boolean;
  backupCortexkit: boolean;
  piExcludePaths: string[];
  backupOnExit: boolean;
  maxBackups: number;
  /** 本机设备标识（归档名与远端 prune 归属判断），缺省时按 hostname+平台生成。 */
  deviceName: string;
  /** 远端归档根目录，末尾带 /，每段限 [A-Za-z0-9._-]。 */
  remoteBaseDir: string;
  /** 退出自动备份的类别范围。 */
  exitBackupScope: BackupKind[];
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

/**
 * 远端根目录校验与归一：逐段限 [A-Za-z0-9._-]，拒绝 ".."、绝对路径与盘符；
 * 任何非法输入回退默认 "pibak/"。返回值保证以 / 结尾。
 */
export function normalizeRemoteBaseDir(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_REMOTE_BASE_DIR;
  const candidate = value.trim().replace(/\\/g, "/");
  if (!candidate || candidate.startsWith("/") || /^[a-zA-Z]:/.test(candidate)) return DEFAULT_REMOTE_BASE_DIR;
  const segments = candidate.replace(/^\/+/, "").split("/").filter(Boolean);
  if (!segments.length) return DEFAULT_REMOTE_BASE_DIR;
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      return DEFAULT_REMOTE_BASE_DIR;
    }
  }
  return `${segments.join("/")}/`;
}

/**
 * 校验用户输入的归档目录前缀；合法返回归一化值（以 / 结尾），非法返回 null。
 * 与 normalizeRemoteBaseDir 不同：不回退默认值，由调用方提示后让用户重输。
 */
export function validateRemoteBaseDirInput(value: string): string | null {
  const candidate = value.trim().replace(/\\/g, "/");
  if (!candidate || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) return null;
  const segments = candidate.replace(/^\/+/, "").split("/").filter(Boolean);
  if (!segments.length) return null;
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) return null;
  }
  return `${segments.join("/")}/`;
}

/** 退出备份范围归一：仅接受合法类别，去重；缺省/非法输入回退全部类别。 */
export function normalizeExitBackupScope(value: unknown): BackupKind[] {
  const source = Array.isArray(value) ? value : [...BACKUP_KINDS];
  const normalized = new Set<BackupKind>();
  for (const raw of source) {
    if (BACKUP_KINDS.includes(raw as BackupKind)) normalized.add(raw as BackupKind);
  }
  return [...normalized];
}

/** 缺省设备名：hostname 清洗后加平台简码后缀，如 "DESKTOP-JK3-win"。 */
export function defaultDeviceName(): string {
  return `${sanitizeDeviceName(os.hostname())}-${platformCode()}`;
}

/** 远端类别目录：`<remoteBaseDir><kind>/`，替代原 WEBDAV_*_DIR 常量的硬编码用法。 */
export function webdavDir(kind: BackupKind, config: Pick<SyncConfig, "remoteBaseDir">): string {
  return `${config.remoteBaseDir}${kind}/`;
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
  const result: SyncConfig = {
    webdavUrl: data.webdavUrl || "",
    webdavUser: data.webdavUser || "",
    webdavPass: data.webdavPass || "",
    language: data.language ? normalizeLanguage(data.language) : defaultLanguage(),
    backupProviders: data.backupProviders !== false,
    backupAgentSkills: data.backupAgentSkills === true,
    // 默认关闭，向后兼容：仅显式 true 时启用。
    backupCortexkit: data.backupCortexkit === true,
    piExcludePaths: isLegacyDefaultPiExcludePaths(data.piExcludePaths)
      ? [...DEFAULT_PI_EXCLUDE_PATHS]
      : normalizePiExcludePaths(data.piExcludePaths),
    backupOnExit: data.backupOnExit !== false,
    maxBackups: typeof data.maxBackups === "number" && data.maxBackups >= 0 ? Math.floor(data.maxBackups) : 10,
    // 缺省在内存中生成；saveConfig 写整对象时物化到配置文件。
    deviceName: typeof data.deviceName === "string" && data.deviceName.trim() ? data.deviceName.trim() : defaultDeviceName(),
    remoteBaseDir: normalizeRemoteBaseDir(data.remoteBaseDir),
    exitBackupScope: normalizeExitBackupScope(data.exitBackupScope),
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

export function resolvePassword(pass: string): string {
  return pass.startsWith("$") ? process.env[pass.slice(1)] ?? pass : pass;
}
