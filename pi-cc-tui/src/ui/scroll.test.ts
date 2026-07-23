import assert from "node:assert/strict";
import test from "node:test";
import {
	applyScrollAction,
	clampScrollOffset,
	scrollActionForInput,
	scrollRangeLabel,
} from "./scroll.ts";

test("scroll offsets clamp to a valid viewport range", () => {
	assert.equal(clampScrollOffset(-3, 20, 5), 0);
	assert.equal(clampScrollOffset(99, 20, 5), 15);
	assert.equal(clampScrollOffset(Number.NaN, 20, 5), 0);
	assert.equal(clampScrollOffset(3.9, 20, 5), 3);
});

test("scroll input supports terminal, vim and page navigation", () => {
	assert.deepEqual(scrollActionForInput("j", 8), { type: "delta", lines: 1 });
	assert.deepEqual(scrollActionForInput("\x1b[A", 8), { type: "delta", lines: -1 });
	assert.deepEqual(scrollActionForInput("\x1b[6~", 8), { type: "delta", lines: 8 });
	assert.deepEqual(scrollActionForInput("g", 8), { type: "home" });
	assert.deepEqual(scrollActionForInput("G", 8), { type: "end" });
	assert.equal(scrollActionForInput("x", 8), undefined);
});

test("scroll actions and range labels stay bounded", () => {
	assert.equal(applyScrollAction({ type: "delta", lines: 20 }, 2, 10, 4), 6);
	assert.equal(applyScrollAction({ type: "home" }, 5, 10, 4), 0);
	assert.equal(applyScrollAction({ type: "end" }, 0, 10, 4), 6);
	assert.equal(scrollRangeLabel(6, 4, 10), "7-10/10");
	assert.equal(scrollRangeLabel(0, 3, 0), "0/0");
});
