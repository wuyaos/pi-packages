/**
 * Claude Code-style collapsible thinking for pi.
 *
 * Monkey-patches AssistantMessageComponent.prototype.updateContent so that
 * the "hidden" state (hideThinkingBlock=true) renders only the first
 * PREVIEW_LINES lines of each thinking block plus an expand hint, instead
 * of pi's default single static label. The expanded state (Ctrl+T) still
 * shows the full thinking via the original renderer.
 *
 * No dist source files are modified. Pair with `hideThinkingBlock: true`
 * in settings.json so pi starts collapsed.
 *
 * Commands:
 *   /claude-thinking-preview <n>   Set preview line count (default 5)
 *   /claude-thinking-preview      Reset to default (5)
 */

import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_PREVIEW = 5;
let previewLines = DEFAULT_PREVIEW;

// Type alias for the internal message shape (avoids importing private types).
type AnyMessage = {
	content: Array<{ type: string; thinking?: string; text?: string }>;
	[key: string]: unknown;
};

export default function (pi: ExtensionAPI) {
	const proto = AssistantMessageComponent.prototype as unknown as {
		updateContent: (this: unknown, message: AnyMessage) => void;
	};

	// Save the original implementation once. Guard against double-patching on /reload.
	if ((proto as { __claudeThinkingPatched?: boolean }).__claudeThinkingPatched) {
		return;
	}
	const origUpdateContent = proto.updateContent;
	(proto as { __claudeThinkingPatched?: boolean }).__claudeThinkingPatched = true;

	proto.updateContent = function (this: any, message: AnyMessage) {
		if (!this.hideThinkingBlock) {
			// Expanded: original renderer shows full thinking.
			return origUpdateContent.call(this, message);
		}

		// Collapsed ("hidden") state: pi would normally show only a static label.
		// Instead, truncate each thinking block to the first N lines and reuse
		// the original renderer's "expanded" branch by flipping the flag back,
		// so it renders the truncated Markdown with thinkingText styling.
		let totalExtra = 0;
		const truncatedContent = message.content.map((c) => {
			if (c.type === "thinking" && typeof c.thinking === "string") {
				const lines = c.thinking.split("\n");
				if (lines.length > previewLines) {
					totalExtra += lines.length - previewLines;
					return { ...c, thinking: lines.slice(0, previewLines).join("\n") };
				}
			}
			return c;
		});

		// Append a single expand hint as a trailing thinking block so the
		// original Markdown renderer styles it like the rest of the thinking.
		if (totalExtra > 0) {
			truncatedContent.push({
				type: "thinking",
				thinking: `✻ ${totalExtra} more line${totalExtra === 1 ? "" : "s"} (Ctrl+T to expand)`,
			});
		}

		// Temporarily flip the flag so the original renderer takes the
		// "show thinking as Markdown" branch instead of the "show label" branch.
		const prev = this.hideThinkingBlock;
		this.hideThinkingBlock = false;
		origUpdateContent.call(this, { ...message, content: truncatedContent });
		this.hideThinkingBlock = prev;

		// Keep the original (untruncated) message as lastMessage so a later
		// Ctrl+T expand re-renders the full thinking, not the truncated copy.
		this.lastMessage = message;
	};

	pi.registerCommand("claude-thinking-preview", {
		description: `Set collapsed thinking preview line count (default ${DEFAULT_PREVIEW}). No args resets.`,
		handler: async (args, ctx) => {
			const n = parseInt(args.trim(), 10);
			if (!Number.isFinite(n) || n < 0) {
				ctx.ui.notify(`Invalid count; reset to ${DEFAULT_PREVIEW}`, "warning");
				previewLines = DEFAULT_PREVIEW;
				return;
			}
			previewLines = n;
			ctx.ui.notify(`Thinking preview: ${previewLines} line${previewLines === 1 ? "" : "s"}`, "info");
		},
	});

	pi.on("session_shutdown", () => {
		// Best-effort restore; pi tears down the process anyway.
		proto.updateContent = origUpdateContent;
		(proto as { __claudeThinkingPatched?: boolean }).__claudeThinkingPatched = false;
	});
}
