/** pi-cc-tui 统一命令入口。 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyEditor, restoreEditor } from "./editor.ts";
import { applyStartupHeader, disposeStartupHeader } from "./startup-header.ts";
import { applyStatusline, restoreDefaultFooter, segmentConfig, saveConfig, loadConfig, configSummary } from "./statusline.ts";
import { ConfigMenuComponent, type MenuResult } from "./menu.ts";
import { loadCcTuiConfig, saveCcTuiIcons } from "../src/config/cc-tui-config.ts";
import { isStartupResourceListingVisible, saveStartupResourceListingVisible } from "../src/config/pi-startup.ts";
import { configureIcons, getIconMode } from "../src/ui/icons.ts";
import { createScrollableOverlay, SCROLLABLE_OVERLAY_OPTIONS } from "../src/overlays/scrollable-overlay.ts";
import { buildContextReportLines } from "../src/overlays/context-report.ts";
import { buildToolReportLines } from "../src/overlays/tool-report.ts";

const USAGE = `用法:
  /cc-tui          打开交互式配置面板
  /cc-tui context  打开只读上下文诊断面板
  /cc-tui tools    打开只读工具调用诊断面板
  /cc-tui apply    启用 CC-TUI 核心界面
  /cc-tui reset    恢复 Pi 原生输入框和页脚

状态栏和外观设置请在 /cc-tui 配置面板中修改。`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cc-tui", {
		description: "打开 CC-TUI 配置面板，或使用 context/tools/apply/reset 核心操作",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const action = tokens[0] || "menu";

			// ── menu: 交互式配置菜单 (默认) ──
			if (action === "menu") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(configSummary(), "info");
					return;
				}
				const persisted = loadCcTuiConfig();
				const result = await ctx.ui.custom<MenuResult | undefined>(
					(_tui, theme, _kb, done) =>
						new ConfigMenuComponent(
							theme,
							done,
							segmentConfig,
							getIconMode(),
							isStartupResourceListingVisible(),
						),
					{
						overlay: true,
						overlayOptions: () => ({
							width: 86,
							maxHeight: 18,
							anchor: "center",
						}),
					},
				);
				if (result?.changed) {
					saveConfig(segmentConfig);
					const saved = saveCcTuiIcons({ mode: result.iconMode, overrides: persisted.icons.overrides });
					configureIcons(saved.icons);
					if (result.startupResourcesChanged) {
						saveStartupResourceListingVisible(result.startupResourcesVisible);
					}
					Object.assign(segmentConfig, loadConfig());
					applyStatusline(ctx);
					const startupHint = result.startupResourcesChanged
						? "；启动资源清单设置将在 /reload 或重启后生效"
						: "";
					ctx.ui.notify(`${configSummary()}${startupHint}`, "info");
				}
				return;
			}

			// ── context: 只读 Overlay，不写入模型上下文 ──
			if (action === "context") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("上下文诊断面板仅在 TUI 模式可用", "info");
					return;
				}
				const lines = buildContextReportLines(ctx);
				await ctx.ui.custom<undefined>(
					(tui, theme, _kb, done) => createScrollableOverlay(tui, theme, done, {
						title: "CC-TUI 上下文诊断",
						lines,
					}),
					SCROLLABLE_OVERLAY_OPTIONS,
				);
				return;
			}

			// ── tools: 只读工具诊断 Overlay，不写入模型上下文 ──
			if (action === "tools") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("工具诊断面板仅在 TUI 模式可用", "info");
					return;
				}
				const lines = buildToolReportLines(ctx);
				await ctx.ui.custom<undefined>(
					(tui, theme, _kb, done) => createScrollableOverlay(tui, theme, done, {
						title: "CC-TUI 工具诊断",
						lines,
					}),
					SCROLLABLE_OVERLAY_OPTIONS,
				);
				return;
			}

			// ── apply: 启用全部 TUI 组件 ──
			if (action === "apply") {
				applyStartupHeader(pi, ctx);
				applyEditor(ctx);
				applyStatusline(ctx);
				ctx.ui.notify("已启用 pi-cc-tui (启动头+输入框+状态栏)", "info");
				return;
			}

			// ── reset: 恢复 pi 原生 ──
			if (action === "reset") {
				disposeStartupHeader();
				restoreEditor(ctx);
				restoreDefaultFooter(ctx);
				ctx.ui.setTitle("pi");
				ctx.ui.setHeader(undefined);
				ctx.ui.notify("已恢复 pi 默认 TUI", "info");
				return;
			}

			ctx.ui.notify(USAGE, "warning");
		},
	});
}
