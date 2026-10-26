import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, AGENT_SKILLS_DIR, loadConfig, refreshFooterStatusFromConfig, type BackupKind, type SyncConfig } from "./config";
import { computeFingerprint, computeStateKey, readSyncState, SYNC_STATE_PATH, writeSyncState } from "./fingerprint";
import { t } from "./i18n";
import { lockFileSync, unlockFileSync } from "./lock";
import { runBackupKinds, SYNC_LOCK_PATH, type KindBackupResult } from "./backup";
import { registerSyncCommand } from "./menus";

export interface ExitBackupDirs {
  agentDir: string;
  skillsDir: string;
}

export interface ExitBackupDeps {
  /** 类别备份执行；默认 runBackupKinds（notify 为 quit 场景标记）。 */
  uploadKinds?: (ctx: ExtensionCommandContext, config: SyncConfig, kinds: BackupKind[], notify: boolean) => Promise<KindBackupResult[]>;
  config?: SyncConfig;
  now?: number;
  lockPath?: string;
  statePath?: string;
  dirs?: ExitBackupDirs;
  /** 直接注入指纹（测试）；缺省按 dirs 现算。 */
  fingerprint?: string;
}

/**
 * 退出时备份：lockFileSync 抢整体锁（失败静默跳过）→ 计算状态键与指纹 →
 * key 不匹配或指纹变化才上传 exitBackupScope 类别 → 全部成功后写 sync-state。
 * 无变化时通知「无变化，已跳过」。
 */
export async function handleShutdown(
  event: Pick<SessionShutdownEvent, "reason">,
  ctx: ExtensionContext,
  deps: ExitBackupDeps = {},
): Promise<void> {
  const config = deps.config ?? loadConfig();
  if (!config.backupOnExit) return;
  if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) return;
  const kinds = config.exitBackupScope;
  if (kinds.length === 0) return;

  const lock = lockFileSync(deps.lockPath ?? SYNC_LOCK_PATH);
  if (!lock) return; // 另一个备份进行中：静默跳过
  const statePath = deps.statePath ?? SYNC_STATE_PATH;
  try {
    const dirs = deps.dirs ?? { agentDir: AGENT_DIR, skillsDir: AGENT_SKILLS_DIR };
    const fingerprint = deps.fingerprint
      ?? computeFingerprint(dirs.agentDir, dirs.skillsDir, config.piExcludePaths);
    const key = computeStateKey({
      webdavUrl: config.webdavUrl,
      webdavUser: config.webdavUser,
      deviceName: config.deviceName,
      remoteBaseDir: config.remoteBaseDir,
      exitBackupScope: kinds,
      piExcludePaths: config.piExcludePaths,
    });
    const state = readSyncState(statePath);
    if (state && state.key === key && state.fingerprint === fingerprint) {
      try {
        ctx.ui.notify(t(config.language, "exitBackupNoChanges"), "info");
      } catch {
        // UI 可能已随运行时重建销毁。
      }
      return;
    }
    const batchTs = new Date();
    const upload = deps.uploadKinds ?? ((uploadCtx, uploadConfig, uploadKinds) =>
      runBackupKinds(uploadCtx as unknown as ExtensionCommandContext, uploadConfig, uploadKinds, { batchTs }));
    const results = await upload(
      ctx as unknown as ExtensionCommandContext,
      config,
      kinds,
      event.reason === "quit",
    );
    if (results.length > 0 && results.every((result) => result.ok)) {
      const remoteFiles: Partial<Record<BackupKind, string>> = {};
      for (const result of results) if (result.file) remoteFiles[result.kind] = result.file;
      writeSyncState({ key, fingerprint, remoteFiles, uploadedAt: deps.now ?? Date.now() }, statePath);
    }
  } finally {
    unlockFileSync(lock);
  }
}

export default function registerSyncExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    refreshFooterStatusFromConfig(ctx, config);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    await handleShutdown(event, ctx);
  });

  registerSyncCommand(pi);
}
