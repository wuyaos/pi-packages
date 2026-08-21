import assert from "node:assert/strict";
import { test } from "node:test";

import { ZoteroApiError } from "./client.ts";
import { batchWriteText, runKeyBatch } from "./batch.ts";

test("batch writes continue after ordinary per-key failures and preserve order", async () => {
  const visited: string[] = [];
  const result = await runKeyBatch(["KEY00001", "KEY00002", "KEY00003"], async (key) => {
    visited.push(key);
    if (key === "KEY00002") throw new ZoteroApiError("conflict", 412);
    return key.toLowerCase();
  });

  assert.deepEqual(visited, ["KEY00001", "KEY00002", "KEY00003"]);
  assert.deepEqual(result.succeeded.map((entry) => entry.key), ["KEY00001", "KEY00003"]);
  assert.deepEqual(result.failed, [{ key: "KEY00002", error: "conflict", status: 412 }]);
  assert.deepEqual(result.skipped, []);
  assert.match(batchWriteText("更新", result), /成功 2，失败 1，跳过 0/);
});

test("batch writes stop after auth or rate-limit failures and report remaining keys as skipped", async () => {
  for (const status of [401, 403, 429]) {
    const result = await runKeyBatch(["KEY00001", "KEY00002", "KEY00003"], async (key) => {
      if (key === "KEY00002") throw new ZoteroApiError("stopped", status);
    });

    assert.deepEqual(result.succeeded.map((entry) => entry.key), ["KEY00001"]);
    assert.deepEqual(result.failed, [{ key: "KEY00002", error: "stopped", status }]);
    assert.deepEqual(result.skipped, ["KEY00003"]);
  }
});
