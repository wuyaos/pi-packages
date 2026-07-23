import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooterEnds, renderPrimaryFooterBarLine } from "./footer-layout.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("primary footer bar line keeps path and visual bar within the requested width", () => {
	const line = renderPrimaryFooterBarLine("PATH", "BARBARBARBAR", 27, " ");
	assert.equal(visibleWidth(line), 26);
	assert.equal(stripAnsi(line), "PATH          BARBARBARBAR");
});

test("primary footer bar line degrades safely for a tiny terminal", () => {
	assert.equal(visibleWidth(renderPrimaryFooterBarLine("path", "bar", 1)), 1);
	assert.equal(visibleWidth(renderPrimaryFooterBarLine("path", "bar", 4)), 4);
});

test("footer ends keep model identity left and telemetry right without a divider", () => {
	assert.equal(renderFooterEnds("MODEL", "CONTEXT | TOOLS", 30), "MODEL          CONTEXT | TOOLS");
	assert.equal(visibleWidth(renderFooterEnds("long-model-name", "context | tools", 16)), 16);
});
