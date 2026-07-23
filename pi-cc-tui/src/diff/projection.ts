/**
 * Pure, bounded edit/write projection for the Diff module.
 *
 * This is deliberately separate from pending-preview filesystem validation and
 * from future ToolDefinition renderers. It transforms already-authorized text
 * only; it never opens paths, writes files, or touches Todo/widget state.
 */

import { MAX_PENDING_PREVIEW_BYTES } from "./pending-preview.ts";

export const MAX_DIFF_REPLACEMENTS = 100;
export const MAX_DIFF_SUMMARY_LINES = 120;
export const MAX_DIFF_SUMMARY_LINE_CHARS = 320;

export type ExactReplacement = Readonly<{ oldText: string; newText: string }>;
export type EditProjectionInput = Readonly<{ oldText?: unknown; newText?: unknown; edits?: unknown }>;
export type DiffProjectionFailure = Readonly<{ ok: false; reason: string }>;
export type DiffSummary = Readonly<{
	lines: readonly string[];
	addedLines: number;
	removedLines: number;
	unchangedLines: number;
	truncated: boolean;
}>;
export type DiffProjectionSuccess = Readonly<{
	ok: true;
	previousContent: string;
	nextContent: string;
	summary: DiffSummary;
}>;
export type DiffProjection = DiffProjectionSuccess | DiffProjectionFailure;

function failure(reason: string): DiffProjectionFailure {
	return Object.freeze({ ok: false, reason });
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function normalizeLf(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitBom(value: string): { bom: string; text: string } {
	return value.startsWith("\uFEFF") ? { bom: "\uFEFF", text: value.slice(1) } : { bom: "", text: value };
}

function detectLineEnding(value: string): "\r\n" | "\n" {
	return value.includes("\r\n") ? "\r\n" : "\n";
}

function restoreLineEnding(value: string, lineEnding: "\r\n" | "\n"): string {
	return lineEnding === "\r\n" ? value.replace(/\n/g, "\r\n") : value;
}

function countMatches(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let cursor = 0;
	while (cursor <= haystack.length - needle.length) {
		const index = haystack.indexOf(needle, cursor);
		if (index < 0) break;
		count++;
		// Advance one code unit, deliberately counting overlapping occurrences.
		cursor = index + 1;
	}
	return count;
}

/** Convert raw edit arguments to a finite list of exact replacement blocks. */
export function parseExactReplacements(value: EditProjectionInput): ExactReplacement[] | undefined {
	const replacements: ExactReplacement[] = [];
	if (Array.isArray(value.edits)) {
		for (const entry of value.edits) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
			const candidate = entry as { oldText?: unknown; newText?: unknown };
			if (typeof candidate.oldText !== "string" || typeof candidate.newText !== "string") return undefined;
			replacements.push({ oldText: candidate.oldText, newText: candidate.newText });
		}
	} else if (typeof value.oldText === "string" && typeof value.newText === "string") {
		replacements.push({ oldText: value.oldText, newText: value.newText });
	} else {
		return undefined;
	}
	return replacements;
}

function validReplacementRequest(replacements: readonly ExactReplacement[]): string | undefined {
	if (replacements.length === 0) return "未提供可用于预览的精确替换块。";
	if (replacements.length > MAX_DIFF_REPLACEMENTS) return `替换块超过 ${MAX_DIFF_REPLACEMENTS} 个上限。`;
	let requestBytes = 0;
	for (const [index, replacement] of replacements.entries()) {
		if (replacement.oldText.length === 0) return `第 ${index + 1} 个替换块的 oldText 不能为空。`;
		requestBytes += byteLength(replacement.oldText) + byteLength(replacement.newText);
		if (requestBytes > MAX_PENDING_PREVIEW_BYTES) {
			return `替换请求超过 ${MAX_PENDING_PREVIEW_BYTES} 字节预览上限。`;
		}
	}
	return undefined;
}

function sanitizeSummaryLine(value: string): string {
	const safe = value
		.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[\^_][\s\S]*?\x1B\\)/g, "")
		.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
	return safe.length > MAX_DIFF_SUMMARY_LINE_CHARS ? `${safe.slice(0, MAX_DIFF_SUMMARY_LINE_CHARS - 1)}…` : safe;
}

function lineParts(value: string): string[] {
	return normalizeLf(splitBom(value).text).split("\n");
}

/**
 * Bounded, linear Diff summary. It intentionally uses common prefix/suffix
 * rather than an O(n²) LCS: an exact renderer can later add richer hunk logic
 * without making previews unbounded or expensive.
 */
export function buildBoundedDiffSummary(previousContent: string, nextContent: string): DiffSummary {
	const before = lineParts(previousContent);
	const after = lineParts(nextContent);
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) suffix++;

	const removed = before.slice(prefix, before.length - suffix);
	const added = after.slice(prefix, after.length - suffix);
	const lines: string[] = [];
	let truncated = false;
	const append = (line: string): void => {
		if (lines.length >= MAX_DIFF_SUMMARY_LINES) {
			truncated = true;
			return;
		}
		lines.push(line);
	};
	const context = 3;
	for (const line of before.slice(Math.max(0, prefix - context), prefix)) append(`  ${sanitizeSummaryLine(line)}`);
	if (prefix > context) append(`… 前方省略 ${prefix - context} 行未改动内容`);
	for (const line of removed) append(`- ${sanitizeSummaryLine(line)}`);
	for (const line of added) append(`+ ${sanitizeSummaryLine(line)}`);
	if (suffix > context) append(`… 后方省略 ${suffix - context} 行未改动内容`);
	for (const line of before.slice(before.length - Math.min(context, suffix))) append(`  ${sanitizeSummaryLine(line)}`);
	if (truncated) {
		// Make the cap visible without exceeding it.
		lines[MAX_DIFF_SUMMARY_LINES - 1] = "… 差异摘要已截断";
	}
	return Object.freeze({
		lines: Object.freeze(lines),
		addedLines: added.length,
		removedLines: removed.length,
		unchangedLines: prefix + suffix,
		truncated,
	});
}

/** Project a Pi edit request while retaining original BOM and CRLF/LF convention. */
export function projectExactEdits(previousContent: string, input: EditProjectionInput): DiffProjection {
	if (byteLength(previousContent) > MAX_PENDING_PREVIEW_BYTES) {
		return failure(`原始内容超过 ${MAX_PENDING_PREVIEW_BYTES} 字节预览上限。`);
	}
	const replacements = parseExactReplacements(input);
	if (!replacements) return failure("编辑请求不包含有效的 oldText/newText 替换块。");
	const invalid = validReplacementRequest(replacements);
	if (invalid) return failure(invalid);

	const { bom, text } = splitBom(previousContent);
	const lineEnding = detectLineEnding(text);
	const normalized = normalizeLf(text);
	const ranges: Array<{ start: number; end: number; nextText: string }> = [];
	for (const [index, replacement] of replacements.entries()) {
		const oldText = normalizeLf(replacement.oldText);
		const matchCount = countMatches(normalized, oldText);
		if (matchCount !== 1) {
			return failure(matchCount === 0
				? `第 ${index + 1} 个替换块未匹配当前内容。`
				: `第 ${index + 1} 个替换块匹配到 ${matchCount} 处，必须恰好一处。`);
		}
		const start = normalized.indexOf(oldText);
		ranges.push({ start, end: start + oldText.length, nextText: normalizeLf(replacement.newText) });
	}
	ranges.sort((left, right) => left.start - right.start);
	for (let index = 1; index < ranges.length; index++) {
		if (ranges[index]!.start < ranges[index - 1]!.end) return failure("替换块在原始内容中重叠，未生成预览。");
	}

	let cursor = 0;
	let projected = "";
	for (const range of ranges) {
		projected += normalized.slice(cursor, range.start) + range.nextText;
		cursor = range.end;
	}
	projected += normalized.slice(cursor);
	const nextContent = `${bom}${restoreLineEnding(projected, lineEnding)}`;
	if (byteLength(nextContent) > MAX_PENDING_PREVIEW_BYTES) {
		return failure(`预期编辑结果超过 ${MAX_PENDING_PREVIEW_BYTES} 字节预览上限。`);
	}
	return Object.freeze({ ok: true, previousContent, nextContent, summary: buildBoundedDiffSummary(previousContent, nextContent) });
}

/** Project write content with the same output-size and bounded-summary rules. */
export function projectWriteContent(previousContent: string | undefined, nextContent: unknown): DiffProjection {
	if (typeof nextContent !== "string") return failure("写入请求未提供字符串 content。");
	if (byteLength(nextContent) > MAX_PENDING_PREVIEW_BYTES) {
		return failure(`写入内容超过 ${MAX_PENDING_PREVIEW_BYTES} 字节预览上限。`);
	}
	const before = previousContent ?? "";
	if (byteLength(before) > MAX_PENDING_PREVIEW_BYTES) {
		return failure(`原始内容超过 ${MAX_PENDING_PREVIEW_BYTES} 字节预览上限。`);
	}
	return Object.freeze({ ok: true, previousContent: before, nextContent, summary: buildBoundedDiffSummary(before, nextContent) });
}
