import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { disposeBackgroundWorkNavigator } from "./shared-navigator.ts";
import { registerBackgroundTasksGoalProvider } from "./goal-provider.js";
import { clearBackgroundTasksNavigatorSession, ensureBackgroundTasksNavigator, ensureBackgroundTasksNavigatorProvider } from "./navigator-provider.js";
import { resumeScheduledWork, suspendScheduledWork } from "./runtime.js";
import { observeForegroundSandboxPolicy } from "./sandbox.js";
import { registerTools } from "./tools.js";
import { appendExecutionPolicy } from "./shared-execution-policy.js";
import { registerForegroundBash } from "./foreground.js";
import { listMetasForOrigin, writeMeta } from "./registry.js";
import { stopTask } from "./runtime.js";
import type { BackgroundTaskCallbackOrigin } from "./types.js";

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  let activeOrigin: BackgroundTaskCallbackOrigin | undefined;
  pi.on("before_agent_start", (event) => ({ systemPrompt: appendExecutionPolicy(event.systemPrompt) }));
  registerBackgroundTasksGoalProvider(pi);
  ensureBackgroundTasksNavigatorProvider(pi);
  // Subscribed at load so a sandbox extension that publishes later is heard, and
  // asked for a snapshot in case one published before this extension existed.
  observeForegroundSandboxPolicy(pi);
  // Registered before registerTools(pi), so this runs before running tasks are resumed.
  pi.on("session_start", async (_event, ctx) => {
    resumeScheduledWork();
    activeOrigin = { cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId() };
    registerBackgroundTasksGoalProvider(pi);
    ensureBackgroundTasksNavigator(ctx);
  });
  pi.on("session_before_switch", async () => {
    clearBackgroundTasksNavigatorSession();
    disposeBackgroundWorkNavigator();
  });
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "quit" && activeOrigin) {
      const running = listMetasForOrigin(activeOrigin).filter((meta) => meta.status === "running");
      if (running.length) {
        const choice = ctx.mode === "tui"
          ? await ctx.ui.select(`There are ${running.length} running background tasks.`, ["Keep all running", "Stop all", "Choose per task"])
          : "Keep all running";
        if (choice === "Stop all") {
          for (const meta of running) await stopTask(pi, meta.id, () => activeOrigin);
        } else if (choice === "Choose per task") {
          for (const meta of running) {
            const decision = await ctx.ui.select(`${meta.name ?? meta.id}: ${meta.command ?? meta.argv?.join(" ") ?? "task"}`, ["Keep running", "Stop"]);
            if (decision === "Stop") await stopTask(pi, meta.id, () => activeOrigin);
            else { meta.backgrounded = true; meta.callback = true; writeMeta(meta); }
          }
        } else {
          for (const meta of running) { meta.backgrounded = true; meta.callback = true; writeMeta(meta); }
        }
      }
    }
    // Reload and session replacement only transfer management; they never stop tasks.
    suspendScheduledWork();
    activeOrigin = undefined;
    clearBackgroundTasksNavigatorSession();
    disposeBackgroundWorkNavigator(ctx);
  });
  registerTools(pi);
  registerForegroundBash(pi);
}