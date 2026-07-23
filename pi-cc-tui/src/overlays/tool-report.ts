/**
 * Bounded, display-only tool diagnostic report for the cc-tui overlay.
 *
 * Like the context report, this is deliberately display-only: it reports tool
 * names and success/error status aggregated from the session branch, never raw
 * tool arguments, result content, or image payloads.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	createToolMetricsState,
	MAX_SUMMARY_TOOL_ENTRIES,
	updateToolMetrics,
} from "../status/tool-metrics.ts";

const MAX_TOOL_ROWS = 200;

function formatCount(value: number): string {
	return value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;
}

/**
 * Builds at most MAX_TOOL_ROWS small rows. It reports aggregated tool metrics
 * and a recent call log (tool name + status only). Raw arguments, result
 * content, and image payloads are never included.
 */
export function buildToolReportLines(ctx: ExtensionCommandContext): string[] {
	const branch = ctx.sessionManager.getBranch();
	const state = createToolMetricsState();
	const metrics = updateToolMetrics(state, branch);

	const lines: string[] = [
		`工具调用总计：${formatCount(metrics.totalCalls)} · 成功 ${formatCount(metrics.success)} · 失败 ${formatCount(metrics.error)}`,
		"",
		"按工具汇总（最多 6 项，按调用数降序）：",
	];

	if (metrics.entries.length === 0) {
		lines.push("（尚无工具调用）");
	} else {
		for (const entry of metrics.entries.slice(0, MAX_SUMMARY_TOOL_ENTRIES)) {
			const total = entry.success + entry.error;
			const rate = total > 0 ? Math.round((entry.success / total) * 100) : 0;
			lines.push(`${entry.name} · ${formatCount(total)} 次 · 成功 ${entry.success} · 失败 ${entry.error} · 成功率 ${rate}%`);
		}
	}

	lines.push("", "最近调用（仅工具名与状态，不含参数或结果内容）：");
	const recent: Array<{ name: string; isError: boolean }> = [];
	for (const entry of branch) {
		if (entry?.type !== "message") continue;
		const message = (entry as { message?: { role?: string; toolName?: unknown; isError?: unknown } }).message;
		if (!message || message.role !== "toolResult") continue;
		const name = typeof message.toolName === "string" && message.toolName ? message.toolName : "tool";
		recent.push({ name, isError: Boolean(message.isError) });
	}
	const shown = recent.slice(-MAX_TOOL_ROWS);
	if (recent.length > shown.length) lines.push(`… 已省略较早的 ${recent.length - shown.length} 次调用`);
	if (shown.length === 0) {
		lines.push("（尚无工具调用）");
	} else {
		for (const call of shown) {
			lines.push(`${call.isError ? "✗" : "✓"} ${call.name}`);
		}
	}
	lines.push("", "提示：该 Overlay 仅用于终端显示，不会写入模型上下文。");
	return lines;
}
