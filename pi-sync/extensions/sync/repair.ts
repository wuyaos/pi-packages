/**
 * 跨平台配置修复（引擎层 + 面板）。
 *
 * 扫描 ~/.pi/agent 下的 settings.json / mcp.json / model-config.json，识别
 * 属于其他平台的值：
 * - Windows 特定：盘符路径（C:\ 或 C:/）、含路径分隔反斜杠、*.exe 二进制、
 *   shellPath 的 Windows shell（powershell/pwsh/cmd）
 * - POSIX 特定：/home、/Users、/root 开头的绝对路径、shellPath 的 POSIX shell
 *
 * ~/ 或 $VAR 开头视为可移植，不报。本机原生值不误报（值平台 == 当前平台跳过）。
 *
 * 修复动作分三类：
 * - auto：值位于当前平台家目录下，可从 homedir 反向映射为 ~/ 形式
 * - suggest：shellPath 清空，回退 Pi 默认
 * - manual：无法自动映射（如另一操作系统的绝对路径），列出原值人工编辑
 *
 * 幂等：修复后的值（~/、$VAR、空、本机原生）再次扫描为 0 项。
 *
 * Import: import { … } from "./repair"
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { platformCode, type PlatformCode } from "./archive-name";
import { AGENT_DIR } from "./config";
import { writeJsonAtomic } from "../_shared/json-io";
import { t, type SyncLanguage } from "./i18n";
import { multiSelect, type MultiSelectItem } from "./multi-select";

export type RepairFile = "settings.json" | "mcp.json" | "model-config.json";
export const REPAIR_FILES: readonly RepairFile[] = ["settings.json", "mcp.json", "model-config.json"];

export type IssueAction = "auto" | "suggest" | "manual";

export interface PlatformIssue {
  file: RepairFile;
  /** 文档内点分路径；数组下标为数字段。 */
  key: string;
  value: string;
  /** 值归属的平台。 */
  valuePlatform: PlatformCode;
  action: IssueAction;
  /** auto/suggest 的建议值；suggest 为 ""（清空用 Pi 默认）。 */
  suggested?: string;
}

export type RepairDocs = Partial<Record<RepairFile, unknown>>;

/**
 * 判断字符串值归属的平台；可移植值（空、~/、$VAR、无法判定）返回 null。
 * key 为点分路径，仅叶子字段名参与 shellPath 特判。
 */
export function classifyValuePlatform(value: string, key: string): PlatformCode | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("~") || trimmed.startsWith("$")) return null;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return "win";
  if (/\.exe$/i.test(trimmed)) return "win";
  if (/^\/(home|root|Users)\//.test(trimmed)) return "posix";
  const leaf = key.split(".").pop() ?? "";
  if (leaf === "shellPath") {
    if (/powershell|pwsh|\bcmd(\.exe)?$/i.test(trimmed)) return "win";
    if (/(^|[/\\])(bash|zsh|sh|fish|dash|ksh)$/i.test(trimmed)) return "posix";
    return null;
  }
  if (/[\\][A-Za-z0-9.]/.test(trimmed)) return "win";
  return null;
}

/**
 * 值位于本机家目录下时返回 "~/rest" 可移植形式（分隔符统一为 /）；
 * 否则返回 null。win 平台路径分隔与大小写不敏感。
 */
export function portableHomePath(value: string, homedir: string, platform: PlatformCode): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const norm = platform === "win" ? trimmed.replace(/\//g, "\\") : trimmed;
  const home = platform === "win" ? homedir.replace(/\//g, "\\") : homedir;
  if (!home) return null;
  const matches = platform === "win"
    ? norm.toLowerCase().startsWith(home.toLowerCase())
    : norm.startsWith(home);
  if (!matches) return null;
  const rest = norm.slice(home.length).replace(/^[\\/]+/, "");
  return rest ? `~/${rest.split(/[\\/]/).join("/")}` : "~";
}

/** 读取参与修复扫描的配置文档；文件缺失或损坏的跳过。 */
export function readRepairDocs(agentDir: string): RepairDocs {
  const docs: RepairDocs = {};
  for (const file of REPAIR_FILES) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, file), "utf8"));
      if (parsed && typeof parsed === "object") docs[file] = parsed;
    } catch {
      // 缺失/损坏的文件不参与扫描。
    }
  }
  return docs;
}

/**
 * 扫描文档中的跨平台值。platform 为当前运行平台：值平台等于它则不报
 * （本机原生）。字符串叶子（含数组元素）都参与扫描。
 */
export function scanPlatformIssues(
  docs: RepairDocs,
  platform: PlatformCode,
  homedir: string,
): PlatformIssue[] {
  const issues: PlatformIssue[] = [];
  for (const file of REPAIR_FILES) {
    walk(docs[file], "", file);
  }
  return issues;

  function walk(node: unknown, prefix: string, file: RepairFile): void {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, prefix ? `${prefix}.${index}` : String(index), file));
      return;
    }
    if (node && typeof node === "object") {
      for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, prefix ? `${prefix}.${name}` : name, file);
      }
      return;
    }
    if (typeof node !== "string") return;
    const valuePlatform = classifyValuePlatform(node, prefix);
    if (!valuePlatform) return;
    // 本机原生值不误报：win 值只在非 win 平台报；posix 值只在 win 平台报。
    if (valuePlatform === "win" && platform === "win") return;
    if (valuePlatform === "posix" && platform !== "win") return;
    const leaf = prefix.split(".").pop() ?? "";
    let action: IssueAction;
    let suggested: string | undefined;
    if (leaf === "shellPath") {
      action = "suggest";
      suggested = "";
    } else {
      const portable = portableHomePath(node, homedir, platform);
      if (portable !== null) {
        action = "auto";
        suggested = portable;
      } else {
        action = "manual";
      }
    }
    issues.push({ file, key: prefix, value: node, valuePlatform, action, suggested });
  }
}

const isIndexSegment = (segment: string): boolean => /^\d+$/.test(segment);

/** 按点分路径设置值；中间节点缺失时按下一段形态创建（数组或对象）。返回新根。 */
export function setValueAtPath(doc: unknown, keyPath: string, value: unknown): unknown {
  const segments = keyPath.split(".");
  const root: unknown = doc !== null && typeof doc === "object"
    ? (Array.isArray(doc) ? [...doc] : { ...(doc as Record<string, unknown>) })
    : (isIndexSegment(segments[0]!) ? [] : {});
  let node: Record<string, unknown> | unknown[] = root as Record<string, unknown> | unknown[];
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const existing = (node as Record<string, unknown>)[segment];
    const container: unknown = existing !== null && typeof existing === "object"
      ? (Array.isArray(existing) ? [...existing] : { ...(existing as Record<string, unknown>) })
      : (isIndexSegment(segments[i + 1]!) ? [] : {});
    (node as Record<string, unknown>)[segment] = container;
    node = container as Record<string, unknown> | unknown[];
  }
  (node as Record<string, unknown>)[segments.at(-1)!] = value;
  return root;
}

export interface RepairOutcome {
  fixed: number;
  skipped: number;
  manual: number;
  /** 发生了修改、需要写回的文件。 */
  changedFiles: Set<RepairFile>;
}

/**
 * 执行勾选的修复项：auto/suggest 直接写建议值；manual 调用 editValue
 * （取消/未改动计人工）。未勾选的 auto/suggest 计跳过，未勾选的 manual
 * 计人工。docs 对象被原地修改。
 */
export async function applyRepairSelections(
  docs: RepairDocs,
  issues: readonly PlatformIssue[],
  checkedIds: readonly string[],
  editValue?: (issue: PlatformIssue) => Promise<string | null | undefined>,
): Promise<RepairOutcome> {
  const outcome: RepairOutcome = { fixed: 0, skipped: 0, manual: 0, changedFiles: new Set() };
  for (let i = 0; i < issues.length; i += 1) {
    const issue = issues[i]!;
    const checked = checkedIds.includes(String(i));
    if (!checked) {
      if (issue.action === "manual") outcome.manual += 1;
      else outcome.skipped += 1;
      continue;
    }
    let nextValue: string | null | undefined = issue.suggested ?? "";
    if (issue.action === "manual") {
      nextValue = editValue ? await editValue(issue) : null;
      if (nextValue === null || nextValue === undefined || nextValue === issue.value) {
        outcome.manual += 1;
        continue;
      }
    }
    const doc = docs[issue.file];
    if (doc === undefined) continue;
    docs[issue.file] = setValueAtPath(doc, issue.key, nextValue);
    outcome.changedFiles.add(issue.file);
    outcome.fixed += 1;
  }
  return outcome;
}

function repairIssueLabel(language: SyncLanguage, issue: PlatformIssue): string {
  const target = issue.action === "auto"
    ? issue.suggested
    : issue.action === "suggest"
      ? t(language, "repairSuggestTarget")
      : t(language, "repairManualTarget");
  return `[${issue.file}] ${issue.key}: ${issue.value} → ${target}`;
}

/** 修复面板：扫描 → 勾选（auto 默认勾、manual 默认不勾）→ 执行 → 汇报。 */
export async function runRepair(
  ctx: ExtensionCommandContext,
  language: SyncLanguage,
  agentDir: string = AGENT_DIR,
): Promise<void> {
  const docs = readRepairDocs(agentDir);
  const issues = scanPlatformIssues(docs, platformCode(), os.homedir());
  if (issues.length === 0) {
    ctx.ui.notify(t(language, "repairNoIssues"), "info");
    return;
  }
  const items: MultiSelectItem[] = issues.map((issue, index) => ({
    id: String(index),
    label: repairIssueLabel(language, issue),
    checked: issue.action === "auto",
  }));
  const result = await multiSelect(ctx, t(language, "repairTitle"), items, t(language, "repairRunAction"));
  if (!result) return;
  const outcome = await applyRepairSelections(docs, issues, result.checked, async (issue) =>
    ctx.ui.input(t(language, "repairPromptValue", { key: issue.key }), issue.value));
  for (const file of outcome.changedFiles) {
    writeJsonAtomic(path.join(agentDir, file), docs[file], { backup: true });
  }
  ctx.ui.notify(t(language, "repairReport", {
    fixed: outcome.fixed,
    skipped: outcome.skipped,
    manual: outcome.manual,
  }), outcome.fixed > 0 ? "info" : "warning");
}
