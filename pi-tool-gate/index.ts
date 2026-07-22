/**
 * pi-tool-gate — 按需工具开关扩展（统一组级管理模型）。
 *
 * 核心模型：组是管理原子单元。
 *   - 工具按来源包（sourceInfo.source）自动归组。
 *   - 管理操作以组为最小粒度，组内不细分——不会出现"只关组里某一个工具"。
 *   - 配置文件可直接写工具名（手写友好），加载时归约到工具所在组，并回写规范文件。
 *   - 全局与项目对称，都支持组级配置；项目配置覆盖全局。
 *   - loader（gate_tools）匹配到工具时开其整组。
 *
 * 两道界面，一种模型：
 *   1. TUI 交互菜单（/tool-gate 无参）—— 组视图，整组切换。
 *   2. 配置文件（~/.pi/agent/config/tool-gate.json）—— 文本界面，可写组名或工具名。
 *
 * 数据模型（全局和项目共用 ScopeGateConfig）：
 *   disabledGroups       关的组（默认名单，loader 可激活）
 *   userDisabledGroups   用户显式关的组（loader 不可恢复）
 *   enabledGroups        强制开的组（覆盖 disabled）
 *   disabled             便利：直接写工具名，加载时归约到组并入 disabledGroups，然后清空回写
 *   protected（仅全局）  安全底线工具名（read/write/edit/bash/gate_tools），永不关，不属管理粒度
 *
 * 不变式：
 *   1. 组不细分：任意时刻一个组要么全开要么全关，不存在组内部分开。
 *   2. protected 永远开（硬底线 HARDCODED_PROTECTED 不可移除）。
 *   3. enabledGroups 覆盖 disabledGroups（同一组在两边都出现时，开优先）。
 *   4. userDisabledGroups 是 loader 不可恢复的关；loader 只能开 disabledGroups 里的组。
 *   5. 项目覆盖全局：项目配置存在时，用项目的组集合（关/开）叠加在全局之上。
 *   6. 归约后回写：disabled（工具名）在首次加载时归约成组并入 disabledGroups，并清空 disabled 字段持久化。
 *   7. applyGate 幂等 + 防抖：每次从全量工具 + 配置重算，比对实际 active 签名，相同则跳过。
 *   8. A 为空 → 回退全开，配置损坏不锁死。
 *
 * 应用时机（四道闸，幂等）：
 *   session_start / before_agent_start / model_select / session_compact
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── 配置路径 ────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "config");
const CONFIG_PATH = path.join(CONFIG_DIR, "tool-gate.json");

// ── 默认 disabled 工具名（加载时归约到组，作为默认关的组）──────────────
//   写工具名是为了手写直观；运行时归约后这些工具所在组整体默认关。
const DEFAULT_DISABLED: string[] = [
  "subagent", "subagent_wait",
  "image_gen", "image_review", "tg_attach",
  "process_thought", "sequential_think", "generate_summary",
  "clear_history", "export_session", "import_session",
  "get_thinking_history", "get_thinking_status",
  "advisor", "skill_manage",
  "memory", "memory_search", "session_search", "recall",
  "create_goal", "update_goal", "get_goal",
  "list_models", "use_role",
];

// ── protected 工具名（永不关：内置核心 + gate_tools 自身）───────────────
const DEFAULT_PROTECTED: string[] = [
  "read", "write", "edit", "bash", "grep", "find", "ls", "ffgrep", "fffind",
  "gate_tools",
];

// ── 硬底线 protected：无论 config.protected 怎么配，这四个内置核心永远开 ──
const HARDCODED_PROTECTED = new Set(["read", "write", "edit", "bash"]);

// ── 配置类型 ────────────────────────────────────────────────────────────
/** 作用域配置：全局和项目共用同一结构。 */
interface ScopeGateConfig {
  disabledGroups: string[];      // 关的组（默认名单，loader 可激活）
  userDisabledGroups: string[];  // 用户显式关的组（loader 不可恢复）
  enabledGroups: string[];       // 强制开的组（覆盖 disabled）
  disabled: string[];            // 便利：直接写工具名，加载时归约到组
}

interface ToolGateConfig extends ScopeGateConfig {
  protected: string[];
  profiles: Record<string, string[]>;
  projects: Record<string, ScopeGateConfig>;  // key=项目 cwd，覆盖全局
}

/** 默认作用域配置（空，所有组默认开）。 */
function emptyScope(): ScopeGateConfig {
  return { disabledGroups: [], userDisabledGroups: [], enabledGroups: [], disabled: [] };
}

// ── 模块级状态 ──────────────────────────────────────────────────────────
// 运行时 loader 激活的组集：session_start 清空，loader 调用时加入，每轮重应用时保留
let sessionGrantedGroups: Set<string> = new Set();

/** 读取配置；文件不存在或 JSON 损坏时回退默认配置并尝试写回。 */
function loadConfig(): ToolGateConfig {
  const fallback: ToolGateConfig = {
    disabled: [...DEFAULT_DISABLED],
    disabledGroups: [],
    userDisabledGroups: [],
    enabledGroups: [],
    protected: [...DEFAULT_PROTECTED],
    profiles: {},
    projects: {},
  };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled.filter((x: unknown) => typeof x === "string") : [...DEFAULT_DISABLED],
      disabledGroups: Array.isArray(parsed.disabledGroups) ? parsed.disabledGroups.filter((x: unknown) => typeof x === "string") : [],
      userDisabledGroups: Array.isArray(parsed.userDisabledGroups) ? parsed.userDisabledGroups.filter((x: unknown) => typeof x === "string") : [],
      enabledGroups: Array.isArray(parsed.enabledGroups) ? parsed.enabledGroups.filter((x: unknown) => typeof x === "string") : [],
      protected: Array.isArray(parsed.protected) ? parsed.protected.filter((x: unknown) => typeof x === "string") : [...DEFAULT_PROTECTED],
      profiles: (parsed.profiles && typeof parsed.profiles === "object" && !Array.isArray(parsed.profiles)) ? parsed.profiles : {},
      projects: (parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)) ? parsed.projects : {},
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

/** 取工具的组键（来源包名），sourceInfo 不可用时 fallback "other"。 */
function groupOf(tool: any): string {
  return tool?.sourceInfo?.source ?? tool?.sourceInfo?.path ?? "other";
}

/** 按组归类工具，返回 Map<组键, 工具名[]>。 */
function groupTools(allToolObjs: any[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of allToolObjs) {
    const g = groupOf(t);
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(t.name);
  }
  return m;
}

/** 工具名 → 组键映射。 */
function toolToGroupMap(allToolObjs: any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of allToolObjs) m.set(t.name, groupOf(t));
  return m;
}

/**
 * 把作用域配置里的 disabled（工具名）归约到组，并入 disabledGroups。
 * 返回归约后的规范 ScopeGateConfig（disabled 清空，disabledGroups 含归约结果）。
 * 不修改入参。
 */
function normalizeScope(scope: ScopeGateConfig, t2g: Map<string, string>): ScopeGateConfig {
  const groups = new Set<string>(scope.disabledGroups);
  // 工具名归约到组
  for (const name of scope.disabled) {
    const g = t2g.get(name);
    if (g) groups.add(g);
  }
  return {
    disabledGroups: [...groups],
    userDisabledGroups: [...scope.userDisabledGroups],
    enabledGroups: [...scope.enabledGroups],
    disabled: [],  // 归约完成，清空
  };
}

/**
 * 若配置含未归约的 disabled 工具名（全局或任意项目），归一化并回写规范文件。
 * 满足不变式 6：归约后回写。
 */
function normalizeAndPersistIfNeeded(cfg: ToolGateConfig, allToolObjs: any[]): ToolGateConfig {
  const t2g = toolToGroupMap(allToolObjs);
  let changed = false;

  // 全局
  if (cfg.disabled.length > 0) {
    cfg = { ...cfg, ...normalizeScope(cfg, t2g) };
    changed = true;
  }
  // 项目
  if (cfg.projects) {
    const newProjects: Record<string, ScopeGateConfig> = {};
    for (const [cwd, p] of Object.entries(cfg.projects)) {
      if (p.disabled && p.disabled.length > 0) {
        newProjects[cwd] = normalizeScope(p, t2g);
        changed = true;
      } else {
        newProjects[cwd] = p;
      }
    }
    cfg = { ...cfg, projects: newProjects };
  }
  if (changed) persistConfig(cfg);
  return cfg;
}

/**
 * 应用 gate：根据配置重算激活集并 setActiveTools。幂等 + 防抖。
 * 生效组集合 = 全局（disabledGroups ∪ userDisabledGroups，扣掉 enabledGroups）被项目覆盖。
 * 关组内所有工具、开组（enabledGroups）内所有工具、protected 永远开、loader 授予的组保留。
 */
function applyGate(pi: ExtensionAPI): void {
  try {
    const allToolObjs = pi.getAllTools();
    const allToolNames: string[] = allToolObjs.map((t: any) => t.name);
    const allSet = new Set<string>(allToolNames);
    const t2g = toolToGroupMap(allToolObjs);
    const groups = groupTools(allToolObjs);

    let cfg = loadConfig();
    cfg = normalizeAndPersistIfNeeded(cfg, allToolObjs);

    const protectedSet = new Set([...cfg.protected, ...HARDCODED_PROTECTED]);

    // 全局生效组集合
    const disabledGroups = new Set<string>([...cfg.disabledGroups, ...cfg.userDisabledGroups]);
    const enabledGroups = new Set<string>(cfg.enabledGroups);
    // enabledGroups 覆盖 disabledGroups（不变式 3）
    for (const g of enabledGroups) disabledGroups.delete(g);

    // 项目覆盖全局：项目存在时，项目关的组并入、项目开的组从关集中移除
    const proj = cfg.projects[pi.cwd];
    if (proj) {
      for (const g of proj.disabledGroups) disabledGroups.add(g);
      for (const g of proj.userDisabledGroups) disabledGroups.add(g);
      for (const g of proj.enabledGroups) disabledGroups.delete(g);
    }

    // 计算激活集
    const activeSet = new Set<string>();
    for (const [g, names] of groups) {
      const isOff = disabledGroups.has(g);
      if (!isOff) for (const n of names) activeSet.add(n);
    }
    // protected 永远开
    for (const n of allToolNames) if (protectedSet.has(n)) activeSet.add(n);
    // loader 运行时授予的组保留（不可恢复 userDisabledGroups，不可关 protected）
    const userDisabledGroupsSet = new Set(cfg.userDisabledGroups);
    for (const g of sessionGrantedGroups) {
      if (userDisabledGroupsSet.has(g)) continue;  // 用户显式关的组，loader 不恢复
      const names = groups.get(g);
      if (names) for (const n of names) if (allSet.has(n)) activeSet.add(n);
    }

    // 不变式 8：A 为空 → 回退全开
    let target = [...activeSet];
    if (target.length === 0) target = [...allToolNames];

    // 防抖：比对当前实际 active 集，相同则跳过
    if (sigOf(pi.getActiveTools()) === sigOf(target)) return;
    pi.setActiveTools(target);
  } catch (e) {
    console.error("[pi-tool-gate] applyGate failed:", e);
  }
}

function forceApplyGate(pi: ExtensionAPI): void {
  applyGate(pi);
}

/** 把参数（组名或工具名）归约成组名。工具名→其所在组；组名→自身；未知→null。 */
function resolveGroupArg(arg: string, groups: Map<string, string[]>, t2g: Map<string, string>): string | null {
  if (groups.has(arg)) return arg;        // 是组名
  const g = t2g.get(arg);                  // 是工具名 → 归约
  return g ?? null;
}

// ── gate_tools loader 工具 ──────────────────────────────────────────────
function registerGateTools(pi: ExtensionAPI): void {
  try {
    pi.registerTool({
      name: "gate_tools",
      label: "Gate Tools",
      description:
        "搜索并激活已注册但当前未启用的工具。当当前可用工具不足以完成任务时调用此工具。" +
        "传入关键词匹配工具名和描述；activate=true（默认）会增量激活匹配工具所在整组使其在下一轮可用，" +
        "activate=false 只列出不激活。query=\"*\" 列出所有 gated 工具。",
      promptSnippet: "当前工具不够用时，必须先调用 gate_tools 搜索并激活已注册但未启用的工具，再继续任务",
      promptGuidelines: [
        "当任务需要当前不可用的能力时，必须先调用 gate_tools 搜索并激活相应工具，而非放弃该步骤或用不合适的工具勉强替代；激活后该工具在下一轮可用。",
        "gate_tools 的激活是增量式的，不会移除当前已启用的工具。",
        "若 gate_tools 查询后仍无匹配工具，再考虑向用户说明能力缺失或寻求其他方案。",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词，匹配工具名和描述；\"*\" 列出所有 gated 工具" }),
        activate: Type.Optional(Type.Boolean({ description: "是否激活匹配的工具所在组，默认 true；false 只列出", default: true })),
        limit: Type.Optional(Type.Integer({ description: "返回数量上限，默认 10", minimum: 1, maximum: 50, default: 10 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        try {
          const query: string = params.query ?? "";
          const activate: boolean = params.activate !== false;
          const limit: number = params.limit ?? 10;

          const allToolObjs = pi.getAllTools();
          const currentActive = pi.getActiveTools();
          const activeSet = new Set(currentActive);
          const cfg = loadConfig();
          const protectedSet = new Set([...cfg.protected, ...HARDCODED_PROTECTED]);
          const groups = groupTools(allToolObjs);
          const t2g = toolToGroupMap(allToolObjs);

          // 当前关的组（loader 可激活的 = disabledGroups 中、但不在 userDisabledGroups 中）
          const userDisabledGroupsSet = new Set(cfg.userDisabledGroups);
          const openableGroups = new Set(cfg.disabledGroups.filter((g) => !userDisabledGroupsSet.has(g)));

          // gated 候选工具 = 当前未激活、所在组是 openableGroups、非 protected
          const gatedCandidates = allToolObjs.filter(
            (t) => !activeSet.has(t.name) && !protectedSet.has(t.name) && openableGroups.has(groupOf(t)),
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
              details: { matches: [], addedGroups: [] },
            };
          }

          // 匹配工具 → 归约到组（去重）
          const matchedGroups = new Set<string>();
          for (const m of matches) matchedGroups.add(groupOf(m));
          const matchNames = matches.map((m) => m.name);
          let addedGroups: string[] = [];

          if (activate) {
            // 按整组激活：把组内所有工具并入 active
            const toAdd: string[] = [];
            for (const g of matchedGroups) {
              if (!userDisabledGroupsSet.has(g)) {
                for (const n of groups.get(g) ?? []) {
                  if (!activeSet.has(n)) toAdd.push(n);
                }
                sessionGrantedGroups.add(g);
                addedGroups.push(g);
              }
            }
            if (toAdd.length > 0) {
              pi.setActiveTools([...new Set([...currentActive, ...toAdd])]);
            }
          }

          const lines = matches.map(
            (m) => `• ${m.name} — ${(m.description ?? "").slice(0, 120)}`,
          );
          const header = activate
            ? addedGroups.length > 0
              ? `已激活 ${addedGroups.length} 个组：${addedGroups.join(", ")}\n\n匹配结果：`
              : `匹配工具所在组均已处于激活状态。\n\n匹配结果：`
            : `仅列出（未激活）：`;
          const text = `${header}\n${lines.join("\n")}`;

          return {
            content: [{ type: "text" as const, text }],
            details: { matches: matchNames, addedGroups },
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
      description: "按需开关工具组：status/list/on/off/group/scope/profile/reset/stats",
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
  let cfg = loadConfig();
  const allToolObjs = pi.getAllTools();
  const allNames = allToolObjs.map((t) => t.name);
  // 归一化（可能回写文件），保证后续读到的是规范组配置
  cfg = normalizeAndPersistIfNeeded(cfg, allToolObjs);
  const activeSet = new Set(pi.getActiveTools());
  const protectedSet = new Set([...cfg.protected, ...HARDCODED_PROTECTED]);
  const groups = groupTools(allToolObjs);
  const t2g = toolToGroupMap(allToolObjs);

  const cwd = pi.cwd;
  const proj = cfg.projects[cwd] ?? null;
  const scopeDesc = proj ? `项目 ${cwd}` : `全局`;

  // 计算当前生效的关组集合（与 applyGate 一致）
  const effectiveDisabled = new Set<string>([...cfg.disabledGroups, ...cfg.userDisabledGroups]);
  for (const g of cfg.enabledGroups) effectiveDisabled.delete(g);
  if (proj) {
    for (const g of proj.disabledGroups) effectiveDisabled.add(g);
    for (const g of proj.userDisabledGroups) effectiveDisabled.add(g);
    for (const g of proj.enabledGroups) effectiveDisabled.delete(g);
  }

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
      const activeCnt = activeSet.size;
      const lines = [
        `Tool-Gate 状态：`,
        `  作用域: ${scopeDesc}`,
        `  active: ${activeCnt}  /  total: ${allNames.length}  /  protected: ${protectedSet.size}`,
        `  关闭的组: ${[...effectiveDisabled].sort().join(", ") || "(无)"}`,
      ];
      out(ctx, lines.join("\n"));
      return;
    }

    case "list": {
      const lines = [`工具组（作用域: ${scopeDesc}）：`];
      for (const [g, names] of [...groups.entries()].sort()) {
        const onCnt = names.filter((n) => activeSet.has(n)).length;
        const tag = onCnt === names.length ? "ON " : onCnt === 0 ? "off" : `${onCnt}/${names.length}`;
        const flag = effectiveDisabled.has(g) ? " (关)" : "";
        lines.push(`  [${tag}] ${g} (${names.length})${flag}`);
      }
      out(ctx, lines.join("\n"));
      return;
    }

    case "on": {
      // /tool-gate on <group|tool|all>  开组：从 disabledGroups + userDisabledGroups 移除，加入 enabledGroups
      const arg = tokens[1];
      if (!arg) {
        out(ctx, "用法: /tool-gate on <组名|工具名|all>");
        return;
      }
      if (arg === "all") {
        // 开全部：清空全局关组；项目存在则清项目关组
        if (proj) {
          proj.disabledGroups = [];
          proj.userDisabledGroups = [];
        } else {
          cfg.disabledGroups = [];
          cfg.userDisabledGroups = [];
        }
        sessionGrantedGroups.clear();
        persistConfig(cfg);
        forceApplyGate(pi);
        out(ctx, `已开启全部组（${scopeDesc}）。active=${pi.getActiveTools().length}`);
        return;
      }
      const g = resolveGroupArg(arg, groups, t2g);
      if (!g) {
        out(ctx, `未找到组或工具: ${arg}`, "warning");
        return;
      }
      const scope: ScopeGateConfig = proj ?? cfg;
      scope.disabledGroups = scope.disabledGroups.filter((x) => x !== g);
      scope.userDisabledGroups = scope.userDisabledGroups.filter((x) => x !== g);
      if (!scope.enabledGroups.includes(g)) scope.enabledGroups.push(g);
      persistConfig(cfg);
      forceApplyGate(pi);
      out(ctx, `已开启组 ${g}（${scopeDesc}）。active=${pi.getActiveTools().length}`);
      return;
    }

    case "off": {
      // /tool-gate off <group|tool|all>  关组：加入 disabledGroups + userDisabledGroups，从 enabledGroups 移除
      const arg = tokens[1];
      if (!arg) {
        out(ctx, "用法: /tool-gate off <组名|工具名|all>");
        return;
      }
      if (arg === "all") {
        // 关全部非 protected 组
        const allGroups = [...groups.keys()];
        const scope: ScopeGateConfig = proj ?? cfg;
        scope.disabledGroups = [...allGroups];
        scope.userDisabledGroups = [...allGroups];
        scope.enabledGroups = [];
        sessionGrantedGroups.clear();
        persistConfig(cfg);
        forceApplyGate(pi);
        out(ctx, `已关闭全部组（${scopeDesc}）。active=${pi.getActiveTools().length}`);
        return;
      }
      const g = resolveGroupArg(arg, groups, t2g);
      if (!g) {
        out(ctx, `未找到组或工具: ${arg}`, "warning");
        return;
      }
      // 检查组内是否全为 protected
      const gNames = groups.get(g) ?? [];
      if (gNames.every((n) => protectedSet.has(n))) {
        out(ctx, `组 ${g} 全为 protected，不能关闭。`, "warning");
        return;
      }
      const scope: ScopeGateConfig = proj ?? cfg;
      if (!scope.disabledGroups.includes(g)) scope.disabledGroups.push(g);
      if (!scope.userDisabledGroups.includes(g)) scope.userDisabledGroups.push(g);
      scope.enabledGroups = scope.enabledGroups.filter((x) => x !== g);
      sessionGrantedGroups.delete(g);
      persistConfig(cfg);
      forceApplyGate(pi);
      out(ctx, `已关闭组 ${g}（${scopeDesc}）。active=${pi.getActiveTools().length}`);
      return;
    }

    case "group": {
      // /tool-gate group [list|on <g|t>|off <g|t>]
      // 与 on/off 等价的组级别名，参数同样自动识别归约
      const gact = tokens[1] ?? "list";
      if (gact === "list" || gact === "" ) {
        // 复用 list
        const lines = [`工具组（作用域: ${scopeDesc}）：`];
        for (const [g, names] of [...groups.entries()].sort()) {
          const onCnt = names.filter((n) => activeSet.has(n)).length;
          const tag = onCnt === names.length ? "ON " : onCnt === 0 ? "off" : `${onCnt}/${names.length}`;
          const flag = effectiveDisabled.has(g) ? " (关)" : "";
          lines.push(`  [${tag}] ${g} (${names.length})${flag}`);
        }
        out(ctx, lines.join("\n"));
        return;
      }
      const arg = tokens[2];
      if (!arg) {
        out(ctx, `用法: /tool-gate group ${gact} <组名|工具名>\n可用组: ${[...groups.keys()].sort().join(", ")}`);
        return;
      }
      const g = resolveGroupArg(arg, groups, t2g);
      if (!g) {
        out(ctx, `未找到组或工具: ${arg}\n可用组: ${[...groups.keys()].sort().join(", ")}`, "warning");
        return;
      }
      const scope: ScopeGateConfig = proj ?? cfg;
      if (gact === "off") {
        const gNames = groups.get(g) ?? [];
        if (gNames.every((n) => protectedSet.has(n))) {
          out(ctx, `组 ${g} 全为 protected，不能关闭。`, "warning");
          return;
        }
        if (!scope.disabledGroups.includes(g)) scope.disabledGroups.push(g);
        if (!scope.userDisabledGroups.includes(g)) scope.userDisabledGroups.push(g);
        scope.enabledGroups = scope.enabledGroups.filter((x) => x !== g);
        sessionGrantedGroups.delete(g);
      } else if (gact === "on") {
        scope.disabledGroups = scope.disabledGroups.filter((x) => x !== g);
        scope.userDisabledGroups = scope.userDisabledGroups.filter((x) => x !== g);
        if (!scope.enabledGroups.includes(g)) scope.enabledGroups.push(g);
      } else {
        out(ctx, `未知 group 动作: ${gact}（可用: list/on/off）`, "warning");
        return;
      }
      persistConfig(cfg);
      forceApplyGate(pi);
      out(ctx, `已 ${gact} 组 ${g}（${scopeDesc}）。active=${pi.getActiveTools().length}`);
      return;
    }

    case "scope": {
      // /tool-gate scope [status|project|global]
      const sact = tokens[1] ?? "";
      if (sact === "" || sact === "status") {
        const lines = [`当前作用域: ${scopeDesc}`];
        if (proj) {
          lines.push(`  项目关组: ${proj.disabledGroups.join(", ") || "(无)"}`);
          lines.push(`  项目用户关组: ${proj.userDisabledGroups.join(", ") || "(无)"}`);
          lines.push(`  项目开组: ${proj.enabledGroups.join(", ") || "(无)"}`);
        } else {
          lines.push(`  全局关组: ${cfg.disabledGroups.join(", ") || "(无)"}`);
          lines.push(`  全局用户关组: ${cfg.userDisabledGroups.join(", ") || "(无)"}`);
          lines.push(`  全局开组: ${cfg.enabledGroups.join(", ") || "(无)"}`);
        }
        out(ctx, lines.join("\n"));
        return;
      }
      if (sact === "project") {
        if (!proj) cfg.projects[cwd] = emptyScope();
        persistConfig(cfg);
        forceApplyGate(pi);
        out(ctx, `已为当前项目创建组配置: ${cwd}`);
        return;
      }
      if (sact === "global") {
        if (proj) {
          delete cfg.projects[cwd];
          persistConfig(cfg);
          forceApplyGate(pi);
          out(ctx, `已删除当前项目的组配置，回退全局。`);
        } else {
          out(ctx, `当前项目无组配置。`);
        }
        return;
      }
      out(ctx, `未知 scope 动作: ${sact}（可用: status/project/global）`, "warning");
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
      // preset 是工具名列表，归约到组，作为全局 disabledGroups
      const presetGroups = new Set<string>();
      for (const name of preset) {
        const g = t2g.get(name);
        if (g) presetGroups.add(g);
      }
      cfg.disabledGroups = [...presetGroups];
      cfg.userDisabledGroups = [];
      cfg.enabledGroups = [];
      sessionGrantedGroups.clear();
      persistConfig(cfg);
      forceApplyGate(pi);
      out(ctx, `已应用 profile "${pname}"（${presetGroups.size} 组）。active=${pi.getActiveTools().length}`);
      return;
    }

    case "reset": {
      // 重置全局为默认关组（DEFAULT_DISABLED 工具名归约到组）
      const defaultGroups = new Set<string>();
      for (const name of DEFAULT_DISABLED) {
        const g = t2g.get(name);
        if (g) defaultGroups.add(g);
      }
      cfg.disabledGroups = [...defaultGroups];
      cfg.userDisabledGroups = [];
      cfg.enabledGroups = [];
      cfg.disabled = [];
      sessionGrantedGroups.clear();
      persistConfig(cfg);
      forceApplyGate(pi);
      out(ctx, `已重置为默认关组（${defaultGroups.size} 组）。active=${pi.getActiveTools().length}`);
      return;
    }

    case "stats": {
      // 按组统计 schema 大小
      const lines = [`工具组 schema 大小：`];
      for (const [g, names] of [...groups.entries()].sort()) {
        const size = names.reduce((s, n) => {
          const t = allToolObjs.find((x) => x.name === n);
          return s + JSON.stringify(t?.parameters ?? {}).length;
        }, 0);
        const onCnt = names.filter((n) => activeSet.has(n)).length;
        const tag = onCnt === names.length ? "ON " : onCnt === 0 ? "off" : `${onCnt}/${names.length}`;
        lines.push(`  ${tag}  ${String(size).padStart(6)}B  ${g} (${names.length})`);
      }
      out(ctx, lines.join("\n"));
      return;
    }

    default:
      out(ctx, `未知子命令: ${sub}\n可用: status, list, on, off, group, scope, profile, reset, stats`);
  }
}

/** 交互菜单：按工具组（来源包）列出，循环整组切换，直到选"完成"或取消。 */
async function interactiveMenu(
  pi: ExtensionAPI,
  ctx: { hasUI: boolean; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void; select?: (title: string, options: string[]) => Promise<string | undefined> } },
): Promise<void> {
  if (typeof ctx.ui.select !== "function") return;

  for (;;) {
    let cfg = loadConfig();
    const allToolObjs = pi.getAllTools();
    cfg = normalizeAndPersistIfNeeded(cfg, allToolObjs);
    const activeSet = new Set(pi.getActiveTools());
    const protectedSet = new Set([...cfg.protected, ...HARDCODED_PROTECTED]);
    const groups = groupTools(allToolObjs);
    const cwd = pi.cwd;
    const proj = cfg.projects[cwd] ?? null;
    const scopeDesc = proj ? `项目 ${cwd}` : `全局`;

    // 当前生效关组集合
    const effectiveDisabled = new Set<string>([...cfg.disabledGroups, ...cfg.userDisabledGroups]);
    for (const g of cfg.enabledGroups) effectiveDisabled.delete(g);
    if (proj) {
      for (const g of proj.disabledGroups) effectiveDisabled.add(g);
      for (const g of proj.userDisabledGroups) effectiveDisabled.add(g);
      for (const g of proj.enabledGroups) effectiveDisabled.delete(g);
    }

    // 构建选项：每组一行状态
    const options: string[] = [];
    const groupKeys: string[] = [];
    for (const [g, names] of [...groups.entries()].sort()) {
      const onCnt = names.filter((n) => activeSet.has(n)).length;
      const tag = onCnt === names.length ? "ON " : onCnt === 0 ? "off" : `${onCnt}/${names.length}`;
      const allProtected = names.every((n) => protectedSet.has(n));
      const flag = effectiveDisabled.has(g) ? " (关)" : allProtected ? " (protected)" : "";
      options.push(`[${tag}] ${g} (${names.length})${flag}`);
      groupKeys.push(g);
    }
    options.push("── 完成 ──");

    const pick = await ctx.ui.select(`选择要整组切换的工具组（${scopeDesc}，完成退出）`, options);
    if (!pick || pick === "── 完成 ──") return;

    const idx = options.indexOf(pick);
    if (idx < 0 || idx >= groupKeys.length) continue;
    const g = groupKeys[idx];
    const gNames = groups.get(g) ?? [];
    if (gNames.every((n) => protectedSet.has(n))) {
      ctx.ui.notify(`组 ${g} 全为 protected，不可切换。`, "warning");
      continue;
    }
    const allOn = gNames.every((n) => activeSet.has(n));
    const scope: ScopeGateConfig = proj ?? cfg;

    if (allOn) {
      // 当前 ON → 关闭
      if (!scope.disabledGroups.includes(g)) scope.disabledGroups.push(g);
      if (!scope.userDisabledGroups.includes(g)) scope.userDisabledGroups.push(g);
      scope.enabledGroups = scope.enabledGroups.filter((x) => x !== g);
      sessionGrantedGroups.delete(g);
    } else {
      // 当前 off → 开启
      scope.disabledGroups = scope.disabledGroups.filter((x) => x !== g);
      scope.userDisabledGroups = scope.userDisabledGroups.filter((x) => x !== g);
      if (!scope.enabledGroups.includes(g)) scope.enabledGroups.push(g);
    }
    persistConfig(cfg);
    forceApplyGate(pi);
    ctx.ui.notify(`已${allOn ? "关闭" : "开启"} 组 ${g}（${gNames.length} 工具）`, "info");
  }
}

// ── 扩展入口 ────────────────────────────────────────────────────────────
export default function registerToolGate(pi: ExtensionAPI): void {
  // 先注册 gate_tools（使其进入 getAllTools）
  registerGateTools(pi);

  // 注册 /tool-gate 命令
  registerToolGateCommand(pi);

  // 闸 1：session_start —— 清空 sessionGrantedGroups 后首次应用
  try {
    pi.on("session_start", () => {
      try {
        sessionGrantedGroups = new Set();
        forceApplyGate(pi);
      } catch (e) {
        console.error("[pi-tool-gate] session_start applyGate failed:", e);
      }
    });
  } catch (e) {
    console.error("[pi-tool-gate] on session_start failed:", e);
  }

  // 闸 2：before_agent_start —— 每轮 agent 启动前重应用（防抖）
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

  // 闸 3：model_select —— 换模型后 active 可能被重置，重应用（sessionGrantedGroups 保留）
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

  // 闸 4：session_compact —— compaction 后 active 可能被重置，重应用（sessionGrantedGroups 保留）
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
