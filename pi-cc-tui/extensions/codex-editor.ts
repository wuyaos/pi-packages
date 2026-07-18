/** Codex 风格圆角输入框，移植自 pi-claude-code-tui (MIT, Phoobobo)。 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	applyRoundedEditorBorders,
	cursorOpenFromFgAnsi,
	restyleEditorCursor,
} from "./render-utils.ts";

class CodexStyleEditor extends CustomEditor {
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

export function applyCodexEditor(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const cursorOpen = () => cursorOpenFromFgAnsi(ctx.ui.theme.getFgAnsi("accent"));
		return new CodexStyleEditor(tui, theme, keybindings, cursorOpen);
	});
}

export function restoreDefaultEditor(ctx: ExtensionContext): void {
	ctx.ui.setEditorComponent(undefined);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => applyCodexEditor(ctx));
}
