/**
 * pi-tool-gate — 按需工具开关扩展。
 *
 * 目标：把重 schema 工具默认 inactive，需要时激活，降低每轮请求 tools[] 的固定 token 占用。
 * 提供两套入口：
 *   1. gate_tools loader 工具 —— 模型自取（当前工具不够时调用，搜索并增量激活已注册但未启用的工具）
 *   2. /tool-gate 命令 —— 用户手动管（开关/列表/统计/profile/reset）
 *
 * 核心不变式：
 *   1. 单源真相：激活集 A = 全部工具中（不在 D 中 或 在 P 中）的那些 ∪ sessionGranted ∪ HARDCODED_PROTECTED。
 *      D = config.disabled ∪ config.userDisabled，P = config.protected ∪ HARDCODED_PROTECTED
 *   2. applyGate 幂等：每次从 getAllTools() + config + sessionGranted 重算，不依赖前一次 active 状态
 *   3. P 永远 ⊆ A：protected 工具即使写进 disabled 也会被捞回；HARDCODED_PROTECTED 是硬底线不可移除
 *   4. off all 永远跳过 P ∪ HARDCODED_PROTECTED
 *   5. 若计算后 A 为空 → 回退到"全开"，配置损坏不锁死
 *   6. tool-gate 命令本身不依赖任何被 gate 的工具（registerCommand 不在 getAllTools 里）
 *   7. gate_tools loader 激活必须 additive：不能在同一 setActiveTools 调用里移除当前 active 工具
 *   8. loader 只能激活"默认 disabled 但不在 userDisabled"的工具；用户显式 off 的不会被 loader 恢复
 *   9. sessionGranted 生命周期：session_start 清空，loader 调用时加入，
 *      before_agent_start/model_select/session_compact 重应用时保留；
 *      用户 off/reset/profile 时同步 delete/clear，确保授予的工具可被关掉
 *      （applyGate 也会二次校验：disabledSet 中的 sessionGranted 不回加）
 *
 * 应用时机（四道闸，幂等）：
 *   - session_start：清空 sessionGranted 后首次应用
 *   - before_agent_start：每轮 agent 启动前重应用（防抖比对实际 active 与 target）
 *   - model_select / session_compact：外部 reset 后重应用（sessionGranted 保留）
 *   - 手动命令后立即应用
 * 防抖：比对 pi.getActiveTools() 与 target 的签名 —— 相同则跳过 setActiveTools（保 cache）；
 *       外部 reset 后实际≠target 则重应用。
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── 配置路径 ────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "config");
const CONFIG_PATH = path.join(CONFIG_DIR, "tool-gate.json");

// ── 默认 disabled 名单（重 schema 工具）────────────────────────────────
const DEFAULT_DISABLED: string[] = [
  "subagent", "subagent_wait",
  "image_gen", "image_review", "tg_attach",
  "process_thought", "sequential_think", "generate_summary",
  "clear_history", "export_session", "import_session",
  "get_thinking_history", "get_thinking_status",
  "advisor", "skill_manage",
  "create_goal", "update_goal", "get_goal",
  "list_models", "use_role",
  "list", "info", "exec", "transfer", "get-result", "grep-result", "write-stdin", "cancel", "sleep",
];

// ── protected 名单（永不关：内置核心 + gate_tools 自身）─────────────────
const DEFAULT_PROTECTED: string[] = [
  "read", "write", "edit", "bash", "grep", "find", "ls", "ffgrep", "fffind",
  "gate_tools",
];

// ── 硬底线 protected：无论 config.protected 怎么配，这四个内置核心工具永远在 target 里 ──
const HARDCODED_PROTECTED = new Set(["read", "write", "edit", "bash"]);

// ── 配置类型 ────────────────────────────────────────────────────────────
interface ToolGateConfig {
  disabled: string[];      // 默认 disabled 名单（reset 写回 DEFAULT_DISABLED）
  userDisabled: string[];  // 用户显式 /tool-gate off 的工具（loader 不可激活）
  protected: string[];
  profiles: Record<string, string[]>;
}

// ── 模块级状态 ──────────────────────────────────────────────────────────
// 运行时 loader 激活的工具集：session_start 清空，loader 调用时加入，每轮重应用时保留
let sessionGranted: Set<string> = new Set();

/** 读取配置；文件不存在或 JSON 损坏时回退默认配置并尝试写回。 */
function loadConfig(): ToolGateConfig {
  const fallback: ToolGateConfig = {
    disabled: [...DEFAULT_DISABLED],
    userDisabled: [],
    protected: [...DEFAULT_PROTECTED],
    profiles: {},
  };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled.filter((x: unknown) => typeof x === "string") : [...DEFAULT_DISABLED],
      userDisabled: Array.isArray(parsed.userDisabled) ? parsed.userDisabled.filter((x: unknown) => typeof x === "string") : [],
      protected: Array.isArray(parsed.protected) ? parsed.protected.filter((x: unknown) => typeof x === "string") : [...DEFAULT_PROTECTED],
      profiles: (parsed.profiles && typeof parsed.profiles === "object" && !Array.isArray(parsed.profiles)) ? parsed.profiles : {},
    };
  } catch {
    // 文件不存在或 JSON 损坏：写回默认配置，不崩
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(fallback, null, 2), "utf8");
    } catch {
      // 写失败也无所谓，内存里用 fallback
    }
    return fallback;
  }
}

/** 持久化配置；失败只 console.error，不 throw。 */
function persistConfig(cfg: ToolGateConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    console.error("[pi-tool-gate] persist config failed:", e);
  }
}

/** 计算签名（排序后 join，用于防抖比对）。 */
function sigOf(names: string[]): string {
  return [...names].sort().join(",");
}

/**
 * 应用 gate：根据 config 重算激活集并 setActiveTools。幂等 + 防抖。
 * A = 全部工具中（不在 D 中 或 在 P 中）的那些。
 * 若 A 为空 → 回退全开。
 */
function applyGate(pi: ExtensionAPI): void {
  try {
    const cfg = loadConfig();
    // disabled = 默认名单 ∪ 用户显式 off；protected = config ∪ 硬底线
    const disabledSet = new Set([...cfg.disabled, ...cfg.userDisabled]);
    const protectedSet = new Set([...cfg.protected, ...HARDCODED_PROTECTED]);

    const allTools: string[] = pi.getAllTools().map((t: any) => t.name);
    const allSet = new Set<string>(allTools);

    // 激活集 = 全部工具中（不在 disabled 或 在 protected）的 ∪ sessionGranted
    const activeSet = new Set<string>(
      allTools.filter((name) => !disabledSet.has(name) || protectedSet.has(name)),
    );
    // loader 运行时激活的工具也保留，但不可绕过用户显式 off（userDisabled）
    // 注意：只检查 userDisabled，不检查 cfg.disabled——cfg.disabled 正是 loader 要激活的默认名单
    // protected 例外（虽然 protected 本就被主 filter 保留，此处冗余保险）
    const userDisabledSet = new Set(cfg.userDisabled);
    for (const name of sessionGranted) {
      if (allSet.has(name) && (!userDisabledSet.has(name) || protectedSet.has(name))) activeSet.add(name);
    }
    const active = [...activeSet];

    // 不变式 5：A 为空 → 回退全开
    let target = active;
    if (active.length === 0) {
      target = [...allTools];
    }

    // 防抖：比对当前实际 active 集，相同则跳过（保 cache，外部 reset 后实际≠target 则重应用）
    const targetSig = sigOf(target);
    if (sigOf(pi.getActiveTools()) === targetSig) return;

    pi.setActiveTools(target);
  } catch (e) {
    console.error("[pi-tool-gate] applyGate failed:", e);
  }
}

/**
 * 手动命令/外部事件后重应用。防抖比对实际 active 与 target，
 * target 变化时 applyGate 自然重应用，无需强制跳过。
 */
function forceApplyGate(pi: ExtensionAPI): void {
  applyGate(pi);
}

// ── gate_tools loader 工具 ──────────────────────────────────────────────
function registerGateTools(pi: ExtensionAPI): void {
  try {
    pi.registerTool({
      name: "gate_tools",
      label: "Gate Tools",
      description:
        "搜索并激活已注册但当前未启用的工具。当当前可用工具不足以完成任务时调用此工具。" +
        "传入关键词匹配工具名和描述；activate=true（默认）会增量激活匹配工具使其在下一轮可用，" +
        "activate=false 只列出不激活。query=\"*\" 列出所有 gated 工具。",
      promptSnippet: "当前工具不够用时，调用 gate_tools 搜索并激活已注册但未启用的工具",
      promptGuidelines: [
        "当任务需要当前不可用的能力时，调用 gate_tools 搜索并激活相应工具；激活后该工具在下一轮可用。",
        "gate_tools 的激活是增量式的，不会移除当前已启用的工具。",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词，匹配工具名和描述；\"*\" 列出所有 gated 工具" }),
        activate: Type.Optional(Type.Boolean({ description: "是否激活匹配的工具，默认 true；false 只列出", default: true })),
        limit: Type.Optional(Type.Integer({ description: "返回数量上限，默认 10", minimum: 1, maximum: 50, default: 10 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        try {
          const query: string = params.query ?? "";
          const activate: boolean = params.activate !== false; // 默认 true
          const limit: number = params.limit ?? 10;

          const allTools = pi.getAllTools();
          const currentActive = pi.getActiveTools();
          const activeSet = new Set(currentActive);

          const cfg = loadConfig();
          const protectedSet = new Set([...cfg.protected, ...HARDCODED_PROTECTED]);
          const userDisabledSet = new Set(cfg.userDisabled);

          // gated 候选 = 全部 - active - protected - userDisabled
          // 语义：loader 只能激活"默认 disabled 但用户没显式 off"的工具；用户显式 off 的不会被 loader 恢复
          const gatedCandidates = allTools.filter(
            (t) => !activeSet.has(t.name) && !protectedSet.has(t.name) && !userDisabledSet.has(t.name),
          );

          // 匹配
          let matches = gatedCandidates;
          if (query !== "*") {
            const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
            matches = gatedCandidates
              .map((t) => ({
                tool: t,
                score: terms.reduce(
                  (s, term) =>
                    s + (`${t.name} ${t.description ?? ""}`.toLowerCase().includes(term) ? 1 : 0),
                  0,
                ),
              }))
              .filter((m) => m.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, limit)
              .map((m) => m.tool);
          } else {
            matches = gatedCandidates.slice(0, limit);
          }

          if (matches.length === 0) {
            return {
              content: [{ type: "text" as const, text: `No tools found for: ${query}` }],
              details: { matches: [], added: [] },
            };
          }

          const matchNames = matches.map((m) => m.name);
          let added: string[] = [];

          if (activate) {
            // additive：只增不减（不变式 7）
            const toAdd = matchNames.filter((n) => !activeSet.has(n));
            if (toAdd.length > 0) {
              pi.setActiveTools([...new Set([...currentActive, ...toAdd])]);
              // 把激活的工具加入 sessionGranted，使下轮 before_agent_start 重应用时保留它们
              for (const n of toAdd) sessionGranted.add(n);
              added = toAdd;
            }
          }

          const lines = matches.map(
            (m) => `• ${m.name} — ${(m.description ?? "").slice(0, 120)}`,
          );
          const header = activate
            ? added.length > 0
              ? `已激活 ${added.length} 个工具：${added.join(", ")}\n\n匹配结果：`
              : `匹配工具均已处于激活状态。\n\n匹配结果：`
            : `仅列出（未激活）：`;
          const text = `${header}\n${lines.join("\n")}`;

          return {
            content: [{ type: "text" as const, text }],
            details: { matches: matchNames, added },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text" as const, text: `gate_tools 执行出错: ${msg}` }],
            details: { error: msg },
          };
        }
      },
    });
  } catch (e) {
    console.error("[pi-tool-gate] registerTool gate_tools failed:", e);
  }
}

// ── /tool-gate 命令 ─────────────────────────────────────────────────────
function registerToolGateCommand(pi: ExtensionAPI): void {
  try {
    pi.registerCommand("tool-gate", {
      description: "按需开关工具：status/list/on/off/profile/reset/stats",
      async handler(args, ctx) {
        try {
          await handleToolGateCommand(pi, args.trim(), ctx);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          try {
            if (ctx.hasUI) ctx.ui.notify(`[tool-gate] 出错: ${msg}`, "error");
          } catch {
            /* ignore */
          }
          console.error("[pi-tool-gate] command handler failed:", e);
        }
      },
    });
  } catch (e) {
    console.error("[pi-tool-gate] registerCommand tool-gate failed:", e);
  }
}

/** 输出文本：有 UI 走 notify，否则 console.log。 */
function out(ctx: { hasUI: boolean; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }, text: string, type?: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type ?? "info");
  } else {
    console.log(text);
  }
}

async function handleToolGateCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: { hasUI: boolean; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void; select?: (title: string, options: string[]) => Promise<string | undefined> } },
): Promise<void> {
  const cfg = loadConfig();
  const allTools = pi.getAllTools();
  const allNames = allTools.map((t) => t.name);
  const activeSet = new Set(pi.getActiveTools());
  const protectedSet = new Set([...cfg.protected, ...HARDCODED_PROTECTED]);

  // gated = 全部 - active - protected
  const gated = allNames.filter((n) => !activeSet.has(n) && !protectedSet.has(n));

  const tokens = args.split(/\s+/).filter(Boolean);
  const sub = tokens[0] ?? "";

  // 无参数 + 有 select → 交互菜单
  if (sub === "" && ctx.hasUI && typeof ctx.ui.select === "function") {
    await interactiveMenu(pi, ctx);
    return;
  }

  switch (sub) {
    case "":
    case "status": {
      const lines = [
        `Tool-Gate 状态：`,
        `  active: ${activeSet.size}  /  gated: ${gated.length}  /  protected: ${protectedSet.size}  /  total: ${allNames.length}`,
      ];
      if (gated.length > 0) {
        lines.push(`  gated 工具: ${gated.join(", ")}`);
      } else {
        lines.push(`  gated 工具: (无)`);
      }
      out(ctx, lines.join("\n"));
      return;
    }

    case "list": {
      const activeList = allNames.filter((n) => activeSet.has(n));
      const lines = ["Active:", `  ${activeList.join(", ") || "(无)"}`, "Gated:", `  ${gated.join(", ") || "(无)"}`];
      out(ctx, lines.join("\n"));
      return;
    }

    case "on": {
      const name = tokens[1];
      if (!name) {
        out(ctx, "用法: /tool-gate on <name|all>");
        return;
      }
      if (name === "all") {
        cfg.disabled = [];
        cfg.userDisabled = [];
        persistConfig(cfg);
        forceApplyGate(pi);
        out(ctx, `已开启全部工具（disabled + userDisabled 清空）。active=${pi.getActiveTools().length}`);
        return;
      }
      // m1: 校验工具存在
      if (!allNames.includes(name)) {
        out(ctx, `工具不存在: ${name}`, "warning");
        return;
      }
      const before = cfg.disabled.length + cfg.userDisabled.length;
      cfg.disabled = cfg.disabled.filter((n) => n !== name);
      cfg.userDisabled = cfg.userDisabled.filter((n) => n !== name);
      if (cfg.disabled.length + cfg.userDisabled.length === before) {
        out(ctx, `${name} 不在 disabled 中，无需开启。`);
        return;
      }
      persistConfig(cfg);
      forceApplyGate(pi);
      out(ctx, `已开启 ${name}。active=${pi.getActiveTools().length}`);
      return;
    }

    case "off": {
      const name = tokens[1];
      if (!name) {
        out(ctx, "用法: /tool-gate off <name|all>");
        return;
      }
      if (name === "all") {
        // off all = userDisabled + disabled 全部非 protected 工具（不变式 4）
        const offList = allNames.filter((n) => !protectedSet.has(n));
        cfg.disabled = [...offList];
        cfg.userDisabled = [...offList];
        sessionGranted.clear();
        persistConfig(cfg);
        forceApplyGate(pi);
        out(ctx, `已关闭全部非 protected 工具。active=${pi.getActiveTools().length}`);
        return;
      }
      // m1: 校验工具存在
      if (!allNames.includes(name)) {
        out(ctx, `工具不存在: ${name}`, "warning");
        return;
      }
      if (protectedSet.has(name)) {
        out(ctx, `${name} 是 protected，不能关闭。`, "warning");
        return;
      }
      // 加入 userDisabled（用户显式 off，loader 不可恢复）+ disabled（applyGate 关闭）
      if (!cfg.userDisabled.includes(name)) cfg.userDisabled.push(name);
      if (!cfg.disabled.includes(name)) cfg.disabled.push(name);
      sessionGranted.delete(name);
      persistConfig(cfg);
      forceApplyGate(pi);
      out(ctx, `已关闭 ${name}。active=${pi.getActiveTools().length}`);
      return;
    }

    case "profile": {
      const pname = tokens[1];
      if (!pname) {
        const names = Object.keys(cfg.profiles);
        out(ctx, `用法: /tool-gate profile <name>${names.length ? `\n可用: ${names.join(", ")}` : ""}`);
        return;
      }
      const preset = cfg.profiles[pname];
      if (!preset) {
        out(ctx, `profile "${pname}" 不存在。可用: ${Object.keys(cfg.profiles).join(", ") || "(无)"}`, "warning");
        return;
      }
      cfg.disabled = preset.filter((n) => !protectedSet.has(n));
      sessionGranted.clear();
      persistConfig(cfg);
      forceApplyGate(pi);
      out(ctx, `已应用 profile "${pname}"。active=${pi.getActiveTools().length}`);
      return;
    }

    case "reset": {
      cfg.disabled = [...DEFAULT_DISABLED];
      cfg.userDisabled = [];
      sessionGranted.clear();
      persistConfig(cfg);
      forceApplyGate(pi);
      out(ctx, `已重置为默认 disabled 名单（userDisabled 清空）。active=${pi.getActiveTools().length}`);
      return;
    }

    case "stats": {
      // 按 JSON.stringify(parameters).length 降序 top 15
      const ranked = allTools
        .map((t) => ({
          name: t.name,
          size: JSON.stringify(t.parameters ?? {}).length,
          active: activeSet.has(t.name),
        }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 15);
      const lines = ranked.map((r) => {
        const tag = r.active ? "ON " : "off";
        return `  ${tag}  ${String(r.size).padStart(5)}B  ${r.name}`;
      });
      out(ctx, `工具 schema 大小 top 15:\n${lines.join("\n")}`);
      return;
    }

    default:
      out(ctx, `未知子命令: ${sub}\n可用: status, list, on, off, profile, reset, stats`);
  }
}

/** 交互菜单：列出 gated 工具，让用户选择开启或关闭。 */
async function interactiveMenu(
  pi: ExtensionAPI,
  ctx: { hasUI: boolean; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void; select?: (title: string, options: string[]) => Promise<string | undefined> } },
): Promise<void> {
  const cfg = loadConfig();
  const allNames = pi.getAllTools().map((t) => t.name);
  const activeSet = new Set(pi.getActiveTools());
  const protectedSet = new Set([...cfg.protected, ...HARDCODED_PROTECTED]);

  // 构建选项：每个工具一行状态
  const options = allNames.map((n) => {
    if (protectedSet.has(n)) return `[protected] ${n}`;
    if (activeSet.has(n)) return `[ON ] ${n}`;
    return `[off] ${n}`;
  });
  options.push("── 完成 ──");

  if (typeof ctx.ui.select !== "function") return;
  const pick = await ctx.ui.select("选择要切换的工具", options);
  if (!pick || pick === "── 完成 ──") return;

  const name = pick.replace(/^\[[^\]]*\]\s*/, "").trim();
  if (protectedSet.has(name)) {
    ctx.ui.notify(`${name} 是 protected，不能关闭。`, "warning");
    return;
  }
  if (activeSet.has(name)) {
    // 当前 ON → 关闭（同步 disabled + userDisabled + sessionGranted）
    if (!cfg.disabled.includes(name)) cfg.disabled.push(name);
    if (!cfg.userDisabled.includes(name)) cfg.userDisabled.push(name);
    sessionGranted.delete(name);
    persistConfig(cfg);
    forceApplyGate(pi);
    ctx.ui.notify(`已关闭 ${name}`, "info");
  } else {
    // 当前 off → 开启（同步清除 disabled + userDisabled）
    cfg.disabled = cfg.disabled.filter((n) => n !== name);
    cfg.userDisabled = cfg.userDisabled.filter((n) => n !== name);
    persistConfig(cfg);
    forceApplyGate(pi);
    ctx.ui.notify(`已开启 ${name}`, "info");
  }
}

// ── 扩展入口 ────────────────────────────────────────────────────────────
export default function registerToolGate(pi: ExtensionAPI): void {
  // 先注册 gate_tools（使其进入 getAllTools）
  registerGateTools(pi);

  // 注册 /tool-gate 命令
  registerToolGateCommand(pi);

  // 闸 1：session_start —— 清空 sessionGranted 后首次应用（新会话重新 gate）
  try {
    pi.on("session_start", () => {
      try {
        sessionGranted = new Set();
        forceApplyGate(pi);
      } catch (e) {
        console.error("[pi-tool-gate] session_start applyGate failed:", e);
      }
    });
  } catch (e) {
    console.error("[pi-tool-gate] on session_start failed:", e);
  }

  // 闸 2：before_agent_start —— 每轮 agent 启动前重应用（防抖比对实际 active 与 target）
  //   外部 reset 后实际≠target 则重应用（含 sessionGranted，不清空）
  try {
    pi.on("before_agent_start", () => {
      try {
        applyGate(pi);
      } catch (e) {
        console.error("[pi-tool-gate] before_agent_start applyGate failed:", e);
      }
    });
  } catch (e) {
    console.error("[pi-tool-gate] on before_agent_start failed:", e);
  }

  // 闸 3：model_select —— 换模型后 active 可能被重置，重应用（sessionGranted 保留）
  try {
    pi.on("model_select", () => {
      try {
        forceApplyGate(pi);
      } catch (e) {
        console.error("[pi-tool-gate] model_select applyGate failed:", e);
      }
    });
  } catch (e) {
    console.error("[pi-tool-gate] on model_select failed:", e);
  }

  // 闸 4：session_compact —— compaction 后 active 可能被重置，重应用（sessionGranted 保留）
  try {
    pi.on("session_compact", () => {
      try {
        forceApplyGate(pi);
      } catch (e) {
        console.error("[pi-tool-gate] session_compact applyGate failed:", e);
      }
    });
  } catch (e) {
    console.error("[pi-tool-gate] on session_compact failed:", e);
  }
}
