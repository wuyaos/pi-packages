/** Bounded, display-only context summary for the cc-tui overlay. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const MAX_ENTRY_ROWS = 200;
const MAX_PREVIEW_CHARS = 160;

function compact(text: string, limit = MAX_PREVIEW_CHARS): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as Record<string, unknown>;
			if (typeof block.text === "string") return block.text;
			if (typeof block.thinking === "string") return "[thinking]";
			if (block.type === "toolCall") return `[tool: ${typeof block.name === "string" ? block.name : "unknown"}]`;
			if (block.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function formatTokens(tokens: number | null | undefined): string {
	if (typeof tokens !== "number" || !Number.isFinite(tokens)) return "?";
	if (tokens < 1_000) return String(Math.round(tokens));
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Builds at most 200 small rows. It reports session metadata only and never
 * includes system prompt content, raw tool arguments, image payloads or full
 * transcript text.
 */
export function buildContextReportLines(ctx: ExtensionCommandContext): string[] {
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选择模型";
	const lines = [
		`模型：${model}`,
		`上下文：${formatTokens(usage?.tokens)}/${formatTokens(window)} (${usage?.percent?.toFixed(1) ?? "?"}%)`,
		`当前目录：${ctx.cwd}`,
		"",
		"会话条目（仅摘要，不显示系统提示、工具参数、图片或完整文本）：",
	];

	const branch = ctx.sessionManager.getBranch();
	const shown = branch.slice(-MAX_ENTRY_ROWS);
	if (branch.length > shown.length) lines.push(`… 已省略较早的 ${branch.length - shown.length} 条会话记录`);
	for (const entry of shown) {
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			content?: unknown;
			usage?: { output?: number | null };
			type?: string;
		};
		const role = message.role ?? message.type ?? "message";
		const preview = compact(textFromContent(message.content));
		const usageLabel = role === "assistant" ? ` · 输出 ${formatTokens(message.usage?.output)}` : "";
		lines.push(`${role}${usageLabel}${preview ? ` · ${preview}` : ""}`);
	}
	lines.push("", "提示：该 Overlay 仅用于终端显示，不会写入模型上下文。");
	return lines;
}
