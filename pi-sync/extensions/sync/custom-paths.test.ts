import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  normalizeCustomPath,
  normalizeCustomPathList,
  parseCustomPathList,
  resolveCustomRestoreTarget,
  validateCustomPathSet,
} from "./custom-paths.ts";

const agentRoot = path.join(os.homedir(), ".pi", "agent");

test("custom paths accept only relative children of the Pi agent directory", () => {
  assert.equal(normalizeCustomPath("extensions/demo.ts"), "extensions/demo.ts");
  assert.throws(() => normalizeCustomPath("../outside"), /must stay within/);
  assert.throws(() => normalizeCustomPath(agentRoot), /child path/);
  assert.throws(() => normalizeCustomPath("/tmp/outside"), /must stay within/);
});

test("custom path lists de-duplicate and reject overlapping restore targets", () => {
  assert.deepEqual(parseCustomPathList("extensions/a.ts, extensions/a.ts\nskills/demo"), ["extensions/a.ts", "skills/demo"]);
  assert.throws(() => validateCustomPathSet(["extensions", "extensions/demo.ts"]), /cannot overlap/);
  assert.deepEqual(normalizeCustomPathList(["extensions", "extensions/demo.ts", "../outside"]), ["extensions"]);
});

test("custom restore metadata rejects bad archive roots and resolves a safe target", () => {
  const parent = path.join(agentRoot, "extensions");
  fs.mkdirSync(parent, { recursive: true });
  const valid = resolveCustomRestoreTarget({ archiveRoot: "custom/0/data", relativePath: "extensions/demo.ts", type: "file" });
  assert.equal(valid.destination, path.join(agentRoot, "extensions", "demo.ts"));
  assert.throws(
    () => resolveCustomRestoreTarget({ archiveRoot: "custom/../data", relativePath: "extensions/demo.ts", type: "file" }),
    /Invalid custom archive root/,
  );
  assert.throws(
    () => resolveCustomRestoreTarget({ archiveRoot: "custom/0/data", relativePath: "../outside", type: "file" }),
    /must stay within/,
  );
});
