import assert from "node:assert/strict";
import test from "node:test";
import { addAssistantEntryUsage, addUsage, createUsageTotals } from "./usage-totals.ts";

test("usage totals add Pi counters independently without totalTokens double counting", () => {
	const totals = createUsageTotals();
	addUsage(totals, {
		input: 34_500,
		output: 106,
		cacheRead: 16_400,
		cacheWrite: 0,
		totalTokens: 51_006,
		cost: { total: 1.25 },
	});
	assert.deepEqual(totals, { input: 34_500, output: 106, cacheRead: 16_400, cacheWrite: 0 });
});

test("usage totals include assistant usage only, matching CC-TUI statusline scope", () => {
	const totals = createUsageTotals();
	addAssistantEntryUsage(totals, { type: "message", message: { role: "user", usage: { input: 999 } } });
	addAssistantEntryUsage(totals, {
		type: "message",
		message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 2, cost: { total: 0 } } },
	});
	assert.deepEqual(totals, { input: 100, output: 20, cacheRead: 30, cacheWrite: 2 });
});
