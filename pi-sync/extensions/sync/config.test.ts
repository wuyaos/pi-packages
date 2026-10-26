import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PI_EXCLUDE_PATHS, defaultDeviceName, normalizeConfig, normalizePiExcludePaths, validateRemoteBaseDirInput, webdavDir, type SyncConfig } from "./config.ts";

test("Pi backup exclusions default to installed packages and transient state", () => {
  assert.deepEqual(normalizePiExcludePaths(undefined), [...DEFAULT_PI_EXCLUDE_PATHS]);
  assert.deepEqual(DEFAULT_PI_EXCLUDE_PATHS, ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack", "install"]);
  assert.deepEqual(normalizePiExcludePaths([]), []);
});

test("Pi backup exclusions normalize safe relative paths and reject escapes", () => {
  assert.deepEqual(
    normalizePiExcludePaths(["./npm/", "git", "npm", "config\\cache", "../outside", "/tmp", "C:/tmp"]),
    ["npm", "git", "config/cache"],
  );
});

test("remote base dir input validation returns the normalized prefix or null", () => {
  assert.equal(validateRemoteBaseDirInput("pibak"), "pibak/");
  assert.equal(validateRemoteBaseDirInput("a/b.c-d_e"), "a/b.c-d_e/");
  // R1：允许前导 /（WebDAV 根相对），空段折叠，无尾斜杠自动补。
  assert.equal(validateRemoteBaseDirInput("/sync/pibak/"), "/sync/pibak/");
  assert.equal(validateRemoteBaseDirInput("a//b"), "a/b/");
  assert.equal(validateRemoteBaseDirInput("pibak"), "pibak/");
  // 仍拒绝：反斜杠、盘符、穿越、非法字符。
  for (const invalid of ["", "  ", "/", "C:/x", "C:\\x", "backup\\sub", "a/../b", "../x", "..", ".", "a b", "a$b", "备份"]) {
    assert.equal(validateRemoteBaseDirInput(invalid), null, `expected null: ${invalid}`);
  }
});

test("normalizeConfig fills defaults and ignores removed legacy fields", () => {
  const config = normalizeConfig({
    webdavUrl: "https://dav.example/dav",
    webdavUser: "u",
    webdavPass: "p",
    language: "zh",
    // 已移除归档类别的遗留字段：静默忽略。
    backupSessions: false,
    sessionProjects: ["x"],
    sessionProjectMode: "whitelist",
    backupProviders: false,
    backupAgentSkills: true,
    piExcludePaths: ["npm"],
    backupOnExit: true,
    maxBackups: 7,
  } as unknown as Partial<SyncConfig>);
  assert.equal(config.remoteBaseDir, "pibak/", "缺省回退默认根目录");
  assert.equal(config.deviceName, defaultDeviceName(), "deviceName 缺省自动生成");
  assert.deepEqual(config.exitBackupScope, ["pi", "skills"], "scope 缺省为全部类别");
  assert.equal(config.backupProviders, false, "保留字段仍生效");
  assert.equal(config.maxBackups, 7);
});

test("webdavDir joins the migrated remoteBaseDir with the kind segment", () => {
  const migrated = { remoteBaseDir: "sync/pibak/" } as Pick<SyncConfig, "remoteBaseDir">;
  assert.equal(webdavDir("pi", migrated), "sync/pibak/pi/");
  assert.equal(webdavDir("skills", migrated), "sync/pibak/skills/");
});
