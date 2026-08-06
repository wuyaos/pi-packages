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
    backupSessions: true,
    backupAgentSkills: true,
    piExcludePaths: ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"],
    backupOnExit: true,
    sessionProjects: [],
    sessionProjectMode: "blacklist",
    maxBackups: 10,
    ...overrides,
  };
}

test("main menu exposes stable actions in both languages", () => {
  const english = buildMainMenuItems("en");
  const chinese = buildMainMenuItems("zh");
  const expected = [
    "upload-all", "restore-all",
    "upload-pi", "upload-skills", "upload-sessions",
    "restore-pi", "restore-skills", "restore-sessions",
    "configure", "language", "cancel",
  ];
  assert.deepEqual(english.map((item) => item.id), expected);
  assert.deepEqual(chinese.map((item) => item.id), expected);
  assert.equal(new Set(english.map((item) => item.label)).size, expected.length);
  assert.notEqual(english[0]!.label, chinese[0]!.label);
});

test("executeBackupAll honors enabled categories and project blacklist in order", async () => {
  const calls: string[] = [];
  const result = await executeBackupAll(config({ sessionProjects: ["--skip--"] }), {
    uploadPi: async () => { calls.push("pi"); return true; },
    uploadSkills: async () => { calls.push("skills"); return false; },
    listProjects: () => ["--keep--", "--skip--"],
    uploadSession: async (project) => { calls.push(`session:${project}`); return true; },
  });

  assert.deepEqual(calls, ["pi", "skills", "session:--keep--"]);
  assert.deepEqual(result, [
    { kind: "pi", success: true },
    { kind: "skills", success: false },
    { kind: "session", project: "--keep--", success: true },
  ]);
});

test("executeRestoreAll honors whitelist and reports remote listing failures", async () => {
  const calls: string[] = [];
  const selected = await executeRestoreAll(config({ sessionProjectMode: "whitelist", sessionProjects: ["--keep--"] }), {
    restorePi: async () => { calls.push("pi"); return true; },
    restoreSkills: async () => { calls.push("skills"); return true; },
    listProjects: async () => ["--skip--", "--keep--"],
    restoreSession: async (project) => { calls.push(`session:${project}`); return true; },
  });
  assert.deepEqual(calls, ["pi", "skills", "session:--keep--"]);
  assert.deepEqual(selected.at(-1), { kind: "session", project: "--keep--", success: true });

  const failed = await executeRestoreAll(config({ backupProviders: false, backupAgentSkills: false }), {
    restorePi: async () => { throw new Error("must not run"); },
    restoreSkills: async () => { throw new Error("must not run"); },
    listProjects: async () => { throw new Error("offline"); },
    restoreSession: async () => true,
  });
  assert.deepEqual(failed, [{ kind: "session", success: false, error: "offline" }]);
});
