import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderBorderLine, renderBoxLine, resolveBorderStyle } from "./box.ts";
import { alignText, alignTextEnds, clipText, padText } from "./text.ts";

test("text layout is ANSI-aware and bounded", () => {
	const green = "\x1b[32mhello\x1b[39m";
	assert.equal(visibleWidth(clipText(green, 3, "…")), 3);
	assert.equal(visibleWidth(padText(green, 8)), 8);
	assert.equal(visibleWidth(alignText(green, 9, "center")), 9);
	assert.equal(visibleWidth(alignTextEnds("left", "right", 12)), 12);
	assert.equal(visibleWidth(alignTextEnds("very-long-left", "right", 6)), 6);
});

test("border styles use ASCII only in ASCII icon mode", () => {
	assert.equal(resolveBorderStyle("rounded", "unicode").topLeft, "╭");
	assert.equal(resolveBorderStyle("double", "ascii").topLeft, "+");
});

test("border and content rows stay within the requested width", () => {
	const border = renderBorderLine({ width: 18, side: "top", label: "标题很长而且会裁剪", labelAlignment: "center" });
	const row = renderBoxLine({ content: "\x1b[31m带颜色且很长的内容\x1b[39m", width: 18, paddingLeft: 1, paddingRight: 1 });
	assert.equal(visibleWidth(border), 18);
	assert.equal(visibleWidth(row), 18);
	assert.ok(border.startsWith("╭"));
	assert.ok(row.startsWith("│ "));
});

test("tiny boxes degrade without overflowing", () => {
	assert.equal(renderBorderLine({ width: 0, side: "top" }), "");
	assert.equal(renderBorderLine({ width: 1, side: "bottom" }), "╰");
	assert.equal(visibleWidth(renderBoxLine({ content: "abc", width: 2 })), 2);
});
