/**
 * Claude Code-style collapsible thinking for pi.
 *
 * Monkey-patches AssistantMessageComponent.prototype.updateContent so that
 * the "hidden" state (hideThinkingBlock=true) renders only the first
 * previewLines lines of each thinking block plus an expand hint, instead
 * of pi's default single static label. The expanded state (Ctrl+T) still
 * shows the full thinking via the original renderer.
 *
 * No dist source files are modified. Pair with `hideThinkingBlock: true`
 * in settings.json so pi starts collapsed.
 */

import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPrototypePatch } from "../src/runtime/prototype-patch.ts";
import { getIcons } from "../src/ui/icons.ts";
import { buildCollapsedThinkingContent, normalizePreviewLines, type ThinkingContent } from "../src/transcript/thinking-preview.ts";

const DEFAULT_PREVIEW = 5;
let previewLines = DEFAULT_PREVIEW;

export function getPreviewLines(): number {
	return previewLines;
}

export function setPreviewLines(n: number): void {
	previewLines = normalizePreviewLines(n, DEFAULT_PREVIEW);
}

// Type alias for the internal message shape (avoids importing private types).
type AnyMessage = {
	content: ThinkingContent[];
	[key: string]: unknown;
};

export default function (pi: ExtensionAPI) {
	const cleanup = installPrototypePatch(
		AssistantMessageComponent.prototype,
		"updateContent",
		"cc-tui:thinking-content",
		({ predecessor, receiver, args }) => {
			const instance = receiver as {
				hideThinkingBlock?: boolean;
				lastMessage?: AnyMessage;
			};
			const message = args[0] as AnyMessage;
			if (!instance.hideThinkingBlock) {
				// Expanded: original renderer shows full thinking.
				return Reflect.apply(predecessor, receiver, args);
			}

			// Collapsed ("hidden") state: Pi would normally show one static label.
			// Render bounded, per-run previews through the original expanded branch.
			const collapsed = buildCollapsedThinkingContent(
				message.content,
				previewLines,
				getIcons().thinking,
			);

			const previousHidden = instance.hideThinkingBlock;
			instance.hideThinkingBlock = false;
			try {
				return Reflect.apply(predecessor, receiver, [{ ...message, content: collapsed.content }]);
			} finally {
				instance.hideThinkingBlock = previousHidden;
				// Retain the original message so Ctrl+T expands the full block.
				instance.lastMessage = message;
			}
		},
	);

	pi.on("session_shutdown", cleanup);
}
