/**
 * 直接备份执行（引擎层）。
 *
 * 不读取 backupXxx 配置开关：类别集合由调用方（备份二级菜单的勾选、
 * 退出备份的 exitBackupScope）决定。命名统一走 formatArchiveName，远端
 * 目录走 webdavDir(kind, config)，每个类别上传后执行远端 prune。
 *
 * 互斥：SYNC_LOCK_PATH 是各类别备份共用的文件锁；未传入整体锁时每个类别
 * 独立加锁串行，保证与退出备份（先锁后判指纹）互斥。
 *
 * Import: import { … } from "./backup"
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatArchiveName, platformCode } from "./archive-name";
import { createAgentSkillsZip, createCortexkitZip, createPiAgentZip } from "./archive";
import { AGENT_DIR, webdavDir, type BackupKind, type SyncConfig } from "./config";
import { lockFileSync, unlockFileSync, type FileLock } from "./lock";
import { pruneOldBackupsInDir, uploadToWebdavDir } from "./webdav";

/** 各类别备份共用的互斥锁（备份菜单与退出备份串行）。 */
export const SYNC_LOCK_PATH = path.join(AGENT_DIR, "state", "pi-sync.lock");

/** 锁被其他进程持有时 results 中的 error 标记，由展示层映射为本地化文案。 */
export const LOCK_BUSY_ERROR = "lock-busy";

export interface KindBackupResult {
  kind: BackupKind;
  ok: boolean;
  /** 成功时为远端归档文件名。 */
  file?: string;
  error?: string;
}

export interface RunBackupOptions {
  /** 调用方已持有的整体锁（退出备份先锁后判指纹）；传入后不再逐类别加锁。 */
  lock?: FileLock;
  /** 每类别完成（含失败/锁冲突）后回调一次，供进度面板更新。 */
  onProgress?: (event: BackupProgressEvent) => void;
  /** @internal 仅供测试注入单类别执行，避免真实打包与网络。 */
  backupKind?: typeof backupKindToWebdav;
}

export interface BackupProgressEvent {
  /** 已完成（含失败）的类别数。 */
  completed: number;
  /** 本次备份的类别总数。 */
  total: number;
  /** 刚完成的类别。 */
  kind: BackupKind;
  /** 该类别的执行结果。 */
  result: KindBackupResult;
}

/** 备份单个类别：打包 → 上传 → 远端 prune。抛错一律折叠为失败结果。 */
export async function backupKindToWebdav(
  ctx: ExtensionContext,
  config: SyncConfig,
  kind: BackupKind,
): Promise<KindBackupResult> {
  const file = formatArchiveName(config.deviceName, platformCode(), kind, new Date());
  const archive = path.join(os.tmpdir(), file);
  try {
    if (kind === "pi") await createPiAgentZip(config, archive);
    else if (kind === "skills") await createAgentSkillsZip(archive, undefined, config.deviceName);
    else await createCortexkitZip(archive, undefined, config.deviceName);
    await uploadToWebdavDir(archive, webdavDir(kind, config), file, config, ctx);
    await pruneOldBackupsInDir(config, ctx, webdavDir(kind, config));
    return { kind, ok: true, file };
  } catch (error) {
    return { kind, ok: false, file, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

/** 串行备份给定类别；无整体锁时每个类别独立 lockFileSync 互斥。 */
export async function runBackupKinds(
  ctx: ExtensionContext,
  config: SyncConfig,
  kinds: readonly BackupKind[],
  options: RunBackupOptions = {},
): Promise<KindBackupResult[]> {
  const results: KindBackupResult[] = [];
  const backupKind = options.backupKind ?? backupKindToWebdav;
  for (const kind of kinds) {
    const lock = options.lock ?? lockFileSync(SYNC_LOCK_PATH);
    if (!lock) {
      results.push({ kind, ok: false, error: LOCK_BUSY_ERROR });
      options.onProgress?.({ completed: results.length, total: kinds.length, kind, result: results[results.length - 1]! });
      continue;
    }
    try {
      const result = await backupKind(ctx, config, kind);
      results.push(result);
    } finally {
      if (!options.lock) unlockFileSync(lock);
    }
    options.onProgress?.({ completed: results.length, total: kinds.length, kind, result: results[results.length - 1]! });
  }
  return results;
}
