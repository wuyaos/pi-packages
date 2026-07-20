#!/usr/bin/env node
/**
 * validate.mjs — 校验 ~/.pi/agent/i18n.json 格式与命令名一致性。
 *
 * 固定流程，不调用任何模型：
 *   - 校验文件存在、可解析、结构正确（version + commands 对象）
 *   - 校验每个值是非空字符串
 *   - 校验命令名与 snapshot 模板（i18n.template.json）一致
 *
 * 用法：
 *   node validate.mjs [i18n.json 路径]    # 默认 ~/.pi/agent/i18n.json
 * 退出码：0 通过，1 失败。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "..");
const AGENT_DIR = join(homedir(), ".pi", "agent");
const DEFAULT_PATH = join(AGENT_DIR, "i18n.json");
const TEMPLATE_PATH = join(AGENT_DIR, "i18n.template.json");

function fail(msg) {
  console.error(`[validate] ✗ ${msg}`);
  process.exit(1);
}

/** 从 snapshot 模板读当前命令名集合。 */
function getCurrentCommandNames() {
  if (!existsSync(TEMPLATE_PATH)) {
    fail(`模板不存在: ${TEMPLATE_PATH}（请先在 pi 里运行 /i18n-translate）`);
  }
  try {
    const data = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    return new Set(Object.keys(data.commands || {}));
  } catch (e) {
    fail(`模板解析失败：${e.message}`);
  }
}

function main() {
  const target = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : DEFAULT_PATH;

  if (!existsSync(target)) fail(`文件不存在: ${target}`);

  let data;
  try {
    data = JSON.parse(readFileSync(target, "utf8"));
  } catch (e) {
    fail(`JSON 解析失败：${e.message}`);
  }

  if (typeof data !== "object" || data === null) fail("根不是对象");
  if (typeof data.commands !== "object" || data.commands === null) {
    fail("缺少 commands 对象");
  }

  const cmds = data.commands;
  const names = Object.keys(cmds);
  if (names.length === 0) fail("commands 为空");

  let errors = 0;
  for (const [k, v] of Object.entries(cmds)) {
    if (typeof v !== "string" || v.trim() === "") {
      console.error(`[validate] ✗ ${k}: 值为空或非字符串`);
      errors++;
    }
  }

  const current = getCurrentCommandNames();
  const missing = [...current].filter((n) => !(n in cmds));
  const extra = names.filter((n) => !current.has(n));

  if (missing.length > 0) {
    console.error(`[validate] ✗ 缺失命令翻译: ${missing.join(", ")}`);
    errors++;
  }
  if (extra.length > 0) {
    console.warn(`[validate] ○ 多余条目（可忽略）: ${extra.join(", ")}`);
  }

  if (errors > 0) fail(`共 ${errors} 项错误`);

  console.log(`[validate] ✓ 通过：${names.length} 条翻译，格式正确，命令名一致`);
}

main();
