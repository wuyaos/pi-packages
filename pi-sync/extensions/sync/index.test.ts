import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import registerSyncExtension, { handleShutdown, type ExitBackupDeps } from "./index.ts";
import { lockFileSync } from "./lock.ts";
import { readSyncState, writeSyncState } from "./fingerprint.ts";
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

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    webdavUrl: "https://dav.example/dav",
    webdavUser: "u",
    webdavPass: "p",
    language: "en",
    backupProviders: true,
    backupAgentSkills: true,
    backupCortexkit: false,
    piExcludePaths: [],
    backupOnExit: true,
    maxBackups: 10,
    deviceName: "test-device",
    remoteBaseDir: "backup/",
    exitBackupScope: ["pi", "skills"],
    ...overrides,
  };
}

interface Harness {
  deps: ExitBackupDeps;
  calls: { kinds: string[]; notify: boolean }[];
  notifications: string[];
  ctx: never;
  root: string;
  lockPath: string;
  statePath: string;
}

function setup(cfg = config()): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-exit-"));
  const calls: { kinds: string[]; notify: boolean }[] = [];
  const notifications: string[] = [];
  const deps: ExitBackupDeps = {
    config: cfg,
    now: 5_000,
    lockPath: path.join(root, "sync.lock"),
    statePath: path.join(root, "sync-state.json"),
    fingerprint: "fp1",
    uploadKinds: async (_ctx, _cfg, kinds, notify) => {
      calls.push({ kinds: [...kinds], notify });
      return kinds.map((kind) => ({ kind, ok: true, file: `${kind}.tar.xz` }));
    },
  };
  const ctx = {
    ui: { notify: (message: string) => { notifications.push(message); } },
  } as never;
  return { deps, calls, notifications, ctx, root, lockPath: deps.lockPath!, statePath: deps.statePath! };
}

const quit = { reason: "quit" } as never;
const reload = { reason: "reload" } as never;

test("exit backup skips upload when key and fingerprint are unchanged", async () => {
  const h = setup();
  try {
    writeSyncState({ key: "k1", fingerprint: "fp1", remoteFiles: { pi: "old.tar.xz" }, uploadedAt: 1 }, h.statePath);
    // 状态里的 key 与当前配置派生 key 不一致（k1）→ 先上传写状态，再验证第二次跳过。
    await handleShutdown(quit, h.ctx, h.deps);
    assert.equal(h.calls.length, 1);
    const state = readSyncState(h.statePath)!;
    assert.equal(state.fingerprint, "fp1");

    h.calls.length = 0;
    h.notifications.length = 0;
    await handleShutdown(reload, h.ctx, h.deps);
    assert.equal(h.calls.length, 0, "无变化不上传");
    assert.match(h.notifications[0]!, /skipped/);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("exit backup uploads when the fingerprint or key changes and writes state", async () => {
  const h = setup();
  try {
    // 指纹变化（state 中记录旧指纹）→ 上传。
    writeSyncState({ key: "whatever", fingerprint: "fp0", remoteFiles: {}, uploadedAt: 0 }, h.statePath);
    await handleShutdown(quit, h.ctx, h.deps);
    assert.deepEqual(h.calls[0]!.kinds, ["pi", "skills"], "scope 取 exitBackupScope");
    assert.equal(h.calls[0]!.notify, true, "quit 场景 notify=true");
    const state = readSyncState(h.statePath)!;
    assert.equal(state.fingerprint, "fp1");
    assert.equal(state.key.length, 64);
    assert.deepEqual(state.remoteFiles, { pi: "pi.tar.xz", skills: "skills.tar.xz" });
    assert.equal(state.uploadedAt, 5_000);

    // key 变化（scope 改变）→ 重新上传。
    const h2 = setup(config({ exitBackupScope: ["pi"] }));
    try {
      await handleShutdown(quit, h2.ctx, h2.deps);
      assert.deepEqual(h2.calls[0]!.kinds, ["pi"], "scope 控制上传类别");
    } finally {
      fs.rmSync(h2.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("exit backup stays silent on lock contention and skips when disabled", async () => {
  const h = setup();
  try {
    // 锁被占用 → 静默跳过。
    const external = lockFileSync(h.lockPath);
    assert.ok(external);
    await handleShutdown(quit, h.ctx, h.deps);
    assert.equal(h.calls.length, 0, "锁失败不上传");
    assert.equal(h.notifications.length, 0, "锁失败静默");
    fs.rmSync(h.lockPath, { force: true });

    // backupOnExit=false → 不触碰锁与上传。
    const h2 = setup(config({ backupOnExit: false }));
    try {
      await handleShutdown(quit, h2.ctx, h2.deps);
      assert.equal(h2.calls.length, 0);
    } finally {
      fs.rmSync(h2.root, { recursive: true, force: true });
    }

    // scope 为空 → 不执行。
    const h3 = setup(config({ exitBackupScope: [] }));
    try {
      await handleShutdown(quit, h3.ctx, h3.deps);
      assert.equal(h3.calls.length, 0);
    } finally {
      fs.rmSync(h3.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("exit backup does not write state when any category fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-fail-"));
  try {
    const calls: string[] = [];
    await handleShutdown(quit, {
      ui: { notify: () => {} },
    } as never, {
      config: config(),
      lockPath: path.join(root, "sync.lock"),
      statePath: path.join(root, "sync-state.json"),
      fingerprint: "fp1",
      uploadKinds: async (_ctx, _cfg, kinds) => {
        calls.push(...kinds);
        return kinds.map((kind, index) => ({ kind, ok: index > 0, file: `${kind}.tar.xz` }));
      },
    });
    assert.deepEqual(calls, ["pi", "skills"], "失败前仍会按序尝试（首个成功、次个失败后中断与否由实现决定）");
    assert.equal(readSyncState(path.join(root, "sync-state.json")), null, "存在失败时不写状态");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
