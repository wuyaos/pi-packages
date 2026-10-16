import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMainMenuItems, formatRestoreRow } from "./menus.ts";

test("main menu exposes the five top-level actions in both languages", () => {
  const english = buildMainMenuItems("en");
  const chinese = buildMainMenuItems("zh");
  const expected = ["backup", "restore", "repair", "settings", "quit"];
  assert.deepEqual(english.map((item) => item.id), expected);
  assert.deepEqual(chinese.map((item) => item.id), expected);
  assert.equal(new Set(english.map((item) => item.label)).size, expected.length);
  assert.notEqual(english[0]!.label, chinese[0]!.label);
});

test("restore rows show only device, platform, time, and local badge (no category labels)", () => {
  const ts = new Date("2025-01-02T03:04:05Z");
  const row = {
    device: "devA",
    platform: "win" as const,
    ts,
    tags: ["pi", "skills"] as ("pi" | "skills" | "cortexkit")[],
    files: { pi: "devA-win-pi_x.tar.xz", skills: "devA-win-skills_x.tar.xz" },
  };
  const local = formatRestoreRow("zh", row, "devA");
  assert.ok(local.startsWith("devA  Windows  2025-01-02 "), local);
  assert.ok(local.endsWith("［本机］"), local);
  assert.ok(!local.includes("Pi") && !local.includes("Skills") && !local.includes("Magic"), "行文案不得包含类别标签");
  const foreign = formatRestoreRow("en", row, "devB");
  assert.equal(foreign, `devA  Windows  ${local.slice("devA  Windows  ".length, -"  ［本机］".length)}`);
  assert.ok(!foreign.includes("localBadge") && !foreign.includes("[local]"));
});
