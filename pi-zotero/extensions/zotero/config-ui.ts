/**
 * /zotero-config TUI 菜单：交互式编辑 pi-zotero 配置。
 * 模式参照 pi-tool-gate 的 interactiveMenu（ctx.ui.select 循环）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, saveConfig, RELOAD_HINT, type ZoteroConfig, type ZoteroResource } from "./config.ts";

interface UiCtx {
  hasUI?: boolean;
  ui: {
    notify: (m: string, t?: "info" | "warning" | "error") => void;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
  };
}

const RESOURCES: ZoteroResource[] = ["items", "collections", "searches"];

export function registerZoteroConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("zotero-config", {
    description: "交互式配置 pi-zotero（写权限门控/连接参数），修改后 /reload 生效",
    handler: async (_args, ctx) => {
      try {
        await configMenu(ctx as UiCtx);
      } catch (err) {
        ctx.ui.notify(`[pi-zotero] 配置出错: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}

async function configMenu(ctx: UiCtx): Promise<void> {
  if (typeof ctx.ui.select !== "function") return;
  for (;;) {
    const cfg = loadConfig();
    const w = cfg.write;
    const toolsLabel = w.enabled && w.tools.length ? w.tools.join(",") : "（无）";
    const options = [
      `[${w.enabled ? "开" : "关"}] write.enabled — 写操作总开关（默认关）`,
      `[${w.tools.length ? "开" : "关"}] write.tools — 资源白名单: ${toolsLabel}`,
      `[${w.delete ? "开" : "关"}] write.delete — 永久删除总闸（默认关）`,
      `[${w.rememberKey ? "开" : "关"}] write.rememberKey — 授权 key 复用（默认关=一次性）`,
      `[${w.enabled ? "开" : "关"}] baseUrl: ${cfg.baseUrl}`,
      `[timeoutMs: ${cfg.timeoutMs}] [cacheDir: ${cfg.cacheDir ?? "默认<cwd>/.zotero-cache"}] [maxItems: ${cfg.maxItems}]`,
      "── 完成（保存并退出） ──",
    ];
    const pick = await ctx.ui.select(`pi-zotero 配置${RELOAD_HINT}`, options);
    if (!pick || pick.startsWith("──")) {
      ctx.ui.notify("配置已保存" + RELOAD_HINT, "info");
      return;
    }
    if (pick.includes("write.enabled")) {
      w.enabled = !w.enabled;
      if (!w.enabled) w.tools = [];
      ctx.ui.notify(`write.enabled → ${w.enabled}`, "info");
    } else if (pick.includes("write.tools")) {
      const sel = await ctx.ui.select("选择允许写的资源（多选请逐个选择）", [
        ...RESOURCES.map((r) => `[${w.tools.includes(r) ? "✓" : " "}] ${r}`),
        "── 返回 ──",
      ]);
      if (sel && !sel.startsWith("──")) {
        const r = RESOURCES.find((x) => sel.includes(x));
        if (r) {
          w.tools = w.tools.includes(r) ? w.tools.filter((x) => x !== r) : [...w.tools, r];
        }
      }
    } else if (pick.includes("write.delete")) {
      w.delete = !w.delete;
      ctx.ui.notify(`write.delete → ${w.delete}（涉及永久删除，请谨慎）`, "warning");
    } else if (pick.includes("write.rememberKey")) {
      w.rememberKey = !w.rememberKey;
      ctx.ui.notify(`write.rememberKey → ${w.rememberKey}`, "info");
    } else if (pick.includes("baseUrl")) {
      const v = await ctx.ui.select("baseUrl（默认 127.0.0.1:23119）", [
        "http://127.0.0.1:23119/api",
        "── 返回 ──",
      ]);
      if (v && !v.startsWith("──")) cfg.baseUrl = v;
    }
    saveConfig(cfg);
  }
}

/** 配置 JSON 序列化辅助（供 saveConfig 用，保证结构完整） */
export function serializeConfig(cfg: ZoteroConfig): Record<string, unknown> {
  return { ...cfg, write: { ...cfg.write } };
}
