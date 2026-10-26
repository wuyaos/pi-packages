/**
 * pi-cc-tui 的唯一扩展入口。
 *
 * 所有扩展生命周期的注册均从此处装配，避免 package glob 让辅助模块被
 * 当作独立扩展加载，亦为后续 tools/widgets/overlays 提供稳定的装配边界。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyEditor } from "./editor.ts";
import installCommands from "./commands.ts";
import installStartupHeader from "./startup-header.ts";
import installStatusline from "./statusline.ts";
import { loadHistory, otherSessionHistory, pushHistory, saveHistory, sessionUserTexts, fullHistory } from "./input-history.ts";

export default function installCcTui(pi: ExtensionAPI): void {
	installCommands(pi);
	installStartupHeader(pi);
	installStatusline(pi);

	// ── 输入历史持久化（项目级），详见 input-history.ts ──
	let sessionDir = "";
	let writeQueue: Promise<void> = Promise.resolve();
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		sessionDir = ctx.sessionManager.getSessionDir();
		const persisted = await loadHistory(sessionDir);
		const sessionTexts = sessionUserTexts(ctx);
		// startup 后 pi 会原生回填当前会话；其他 reason 的编辑器重建不会保留 history。
		const history = persisted ?? [];
		const fill = event.reason === "startup"
			? otherSessionHistory(history, sessionTexts)
			: fullHistory(history, sessionTexts);
		applyEditor(ctx, fill);
	});
	pi.on("input", async (event, _ctx) => {
		if (event.source !== "interactive" || !sessionDir) return { action: "continue" };
		const text = event.text.trim();
		if (!text) return { action: "continue" };
		const dir = sessionDir;
		// 串行化 read-modify-write，避免同实例并发提交（如 steer + 主提交）互相覆盖丢历史；
		// 跨进程为 last-write-wins，属已知限制
		writeQueue = writeQueue.catch(() => {}).then(async () => {
			const history = await loadHistory(dir);
			if (!history) return; // 读取异常（非 ENOENT）时不写盘，防止覆盖既有历史
			await saveHistory(dir, pushHistory(history, text));
		});
		await writeQueue;
		return { action: "continue" };
	});
}
