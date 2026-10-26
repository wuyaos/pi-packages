import { once } from "node:events";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { nextTaskId, readMeta, removeMeta, taskDir, writeMeta } from "./registry.js";
import { readProcessStartToken } from "./process-identity.js";
import { spawnCommand } from "./process.js";
import { resumeRunningTask, suspendScheduledWork } from "./runtime.js";
import type { BackgroundTaskMeta } from "./types.js";

describe("recovered local tasks", () => {
  it("keeps polling a live process adopted from another Pi process", async () => {
    const id = nextTaskId();
    const logPath = join(taskDir(id), "output.log");
    const spawned = spawnCommand({
      shell: false,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
    }, logPath, true);
    const pid = spawned.child.pid!;
    const pidStartTime = readProcessStartToken(pid) ?? "test-process-start";
    const meta: BackgroundTaskMeta = {
      id,
      kind: "process",
      status: "running",
      startedAt: Date.now(),
      logPath,
      callback: false,
      cwd: process.cwd(),
      pid,
      pidStartTime,
      pgid: spawned.pgid,
      spawnPid: process.pid + 1,
      spawnPidStartTime: "foreign-pi-process",
    };
    writeMeta(meta);

    try {
      resumeRunningTask({} as ExtensionAPI, meta, undefined, {}, new Map([[pid, pidStartTime]]));
      expect(readMeta(id)?.status).toBe("running");
      await once(spawned.child, "close");
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      expect(readMeta(id)?.status).toBe("lost");
    } finally {
      suspendScheduledWork();
      removeMeta(meta);
    }
  }, 30_000);
});
