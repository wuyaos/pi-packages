/** pi-cc-tui 统一命令入口。 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyCodexEditor, restoreDefaultEditor } from "./codex-editor.ts";
import { applyStartupHeader, disposeStartupHeader } from "./startup-header.ts";
import { applyStatusline, restoreDefaultFooter, segmentConfig, SEGMENT_NAMES, saveConfig, loadConfig, isSegmentName, configSummary, gitEnabled } from "./statusline.ts";
import { getPreviewLines, setPreviewLines } from "./thinking.ts";
import { ConfigMenuComponent } from "./menu.ts";

const DEFAULT_PREVIEW = 5;

const USAGE = `用法:
  /cc-tui              打开交互式配置菜单
  /cc-tui on           开启全部段
  /cc-tui off          关闭全部段
  /cc-tui show <段>    开启指定段
  /cc-tui hide <段>    关闭指定段
  /cc-tui only <段>    只开启指定段
  /cc-tui git          切换 git 统计 (重启生效)
  /cc-tui preview <n>  thinking 折叠行数 (默认 5)
  /cc-tui apply        启用启动头+输入框+状态栏
  /cc-tui reset        恢复 pi 原生 TUI

段: ${SEGMENT_NAMES.join(", ")}`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cc-tui", {
		description: "配置状态栏: 交互式菜单或 list/on/off/show/hide/only/git/preview/apply/reset",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const action = tokens[0] || "menu";

			// ── menu: 交互式配置菜单 (默认) ──
			if (action === "menu") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(configSummary(), "info");
					return;
				}
				const result = await ctx.ui.custom(
					(_tui, theme, _kb, done) =>
						new ConfigMenuComponent(theme, done, segmentConfig, getPreviewLines()),
					{ overlay: true },
				);
				if (result?.changed) {
					saveConfig(segmentConfig);
					Object.assign(segmentConfig, loadConfig());
					applyStatusline(ctx);
					ctx.ui.notify(configSummary(), "info");
				}
				return;
			}

			// ── apply: 启用全部 TUI 组件 ──
			if (action === "apply") {
				applyStartupHeader(pi, ctx);
				applyCodexEditor(ctx);
				applyStatusline(ctx);
				ctx.ui.notify("已启用 pi-cc-tui (启动头+输入框+状态栏)", "info");
				return;
			}

			// ── reset: 恢复 pi 原生 ──
			if (action === "reset") {
				disposeStartupHeader();
				restoreDefaultEditor(ctx);
				restoreDefaultFooter(ctx);
				ctx.ui.setTitle("pi");
				ctx.ui.setHeader(undefined);
				ctx.ui.notify("已恢复 pi 默认 TUI", "info");
				return;
			}

			// ── git: 切换 git 统计 ──
			if (action === "git") {
				const next = gitEnabled ? "0" : "1";
				ctx.ui.notify(`重启 pi 后生效: PI_STATUSLINE_GIT=${next}`, "info");
				return;
			}

			// ── preview: thinking 折叠行数 ──
			if (action === "preview") {
				const n = parseInt(tokens[1] || "", 10);
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify(`无效行数，重置为 ${DEFAULT_PREVIEW}`, "warning");
					setPreviewLines(DEFAULT_PREVIEW);
					return;
				}
				setPreviewLines(n);
				ctx.ui.notify(`Thinking 折叠: ${getPreviewLines()} 行`, "info");
				return;
			}

			// ── 段配置 ──
			if (action === "list") {
				ctx.ui.notify(configSummary(), "info");
				return;
			}

			if (action === "all" || action === "on") {
				for (const name of SEGMENT_NAMES) segmentConfig[name] = true;
			} else if (action === "none" || action === "off") {
				for (const name of SEGMENT_NAMES) segmentConfig[name] = false;
			} else if (action === "only") {
				const names = tokens.slice(1);
				const invalid = names.filter((name) => !isSegmentName(name));
				if (invalid.length > 0) {
					ctx.ui.notify(`未知段: ${invalid.join(", ")}`, "warning");
					return;
				}
				for (const name of SEGMENT_NAMES) segmentConfig[name] = false;
				for (const name of names) segmentConfig[name as keyof typeof segmentConfig] = true;
			} else if (action === "show" || action === "hide") {
				const names = tokens.slice(1);
				if (names.length === 0) {
					ctx.ui.notify(USAGE, "warning");
					return;
				}
				const invalid = names.filter((name) => !isSegmentName(name));
				if (invalid.length > 0) {
					ctx.ui.notify(`未知段: ${invalid.join(", ")}`, "warning");
					return;
				}
				for (const name of names) segmentConfig[name as keyof typeof segmentConfig] = action === "show";
			} else {
				ctx.ui.notify(USAGE, "warning");
				return;
			}

			saveConfig(segmentConfig);
			Object.assign(segmentConfig, loadConfig());
			applyStatusline(ctx);
			ctx.ui.notify(configSummary(), "info");
		},
	});
}
