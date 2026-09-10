import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import registerSyncExtension, {
  exitUploadDue,
  handleSessionShutdown,
  projectDirFromSessionDir,
  recordExitUpload,
  resetExitUploadInFlight,
} from "./index.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SyncConfig } from "./config.ts";

type UploadFn = Parameters<typeof handleSessionShutdown>[2] extends infer D ? (D extends { upload?: infer U } ? U : never) : never;

test("projectDirFromSessionDir accepts only Pi project session directories", () => {
  assert.equal(
    projectDirFromSessionDir("/home/user/.pi/agent/sessions/--mnt-d-work-project--"),
    "--mnt-d-work-project--",
  );
  assert.equal(projectDirFromSessionDir("/tmp/not-a-project"), undefined);
  assert.equal(projectDirFromSessionDir(undefined), undefined);
});

test("archive-only entrypoint registers no per-turn or live-sync hooks", () => {
  const events: string[] = [];
  let command = "";
  registerSyncExtension({
    on: (event: string) => { events.push(event); },
    registerCommand: (name: string) => { command = name; },
  } as never);
  assert.deepEqual(events, ["session_start", "session_shutdown"]);
  assert.equal(command, "sync");
});

test("exit upload throttling tolerates missing, invalid, and fresh markers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-exit-"));
  const marker = path.join(root, "state", "marker.txt");
  try {
    const now = 1_800_000_000_000;
    assert.equal(exitUploadDue(marker, now), true, "missing marker should allow upload");
    recordExitUpload(marker, now);
    assert.equal(exitUploadDue(marker, now + 1_000), false, "a fresh marker should throttle the upload");
    assert.equal(exitUploadDue(marker, now + 3600_000), true, "an expired interval should allow the upload");
    fs.writeFileSync(marker, "garbage");
    assert.equal(exitUploadDue(marker, now), true, "an invalid marker should allow the upload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exit upload is backgrounded for reload and skipped while one is in flight", async () => {
  resetExitUploadInFlight();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-bg-"));
  const marker = path.join(root, "marker.txt");
  try {
    const config = {
      backupOnExit: true,
      backupSessions: true,
      webdavUrl: "https://dav.example/dav",
      webdavUser: "u",
      webdavPass: "p",
      sessionProjects: ["--proj--"],
      sessionProjectMode: "whitelist",
    } as never;
    const calls: { signal: AbortSignal | undefined; project: string; notify: boolean }[] = [];
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    const upload: UploadFn = (ctx, _config, project, notify) => {
      calls.push({ signal: (ctx as { signal?: AbortSignal }).signal, project, notify: notify ?? true });
      return gate;
    };
    const ctx = {
      sessionManager: { getSessionDir: () => "/home/u/.pi/agent/sessions/--proj--" },
      ui: { notify: () => { throw new Error("UI 已重建时不应抛出"); } },
    } as never;

    await handleSessionShutdown({ reason: "reload" } as never, ctx, { upload, config, now: 1_000, markerPath: marker });
    assert.equal(calls.length, 1, "reload 应立即返回且上传已在后台启动");
    assert.equal(calls[0].notify, false, "后台模式不通知");
    assert.ok(calls[0].signal && !calls[0].signal.aborted, "后台任务必须用独立 signal，不受旧 runner teardown 影响");

    await handleSessionShutdown({ reason: "reload" } as never, ctx, { upload, config, now: 1_001, markerPath: marker });
    assert.equal(calls.length, 1, "进行中时连续 reload 不叠加上传");

    release(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(Number(fs.readFileSync(marker, "utf8")), 1_000, "后台成功后写 marker");
    resetExitUploadInFlight();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exit upload is awaited on quit and skipped when throttled", async () => {
  resetExitUploadInFlight();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-quit-"));
  const marker = path.join(root, "marker.txt");
  try {
    const config = {
      backupOnExit: true,
      backupSessions: true,
      webdavUrl: "https://dav.example/dav",
      webdavUser: "u",
      webdavPass: "p",
      sessionProjects: ["--proj--"],
      sessionProjectMode: "whitelist",
    } as never;
    const ctx = { sessionManager: { getSessionDir: () => "/home/u/.pi/agent/sessions/--proj--" }, ui: { notify: () => {} } } as never;
    const calls: { notify: boolean }[] = [];
    const upload: UploadFn = (_ctx, _config, _project, notify) => {
      calls.push({ notify: notify ?? true });
      return Promise.resolve(true);
    };

    await handleSessionShutdown({ reason: "quit" } as never, ctx, { upload, config, now: 5_000, markerPath: marker });
    assert.equal(calls.length, 1, "quit 时同步等待上传完成");
    assert.equal(calls[0].notify, true, "quit 时保留通知");
    assert.equal(Number(fs.readFileSync(marker, "utf8")), 5_000);

    await handleSessionShutdown({ reason: "quit" } as never, ctx, { upload, config, now: 6_000, markerPath: marker });
    assert.equal(calls.length, 1, "节流窗口内不重复上传");
    resetExitUploadInFlight();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
