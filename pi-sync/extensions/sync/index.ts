import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import { AGENT_DIR, loadConfig, refreshFooterStatusFromConfig, type SyncConfig } from "./config";
import { ensureDir } from "../_shared/json-io";
import { registerSyncCommand, uploadEnabledBackups } from "./menus";

/** 退出自动上传的最小间隔：频繁重启不应耗尽历史归档。 */
export const EXIT_UPLOAD_MIN_INTERVAL_MS = 30 * 60 * 1000;

const exitUploadMarkerPath = path.join(AGENT_DIR, "state", "pi-sync-last-exit-upload.txt");

/** 判断退出自动上传是否到期。marker 不存在或距上次上传超过 minIntervalMs 时到期。 */
export function exitUploadDue(markerPath: string, nowMs: number, minIntervalMs = EXIT_UPLOAD_MIN_INTERVAL_MS): boolean {
  try {
    const last = Number(fs.readFileSync(markerPath, "utf8").trim());
    if (!Number.isFinite(last) || last <= 0) return true;
    return nowMs - last >= minIntervalMs;
  } catch {
    return true;
  }
}

export function recordExitUpload(markerPath: string, nowMs: number): void {
  ensureDir(path.dirname(markerPath));
  fs.writeFileSync(markerPath, String(nowMs));
}

let exitUploadInFlight = false;

/** 测试用：重置后台任务标志。 */
export function resetExitUploadInFlight(): void {
  exitUploadInFlight = false;
}

export interface ExitUploadDeps {
  upload?: (ctx: ExtensionCommandContext, config: SyncConfig, notify?: boolean) => Promise<boolean>;
  config?: SyncConfig;
  now?: number;
  markerPath?: string;
}

/**
 * 退出时备份已启用的 Pi、共享 Skills 与 Magic Context 配置类别。
 * quit：进程即将终止，同步等待上传完成；其他原因转入后台，不阻塞运行时重建。
 */
export async function handleShutdown(
  event: Pick<SessionShutdownEvent, "reason">,
  ctx: ExtensionContext,
  deps: ExitUploadDeps = {},
): Promise<void> {
  const config = deps.config ?? loadConfig();
  if (!config.backupOnExit) return;
  if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) return;
  if (!config.backupProviders && !config.backupAgentSkills && !config.backupCortexkit) return;
  const now = deps.now ?? Date.now();
  const markerPath = deps.markerPath ?? exitUploadMarkerPath;
  if (!exitUploadDue(markerPath, now)) return;

  const upload = deps.upload ?? uploadEnabledBackups;
  const finish = (uploaded: boolean): void => {
    if (uploaded) recordExitUpload(markerPath, now);
  };

  if (event.reason === "quit") {
    finish(await upload(ctx as unknown as ExtensionCommandContext, config, true));
    return;
  }

  if (exitUploadInFlight) return;
  exitUploadInFlight = true;
  const controller = new AbortController();
  const detachedCtx = {
    signal: controller.signal,
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error"): void => {
        try { ctx.ui.notify(message, type); } catch { /* UI 可能已随重建销毁 */ }
      },
    },
  } as unknown as ExtensionCommandContext;
  void (async (): Promise<void> => {
    try {
      finish(await upload(detachedCtx, config, false));
    } catch {
      // 失败不写 marker，下个窗口可重试。
    } finally {
      exitUploadInFlight = false;
    }
  })();
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
