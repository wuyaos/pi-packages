import assert from "node:assert/strict";
import test from "node:test";
import { BASH_REFRESH_MS, BashActivityRegistry, bashElapsed, formatBashElapsed, type BashActivityState } from "./bash-activity.ts";

function fakeTimers() {
	let now = 1_000;
	let nextId = 0;
	const callbacks = new Map<number, () => void>();
	const cleared: number[] = [];
	return {
		api: {
			now: () => now,
			setInterval: (callback: () => void, milliseconds: number) => {
				assert.equal(milliseconds, BASH_REFRESH_MS);
				const id = ++nextId;
				callbacks.set(id, callback);
				return id as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: (timer: ReturnType<typeof setInterval>) => {
				const id = timer as unknown as number;
				cleared.push(id);
				callbacks.delete(id);
			},
		},
		advance: (milliseconds: number) => { now += milliseconds; },
		callbacks,
		cleared,
	};
}

test("Bash activity starts one 200ms refresh per active tool call and settles independently", () => {
	const timers = fakeTimers();
	const registry = new BashActivityRegistry(timers.api);
	const first: BashActivityState = {};
	const second: BashActivityState = {};
	let redraws = 0;

	registry.observe(first, { executionStarted: true, isPartial: true, isError: false, invalidate: () => redraws++ });
	registry.observe(first, { executionStarted: true, isPartial: true, isError: false, invalidate: () => redraws++ });
	registry.observe(second, { executionStarted: true, isPartial: true, isError: false, invalidate: () => redraws++ });
	assert.equal(registry.activeCount, 2);
	assert.equal(timers.callbacks.size, 2);
	for (const callback of timers.callbacks.values()) callback();
	assert.equal(redraws, 2);

	timers.advance(850);
	registry.observe(first, { executionStarted: true, isPartial: false, isError: false, invalidate: () => redraws++ });
	assert.equal(first.endedAt, 1_850);
	assert.equal(registry.activeCount, 1);
	assert.equal(timers.callbacks.size, 1);
	assert.equal(bashElapsed(first, 9_000), 850);
});

test("Bash activity errors and shutdown release every remaining timer", () => {
	const timers = fakeTimers();
	const registry = new BashActivityRegistry(timers.api);
	const failed: BashActivityState = {};
	const running: BashActivityState = {};
	registry.observe(failed, { executionStarted: true, isPartial: true, isError: false, invalidate: () => {} });
	registry.observe(running, { executionStarted: true, isPartial: true, isError: false, invalidate: () => {} });
	registry.observe(failed, { executionStarted: true, isPartial: true, isError: true, invalidate: () => {} });
	assert.equal(registry.activeCount, 1);
	assert.equal(timers.callbacks.size, 1);
	registry.dispose();
	assert.equal(registry.activeCount, 0);
	assert.equal(timers.callbacks.size, 0);
	assert.equal(timers.cleared.length, 2);
});

test("Bash duration formatting remains readable and non-negative", () => {
	assert.equal(formatBashElapsed(-5), "0s");
	assert.equal(formatBashElapsed(850), "0.8s");
	assert.equal(formatBashElapsed(1_500), "1.5s");
	assert.equal(formatBashElapsed(61_000), "1m 1s");
});
