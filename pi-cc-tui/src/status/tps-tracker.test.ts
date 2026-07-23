import assert from "node:assert/strict";
import test from "node:test";
import {
	createTpsTracker,
	recordTpsTokens,
	resetTpsTracker,
	shortWindowTps,
	TPS_SAMPLE_LIMIT,
	workingDurationSeconds,
} from "./tps-tracker.ts";

test("short-window TPS reflects recent streaming speed, not the session average", () => {
	const tracker = createTpsTracker();
	// Burst: 100 tokens in the first second.
	recordTpsTokens(tracker, 100, 1_000);
	recordTpsTokens(tracker, 200, 2_000);
	// Long idle, then a fresh burst: 50 tokens in one second.
	recordTpsTokens(tracker, 250, 60_000);
	recordTpsTokens(tracker, 300, 61_000);

	// The window only spans the recent burst, so the rate is ~50 TPS, not the
	// cumulative 300 tokens / 61 seconds.
	const tps = shortWindowTps(tracker, 61_000);
	assert.ok(tps !== null);
	assert.ok(Math.abs(tps - 50) < 1, `expected ~50, got ${tps}`);
});

test("TPS tracker ring buffer stays bounded and resets cleanly", () => {
	const tracker = createTpsTracker();
	for (let index = 0; index < TPS_SAMPLE_LIMIT + 50; index++) {
		recordTpsTokens(tracker, index, index * 100);
	}
	assert.ok(tracker.samples.length <= TPS_SAMPLE_LIMIT);
	resetTpsTracker(tracker);
	assert.equal(tracker.samples.length, 0);
	assert.equal(shortWindowTps(tracker, 1_000), null);
	assert.equal(workingDurationSeconds(tracker, 1_000), null);
});

test("working duration reports elapsed seconds and nulls after a long idle gap", () => {
	const tracker = createTpsTracker();
	recordTpsTokens(tracker, 0, 1_000);
	recordTpsTokens(tracker, 100, 4_000);
	assert.equal(workingDurationSeconds(tracker, 4_000), 3);
	// Beyond twice the window, the active window is considered closed.
	assert.equal(workingDurationSeconds(tracker, 100_000), null);
});

test("TPS tracker returns null without enough elapsed time for a stable rate", () => {
	const tracker = createTpsTracker();
	assert.equal(shortWindowTps(tracker, 0), null);
	recordTpsTokens(tracker, 10, 1_000);
	// Same timestamp baseline means no elapsed time.
	assert.equal(shortWindowTps(tracker, 1_000, 5_000), null);
});
