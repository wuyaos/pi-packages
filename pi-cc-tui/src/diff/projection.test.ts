/** Pure projection regression coverage: no filesystem or renderer dependency. */

import assert from "node:assert/strict";
import test from "node:test";
import {
	buildBoundedDiffSummary,
	parseExactReplacements,
	projectExactEdits,
	projectWriteContent,
	MAX_DIFF_SUMMARY_LINES,
} from "./projection.ts";

test("exact edit projection preserves BOM and CRLF across multiple unique replacements", () => {
	const original = "\uFEFFfirst\r\nsecond\r\nthird\r\n";
	const result = projectExactEdits(original, {
		edits: [
			{ oldText: "first\n", newText: "FIRST\n" },
			{ oldText: "third", newText: "THIRD" },
		],
	});
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.nextContent, "\uFEFFFIRST\r\nsecond\r\nTHIRD\r\n");
		assert.deepEqual(result.summary.lines, ["- first", "- second", "- third", "+ FIRST", "+ second", "+ THIRD", "  "]);
		assert.equal(result.summary.addedLines, 3);
		assert.equal(result.summary.removedLines, 3);
	}
});

test("exact edit projection rejects missing, non-unique, overlapping, and malformed requests", () => {
	for (const input of [
		{ oldText: "missing", newText: "x" },
		{ oldText: "a", newText: "x" },
		{ edits: [{ oldText: "bc", newText: "X" }, { oldText: "cd", newText: "Y" }] },
		{ edits: [{ oldText: "a", newText: 1 }] },
		{ oldText: "", newText: "x" },
	]) {
		const base = input === (input as unknown) && (input as { oldText?: unknown }).oldText === "a" ? "a a" : "abcdef";
		const result = projectExactEdits(base, input);
		assert.equal(result.ok, false);
	}
	assert.equal(parseExactReplacements({ edits: [] })?.length, 0);
});

test("write projection is bounded and reports create/overwrite changes without mutating input", () => {
	const result = projectWriteContent(undefined, "new\ncontent\n");
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.previousContent, "");
		assert.equal(result.nextContent, "new\ncontent\n");
		assert.deepEqual(result.summary.lines, ["+ new", "+ content", "  "]);
	}
	assert.equal(projectWriteContent("old", 3).ok, false);
});

test("diff summary uses a finite linear summary and sanitizes oversized/control lines", () => {
	const before = Array.from({ length: MAX_DIFF_SUMMARY_LINES + 50 }, (_, index) => `before-${index}`).join("\n");
	const after = Array.from({ length: MAX_DIFF_SUMMARY_LINES + 50 }, (_, index) => `after-${index}\x1b[31m`).join("\n");
	const summary = buildBoundedDiffSummary(before, after);
	assert.equal(summary.lines.length, MAX_DIFF_SUMMARY_LINES);
	assert.equal(summary.truncated, true);
	assert.equal(summary.lines.at(-1), "… 差异摘要已截断");
	assert.equal(summary.lines.some((line) => line.includes("\x1b")), false);
});
