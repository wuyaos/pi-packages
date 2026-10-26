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

test("restore rows include category labels after time; local badge last", () => {
  const ts = new Date("2025-01-02T03:04:05Z");
  const row = {
    device: "devA",
    platform: "win" as const,
    ts,
    tags: ["pi", "skills"] as ("pi" | "skills")[],
    files: { pi: "devA-win-pi_x.tar.xz", skills: "devA-win-skills_x.tar.xz" },
  };
  const local = formatRestoreRow("zh", row, "devA");
  assert.ok(local.startsWith("devA  Windows  2025-01-02 "), local);
  assert.ok(local.includes("Pi+Skills") || (local.includes("Pi") && local.includes("Skills")), local);
  assert.ok(local.endsWith("［本机］"), local);
  const foreign = formatRestoreRow("en", row, "devB");
  assert.ok(foreign.includes("Pi config") || foreign.includes("Pi"), foreign);
  assert.ok(!foreign.includes("［本机］") && !foreign.includes("[local]"));
});
