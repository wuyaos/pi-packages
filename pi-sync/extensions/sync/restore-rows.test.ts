import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRestoreRows, filterRowsByDevice, listRowDevices } from "./restore-rows.ts";

const T1 = Date.UTC(2025, 0, 2, 3, 4, 5);
const T2 = Date.UTC(2025, 5, 1, 0, 0, 0);

test("restore rows merge same device+platform+timestamp tags into one line", () => {
  const rows = buildRestoreRows([
    `devA-win-pi_20250102-030405.tar.xz`,
    `devA-win-skills_20250102-030405.tar.xz`,
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.tags, ["pi", "skills"]);
  assert.equal(rows[0]!.files.pi, "devA-win-pi_20250102-030405.tar.xz");
  assert.equal(rows[0]!.device, "devA");
  assert.equal(rows[0]!.platform, "win");
  assert.equal(rows[0]!.ts.getTime(), T1);
});

test("restore rows split lines across devices, platforms, and timestamps", () => {
  const names = [
    `devA-win-pi_20250102-030405.tar.xz`,
    `devB-win-pi_20250102-030405.tar.xz`,   // 其他设备
    `devA-linux-pi_20250102-030405.tar.xz`, // 其他平台
    `devA-win-pi_20250601-000000.tar.xz`,   // 其他时间
  ];
  const rows = buildRestoreRows(names);
  assert.equal(rows.length, 4);
  // 按时间倒序。
  assert.deepEqual(rows.map((row) => row.ts.getTime()), [T2, T1, T1, T1]);
  // 同 ts 的顺序按输入稳定。
  assert.deepEqual(rows.slice(1).map((row) => row.device), ["devA", "devB", "devA"]);
  assert.equal(rows[0]!.platform, "win");
});

test("restore rows skip unparseable names and dedupe repeated tags", () => {
  const rows = buildRestoreRows([
    "pi_agent_windows11_20240101T120000Z.tar.xz", // 旧版命名
    "junk.txt",
    `devA-win-pi_20250102-030405.tar.xz`,
    `devA-win-pi_20250102-030405.tar.xz`, // 重复文件名
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.tags, ["pi"]);
});

test("device list is deduplicated in descending-time first-seen order", () => {
  const rows = buildRestoreRows([
    `devB-win-pi_20250601-000000.tar.xz`,
    `devA-win-pi_20250102-030405.tar.xz`,
    `devB-win-skills_20250101-000000.tar.xz`,
    `devB-win-pi_20250101-000000.tar.xz`,
  ]);
  assert.deepEqual(listRowDevices(rows), ["devB", "devA"]);
});

test("device filter keeps all rows for undefined and matches one device otherwise", () => {
  const rows = buildRestoreRows([
    `devA-win-pi_20250601-000000.tar.xz`,
    `devB-win-pi_20250102-030405.tar.xz`,
  ]);
  assert.equal(filterRowsByDevice(rows).length, 2);
  assert.deepEqual(filterRowsByDevice(rows, "devB").map((row) => row.device), ["devB"]);
  assert.deepEqual(filterRowsByDevice(rows, "missing"), []);
});
