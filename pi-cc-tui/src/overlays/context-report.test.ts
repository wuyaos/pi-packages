import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildContextReportLines } from "./context-report.ts";

function fakeContext(): ExtensionCommandContext {
	const longText = "用户可见摘要 ".repeat(100);
	return {
		cwd: "/workspace",
		model: { provider: "demo", id: "model" },
		getContextUsage: () => ({ tokens: 1_234, contextWindow: 10_000, percent: 12.34 }),
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: { role: "user", content: longText },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { output: 42 },
						content: [{ type: "toolCall", name: "secret_tool", arguments: { secret: "must-not-display" } }],
					},
				},
			],
		},
	} as unknown as ExtensionCommandContext;
}

test("context report is bounded and omits raw tool arguments", () => {
	const lines = buildContextReportLines(fakeContext());
	assert.ok(lines.some((line) => line.includes("demo/model")));
	assert.ok(lines.some((line) => line.includes("1.2k/10.0k")));
	assert.ok(lines.some((line) => line.includes("[tool: secret_tool]")));
	assert.equal(lines.some((line) => line.includes("must-not-display")), false);
	assert.ok(lines.every((line) => line.length <= 220));
	assert.ok(lines.some((line) => line.includes("不会写入模型上下文")));
});
