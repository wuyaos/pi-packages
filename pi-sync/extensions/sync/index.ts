import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config";
import { registerSyncCommand } from "./menus";
import {
  clearLiveBackupTimer,
  currentProjectIsAllowed,
  incrementTurnAndShouldSync,
  refreshSessionFile,
  scheduleLiveBackup,
  setSessionContext,
  uploadCurrentSession,
} from "./session-sync";

/**
 * pi-sync extension entrypoint.
 *
 * Wires session lifecycle hooks to the session-sync state module and registers
 * the `/sync` interactive command. All implementation lives in the responsibility
 * modules: config, webdav, archive, restore, session-sync, menus.
 */
export default function (pi: ExtensionAPI): void {
  // Capture the active session file/project dir for live backup and interval sync.
  pi.on("session_start", async (_event, ctx) => {
    setSessionContext(ctx.sessionManager.getSessionFile() ?? undefined, ctx.sessionManager.getSessionDir());
  });

  // Refresh the session path (compaction/fork may change it) and schedule a debounced live backup.
  pi.on("agent_settled", async (_event, ctx) => {
    refreshSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
    const config = loadConfig();
    if (config.liveSessionBackup && currentProjectIsAllowed(config)) {
      scheduleLiveBackup(ctx);
    }
  });

  // Every-N-turns interval sync (0 = off). Only counts turns for allowed projects.
  pi.on("turn_end", async (_event, ctx) => {
    const config = loadConfig();
    if (!config.syncIntervalTurns || config.syncIntervalTurns <= 0) return;
    if (!currentProjectIsAllowed(config)) return;
    refreshSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
    if (incrementTurnAndShouldSync(config.syncIntervalTurns)) {
      await uploadCurrentSession(ctx, true).catch(() => { /* silent */ });
    }
  });

  // Flush on exit: upload if sync-on-exit or live backup is enabled.
  pi.on("session_shutdown", async (_event, ctx) => {
    clearLiveBackupTimer();
    const config = loadConfig();
    if (config.syncSessionOnExit || config.liveSessionBackup) {
      await uploadCurrentSession(ctx, true).catch(() => { /* silent */ });
    }
  });

  registerSyncCommand(pi);
}
