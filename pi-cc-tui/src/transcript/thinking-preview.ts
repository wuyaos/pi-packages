/** Pure collapsed-thinking preparation; no Pi component or renderer dependency. */

export type ThinkingContent = {
	type: string;
	thinking?: string;
	[key: string]: unknown;
};

export type CollapsedThinkingResult = Readonly<{
	content: ThinkingContent[];
	omittedLines: number;
	runs: number;
}>;

function lineCount(text: string): number {
	return text.split("\n").length;
}

/**
 * Preserve content ordering while replacing each contiguous reasoning run with
 * a bounded, labelled preview. The original message remains outside this
 * function and is retained by the component for native Ctrl+T expansion.
 */
export function buildCollapsedThinkingContent(
	content: readonly ThinkingContent[],
	previewLines: number,
	thinkingIcon: string,
): CollapsedThinkingResult {
	const limit = Math.max(0, Math.trunc(previewLines));
	const result: ThinkingContent[] = [];
	let omittedLines = 0;
	let runs = 0;

	for (let index = 0; index < content.length;) {
		const current = content[index]!;
		if (current.type !== "thinking" || typeof current.thinking !== "string") {
			result.push(current);
			index += 1;
			continue;
		}

		const run: ThinkingContent[] = [];
		while (index < content.length) {
			const candidate = content[index]!;
			if (candidate.type !== "thinking" || typeof candidate.thinking !== "string") break;
			run.push(candidate);
			index += 1;
		}
		runs += 1;
		let omittedInRun = 0;
		const preview = run.map((block) => {
			const lines = block.thinking!.split("\n");
			omittedInRun += Math.max(0, lines.length - limit);
			return { ...block, thinking: lines.slice(0, limit).join("\n") };
		});
		omittedLines += omittedInRun;

		const stepLabel = run.length === 1 ? "1 步" : `${run.length} 步`;
		const omittedLabel = omittedInRun > 0 ? ` · 已折叠 ${omittedInRun} 行` : "";
		result.push({
			type: "thinking",
			thinking: `${thinkingIcon} 思考 · ${stepLabel}${omittedLabel} · Ctrl+T 展开`,
		});
		result.push(...preview);
	}
	return Object.freeze({ content: result, omittedLines, runs });
}

export function normalizePreviewLines(value: number, fallback = 5): number {
	return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}
