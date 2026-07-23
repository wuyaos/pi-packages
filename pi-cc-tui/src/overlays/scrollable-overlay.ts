/**
 * Read-only, bounded custom overlay for diagnostics and future tool/context
 * viewers. It is deliberately display-only: callers pass prepared lines and
 * it never calls appendEntry/sendMessage or mutates agent context.
 *
 * Design reference: @zenspc/pi-devtools context overlay (MIT), rewritten with
 * cc-tui's box/text primitives and no private Pi APIs.
 */

import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getIconMode } from "../ui/icons.ts";
import { renderBorderLine, renderBoxLine, resolveBorderStyle } from "../ui/box.ts";
import {
	applyScrollAction,
	clampScrollOffset,
	scrollActionForInput,
	scrollRangeLabel,
} from "../ui/scroll.ts";
import { clipText } from "../ui/text.ts";

export const SCROLLABLE_OVERLAY_OPTIONS = {
	overlay: true as const,
	overlayOptions: {
		anchor: "top-left" as const,
		width: "100%" as const,
		maxHeight: "100%" as const,
		margin: 0,
	},
};

export type ScrollableOverlayOptions = {
	title: string;
	lines: readonly string[];
	maxLines?: number;
	maxLineChars?: number;
};

function terminalRows(tui: TUI): number {
	const rows = (tui as unknown as { terminal?: { rows?: unknown } }).terminal?.rows;
	if (typeof rows === "number" && rows > 0) return rows;
	return typeof process.stdout.rows === "number" && process.stdout.rows > 0 ? process.stdout.rows : 24;
}

function boundedLines(lines: readonly string[], maxLines: number, maxLineChars: number): string[] {
	const result = lines.slice(0, Math.max(0, maxLines)).map((line) => line.slice(0, maxLineChars));
	if (lines.length > result.length) result.push(`… ${lines.length - result.length} 行未显示`);
	return result;
}

/** A standalone Component factory makes it unit-testable without an ExtensionContext. */
export function createScrollableOverlay(
	tui: TUI,
	theme: Theme,
	done: (value: undefined) => void,
	options: ScrollableOverlayOptions,
): Component & { handleInput(data: string): void } {
	let offset = 0;
	let lastViewport = 1;
	const source = boundedLines(options.lines, options.maxLines ?? 2_000, options.maxLineChars ?? 4_000);

	return {
		render(width: number): string[] {
			if (width <= 0) return [""];
			const glyphs = resolveBorderStyle("rounded", getIconMode());
			const paintBorder = (text: string) => theme.fg("border", text);
			const rows = terminalRows(tui);
			// Top + bottom borders plus one persistent hint row.
			lastViewport = Math.max(1, rows - 3);
			offset = clampScrollOffset(offset, source.length, lastViewport);
			const innerWidth = Math.max(0, width - 2);
			const visible = source
				.slice(offset, offset + lastViewport)
				.map((line) => renderBoxLine({ content: clipText(line, innerWidth, "…"), width, glyphs, paint: paintBorder }));
			while (visible.length < lastViewport) visible.push(renderBoxLine({ content: "", width, glyphs, paint: paintBorder }));

			const canScroll = source.length > lastViewport;
			const range = canScroll ? `${scrollRangeLabel(offset, lastViewport, source.length)} · ` : "";
			const hint = `${range}↑↓/jk · PgUp/PgDn · Home/End · Esc 关闭 · 仅显示，不写入模型上下文`;
			return [
				renderBorderLine({ width, side: "top", glyphs, label: options.title, paint: paintBorder }),
				...visible,
				renderBoxLine({ content: theme.fg("dim", hint), width, glyphs, paint: paintBorder }),
				renderBorderLine({ width, side: "bottom", glyphs, paint: paintBorder }),
			];
		},
		invalidate() {},
		handleInput(data: string): void {
			if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
				done(undefined);
				return;
			}
			const action = scrollActionForInput(data, Math.max(1, lastViewport - 1));
			if (!action) return;
			const next = applyScrollAction(action, offset, source.length, lastViewport);
			if (next === offset) return;
			offset = next;
			tui.requestRender();
		},
	};
}
