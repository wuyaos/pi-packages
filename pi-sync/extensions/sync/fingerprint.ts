/**
 * 同步指纹与状态（引擎层）。
 *
 * - computeFingerprint：对 Pi agent 关键配置 + 共享 Skills + Cortexkit 配置收集
 *   { relPath: "mtimeMs:size" } 清单，稳定序列化后取 sha256。
 * - sync-state.json 状态文件记录 { key, fingerprint, remoteFiles, uploadedAt }；
 *   key 绑定 WebDAV 连接 + 设备 + 目录 + 备份范围，key 变化即视为全新状态。
 * - 读写原子（tmp+rename）；invalidate() 供恢复后清空指纹，强制下轮重新上传。
 *
 * Import: import { … } from "./fingerprint"
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_DIR, PI_EXCLUDE_GLOBS, matchExcludeGlob, type BackupKind } from "./config";
import { writeJsonAtomic } from "../_shared/json-io";

export const SYNC_STATE_PATH = path.join(AGENT_DIR, "sync-state.json");

/** 参与 fingerprint 的 Pi agent 顶层配置文件（相对 agentDir）。 */
const AGENT_FINGERPRINT_FILES = [
  "settings.json",
  "models.json",
  "model-config.json",
  "mcp.json",
  "lazy.json",
  "pi-goal.json",
] as const;

/** 指纹扫描跳过的目录/文件名噪声：__pycache__、*.log 及共用通配排除清单。 */
function isNoiseName(name: string): boolean {
  return name === "__pycache__" || matchExcludeGlob(name, PI_EXCLUDE_GLOBS);
}

function isExcludedRelPath(relPath: string, excludePaths: readonly string[]): boolean {
  return excludePaths.some((excluded) => relPath === excluded || relPath.startsWith(`${excluded}/`));
}

type Manifest = Record<string, string>;

function walkTree(dir: string, base: string, excludePaths: readonly string[], manifest: Manifest): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relPath = `${base}/${entry.name}`;
    if (isNoiseName(entry.name)) continue;
    if (isExcludedRelPath(relPath, excludePaths)) continue;
    const full = path.join(dir, entry.name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      walkTree(full, relPath, excludePaths, manifest);
    } else if (stats.isFile()) {
      manifest[relPath] = `${stats.mtimeMs}:${stats.size}`;
    }
  }
}

/**
 * 计算同步指纹：agentDir 的关键配置文件 + skillsDir/cortexkitDir 递归清单
 * （排除 piExcludePaths 相对路径、__pycache__ 与共用通配排除清单
 * （*.log、*.bak、*.tmp、*.swp、sync-state.json、*.bak-*）、符号链接）。
 * 目录不存在或文件缺失视为"缺席"，同样参与指纹。
 */
export function computeFingerprint(
  agentDir: string,
  skillsDir: string,
  cortexkitDir: string,
  excludePaths: readonly string[] = [],
): string {
  const manifest: Manifest = {};
  for (const name of AGENT_FINGERPRINT_FILES) {
    if (isExcludedRelPath(name, excludePaths)) continue;
    try {
      const stats = fs.lstatSync(path.join(agentDir, name));
      if (stats.isFile()) manifest[name] = `${stats.mtimeMs}:${stats.size}`;
    } catch {
      // 缺席即指纹的一部分。
    }
  }
  if (fs.existsSync(skillsDir)) walkTree(skillsDir, "skills", excludePaths, manifest);
  if (fs.existsSync(cortexkitDir)) walkTree(cortexkitDir, "cortexkit", excludePaths, manifest);
  // replacer 数组按给定顺序序列化键，等价于按键名稳定排序。
  const serialized = JSON.stringify(manifest, Object.keys(manifest).sort());
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export interface SyncStateKeyInputs {
  webdavUrl: string;
  webdavUser: string;
  deviceName: string;
  remoteBaseDir: string;
  exitBackupScope: readonly string[];
  piExcludePaths: readonly string[];
}

/** 状态键：绑定 WebDAV 连接、设备、远端目录与备份范围；任一变化即产生新 key。 */
export function computeStateKey(inputs: SyncStateKeyInputs): string {
  const material = [
    inputs.webdavUrl,
    inputs.webdavUser,
    inputs.deviceName,
    inputs.remoteBaseDir,
    [...inputs.exitBackupScope].sort().join(","),
    [...inputs.piExcludePaths].sort().join(","),
  ].join("\n");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

export interface SyncState {
  key: string;
  fingerprint: string;
  /** 每个备份类别最近一次上传的远端文件名。 */
  remoteFiles: Partial<Record<BackupKind, string>>;
  uploadedAt: number;
}

/** 读取同步状态；文件缺失或损坏返回 null。 */
export function readSyncState(statePath: string = SYNC_STATE_PATH): SyncState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<SyncState> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      key: typeof parsed.key === "string" ? parsed.key : "",
      fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : "",
      remoteFiles: parsed.remoteFiles && typeof parsed.remoteFiles === "object" ? parsed.remoteFiles : {},
      uploadedAt: typeof parsed.uploadedAt === "number" ? parsed.uploadedAt : 0,
    };
  } catch {
    return null;
  }
}

/** 原子写入同步状态（tmp+rename）。 */
export function writeSyncState(state: SyncState, statePath: string = SYNC_STATE_PATH): void {
  writeJsonAtomic(statePath, state);
}

/** 清空指纹（保留 remoteFiles），供恢复远端备份后调用，强制下轮重新上传。 */
export function invalidateSyncState(statePath: string = SYNC_STATE_PATH): void {
  const state = readSyncState(statePath);
  if (!state) return;
  state.fingerprint = "";
  writeSyncState(state, statePath);
}
