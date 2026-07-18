import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const BRAND_RGB = "215;119;87";
export const brand = (text: string) => `\x1b[38;2;${BRAND_RGB}m${text}\x1b[39m`;

/**
 * Build a block-cursor open style from a theme foreground ANSI sequence.
 * Turns `38;…` (fg) into `48;…` (bg) and pairs it with a dark foreground.
 */
export function cursorOpenFromFgAnsi(fgAnsi: string): string {
	const bg = fgAnsi.replace("\x1b[38;", "\x1b[48;").replace("\u001b[38;", "\u001b[48;");
	// Dark ink on the accent block for contrast (same idea as the old brand cursor).
	return `${bg}\x1b[38;2;24;24;30m`;
}

/** Fallback when theme accent is unavailable. */
export const cursorStyleOpen = () => cursorOpenFromFgAnsi(`\x1b[38;2;${BRAND_RGB}m`);

/**
 * Logo half is the hero (Claude Code style): it takes most of the width and
 * grows on wide terminals so the mark stays centered in a large left area.
 * Tips are a narrow right sidebar that truncates with an ellipsis.
 */
/** Narrowest left column that still fits the animated logo (8×3 cells). */
export const MIN_LEFT_WIDTH = 28;
/** Narrowest tips sidebar; below this, tips are hidden. */
export const MIN_TIPS_WIDTH = 16;
/** Cap tips so they never steal the logo half on wide terminals. */
export const MAX_TIPS_WIDTH = 28;
const COLUMN_GAP = 3; // ` ${divider} `
/** Zero-width APC marker emitted by pi-tui before the fake cursor when focused. */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

/** Strip CSI SGR and APC sequences so border detection can inspect plain text. */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
}

export function formatCwd(cwd: string, home = process.env.HOME): string {
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Prefer `provider/id` when available (matches other pi extension examples). */
export function formatModelLabel(model: { provider?: string; id?: string } | null | undefined): string {
	if (!model?.id) return "Default model";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

export function formatThinkingLabel(level: string): string {
	return level === "off" ? "off" : level;
}

/**
 * Built-in interactive slash command names (from pi's BUILTIN_SLASH_COMMANDS).
 * `pi.getCommands()` only returns extension/prompt/skill commands, so we keep
 * this list to surface real host commands in tips.
 */
export const PI_BUILTIN_SLASH_COMMAND_NAMES = [
	"settings",
	"model",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
] as const;

/**
 * Build tip lines: always include `fixed` (default `/use-default-tui`), then
 * `count` random picks from the available command pool.
 * Returns slash-prefixed names, e.g. `["/use-default-tui", "/model", ...]`.
 */
export function pickSlashCommandTips(
	availableNames: readonly string[],
	options: {
		fixed?: readonly string[];
		count?: number;
		exclude?: readonly string[];
		/** Injected RNG in [0, 1) for tests. */
		random?: () => number;
	} = {},
): string[] {
	const fixed = [...(options.fixed ?? ["use-default-tui"])];
	const count = options.count ?? 3;
	const exclude = new Set<string>([
		...(options.exclude ?? []),
		...fixed,
		// Don't advertise re-enabling this package look in the tips list.
		"use-claude-code-tui",
	]);
	const random = options.random ?? Math.random;

	const pool = [...new Set(availableNames.map((n) => n.trim()).filter(Boolean))].filter(
		(name) => !exclude.has(name),
	);

	// Partial Fisher–Yates for `count` samples without bias.
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const tmp = pool[i]!;
		pool[i] = pool[j]!;
		pool[j] = tmp;
	}

	const picked = pool.slice(0, Math.max(0, count));
	return [...fixed, ...picked].map((name) => (name.startsWith("/") ? name : `/${name}`));
}

/** Collect host builtins + session commands from `pi.getCommands()`. */
export function collectPiCommandNames(sessionCommands: readonly { name: string }[]): string[] {
	const names = new Set<string>(PI_BUILTIN_SLASH_COMMAND_NAMES);
	for (const command of sessionCommands) {
		if (command.name) names.add(command.name);
	}
	return [...names];
}

export function center(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…");
	return `${" ".repeat(Math.floor((width - w) / 2))}${text}`;
}

export function padRight(text: string, width: number, ellipsis = ""): string {
	const clipped = truncateToWidth(text, width, ellipsis);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * Layout widths for the startup header body (Claude Code proportions).
 *
 * - Tips sidebar ≈ 28% of width, clamped to [MIN_TIPS_WIDTH, MAX_TIPS_WIDTH].
 * - Left (logo) gets the rest and stays the wider half.
 * - Narrow: hide tips and give the left column the full inner width.
 */
export function headerColumnWidths(
	innerWidth: number,
	minTipsWidth = MIN_TIPS_WIDTH,
	maxTipsWidth = MAX_TIPS_WIDTH,
	minLeftWidth = MIN_LEFT_WIDTH,
): { leftWidth: number; rightWidth: number; useTips: boolean } {
	if (innerWidth <= 0) {
		return { leftWidth: 0, rightWidth: 0, useTips: false };
	}

	const gap = COLUMN_GAP;
	if (innerWidth < minLeftWidth + gap + minTipsWidth) {
		return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
	}

	// Narrow tips sidebar; logo half absorbs the remaining width.
	let rightWidth = Math.min(maxTipsWidth, Math.max(minTipsWidth, Math.round(innerWidth * 0.28)));
	let leftWidth = innerWidth - gap - rightWidth;

	if (leftWidth < minLeftWidth) {
		leftWidth = minLeftWidth;
		rightWidth = innerWidth - gap - leftWidth;
	}

	// Keep logo half strictly wider than tips (Claude Code feel).
	if (leftWidth <= rightWidth) {
		leftWidth = Math.ceil((innerWidth - gap) * 0.65);
		rightWidth = innerWidth - gap - leftWidth;
	}

	if (rightWidth < minTipsWidth || leftWidth < minLeftWidth) {
		return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
	}

	return { leftWidth, rightWidth, useTips: true };
}

/**
 * True for the editor's horizontal rule rows (plain ─ fill or scroll indicators).
 * Content and autocomplete rows start with padding spaces and do not match.
 */
export function isEditorBorderLine(line: string): boolean {
	const plain = stripAnsi(line);
	if (/^─+$/.test(plain)) return true;
	if (/^─*\s*[↑↓]\s+\d+\s+more\s*─*$/.test(plain)) return true;
	return false;
}

/** Index of the bottom border in Editor.render output (before autocomplete rows). */
export function findBottomBorderIndex(lines: string[]): number {
	for (let i = lines.length - 1; i >= 1; i--) {
		if (isEditorBorderLine(lines[i]!)) return i;
	}
	return Math.max(0, lines.length - 1);
}

export function roundedBorderLine(
	sourceLine: string,
	width: number,
	kind: "top" | "bottom",
	color: (text: string) => string = brand,
): string {
	if (width < 2) return color(truncateToWidth(kind === "top" ? "╭╮" : "╰╯", width, ""));

	const corners = kind === "top" ? (["╭", "╮"] as const) : (["╰", "╯"] as const);
	const plain = stripAnsi(sourceLine);
	const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);

	if (scrollMatch) {
		const label = `─── ${scrollMatch[1]} `;
		const fill = Math.max(0, width - 2 - visibleWidth(label));
		return color(`${corners[0]}${label}${"─".repeat(fill)}${corners[1]}`);
	}

	return color(`${corners[0]}${"─".repeat(Math.max(0, width - 2))}${corners[1]}`);
}

/**
 * Restyle only the editor fake cursor (reverse-video span), not other reverse video.
 * Prefer the focused form with CURSOR_MARKER; fall back to the first short reverse span.
 */
export function restyleEditorCursor(line: string, openStyle: string): string {
	const markerIdx = line.indexOf(CURSOR_MARKER);
	if (markerIdx !== -1) {
		// Focused editor: only restyle the reverse-video span immediately after the marker.
		const afterMarker = markerIdx + CURSOR_MARKER.length;
		const tail = line.slice(afterMarker);
		const replacedTail = tail.replace(/\x1b\[7m([^\x1b]*)\x1b\[0m/, `${openStyle}$1\x1b[0m`);
		return line.slice(0, afterMarker) + replacedTail;
	}

	// Unfocused: restyle only the first reverse-video span with no nested escapes
	// (cursor is a single grapheme or space).
	return line.replace(/\x1b\[7m([^\x1b]*)\x1b\[0m/, `${openStyle}$1\x1b[0m`);
}

/**
 * Apply half-open rounded borders (top + bottom only) to Editor.render output.
 * Leaves content rows and autocomplete rows without vertical sides.
 */
export function applyRoundedEditorBorders(
	lines: string[],
	width: number,
	color: (text: string) => string = brand,
): string[] {
	if (lines.length === 0 || width < 4) return lines;

	const result = lines.slice();
	const bottomIdx = findBottomBorderIndex(result);

	result[0] = roundedBorderLine(result[0]!, width, "top", color);
	result[bottomIdx] = roundedBorderLine(result[bottomIdx]!, width, "bottom", color);

	return result.map((line) => padRight(truncateToWidth(line, width, ""), width));
}
