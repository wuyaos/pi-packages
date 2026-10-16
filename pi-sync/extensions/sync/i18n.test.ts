import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLanguage, t } from "./i18n.ts";

test("normalizeLanguage recognizes Chinese locale variants and defaults to English", () => {
  assert.equal(normalizeLanguage("zh-CN"), "zh");
  assert.equal(normalizeLanguage("ZH-TW"), "zh");
  assert.equal(normalizeLanguage("en-US"), "en");
  assert.equal(normalizeLanguage(undefined), "en");
});

test("translations interpolate named parameters in both languages", () => {
  assert.equal(t("en", "maxCloudBackups", { value: 10 }), "Max Cloud Backups: 10");
  assert.equal(t("zh", "repairReport", { fixed: 2, skipped: 1, manual: 3 }), "已修复 2 · 跳过 1 · 待人工 3");
});
