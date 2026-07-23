import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { configureIcons } from "../ui/icons.ts";
import { renderUserMessageChrome } from "./user-message-chrome.ts";

test("user-message chrome bounds every line and preserves formatted body text", () => {
	configureIcons({ mode: "unicode" });
	const body = ["\x1b[1m标题\x1b[22m", "很长的正文内容，需要在窄终端中裁剪"];
	const lines = renderUserMessageChrome(body, 24, undefined);
	assert.equal(lines.length, 4);
	assert.ok(lines[0]!.startsWith("╭"));
	assert.ok(lines.at(-1)!.startsWith("╰"));
	assert.ok(lines.some((line) => line.includes("标题")));
	assert.ok(lines.every((line) => visibleWidth(line) <= 24));
});

test("user-message chrome follows ASCII mode and degrades on tiny widths", () => {
	configureIcons({ mode: "ascii" });
	const ascii = renderUserMessageChrome(["hello"], 20, undefined);
	assert.ok(ascii[0]!.startsWith("+"));
	assert.ok(ascii.some((line) => line.includes("user")));
	const tiny = renderUserMessageChrome(["hello"], 3, undefined);
	assert.equal(tiny.length, 1);
	assert.equal(visibleWidth(tiny[0]!), 3);
	configureIcons({ mode: "unicode" });
});
