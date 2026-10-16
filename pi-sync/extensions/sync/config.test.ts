import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PI_EXCLUDE_PATHS, normalizePiExcludePaths, validateRemoteBaseDirInput } from "./config.ts";

test("Pi backup exclusions default to installed packages and transient state", () => {
  assert.deepEqual(normalizePiExcludePaths(undefined), [...DEFAULT_PI_EXCLUDE_PATHS]);
  assert.deepEqual(DEFAULT_PI_EXCLUDE_PATHS, ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"]);
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
  assert.equal(validateRemoteBaseDirInput("backup\\sub"), "backup/sub/");
  for (const invalid of ["", "  ", "/abs", "C:/x", "C:\\x", "a/../b", "..", ".", "a b", "a$b", "备份"]) {
    assert.equal(validateRemoteBaseDirInput(invalid), null, `expected null: ${invalid}`);
  }
});
