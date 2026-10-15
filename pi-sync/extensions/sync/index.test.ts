import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import registerSyncExtension, {
  exitUploadDue,
  handleShutdown,
  recordExitUpload,
  resetExitUploadInFlight,
} from "./index.ts";
import type { SyncConfig } from "./config.ts";

test("entrypoint registers no per-turn or live-sync hooks", () => {
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

function config(): SyncConfig {
  return {
    webdavUrl: "https://dav.example/dav",
    webdavUser: "u",
    webdavPass: "p",
    language: "en",
    backupProviders: true,
    backupAgentSkills: true,
    piExcludePaths: [],
    backupOnExit: true,
    maxBackups: 10,
  };
}

test("exit upload is backgrounded for reload and skipped while one is in flight", async () => {
  resetExitUploadInFlight();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-bg-"));
  const marker = path.join(root, "marker.txt");
  try {
    const calls: { notify: boolean }[] = [];
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    const upload = (_ctx: unknown, _config: SyncConfig, notify = true): Promise<boolean> => {
      calls.push({ notify });
      return gate;
    };
    const ctx = { ui: { notify: () => { throw new Error("UI 已重建时不应抛出"); } } } as never;

    await handleShutdown({ reason: "reload" } as never, ctx, { upload, config: config(), now: 1_000, markerPath: marker });
    assert.equal(calls.length, 1, "reload 应立即返回且上传已在后台启动");
    assert.equal(calls[0].notify, false, "后台模式不通知");

    await handleShutdown({ reason: "reload" } as never, ctx, { upload, config: config(), now: 1_001, markerPath: marker });
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
    const calls: { notify: boolean }[] = [];
    const upload = (_ctx: unknown, _config: SyncConfig, notify = true): Promise<boolean> => {
      calls.push({ notify });
      return Promise.resolve(true);
    };
    const ctx = { ui: { notify: () => {} } } as never;

    await handleShutdown({ reason: "quit" } as never, ctx, { upload, config: config(), now: 5_000, markerPath: marker });
    assert.equal(calls.length, 1, "quit 时同步等待上传完成");
    assert.equal(calls[0].notify, true, "quit 时保留通知");
    assert.equal(Number(fs.readFileSync(marker, "utf8")), 5_000);

    await handleShutdown({ reason: "quit" } as never, ctx, { upload, config: config(), now: 6_000, markerPath: marker });
    assert.equal(calls.length, 1, "节流窗口内不重复上传");
    resetExitUploadInFlight();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
