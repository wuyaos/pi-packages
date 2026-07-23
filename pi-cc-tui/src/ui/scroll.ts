/** Pure, Pi-independent scroll math shared by read-only cc-tui overlays. */

export type ScrollAction = { type: "delta"; lines: number } | { type: "home" } | { type: "end" };

export function clampScrollOffset(offset: number, contentLines: number, viewportLines: number): number {
	const max = Math.max(0, contentLines - Math.max(1, viewportLines));
	if (!Number.isFinite(offset)) return 0;
	return Math.max(0, Math.min(Math.trunc(offset), max));
}

/** Resolve common terminal and vim-like navigation input without a TUI dependency. */
export function scrollActionForInput(data: string, pageSize: number): ScrollAction | undefined {
	const page = Math.max(1, Math.trunc(pageSize) || 1);
	if (["k", "K", "\x10", "\x1b[A", "\x1bOA"].includes(data)) return { type: "delta", lines: -1 };
	if (["j", "J", "\x0e", "\x1b[B", "\x1bOB"].includes(data)) return { type: "delta", lines: 1 };
	if (["\x1b[5~", "\x1bv"].includes(data)) return { type: "delta", lines: -page };
	if (["\x1b[6~", "\x16"].includes(data)) return { type: "delta", lines: page };
	if (["g", "\x1b[H", "\x1b[1~", "\x1bOH"].includes(data)) return { type: "home" };
	if (["G", "\x1b[F", "\x1b[4~", "\x1bOF"].includes(data)) return { type: "end" };
	return undefined;
}

export function applyScrollAction(
	action: ScrollAction,
	currentOffset: number,
	contentLines: number,
	viewportLines: number,
): number {
	const max = Math.max(0, contentLines - Math.max(1, viewportLines));
	if (action.type === "home") return 0;
	if (action.type === "end") return max;
	return clampScrollOffset(currentOffset + action.lines, contentLines, viewportLines);
}

export function scrollRangeLabel(offset: number, viewportLines: number, contentLines: number): string {
	if (contentLines <= 0) return "0/0";
	const start = Math.min(contentLines, offset + 1);
	const end = Math.min(contentLines, offset + Math.max(1, viewportLines));
	return `${start}-${end}/${contentLines}`;
}
