/**
 * pi-i18n — pi `/` 菜单汉化扩展。
 *
 * 单一命令流程：
 * 1. `/i18n-translate` 命令：合并 pi.getCommands()（扩展+prompt+skill）与
 *    内置 BUILTIN_SLASH_COMMANDS（静态解析 dist/core/slash-commands.js），
 *    导出所有命令英文原文到 ~/.pi/agent/i18n.template.json。
 * 2. 同一命令接着读 instructions/i18n-translate.md 正文，作为指令注入给
 *    当前会话模型，模型按指令完成翻译 + apply + validate。
 * 不注册 skill（package.json 无 pi.skills），故菜单只有 /i18n-translate 一个命令，
 * 不出现 /skill:i18n-translate。模板/翻译中间文件都在 ~/.pi/agent/，不污染
 * 用户项目或开发目录。
 *
 * autocomplete 包装：`/` 菜单触发时按命令名查 ~/.pi/agent/i18n.json，命中则
 * 替换 description 正文，保留 `[sourceTag]` 前缀。实时读文件（mtime 缓存），
 * 翻译完下次按 `/` 立即生效，无需 reload。
 *
 * 翻译数据格式（~/.pi/agent/i18n.json）：
 * { "version": 1, "commands": { "settings": "打开设置菜单", "skill:foo": "..." } }
 *
 * 脚本（固定流程，不调模型）：
 * - scripts/apply.mjs     校验 + 合并 + 替换 ${APP_NAME} + 写回 i18n.json
 * - scripts/validate.mjs  校验格式
 * snapshot 由 /i18n-translate 命令直接写文件，不需要脚本。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const I18N_PATH = join(AGENT_DIR, "i18n.json");
const TEMPLATE_PATH = join(AGENT_DIR, "i18n.template.json");
const __extDir = dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = join(__extDir, "..", "instructions", "i18n-translate.md");
const require = createRequire(import.meta.url);

interface I18nFile {
  version?: number;
  commands?: Record<string, string>;
}

/** 读 i18n.json，带 mtime 缓存，文件变化才重读。 */
const i18nCache: { mtime: number; data: I18nFile | null } = {
  mtime: -1,
  data: null,
};

function readI18n(): I18nFile | null {
  try {
    const st = statSync(I18N_PATH);
    const mtime = st.mtimeMs;
    if (mtime === i18nCache.mtime) return i18nCache.data;
    const raw = readFileSync(I18N_PATH, "utf8");
    const parsed = JSON.parse(raw) as I18nFile;
    i18nCache.mtime = mtime;
    i18nCache.data = parsed;
    return parsed;
  } catch {
    i18nCache.mtime = -1;
    i18nCache.data = null;
    return null;
  }
}

/** 判断是否为 `/` 命令补全场景（非文件路径、非 @ 补全）。 */
function isSlashCommandPrefix(prefix: string): boolean {
  if (!prefix.startsWith("/")) return false;
  if (prefix.indexOf(" ") !== -1) return false;
  return true;
}

/**
 * 替换 description 正文，保留 `[sourceTag]` 前缀。
 * 例："[u:git:x/y] Open settings menu" + 中文 → "[u:git:x/y] 打开设置菜单"
 * 无前缀则直接替换。
 */
function replaceDescriptionBody(origDesc: string | undefined, zh: string): string {
  if (!origDesc) return zh;
  const m = origDesc.match(/^\[(.+?)\]\s*(.*)$/s);
  if (m) {
    return `[${m[1]}] ${zh}`;
  }
  return zh;
}

/** 读取 SKILL.md 正文，去掉 YAML frontmatter。作为指令注入给模型。 */
function readSkillBody(): string {
  const raw = readFileSync(SKILL_FILE, "utf8");
  // 去掉开头 ---\n...\n---\n frontmatter
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) return raw.slice(end + 4).trimStart();
  }
  return raw.trim();
}

interface BuiltinCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/**
 * 静态提取内置 slash 命令（BUILTIN_SLASH_COMMANDS）。
 * pi.getCommands() 不返回内置命令，需解析 dist/core/slash-commands.js。
 * 通过 require.resolve 定位 pi 包路径。
 */
function getBuiltinCommands(): BuiltinCommand[] {
  try {
    // exports 只暴露 '.' 的 import 条件，用 ESM resolve（返回 URL）
    const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const entry = fileURLToPath(entryUrl);
    const slashFile = join(dirname(entry), "core", "slash-commands.js");
    const src = readFileSync(slashFile, "utf8");
    // 提取 BUILTIN_SLASH_COMMANDS = [ ... ] 数组体
    const m = src.match(/BUILTIN_SLASH_COMMANDS\s*=\s*\[([\s\S]*?)\];/);
    if (!m) return [];
    const body = m[1];
    const cmds: BuiltinCommand[] = [];
    // 匹配每个 { name: "...", description: `...` | "...", argumentHint?: "..." }
    const re = /\{\s*name:\s*"([^"]+)"(?:[^}]*?description:\s*(?:`[^`]*`|"[^"]*")[^}]*?)?(?:[^}]*?argumentHint:\s*"([^"]+)")?/g;
    let mm;
    while ((mm = re.exec(body)) !== null) {
      const name = mm[1];
      // 提取 description 值（模板字符串或普通字符串）
      const descMatch = mm[0].match(/description:\s*(`[^`]*`|"[^"]*")/);
      let desc: string | undefined;
      if (descMatch) {
        desc = descMatch[1].replace(/^[`"']|[`"']$/g, "");
      }
      cmds.push({ name, description: desc, argumentHint: mm[2] });
    }
    return cmds;
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  // ── 1. autocomplete 包装：汉化 `/` 菜单 ──────────────────────────
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (ctx.hasUI === false) return;

    ctx.ui.addAutocompleteProvider((current: AutocompleteProvider) => {
      const wrapped: AutocompleteProvider = {
        triggerCharacters: current.triggerCharacters,
        shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
        applyCompletion: current.applyCompletion.bind(current),
        async getSuggestions(
          lines: string[],
          cursorLine: number,
          cursorCol: number,
          options: { signal: AbortSignal; force?: boolean },
        ): Promise<AutocompleteSuggestions | null> {
          const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
          if (!result) return result;
          if (!isSlashCommandPrefix(result.prefix)) return result;

          const i18n = readI18n();
          const cmds = i18n?.commands;
          if (!cmds) return result;

          let changed = false;
          const items = result.items.map((it) => {
            const zh = cmds[it.value];
            if (!zh) return it;
            const newDesc = replaceDescriptionBody(it.description, zh);
            if (newDesc !== it.description) {
              changed = true;
              return { ...it, description: newDesc };
            }
            return it;
          });
          return changed ? { ...result, items } : result;
        },
      };
      return wrapped;
    });
  });

  // ── /i18n-translate 唯一命令：导出模板 + 自动触发模型翻译 ───────
  // 合并 pi.getCommands()（扩展+prompt+skill）与内置 BUILTIN_SLASH_COMMANDS
  // （静态解析），导出所有命令英文原文到 ~/.pi/agent/i18n.template.json，再读
  // instructions/i18n-translate.md 正文注入给当前会话模型完成翻译。一个命令
  // 全自动，菜单只显示本命令，无 /skill:i18n-translate。
  // 中间文件都在 ~/.pi/agent/，不污染用户项目或开发目录。
  pi.registerCommand("i18n-translate", {
    description: "翻译 pi 菜单：导出当前所有 / 命令原文并调用当前模型翻译",
    handler: async (_args, ctx) => {
      // 0. 前置检查
      if (!ctx.model) {
        ctx.ui.notify("请先选择模型（/model）再翻译", "error");
        return;
      }
      if (!existsSync(SKILL_FILE)) {
        ctx.ui.notify(`skill 指令文件不存在: ${SKILL_FILE}`, "error");
        return;
      }

      // 1. 导出 snapshot 模板：内置 + getCommands()（扩展+prompt+skill）
      const runtimeCmds = pi.getCommands();
      const builtins = getBuiltinCommands();
      // 合并：内置在前，扩展/prompt/skill 在后；去重（内置名优先）
      const seen = new Set<string>();
      const allCmds: { name: string; description?: string; source: string }[] = [];
      for (const b of builtins) {
        if (!seen.has(b.name)) {
          seen.add(b.name);
          allCmds.push({ name: b.name, description: b.description, source: "builtin" });
        }
      }
      for (const c of runtimeCmds) {
        if (!seen.has(c.name)) {
          seen.add(c.name);
          allCmds.push({ name: c.name, description: c.description, source: c.source });
        }
      }

      const template = {
        version: 1,
        _comment:
          "翻译模板：把每条 description 译成中文，name 不要改。[sourceTag] 前缀是自动加的，不要出现在翻译里。运行 apply.mjs 写回 i18n.json。",
        snapshotAt: new Date().toISOString(),
        count: allCmds.length,
        commands: Object.fromEntries(
          allCmds
            .filter((c) => c.description)
            .map((c) => [c.name, c.description]),
        ),
        sources: Object.fromEntries(
          allCmds.map((c) => [c.name, c.source]),
        ),
      };

      mkdirSync(dirname(TEMPLATE_PATH), { recursive: true });
      writeFileSync(TEMPLATE_PATH, JSON.stringify(template, null, 2) + "\n", "utf8");

      const withDesc = Object.keys(template.commands).length;
      ctx.ui.notify(
        `已导出 ${allCmds.length} 条命令（${withDesc} 条有描述）→ ${TEMPLATE_PATH}`,
        "info",
      );

      // 2. 读指令正文，作为指令注入给当前模型触发翻译流程
      ctx.ui.notify("开始翻译，请稍候…", "info");
      const body = readSkillBody();
      const scriptsDir = join(__extDir, "..", "scripts");
      const prompt =
        body +
        "\n\n## 运行环境（由命令注入）\n" +
        `- 模板：${TEMPLATE_PATH}\n` +
        `- 翻译输出：${join(AGENT_DIR, "i18n.translated.json")}\n` +
        `- 应用脚本：${join(scriptsDir, "apply.mjs")}\n` +
        `- 校验脚本：${join(scriptsDir, "validate.mjs")}\n` +
        `- 用上面这些绝对路径调用脚本，不要用相对路径或 cwd 猜测`;
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    },
  });
}
