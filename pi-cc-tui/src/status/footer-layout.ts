/** 状态栏的宽度预算与降级规则；保持纯函数以便覆盖窄终端回归。 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { clipText, padText } from "../ui/text.ts";

const DEFAULT_DIVIDER = " │ ";

/**
 * 路径与半宽色条各固定获得可用显示宽度的一半。色条含 ANSI 背景，
 * 不能经过通用文本 padding，否则终端背景会泄漏到填充区。
 */
export function renderPrimaryFooterBarLine(
	path: string,
	bar: string,
	width: number,
	divider = DEFAULT_DIVIDER,
): string {
	if (width <= 0) return "";
	if (!path) return bar;
	if (!bar) return clipText(path, width);

	const dividerWidth = visibleWidth(divider);
	if (width <= dividerWidth + 2) return clipText(`${path} ${bar}`, width);
	const contentWidth = width - dividerWidth;
	const pathWidth = Math.floor(contentWidth / 2);
	const barWidth = contentWidth - pathWidth;
	const normalizedBar = visibleWidth(bar) > barWidth ? clipText(bar, barWidth, "") : bar;
	return `${padText(clipText(path, pathWidth), pathWidth)}${divider}${normalizedBar}`;
}

/**
 * Render a compact status row with one left-aligned identity segment and one
 * right-aligned telemetry group. If a narrow terminal cannot fit both, reserve
 * the right edge for telemetry and clip the identity segment first.
 */
export function renderFooterEnds(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!left) return clipText(right, width);
	if (!right) return clipText(left, width);
	const combinedWidth = visibleWidth(left) + visibleWidth(right);
	if (combinedWidth <= width) return `${left}${" ".repeat(width - combinedWidth)}${right}`;

	// The telemetry group is actionable while streaming, so keep it visible.
	const rightWidth = Math.min(visibleWidth(right), Math.max(1, Math.floor(width * 0.65)));
	const leftWidth = Math.max(0, width - rightWidth);
	return `${clipText(left, leftWidth)}${clipText(right, rightWidth)}`;
}
