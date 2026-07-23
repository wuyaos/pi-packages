import assert from "node:assert/strict";
import test from "node:test";
import { buildToolReportLines } from "./tool-report.ts";

function toolResult(toolCallId: string, toolName: string, isError = false): unknown {
	return { type: "message", message: { role: "toolResult", toolCallId, toolName, isError } };
}

function fakeCtx(branch: unknown[]): any {
	return { sessionManager: { getBranch: () => branch } };
}

test("tool report aggregates metrics and lists recent calls without arguments", () => {
	const branch = [
		toolResult("1", "read"),
		toolResult("2", "read"),
		toolResult("3", "bash", true),
		toolResult("4", "edit"),
	];
	const lines = buildToolReportLines(fakeCtx(branch));
	const joined = lines.join("\n");
	assert.ok(joined.includes("工具调用总计：4"));
	assert.ok(joined.includes("成功 3"));
	assert.ok(joined.includes("失败 1"));
	assert.ok(joined.includes("read · 2 次"));
	assert.ok(joined.includes("bash · 1 次"));
	// Recent log shows status markers and names, never arguments.
	assert.ok(joined.includes("✓ read"));
	assert.ok(joined.includes("✗ bash"));
	assert.equal(joined.includes("oldText"), false);
	assert.equal(joined.includes("arguments"), false);
});

test("tool report handles empty sessions and caps the recent log", () => {
	const empty = buildToolReportLines(fakeCtx([]));
	assert.ok(empty.some((line) => line.includes("尚无工具调用")));

	const branch: unknown[] = [];
	for (let index = 0; index < 250; index++) branch.push(toolResult(`${index}`, "read"));
	const lines = buildToolReportLines(fakeCtx(branch));
	assert.ok(lines.some((line) => line.includes("已省略较早的 50 次调用")));
});
