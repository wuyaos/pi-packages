import { type ExtensionAPI, type ExtensionContext, type SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import { AGENT_DIR, isProjectAllowed, loadConfig, refreshFooterStatusFromConfig, type SyncConfig } from "./config";
import { ensureDir } from "../_shared/json-io";
import { registerSyncCommand, uploadSessionProjectArchive } from "./menus";

/** 退出时自动上传会话归档的最小间隔：频繁重启不应耗尽 maxBackups 把含历史的老归档轮替掉。 */
export const EXIT_UPLOAD_MIN_INTERVAL_MS = 30 * 60 * 1000;

const exitUploadMarkerPath = path.join(AGENT_DIR, "state", "pi-sync-last-exit-upload.txt");

/**
 * 判断退出自动上传是否到期。marker 不存在或距上次上传超过 minIntervalMs 时到期。
 * 独立导出便于测试。
 */
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

export function projectDirFromSessionDir(sessionDir: string | undefined): string | undefined {
  if (!sessionDir) return undefined;
  const projectDir = path.basename(sessionDir);
  return projectDir.startsWith("--") && projectDir.endsWith("--") ? projectDir : undefined;
}

/**
 * Archive-only pi-sync entrypoint。
 *
 * 运行时工作仅限：启动时读一次缓存配置 + 关停时的会话归档（quit 同步等待，
 * reload/new/resume/fork 转后台，不阻塞 reload）。无 per-turn 钩子、无定时器、无常驻上传。
 */
let exitUploadInFlight = false;

/** 测试用：重置后台任务标志。 */
export function resetExitUploadInFlight(): void {
  exitUploadInFlight = false;
}

export interface ExitUploadDeps {
  upload?: typeof uploadSessionProjectArchive;
  config?: SyncConfig;
  now?: number;
  markerPath?: string;
}

/**
 * 退出自动上传会话归档。
 * quit：进程即将终止，同步等待上传完成（fire-and-forget 会被终止）。
 * reload/new/resume/fork：进程存活，上传转入后台，不阻塞 reload；
 * 旧 runner 的 ctx.signal 在 teardown 后会失效，后台任务必须用独立 AbortController。
 */
export async function handleSessionShutdown(
  event: Pick<SessionShutdownEvent, "reason">,
  ctx: ExtensionContext,
  deps: ExitUploadDeps = {},
): Promise<void> {
  const config = deps.config ?? loadConfig();
  if (!config.backupOnExit || !config.backupSessions) return;
  if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) return;
  const projectDir = projectDirFromSessionDir(ctx.sessionManager.getSessionDir());
  if (!projectDir || !isProjectAllowed(projectDir, config)) return;
  const now = deps.now ?? Date.now();
  const markerPath = deps.markerPath ?? exitUploadMarkerPath;
  if (!exitUploadDue(markerPath, now)) return;

  const upload = deps.upload ?? uploadSessionProjectArchive;
  const finish = (uploaded: boolean): void => {
    if (uploaded) recordExitUpload(markerPath, now);
  };

  if (event.reason === "quit") {
    finish(await upload(ctx, config, projectDir, true));
    return;
  }

  if (exitUploadInFlight) return;
  exitUploadInFlight = true;
  const controller = new AbortController();
  const detachedCtx = {
    signal: controller.signal,
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error"): void => {
        try { ctx.ui.notify(message, type); } catch { /* UI 可能已随 reload 重建 */ }
      },
    },
  } as unknown as ExtensionContext;
  void (async (): Promise<void> => {
    try {
      finish(await upload(detachedCtx, config, projectDir, false));
    } catch {
      // 后台归档失败只影响本次节流窗口，不影响会话；marker 不写入，下个窗口重试。
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
    await handleSessionShutdown(event, ctx);
  });

  registerSyncCommand(pi);
}
