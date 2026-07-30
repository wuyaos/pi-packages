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

/** 带优先级的左侧段；窄屏时低优先级段先被丢弃或截断。 */
export type PrioritizedSegment = {
	text: string;
	/** 数值越小，窄屏时越先被丢弃。 */
	priority: number;
};

/**
 * Pack segments into maxWidth, shrinking/dropping lowest-priority segments first.
 * Higher priority = survives longer. Returns the surviving segment texts in
 * original order, space-joined. Each segment is either kept whole, truncated
 * with ellipsis, or dropped entirely.
 */
export function fitSegmentsByPriority(
	segs: readonly PrioritizedSegment[],
	maxW: number,
	ellipsis = "...",
): string[] {
	const items = segs.map((s) => ({ text: s.text, priority: s.priority, w: visibleWidth(s.text) }));
	const totalW = () => {
		const active = items.filter((it) => it.text !== "");
		return active.reduce((a, it) => a + it.w, 0) + Math.max(0, active.length - 1);
	};
	while (totalW() > maxW) {
		let target = -1;
		for (let i = 0; i < items.length; i++) {
			if (items[i]!.text !== "" && (target === -1 || items[i]!.priority < items[target]!.priority)) {
				target = i;
			}
		}
		if (target === -1) break;
		const others = items.filter((_, i) => i !== target && items[i]!.text !== "");
		const otherW = others.reduce((a, it) => a + it.w, 0) + Math.max(0, others.length - 1);
		const avail = maxW - otherW - (others.length > 0 ? 1 : 0);
		if (avail <= visibleWidth(ellipsis)) {
			items[target]!.text = "";
			items[target]!.w = 0;
		} else if (avail < items[target]!.w) {
			items[target]!.text = clipText(items[target]!.text, avail, ellipsis);
			items[target]!.w = visibleWidth(items[target]!.text);
		} else {
			break;
		}
	}
	return items.filter((it) => it.text !== "").map((it) => it.text);
}

/**
 * renderFooterEnds 的优先级裁剪版：左侧段按优先级窄屏逐级丢弃，右侧
 * telemetry 整体保留。比 renderFooterEnds 的整体 clip left 更适合多段左侧。
 */
export function renderFooterEndsPrioritized(
	left: readonly PrioritizedSegment[],
	right: string,
	width: number,
	ellipsis = "...",
): string {
	if (width <= 0) return "";
	const hasLeft = left.some((s) => s.text !== "");
	if (!hasLeft) return right ? `${" ".repeat(Math.max(0, width - visibleWidth(right)))}${right}` : "";
	if (!right) {
		return fitSegmentsByPriority(left, width, ellipsis).join(" ");
	}
	const rightW = visibleWidth(right);
	if (rightW >= width) return clipText(right, width, ellipsis);
	const availLeft = Math.max(0, width - rightW - 1);
	const fitted = fitSegmentsByPriority(left, availLeft, ellipsis);
	const leftStr = fitted.join(" ");
	const leftW = visibleWidth(leftStr);
	const pad = width - leftW - rightW;
	if (pad >= 1) return `${leftStr}${" ".repeat(pad)}${right}`;
	return `${leftStr}${right}`.slice(0, width);
}

/** 按 provider 语义着色，让不同厂商一眼可辨；用 includes 宽松匹配，覆盖 cpa-openai-completions 等变体。 */
export function providerColor(provider: string): string {
	const p = provider.toLowerCase();
	if (p.includes("anthropic")) return "accent";
	if (p.includes("openai")) return "success";
	if (p.includes("google") || p.includes("gemini") || p.includes("vertex")) return "warning";
	if (p.includes("bedrock") || p.includes("copilot")) return "mdLink";
	if (p.includes("deepseek")) return "text";
	if (p.includes("xai") || p.includes("groq")) return "error";
	return "muted";
}

/** 按 thinking level 语义着色，级别越高越醒目。 */
export function effortColor(level: string): string {
	switch (level) {
		case "off":
		case "minimal":
			return "muted";
		case "low":
			return "dim";
		case "medium":
			return "text";
		case "high":
			return "accent";
		case "xhigh":
		case "max":
			return "warning";
		default:
			return "text";
	}
}

/**
 * 清理扩展状态文本：剥离 ANSI 转义/OSC 序列、控制字符替换为空格、
 * 合并多余空格并 trim。防止扩展误发的 ANSI 码破坏 footer 对齐。
 */
export function sanitizeStatus(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
