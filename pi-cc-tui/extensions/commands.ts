/** pi-cc-tui 统一启用和恢复命令。 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyCodexEditor, restoreDefaultEditor } from "./codex-editor.ts";
import { applyStartupHeader, disposeStartupHeader } from "./startup-header.ts";
import { applyStatusline, restoreDefaultFooter } from "./statusline.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("use-cc-tui", {
		description: "启用 pi-cc-tui 启动头、Codex 输入框和状态栏",
		handler: async (_args, ctx) => {
			applyStartupHeader(pi, ctx);
			applyCodexEditor(ctx);
			applyStatusline(ctx);
			ctx.ui.notify("已启用 pi-cc-tui", "info");
		},
	});

	pi.registerCommand("use-default-tui", {
		description: "恢复 pi 内置启动头、输入框和状态栏",
		handler: async (_args, ctx) => {
			disposeStartupHeader();
			restoreDefaultEditor(ctx);
			restoreDefaultFooter(ctx);
			ctx.ui.setTitle("pi");
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("已恢复 pi 默认 TUI", "info");
		},
	});
}
