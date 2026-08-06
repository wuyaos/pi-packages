import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

import { isProjectAllowed, loadConfig, refreshFooterStatusFromConfig } from "./config";
import { registerSyncCommand, uploadSessionProjectArchive } from "./menus";

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
    await uploadSessionProjectArchive(ctx, config, projectDir, true);
  });

  registerSyncCommand(pi);
}
