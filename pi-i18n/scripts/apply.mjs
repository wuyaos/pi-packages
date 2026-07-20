#!/usr/bin/env node
/**
 * apply.mjs — 把翻译结果合并校验后写回 ~/.pi/agent/i18n.json。
 *
 * 固定流程，不调用任何模型：
 *   1. 读取翻译文件（命令行参数，默认 i18n.translated.json）
 *   2. 读取 snapshot 模板（i18n.template.json，由 /i18n-snapshot 导出）作为
 *      当前命令名权威集合，校验翻译的命令名是否齐全、无多余
 *   3. 与现有 i18n.json 合并（翻译覆盖旧值，保留未翻译项）
 *   4. 替换 ${APP_NAME} 占位符为实际 app 名
 *   5. 校验通过后原子写入 ~/.pi/agent/i18n.json
 *
 * 用法：
 *   node apply.mjs [翻译文件]    # 默认 i18n.translated.json
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "..");
const AGENT_DIR = join(homedir(), ".pi", "agent");
const I18N_PATH = join(AGENT_DIR, "i18n.json");
const TEMPLATE_PATH = join(AGENT_DIR, "i18n.template.json");

function fail(msg) {
  console.error(`[apply] ${msg}`);
  process.exit(1);
}

/** 从 pi 安装目录读取 APP_NAME（用于替换 ${APP_NAME} 占位符）。 */
function getAppName() {
  // 从 skill 目录向上找 node_modules
  for (let dir = SKILL_DIR; dir !== dirname(dir); dir = dirname(dir)) {
    const cfg = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "config.js");
    try {
      const src = readFileSync(cfg, "utf8");
      const m = src.match(/export\s+const\s+APP_NAME\s*=\s*[^;]*?"([^"]+)"/);
      if (m) return m[1];
    } catch {}
  }
  return "pi";
}

/** 替换 ${APP_NAME} 占位符。 */
function substitute(value, appName) {
  return value.replace(/\$\{APP_NAME\}/g, appName).replace(/\$APP_NAME/g, appName);
}

function main() {
  const inputFile = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : join(AGENT_DIR, "i18n.translated.json");

  if (!existsSync(inputFile)) {
    fail(`翻译文件不存在: ${inputFile}`);
  }

  let translated;
  try {
    translated = JSON.parse(readFileSync(inputFile, "utf8"));
  } catch (e) {
    fail(`翻译文件 JSON 解析失败：${e.message}`);
  }

  const translatedCmds = translated.commands || translated;
  if (typeof translatedCmds !== "object" || translatedCmds === null) {
    fail("翻译文件缺少 commands 对象");
  }

  // 读取 snapshot 模板作为命令名权威集合
  if (!existsSync(TEMPLATE_PATH)) {
    fail(`模板不存在: ${TEMPLATE_PATH}（请先在 pi 里运行 /i18n-translate）`);
  }
  let template;
  try {
    template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
  } catch (e) {
    fail(`模板解析失败：${e.message}`);
  }
  const currentNames = new Set(Object.keys(template.commands || {}));
  if (currentNames.size === 0) {
    fail("模板 commands 为空（请先运行 /i18n-snapshot）");
  }

  // 校验命令名一致性
  const translatedNames = new Set(Object.keys(translatedCmds));
  const missing = [...currentNames].filter((n) => !translatedNames.has(n));
  const extra = [...translatedNames].filter((n) => !currentNames.has(n));
  const empty = Object.entries(translatedCmds)
    .filter(([, v]) => typeof v !== "string" || v.trim() === "")
    .map(([k]) => k);

  if (missing.length > 0) {
    fail(`翻译缺少命令: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    console.warn(`[apply] 警告：翻译含未知命令（已忽略）: ${extra.join(", ")}`);
  }
  if (empty.length > 0) {
    fail(`翻译有空值: ${empty.join(", ")}`);
  }

  // 合并现有 i18n.json（保留未翻译项，翻译覆盖）
  let existing = { version: 1, commands: {} };
  if (existsSync(I18N_PATH)) {
    try {
      existing = JSON.parse(readFileSync(I18N_PATH, "utf8"));
      if (!existing.commands) existing.commands = {};
    } catch {
      console.warn("[apply] 警告：现有 i18n.json 解析失败，将覆盖");
    }
  }

  const appName = getAppName();
  // 只保留当前存在的命令名，丢弃已废弃的旧翻译；替换 ${APP_NAME}
  const merged = {};
  for (const name of currentNames) {
    if (typeof translatedCmds[name] === "string") {
      merged[name] = substitute(translatedCmds[name], appName);
    } else if (typeof existing.commands[name] === "string") {
      merged[name] = existing.commands[name];
    }
  }

  const result = { version: 1, commands: merged };

  // 原子写入
  mkdirSync(dirname(I18N_PATH), { recursive: true });
  const tmp = I18N_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(result, null, 2) + "\n", "utf8");
  renameSync(tmp, I18N_PATH);

  console.log(`[apply] 已写入 ${I18N_PATH}（${Object.keys(merged).length} 条翻译）`);
  console.log("[apply] 下次按 `/` 即可看到中文菜单（实时读文件，无需 reload）");
}

main();
