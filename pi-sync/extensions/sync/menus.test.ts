import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncConfig } from "./config.ts";
import { buildMainMenuItems, executeBackupAll, executeRestoreAll } from "./menus.ts";

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    webdavUrl: "https://example.test/dav/pi",
    webdavUser: "user",
    webdavPass: "pass",
    language: "en",
    backupProviders: true,
    backupAgentSkills: true,
    backupCortexkit: false,
    piExcludePaths: ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"],
    backupOnExit: true,
    maxBackups: 10,
    ...overrides,
  };
}

test("main menu exposes Pi and shared Skills actions in both languages", () => {
  const english = buildMainMenuItems("en");
  const chinese = buildMainMenuItems("zh");
  const expected = [
    "upload-all", "restore-all",
    "upload-pi", "upload-skills", "upload-cortexkit",
    "restore-pi", "restore-skills", "restore-cortexkit",
    "configure", "language", "cancel",
  ];
  assert.deepEqual(english.map((item) => item.id), expected);
  assert.deepEqual(chinese.map((item) => item.id), expected);
  assert.equal(new Set(english.map((item) => item.label)).size, expected.length);
  assert.notEqual(english[0]!.label, chinese[0]!.label);
});

test("executeBackupAll honors enabled categories in order", async () => {
  const calls: string[] = [];
  const result = await executeBackupAll(config({ backupCortexkit: true }), {
    uploadPi: async () => { calls.push("pi"); return true; },
    uploadSkills: async () => { calls.push("skills"); return false; },
    uploadCortexkit: async () => { calls.push("cortexkit"); return true; },
  });

  assert.deepEqual(calls, ["pi", "skills", "cortexkit"]);
  assert.deepEqual(result, [
    { kind: "pi", success: true },
    { kind: "skills", success: false },
    { kind: "cortexkit", success: true },
  ]);
});

test("executeBackupAll skips Magic Context when disabled by default", async () => {
  const calls: string[] = [];
  const result = await executeBackupAll(config(), {
    uploadPi: async () => { calls.push("pi"); return true; },
    uploadSkills: async () => { calls.push("skills"); return true; },
    uploadCortexkit: async () => { calls.push("cortexkit"); return true; },
  });
  assert.deepEqual(calls, ["pi", "skills"]);
  assert.deepEqual(result, [
    { kind: "pi", success: true },
    { kind: "skills", success: true },
  ]);
});

test("executeRestoreAll skips disabled categories", async () => {
  const calls: string[] = [];
  const result = await executeRestoreAll(config({ backupProviders: false, backupCortexkit: true }), {
    restorePi: async () => { calls.push("pi"); return true; },
    restoreSkills: async () => { calls.push("skills"); return true; },
    restoreCortexkit: async () => { calls.push("cortexkit"); return true; },
  });
  assert.deepEqual(calls, ["skills", "cortexkit"]);
  assert.deepEqual(result, [
    { kind: "skills", success: true },
    { kind: "cortexkit", success: true },
  ]);
});
