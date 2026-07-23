/** ANSI-aware text layout primitives shared by every cc-tui visual module. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type HorizontalAlignment = "left" | "right" | "center";

/** Truncate by terminal display width while preserving Pi's ANSI-safe behavior. */
export function clipText(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, ellipsis);
}

/** Fill a line to exactly the requested visible width whenever possible. */
export function padText(text: string, width: number, ellipsis = ""): string {
	const clipped = clipText(text, width, ellipsis);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

/** Align ANSI-coloured content in a fixed display width. */
export function alignText(
	text: string,
	width: number,
	alignment: HorizontalAlignment = "left",
	fill = " ",
): string {
	const clipped = clipText(text, width, "…");
	const remaining = Math.max(0, width - visibleWidth(clipped));
	if (alignment === "left") return `${clipped}${fill.repeat(remaining)}`;
	if (alignment === "right") return `${fill.repeat(remaining)}${clipped}`;
	const before = Math.floor(remaining / 2);
	return `${fill.repeat(before)}${clipped}${fill.repeat(remaining - before)}`;
}

/** Place two ANSI-coloured labels at opposite ends, trimming the right side first. */
export function alignTextEnds(left: string, right: string, width: number, fill = " "): string {
	if (width <= 0) return "";
	const clippedLeft = clipText(left, width, "…");
	const remainingAfterLeft = Math.max(0, width - visibleWidth(clippedLeft));
	const clippedRight = clipText(right, remainingAfterLeft, "…");
	return `${clippedLeft}${fill.repeat(Math.max(0, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight)))}${clippedRight}`;
}
