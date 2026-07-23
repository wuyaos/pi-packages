import assert from "node:assert/strict";
import test from "node:test";
import {
	createToolMetricsState,
	MAX_SUMMARY_TOOL_ENTRIES,
	MAX_TRACKED_TOOL_NAMES,
	resetToolMetricsCursor,
	summarizeToolMetrics,
	updateToolMetrics,
} from "./tool-metrics.ts";

function toolResult(toolCallId: string, toolName: string, isError = false): unknown {
	return { type: "message", message: { role: "toolResult", toolCallId, toolName, isError } };
}

test("tool metrics aggregate incrementally and only over new branch entries", () => {
	const state = createToolMetricsState();
	const branch = [
		toolResult("1", "read"),
		toolResult("2", "read"),
		toolResult("3", "bash", true),
	];
	let snapshot = updateToolMetrics(state, branch);
	assert.equal(snapshot.totalCalls, 3);
	assert.equal(snapshot.success, 2);
	assert.equal(snapshot.error, 1);
	assert.equal(snapshot.entries[0]!.name, "read");

	// A second pass with two new entries must not rescan the first three.
	branch.push(toolResult("4", "edit"), toolResult("5", "write"));
	snapshot = updateToolMetrics(state, branch);
	assert.equal(snapshot.totalCalls, 5);
	assert.equal(snapshot.success, 4);
	assert.equal(snapshot.error, 1);
	assert.equal(snapshot.entries.length, 4);
});

test("tool metrics rebuild from zero after a rewind shrinks the branch", () => {
	const state = createToolMetricsState();
	const branch = [toolResult("1", "read"), toolResult("2", "bash", true)];
	updateToolMetrics(state, branch);
	assert.equal(summarizeToolMetrics(state).totalCalls, 2);

	// Rewind removes the bash result; cursor reset triggers a full rebuild.
	resetToolMetricsCursor(state);
	const shorter = [toolResult("1", "read")];
	const snapshot = updateToolMetrics(state, shorter);
	assert.equal(snapshot.totalCalls, 1);
	assert.equal(snapshot.success, 1);
	assert.equal(snapshot.error, 0);
});

test("tool metrics bound the per-name map and the rendered summary", () => {
	const state = createToolMetricsState();
	const branch: unknown[] = [];
	for (let index = 0; index < MAX_TRACKED_TOOL_NAMES + 5; index++) {
		branch.push(toolResult(`${index}`, `tool-${index}`));
	}
	updateToolMetrics(state, branch);
	// The map never exceeds the cap; lowest-volume names are evicted.
	assert.ok(state.byName.size <= MAX_TRACKED_TOOL_NAMES);
	const snapshot = summarizeToolMetrics(state);
	assert.ok(snapshot.entries.length <= MAX_SUMMARY_TOOL_ENTRIES);
	assert.equal(snapshot.totalCalls, MAX_TRACKED_TOOL_NAMES + 5);
});

test("tool metrics treat missing tool names and non-toolResult entries safely", () => {
	const state = createToolMetricsState();
	const branch: unknown[] = [
		{ type: "message", message: { role: "assistant", content: [] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "1" } },
		{ type: "message", message: { role: "toolResult", toolCallId: "2", toolName: "read", isError: false } },
		{ type: "other" },
		null,
	];
	const snapshot = updateToolMetrics(state, branch);
	assert.equal(snapshot.totalCalls, 2);
	assert.equal(snapshot.success, 2);
	assert.equal(snapshot.error, 0);
	const names = snapshot.entries.map((entry) => entry.name).sort();
	assert.deepEqual(names, ["read", "tool"]);
});
