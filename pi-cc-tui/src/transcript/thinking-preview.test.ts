import assert from "node:assert/strict";
import test from "node:test";
import { buildCollapsedThinkingContent, normalizePreviewLines } from "./thinking-preview.ts";

test("collapsed thinking preserves ordering and inserts one labelled preview per run", () => {
	const source = [
		{ type: "text", text: "before" },
		{ type: "thinking", thinking: "one\ntwo\nthree" },
		{ type: "thinking", thinking: "four\nfive" },
		{ type: "text", text: "after" },
		{ type: "thinking", thinking: "six" },
	];
	const result = buildCollapsedThinkingContent(source, 1, "💭");
	assert.equal(result.runs, 2);
	assert.equal(result.omittedLines, 3);
	assert.equal(result.content[0]!.type, "text");
	assert.match(result.content[1]!.thinking!, /💭 思考 · 2 步 · 已折叠 3 行 · Ctrl\+T 展开/);
	assert.equal(result.content[2]!.thinking, "one");
	assert.equal(result.content[3]!.thinking, "four");
	assert.equal(result.content[4]!.type, "text");
	assert.match(result.content[5]!.thinking!, /💭 思考 · 1 步/);
});

test("zero preview lines retains a label but no reasoning text", () => {
	const result = buildCollapsedThinkingContent([{ type: "thinking", thinking: "one\ntwo" }], 0, "…");
	assert.equal(result.omittedLines, 2);
	assert.equal(result.content[0]!.thinking, "… 思考 · 1 步 · 已折叠 2 行 · Ctrl+T 展开");
	assert.equal(result.content[1]!.thinking, "");
});

test("preview count normalizes invalid values", () => {
	assert.equal(normalizePreviewLines(3.8), 3);
	assert.equal(normalizePreviewLines(-1), 5);
	assert.equal(normalizePreviewLines(Number.NaN), 5);
});
