import assert from "node:assert/strict";
import test from "node:test";
import {
	buildBoundedToolPreview,
	describeReadSearchCall,
	describeReadSearchResult,
	isBuiltinToolOwner,
	sanitizeToolDisplayText,
	toolResultText,
	COMPACT_RESULT_LINES,
	EXPANDED_RESULT_LINES,
	MAX_RESULT_CHARACTERS,
} from "./read-search-summary.ts";

test("read/search call summaries use semantic tool icon and preserve relevant arguments", () => {
	assert.match(describeReadSearchCall("read", { path: "src/a.ts", offset: 3, limit: 4 }), /read src\/a\.ts:3-6/);
	assert.match(describeReadSearchCall("grep", { pattern: "hello", path: "src", glob: "*.ts", limit: 9 }), /grep \/hello\/ in src \(\*\.ts\) · 9/);
	assert.match(describeReadSearchCall("find", { pattern: "*.ts" }), /find \*\.ts in \./);
	assert.match(describeReadSearchCall("ls", { path: "docs", limit: 7 }), /ls docs · 7/);
});

test("tool result text strips controls and never includes image payloads", () => {
	const text = toolResultText({
		content: [
			{ type: "text", text: "ok\x1b[31m!\x1b[0m\r\nnext\x00" },
			{ type: "image", data: "SUPER-SECRET-IMAGE" },
		],
	});
	assert.equal(text, "ok!\nnext");
	assert.equal(sanitizeToolDisplayText("x\x1b]8;;https://bad\x07link\x1b]8;;\x07"), "xlink");
	assert.equal(sanitizeToolDisplayText("x\x1b]8;;https://bad\x1b\\link\x1b]8;;\x1b\\"), "xlink");
});

test("tool previews remain bounded in collapsed and expanded views", () => {
	const lines = Array.from({ length: EXPANDED_RESULT_LINES + 12 }, (_, index) => `line ${index}`).join("\n");
	const compact = buildBoundedToolPreview(lines, false);
	assert.equal(compact.lines.length, COMPACT_RESULT_LINES);
	assert.equal(compact.hiddenLines, EXPANDED_RESULT_LINES + 12 - COMPACT_RESULT_LINES);
	const expanded = buildBoundedToolPreview(lines, true);
	assert.equal(expanded.lines.length, EXPANDED_RESULT_LINES);
	assert.equal(expanded.hiddenLines, 12);
	assert.match(describeReadSearchResult(lines, false), /行未显示/);

	const oversized = buildBoundedToolPreview("x".repeat(MAX_RESULT_CHARACTERS + 20), true);
	assert.equal(oversized.truncatedCharacters, true);
});

test("only builtin source owners are eligible for same-name renderer overrides", () => {
	assert.equal(isBuiltinToolOwner({ sourceInfo: { source: "builtin" } }), true);
	assert.equal(isBuiltinToolOwner({ sourceInfo: { source: "package" } }), false);
	assert.equal(isBuiltinToolOwner(undefined), false);
});
