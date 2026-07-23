/** Pure user-message transcript chrome; safe to test without Pi runtime imports. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderBorderLine, resolveBorderStyle } from "../ui/box.ts";
import { getIconMode, getIcons } from "../ui/icons.ts";
import { clipText, padText } from "../ui/text.ts";

/** Wrap host-rendered lines, preserving Markdown formatting and existing semantics. */
export function renderUserMessageChrome(
	lines: readonly string[],
	width: number,
	paint: (token: "border" | "accent", text: string) => string = (_token, text) => text,
): string[] {
	if (width <= 0) return [""];
	if (width < 8) return lines.map((line) => clipText(line, width, ""));

	const glyphs = resolveBorderStyle("rounded", getIconMode());
	const paintBorder = (text: string) => paint("border", text);
	const rail = paint("accent", `${getIcons().user} `);
	const innerWidth = Math.max(0, width - 2);
	const contentWidth = Math.max(0, innerWidth - visibleWidth(rail));
	const body = lines.length > 0 ? lines : [""];
	const framed = body.map((line) => {
		const content = `${rail}${padText(line, contentWidth, "")}`;
		return `${paintBorder(glyphs.vertical)}${truncateToWidth(content, innerWidth, "")}${paintBorder(glyphs.vertical)}`;
	});
	return [
		renderBorderLine({ width, side: "top", glyphs, label: "用户消息", paint: paintBorder }),
		...framed,
		renderBorderLine({ width, side: "bottom", glyphs, paint: paintBorder }),
	];
}
