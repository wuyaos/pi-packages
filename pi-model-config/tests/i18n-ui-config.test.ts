import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatError, mcError, normalizeUiLanguage, t } from "../src/i18n.ts";
import { loadUiLanguage, saveUiLanguage, uiPreferencesPath } from "../src/ui-config.ts";
import { sanitizeError } from "../src/config.ts";

test("中英文字典独立格式化且稳定错误码不随语言变化", () => {
  assert.equal(normalizeUiLanguage("en"), "en");
  assert.equal(normalizeUiLanguage("fr"), "zh-CN");
  assert.equal(t("zh-CN", "previewModelsAdded", { items: "聊天/a" }), "添加模型：聊天/a");
  assert.equal(t("en", "previewModelsAdded", { items: "Chat/a" }), "Add models: Chat/a");

  const error = mcError("MCFG_E_PAGINATION", { reason: "has_more=true" });
  assert.match(formatError("zh-CN", error), /^\[MCFG_E_PAGINATION\].*分页暂不支持/u);
  assert.match(formatError("en", error), /^\[MCFG_E_PAGINATION\].*pagination is unsupported/iu);
});

test("error sanitization redacts full Authorization schemes, JSON keys, queries, and active secrets", () => {
  const message = [
    "authorization: Bearer bearer-secret",
    "Authorization=Basic basic-secret",
    '{"authorization":"Bearer json-secret","api_key":"json-key"}',
    "https://example.test/path?token=query-secret",
    "literal-active",
  ].join(" | ");
  const sanitized = sanitizeError(new Error(message), ["literal-active"]);
  for (const secret of ["bearer-secret", "basic-secret", "json-secret", "json-key", "query-secret", "literal-active"]) {
    assert.doesNotMatch(sanitized, new RegExp(secret, "u"));
  }
  assert.match(sanitized, /\[REDACTED\]/u);
});

test("UI 语言偏好只写独立文件，不触碰模型配置快照", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-i18n-"));
  try {
    const modelsPath = join(dir, "models.json");
    const configPath = join(dir, "model-config.json");
    const modelsBefore = "{\"sentinel\":\"models\"}\n";
    const configBefore = "{\"sentinel\":\"config\"}\n";
    writeFileSync(modelsPath, modelsBefore);
    writeFileSync(configPath, configBefore);

    assert.equal(loadUiLanguage(dir), "zh-CN");
    assert.equal(existsSync(uiPreferencesPath(dir)), false);
    saveUiLanguage(dir, "en");

    assert.equal(loadUiLanguage(dir), "en");
    assert.deepEqual(JSON.parse(readFileSync(uiPreferencesPath(dir), "utf8")), { version: 1, language: "en" });
    assert.equal(readFileSync(modelsPath, "utf8"), modelsBefore);
    assert.equal(readFileSync(configPath, "utf8"), configBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏或未知语言偏好安全回退中文且不重写文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-i18n-invalid-"));
  try {
    const path = uiPreferencesPath(dir);
    writeFileSync(path, "{\"version\":1,\"language\":\"de\",\"keep\":true}\n");
    const before = readFileSync(path, "utf8");
    assert.equal(loadUiLanguage(dir), "zh-CN");
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
