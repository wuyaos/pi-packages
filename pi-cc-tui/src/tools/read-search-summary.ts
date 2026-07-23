/**
 * Pure, bounded presentation helpers for read/grep/find/ls.
 *
 * These functions deliberately accept only tool arguments and result text. They
 * never touch the filesystem, session, or model context, which keeps tool
 * display independent from tool execution and makes the output safe to test.
 */

import { getIcons } from "../ui/icons.ts";

export const COMPACT_RESULT_LINES = 12;
export const EXPANDED_RESULT_LINES = 200;
export const MAX_RESULT_CHARACTERS = 64 * 1024;

export type ReadSearchToolName = "read" | "grep" | "find" | "ls";
export type ReadSearchArgs = Readonly<Record<string, unknown>>;

function stringField(args: ReadSearchArgs, name: string, fallback = ""): string {
	return typeof args[name] === "string" ? args[name] as string : fallback;
}

function numberField(args: ReadSearchArgs, name: string): number | undefined {
	return typeof args[name] === "number" && Number.isFinite(args[name]) ? args[name] as number : undefined;
}

/** Remove terminal controls and non-printing control bytes before TUI display. */
export function sanitizeToolDisplayText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[\^_][\s\S]*?\x1B\\)/g, "")
		.replace(/\r/g, "")
		.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

function compactPath(value: string): string {
	return value || ".";
}

/** Build a concise, semantic call description without relying on raw tool output. */
export function describeReadSearchCall(name: ReadSearchToolName, args: ReadSearchArgs): string {
	const icon = getIcons().tool;
	if (name === "read") {
		const offset = numberField(args, "offset");
		const limit = numberField(args, "limit");
		const range = offset === undefined && limit === undefined
			? ""
			: `:${offset ?? 1}${limit === undefined ? "" : `-${(offset ?? 1) + limit - 1}`}`;
		return `${icon} read ${compactPath(stringField(args, "path", "…"))}${range}`;
	}

	if (name === "grep") {
		const glob = stringField(args, "glob");
		const limit = numberField(args, "limit");
		return `${icon} grep /${stringField(args, "pattern", "")}/ in ${compactPath(stringField(args, "path"))}${glob ? ` (${glob})` : ""}${limit === undefined ? "" : ` · ${limit}`}`;
	}

	if (name === "find") {
		const limit = numberField(args, "limit");
		return `${icon} find ${stringField(args, "pattern", "") || "…"} in ${compactPath(stringField(args, "path"))}${limit === undefined ? "" : ` · ${limit}`}`;
	}

	const limit = numberField(args, "limit");
	return `${icon} ls ${compactPath(stringField(args, "path"))}${limit === undefined ? "" : ` · ${limit}`}`;
}

/** Extract only text blocks from a ToolDefinition result without exposing image payloads. */
export function toolResultText(result: { content?: readonly unknown[] } | undefined): string {
	const blocks = result?.content ?? [];
	return blocks
		.filter((block): block is { type: "text"; text?: unknown } =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
		)
		.map((block) => sanitizeToolDisplayText(block.text))
		.filter(Boolean)
		.join("\n");
}

export type BoundedToolPreview = Readonly<{
	lines: readonly string[];
	hiddenLines: number;
	truncatedCharacters: boolean;
}>;

/**
 * Keep rendering bounded even when a third-party implementation returns a
 * giant result. Expanded views are larger but retain a hard, predictable cap.
 */
export function buildBoundedToolPreview(text: string, expanded: boolean): BoundedToolPreview {
	const safe = sanitizeToolDisplayText(text);
	const truncatedCharacters = safe.length > MAX_RESULT_CHARACTERS;
	const source = (truncatedCharacters ? safe.slice(0, MAX_RESULT_CHARACTERS) : safe).split("\n");
	const lineLimit = expanded ? EXPANDED_RESULT_LINES : COMPACT_RESULT_LINES;
	return Object.freeze({
		lines: Object.freeze(source.slice(0, lineLimit)),
		hiddenLines: Math.max(0, source.length - lineLimit),
		truncatedCharacters,
	});
}

/** Render a bounded result body; callers apply theme colours around this text. */
export function describeReadSearchResult(text: string, expanded: boolean): string {
	const preview = buildBoundedToolPreview(text, expanded);
	if (preview.lines.length === 0 || (preview.lines.length === 1 && preview.lines[0] === "")) return "";
	const notices: string[] = [];
	if (preview.hiddenLines > 0) notices.push(`${preview.hiddenLines} 行未显示`);
	if (preview.truncatedCharacters) notices.push("输出过大，已截断");
	return `${preview.lines.join("\n")}${notices.length > 0 ? `\n… ${notices.join("；")}（展开查看更多）` : ""}`;
}

/** Only claim a built-in when no extension already owns its same-name override. */
export function isBuiltinToolOwner(tool: { sourceInfo?: { source?: unknown } } | undefined): boolean {
	return tool?.sourceInfo?.source === "builtin";
}
