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
 * - auto：可确定的目标 home 形式（本机家目录、恢复 meta 的源 home、或
 *   保守模式识别的 .pi/.agents/.config 前缀），改写为可移植 ~/ 形式
 * - suggest：shellPath 清空回退默认；mcp.json command 去 win 后缀
 *   （node.exe→node）或剥离 cmd /c 包装
 * - manual：无法自动映射（如另一操作系统的绝对路径、WSL 路径、posix
 *   command 在 win 上），列出原值人工编辑
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
  /** 数组值（mcp.json command 数组）为 JSON 编码文本。 */
  value: string;
  /** 值归属的平台。 */
  valuePlatform: PlatformCode;
  action: IssueAction;
  /** auto/suggest 的建议值；suggest 为 ""（清空用 Pi 默认）；数组值为 JSON 编码。 */
  suggested?: string;
  /** value/suggested 为 JSON 编码的字符串数组（mcp.json command 数组）。 */
  isArrayValue?: boolean;
  /** WSL 路径（\\wsl$\、\\wsl.localhost\、/mnt/x/），只报不改。 */
  wsl?: boolean;
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
  if (/\.(exe|cmd|bat)$/i.test(trimmed)) return "win";
  if (/^\\\\wsl(\$|\.localhost)/i.test(trimmed)) return "win";
  if (/^\/(home|root|Users)\//.test(trimmed)) return "posix";
  if (/^\/mnt\/[a-z]\//i.test(trimmed)) return "posix";
  const leaf = key.split(".").pop() ?? "";
  if (leaf === "shellPath") {
    if (/powershell|pwsh|\bcmd(\.exe)?$/i.test(trimmed)) return "win";
    if (/(^|[/\\])(bash|zsh|sh|fish|dash|ksh)$/i.test(trimmed)) return "posix";
    return null;
  }
  if (/[\\][A-Za-z0-9.]/.test(trimmed)) return "win";
  return null;
}

/** WSL 路径识别：win 值的 \\wsl$\ 与 \\wsl.localhost\，posix 值的 /mnt/x/。 */
export function isWslPath(value: string, valuePlatform: PlatformCode): boolean {
  const trimmed = value.trim();
  if (valuePlatform === "win") return /^\\\\wsl(\$|\.localhost)/i.test(trimmed);
  return /^\/mnt\/[a-z]\//i.test(trimmed);
}

/**
 * 值位于本机家目录下时返回 "~/rest" 可移植形式（分隔符统一为 /）；
 * 否则返回 null。win 平台路径分隔与大小写不敏感。提供 sourceHome
 * （恢复时 manifest meta 的源家目录）时，值以它开头同样映射为 ~/rest
 * ——目标即当前机器的家目录（可移植形式）。
 */
export function portableHomePath(
  value: string,
  homedir: string,
  platform: PlatformCode,
  sourceHome?: string,
): string | null {
  if (sourceHome) {
    // 源 home 模式按值自身平台的分隔符/大小写规则归一。
    const viaSource = matchHomePrefix(value, sourceHome, platform);
    if (viaSource !== null) return viaSource;
  }
  return matchHomePrefix(value, homedir, platform);
}

function matchHomePrefix(value: string, home: string, platform: PlatformCode): string | null {
  const trimmed = value.trim();
  if (!trimmed || !home) return null;
  const norm = platform === "win" ? trimmed.replace(/\//g, "\\") : trimmed;
  const homeNorm = platform === "win" ? home.replace(/\//g, "\\") : home;
  const matches = platform === "win"
    ? norm.toLowerCase().startsWith(homeNorm.toLowerCase())
    : norm.startsWith(homeNorm);
  if (!matches) return null;
  const rest = norm.slice(homeNorm.length).replace(/^[\\/]+/, "");
  return rest ? `~/${rest.split(/[\\/]/).join("/")}` : "~";
}

/**
 * 模式识别 B（无 manifest meta 时的保守回落）：值以另一台机器的用户
 * home 前缀开头（C:\Users\x\、/home/x/、/Users/x/），且余下部分以
 * .pi/、.agents/、.config/ 开头（Pi/agent 配置的固定位置）才给 auto；
 * 其余返回 null（由调用方计 manual）。
 */
export function fallbackHomePortable(value: string, valuePlatform: PlatformCode): string | null {
  const trimmed = value.trim();
  const match = valuePlatform === "win"
    ? /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)([\\/].+)$/i.exec(trimmed.replace(/\//g, "\\"))
    : /^((?:\/home|\/Users)\/[^/]+)(\/.+)$/.exec(trimmed);
  if (!match) return null;
  const rest = match[2]!.slice(1).split(/[\\/]/).join("/");
  if (!/^\.(?:pi|agents|config)(?:\/|$)/.test(rest)) return null;
  return `~/${rest}`;
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

/** mcp.json 的 command 字段（字符串叶子或字符串数组）参与命令名映射。 */
function isCommandKey(file: RepairFile, keyPath: string): boolean {
  return file === "mcp.json" && /(^|\.)command$/.test(keyPath);
}

/**
 * win 命令名的 suggest 形式：剥离 cmd /c 包装与可执行后缀
 * （node.exe→node、npx.cmd→npx、*.bat 同）。
 */
function suggestCommandString(value: string): string {
  const stripped = value.trim().replace(/^cmd(\.exe)?[ \t]+\/c[ \t]+/i, "");
  // 去 首 个 token（命令名）的可执行后缀；单 token 即整串。
  const spaceIdx = stripped.search(/[ \t]/);
  const head = spaceIdx === -1 ? stripped : stripped.slice(0, spaceIdx);
  const headStripped = head.replace(/\.(exe|cmd|bat)$/i, "");
  return spaceIdx === -1 ? headStripped : headStripped + stripped.slice(spaceIdx);
}

function parseStringArray(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every((el) => typeof el === "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

/**
 * 扫描文档中的跨平台值。platform 为当前运行平台：值平台等于它则不报
 * （本机原生）。字符串叶子（含数组元素）都参与扫描。sourceHome 为恢复
 * 时 manifest meta 的源家目录（修复命令独立运行时不传，回落模式识别）。
 */
export function scanPlatformIssues(
  docs: RepairDocs,
  platform: PlatformCode,
  homedir: string,
  sourceHome?: string,
): PlatformIssue[] {
  const issues: PlatformIssue[] = [];
  for (const file of REPAIR_FILES) {
    walk(docs[file], "", file);
  }
  return issues;

  function walk(node: unknown, prefix: string, file: RepairFile): void {
    if (Array.isArray(node)) {
      // mcp.json command 数组整体评估（cmd /c 剥离涉及多元素），不下钻。
      if (isCommandKey(file, prefix) && node.length > 0 && node.every((el) => typeof el === "string")) {
        assessCommandArray(node as string[], prefix, file);
        return;
      }
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
    let valuePlatform = classifyValuePlatform(node, prefix);
    // 字符串形式的 cmd /c 包装是 win 特有命令写法。
    if (!valuePlatform && isCommandKey(file, prefix) && /^cmd(\.exe)?([ \t]|$)/i.test(node.trim())) {
      valuePlatform = "win";
    }
    if (!valuePlatform) return;
    // 本机原生值不误报：win 值只在非 win 平台报；posix 值只在 win 平台报。
    if (valuePlatform === "win" && platform === "win") return;
    if (valuePlatform === "posix" && platform !== "win") return;
    // WSL 路径不 auto 改写（目标发行版/挂载未知），只报 manual。
    if (isWslPath(node, valuePlatform)) {
      issues.push({ file, key: prefix, value: node, valuePlatform, action: "manual", wsl: true });
      return;
    }
    const leaf = prefix.split(".").pop() ?? "";
    const command = isCommandKey(file, prefix);
    let action: IssueAction;
    let suggested: string | undefined;
    if (leaf === "shellPath") {
      action = "suggest";
      suggested = "";
    } else if (command && valuePlatform === "win") {
      // win 命令名在非 win 平台：去后缀/剥 cmd /c 后仍可读，建议而非手工。
      action = "suggest";
      suggested = suggestCommandString(node);
    } else if (command) {
      // posix 命令名在 win：不确定目标 shell，列人工。
      action = "manual";
    } else {
      const portable = portableHomePath(node, homedir, platform, sourceHome);
      if (portable !== null) {
        action = "auto";
        suggested = portable;
      } else {
        const fallback = fallbackHomePortable(node, valuePlatform);
        if (fallback !== null) {
          action = "auto";
          suggested = fallback;
        } else {
          action = "manual";
        }
      }
    }
    issues.push({ file, key: prefix, value: node, valuePlatform, action, suggested });
  }

  function assessCommandArray(elements: string[], prefix: string, file: RepairFile): void {
    const first = elements[0]!;
    const jsonValue = JSON.stringify(elements);
    let valuePlatform = classifyValuePlatform(first, "command");
    if (!valuePlatform && /^cmd(\.exe)?$/i.test(first.trim())) valuePlatform = "win";
    if (!valuePlatform) return;
    if (valuePlatform === "win" && platform === "win") return;
    if (valuePlatform === "posix" && platform !== "win") return;
    const base = { file, key: prefix, value: jsonValue, valuePlatform, isArrayValue: true } as const;
    if (isWslPath(first, valuePlatform)) {
      issues.push({ ...base, action: "manual", wsl: true });
      return;
    }
    if (valuePlatform === "posix") {
      // posix 命令在 win：不确定目标 shell。
      issues.push({ ...base, action: "manual" });
      return;
    }
    // win 命令数组在非 win 平台：剥离 cmd /c 包装，再给首元素去后缀。
    let rest = elements.slice();
    if (/^cmd(\.exe)?$/i.test(rest[0]!.trim()) && rest.length >= 2 && /^\/c$/i.test(rest[1]!.trim())) {
      rest = rest.slice(2);
    }
    if (rest.length === 0 || !rest[0]) {
      issues.push({ ...base, action: "manual" });
      return;
    }
    rest[0] = suggestCommandString(rest[0]!);
    if (!rest[0]) {
      issues.push({ ...base, action: "manual" });
      return;
    }
    issues.push({ ...base, action: "suggest", suggested: JSON.stringify(rest) });
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
    let nextValue: string | string[] | null | undefined = issue.suggested ?? "";
    if (issue.action === "manual") {
      nextValue = editValue ? await editValue(issue) : null;
      if (nextValue === null || nextValue === undefined || nextValue === issue.value) {
        outcome.manual += 1;
        continue;
      }
      if (issue.isArrayValue) {
        const parsed = parseStringArray(nextValue);
        if (!parsed) {
          outcome.manual += 1;
          continue;
        }
        nextValue = parsed;
      }
    } else if (issue.isArrayValue) {
      const parsed = parseStringArray(issue.suggested ?? "");
      if (!parsed) {
        outcome.manual += 1;
        continue;
      }
      nextValue = parsed;
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
  const actionBadge = t(language,
    issue.action === "auto" ? "repairActionAuto"
      : issue.action === "suggest" ? "repairActionSuggest"
      : "repairActionManual");
  const target = issue.action === "auto"
    ? issue.suggested
    : issue.action === "suggest"
      ? t(language, "repairSuggestTarget")
      : t(language, "repairManualTarget");
  const wslSuffix = issue.wsl ? ` ⚠ ${t(language, "repairWslWarn")}` : "";
  return `[${actionBadge}] [${issue.file}] ${issue.key}: ${issue.value} → ${target}${wslSuffix}`;
}

/**
 * 修复面板：扫描 → 勾选（auto 默认勾、manual 默认不勾）→ 执行 → 汇报。
 * sourceHome 为恢复时 manifest meta 的源家目录；修复命令独立运行时不传。
 */
export async function runRepair(
  ctx: ExtensionCommandContext,
  language: SyncLanguage,
  agentDir: string = AGENT_DIR,
  sourceHome?: string,
): Promise<void> {
  const docs = readRepairDocs(agentDir);
  const issues = scanPlatformIssues(docs, platformCode(), os.homedir(), sourceHome);
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
