/**
 * Small, rendering-only box helpers. Widgets, Todo and Diff remain separate
 * modules; they may share this geometry without sharing state or interaction.
 *
 * Behaviour is adapted from the MIT @mohndoe/pi-tui-extras BorderBox design,
 * rewritten as pure cc-tui functions instead of a TUI component dependency.
 */

import type { IconMode } from "./icons.ts";
import { alignText, alignTextEnds, clipText, padText } from "./text.ts";

export type BorderStyle = "rounded" | "single" | "double" | "heavy" | "ascii";
export type BorderGlyphs = Readonly<{
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
}>;

const BORDER_STYLES: Readonly<Record<BorderStyle, BorderGlyphs>> = {
	rounded: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	single: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" },
	double: { topLeft: "╔", topRight: "╗", bottomLeft: "╚", bottomRight: "╝", horizontal: "═", vertical: "║" },
	heavy: { topLeft: "┏", topRight: "┓", bottomLeft: "┗", bottomRight: "┛", horizontal: "━", vertical: "┃" },
	ascii: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" },
};

export function resolveBorderStyle(style: BorderStyle = "rounded", iconMode?: IconMode): BorderGlyphs {
	return BORDER_STYLES[iconMode === "ascii" ? "ascii" : style];
}

function clippedLabel(label: string, innerWidth: number): string {
	return clipText(label, Math.max(0, innerWidth - 4), "…");
}

/** Render one labelled or plain top/bottom border at an exact display width. */
export function renderBorderLine(options: {
	width: number;
	side: "top" | "bottom";
	glyphs?: BorderGlyphs;
	label?: string;
	labelAlignment?: "left" | "right" | "center";
	paint?: (text: string) => string;
}): string {
	const { width, side, glyphs = resolveBorderStyle(), label, labelAlignment = "left", paint = (text) => text } = options;
	if (width <= 0) return "";
	if (width === 1) return paint(side === "top" ? glyphs.topLeft : glyphs.bottomLeft);
	const left = side === "top" ? glyphs.topLeft : glyphs.bottomLeft;
	const right = side === "top" ? glyphs.topRight : glyphs.bottomRight;
	const innerWidth = width - 2;
	if (!label || innerWidth < 3) return paint(`${left}${glyphs.horizontal.repeat(innerWidth)}${right}`);

	const decorated = `${glyphs.horizontal} ${clippedLabel(label, innerWidth)} ${glyphs.horizontal}`;
	const content = labelAlignment === "center"
		? alignText(decorated, innerWidth, "center", glyphs.horizontal)
		: labelAlignment === "right"
			? alignTextEnds("", decorated, innerWidth, glyphs.horizontal)
			: alignTextEnds(decorated, "", innerWidth, glyphs.horizontal);
	return paint(`${left}${content}${right}`);
}

/** Render a bounded content row between vertical edges. */
export function renderBoxLine(options: {
	content: string;
	width: number;
	glyphs?: BorderGlyphs;
	paint?: (text: string) => string;
	paddingLeft?: number;
	paddingRight?: number;
}): string {
	const { content, width, glyphs = resolveBorderStyle(), paint = (text) => text, paddingLeft = 0, paddingRight = 0 } = options;
	if (width <= 0) return "";
	if (width <= 2) return clipText(content, width, "");
	const innerWidth = width - 2;
	const leftPadding = " ".repeat(Math.min(Math.max(0, paddingLeft), innerWidth));
	const rightPadding = " ".repeat(Math.min(Math.max(0, paddingRight), Math.max(0, innerWidth - leftPadding.length)));
	const textWidth = Math.max(0, innerWidth - leftPadding.length - rightPadding.length);
	return `${paint(glyphs.vertical)}${leftPadding}${padText(content, textWidth, "…")}${rightPadding}${paint(glyphs.vertical)}`;
}
