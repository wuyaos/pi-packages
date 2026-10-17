/** 圆角输入框，移植自 pi-claude-code-tui (MIT, Phoobobo)。 */

import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	applyRoundedEditorBorders,
	cursorOpenFromFgAnsi,
	restyleEditorCursor,
} from "./render-utils.ts";

class CcTuiEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly cursorOpen: () => string,
	) {
		super(tui, theme, keybindings, { paddingX: 1 });
	}

	render(width: number): string[] {
		const open = this.cursorOpen();
		const paint = (text: string) => this.borderColor(text);
		const lines = super.render(width).map((line) => restyleEditorCursor(line, open));
		return applyRoundedEditorBorders(lines, width, paint);
	}
}

export function applyEditor(ctx: ExtensionContext, history: string[] = []): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const cursorOpen = () => cursorOpenFromFgAnsi(ctx.ui.theme.getFgAnsi("accent"));
		const editor = new CcTuiEditor(tui, theme, keybindings, cursorOpen);
		// 旧→新灌入，使 ↑ 先命中最近一条（项目级持久化历史，见 input-history.ts）
		for (let index = history.length - 1; index >= 0; index--) {
			editor.addToHistory?.(history[index]);
		}
		return editor;
	});
}

export function restoreEditor(ctx: ExtensionContext): void {
	ctx.ui.setEditorComponent(undefined);
}
