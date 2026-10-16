import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMainMenuItems } from "./menus.ts";

test("main menu exposes the five top-level actions in both languages", () => {
  const english = buildMainMenuItems("en");
  const chinese = buildMainMenuItems("zh");
  const expected = ["backup", "restore", "repair", "settings", "quit"];
  assert.deepEqual(english.map((item) => item.id), expected);
  assert.deepEqual(chinese.map((item) => item.id), expected);
  assert.equal(new Set(english.map((item) => item.label)).size, expected.length);
  assert.notEqual(english[0]!.label, chinese[0]!.label);
});
