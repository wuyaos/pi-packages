import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import { AGENT_DIR, isProjectAllowed, loadConfig, refreshFooterStatusFromConfig } from "./config";
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
 * Archive-only pi-sync entrypoint.
 *
 * Runtime work is intentionally limited to one cached config read at startup
 * and one current-project archive on shutdown. There are no per-turn hooks,
 * timers, live uploads, or interval counters.
 */
export default function registerSyncExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    refreshFooterStatusFromConfig(ctx, config);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const config = loadConfig();
    if (!config.backupOnExit || !config.backupSessions) return;
    if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) return;
    const projectDir = projectDirFromSessionDir(ctx.sessionManager.getSessionDir());
    if (!projectDir || !isProjectAllowed(projectDir, config)) return;
    const now = Date.now();
    if (!exitUploadDue(exitUploadMarkerPath, now)) return;
    const uploaded = await uploadSessionProjectArchive(ctx, config, projectDir, true);
    if (uploaded) recordExitUpload(exitUploadMarkerPath, now);
  });

  registerSyncCommand(pi);
}
