/**
 * pi-cc-tui 状态栏（含 context bar，合并自 pi-nano-context）。
 *
 * 行 1: model | git | Context/Token | tools。
 * 行 2: ⌂ path（约半宽）| context 色条（约半宽）。
 * 行 3: extensions。
 *
 * git 段默认开启：异步刷新 `git status --porcelain=v2 -b`，render 只读
 * 进程级缓存，非 git 仓库时不显示。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { configureIcons, getIcons } from "../src/ui/icons.ts";
import {
	hasCcTuiIconConfiguration,
	loadCcTuiConfig,
	SEGMENT_NAMES,
	saveCcTuiSegments,
	type SegmentConfig,
	type SegmentName,
} from "../src/config/cc-tui-config.ts";
import {
	createToolMetricsState,
	resetToolMetricsCursor,
	summarizeToolMetrics,
	updateToolMetrics,
	type ToolMetricsState,
} from "../src/status/tool-metrics.ts";
import {
	createGitStatusState,
	refreshGitStatus,
	type GitStatusState,
} from "../src/status/git-status.ts";
import { renderFooterEnds, renderPrimaryFooterBarLine } from "../src/status/footer-layout.ts";
import {
	addAssistantEntryUsage,
	createUsageTotals,
	type UsageTotals,
} from "../src/status/usage-totals.ts";



// ── Context bar 配色 (合并自 pi-nano-context，并适配 CC-TUI 暗色主题) ──
const CHARACTERS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1200;

interface ContextSegment {
	key: "system" | "prompt" | "assistant" | "thinking" | "tools";
	color: string;
	labels: string[];
}

const CONTEXT_SEGMENTS: ContextSegment[] = [
	{ key: "system", color: "#355d4a", labels: ["sys", "s"] },
	{ key: "prompt", color: "#5c4051", labels: ["pat", "p"] },
	{ key: "assistant", color: "#35565b", labels: ["ast", "a"] },
	{ key: "thinking", color: "#405965", labels: ["th", "t"] },
	{ key: "tools", color: "#665739", labels: ["tools", "tl", "x"] },
];

// 与 dark-monochrome 的 gray2/gray3 保持接近，避免色条成为视觉焦点。
const FREE_SEGMENT_FILL = "#2a2a2a";

interface ContextSnapshot {
	segments: Record<string, number>;
	usedTokens: number;
	contextWindow: number;
	usageIsEstimated: boolean;
}

let contextSnapshot: ContextSnapshot = {
	segments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
	usedTokens: 0,
	contextWindow: 0,
	usageIsEstimated: false,
};
let contextSnapshotRevision = 0;
let renderedContextSnapshotRevision = -1;

/** 可配置段。thinking 已并入 model，output 已并入 context。 */
export type { SegmentConfig, SegmentName };
export { SEGMENT_NAMES };

export function loadConfig(): SegmentConfig {
	const config = loadCcTuiConfig();
	// Keep PI_CC_TUI_ICON_MODE as the backwards-compatible default until a
	// user explicitly adds an icons object to their persisted configuration.
	if (hasCcTuiIconConfiguration()) configureIcons(config.icons);
	return { ...config.segments };
}

export function saveConfig(config: SegmentConfig): void {
	const saved = saveCcTuiSegments(config);
	configureIcons(saved.icons);
}

export let segmentConfig = loadConfig();
let cachedThinkingLevel = "medium";

let usageTotals: UsageTotals = createUsageTotals();
let usageBranchLength = -1;
let toolMetrics: ToolMetricsState = createToolMetricsState();
let gitStatus: GitStatusState = createGitStatusState();

/** Incrementally aggregate branch usage; terminal rendering must stay O(1). */
function updateUsageTotals(ctx: ExtensionContext): UsageTotals {
	try {
		const branch = ctx.sessionManager.getBranch();
		// A branch rewind/fork can shrink or replace history; rebuild only then.
		if (usageBranchLength < 0 || branch.length < usageBranchLength) {
			usageTotals = createUsageTotals();
			usageBranchLength = 0;
		}
		for (let index = usageBranchLength; index < branch.length; index += 1) {
			addAssistantEntryUsage(usageTotals, branch[index]);
		}
		usageBranchLength = branch.length;
	} catch {
		// Keep the last known totals while the session is initializing.
	}
	return usageTotals;
}

function fmtTokens(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function fmtPath(p: string): string {
	const home = homedir();
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function configSummary(): string {
	return SEGMENT_NAMES.map((name) => `${name}:${segmentConfig[name] ? "on" : "off"}`).join(" · ");
}

// ── ANSI 颜色 (用于 context bar 色条) ──
function ansiColor(mode: 38 | 48, hex: string, text: string): string {
	const value = Number.parseInt(hex.replace(/^#/, ""), 16);
	const r = (value >> 16) & 0xff;
	const g = (value >> 8) & 0xff;
	const b = value & 0xff;
	const reset = mode === 38 ? 39 : 49;
	return `\x1b[${mode};2;${r};${g};${b}m${text}\x1b[${reset}m`;
}

function bgHex(hex: string, text: string): string {
	return ansiColor(48, hex, text);
}

function fgHex(hex: string, text: string): string {
	return ansiColor(38, hex, text);
}

// ── Context snapshot 计算 (合并自 pi-nano-context) ──
function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

function contentRecords(content: unknown): readonly Record<string, unknown>[] {
	return Array.isArray(content) ? content.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	return contentRecords(content)
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

function imageCount(content: unknown): number {
	return contentRecords(content).filter((part) => part.type === "image").length;
}

function estimateContentTokens(content: unknown): number {
	return estimateTextTokens(textFromContent(content)) + imageCount(content) * IMAGE_TOKEN_ESTIMATE;
}

function estimateToolCallTokens(part: Record<string, unknown>): number {
	const name = typeof part.name === "string" ? part.name : "";
	const input = JSON.stringify(part.arguments ?? {});
	return estimateTextTokens(`${name}${input}`);
}

function addAssistantTokens(segments: Record<string, number>, content: unknown): void {
	for (const part of contentRecords(content)) {
		if (part.type === "text" && typeof part.text === "string") {
			segments.assistant += estimateTextTokens(part.text);
		}
		if (part.type === "thinking" && typeof part.thinking === "string") {
			segments.thinking += estimateTextTokens(part.thinking);
		}
		if (part.type === "toolCall") {
			segments.assistant += estimateToolCallTokens(part);
		}
	}
}

function segmentSessionMessages(messages: readonly unknown[], systemPrompt: string): Record<string, number> {
	const segments: Record<string, number> = { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 };
	segments.system = estimateTextTokens(systemPrompt);
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const msg = message as Record<string, unknown>;
		if (msg.role === "user") segments.prompt += estimateContentTokens(msg.content);
		if (msg.role === "assistant") addAssistantTokens(segments, msg.content);
		if (msg.role === "toolResult") segments.tools += estimateContentTokens(msg.content);
	}
	return segments;
}

function segmentTotal(segments: Record<string, number>): number {
	return CONTEXT_SEGMENTS.reduce((total, seg) => total + (segments[seg.key] || 0), 0);
}

function allocateProportionally(values: readonly number[], columns: number): number[] {
	if (columns <= 0) return values.map(() => 0);
	const total = values.reduce((sum, v) => sum + v, 0);
	if (total <= 0) return values.map(() => 0);
	const raw = values.map((v) => (v / total) * columns);
	const allocated = raw.map(Math.floor);
	let remaining = columns - allocated.reduce((sum, v) => sum + v, 0);
	const remainders = raw
		.map((v, i) => ({ i, r: v - Math.floor(v) }))
		.sort((a, b) => b.r - a.r);
	for (let i = 0; i < remainders.length && remaining > 0; i++, remaining--) {
		allocated[remainders[i]!.i]!++;
	}
	return allocated;
}

function scaleSegments(segments: Record<string, number>, usedTokens: number): Record<string, number> {
	if (usedTokens <= 0 || segmentTotal(segments) <= 0) return segments;
	const values = CONTEXT_SEGMENTS.map((s) => segments[s.key] || 0);
	const scaled = allocateProportionally(values, Math.round(usedTokens));
	const result: Record<string, number> = { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 };
	for (const [i, seg] of CONTEXT_SEGMENTS.entries()) result[seg.key] = scaled[i] ?? 0;
	return result;
}

function resetContextSnapshotCache(): void {
	contextSnapshotRevision++;
}

/**
 * Context segmentation walks history, so never probe session entries on every
 * terminal repaint. Pi lifecycle events mark the snapshot dirty; the next
 * render rebuilds it once, then all subsequent renders are O(1).
 */
function updateContextSnapshot(ctx: ExtensionContext): void {
	if (renderedContextSnapshotRevision === contextSnapshotRevision) return;
	try {
		const usage = ctx.getContextUsage();
		const measuredTokens = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : undefined;
		const contextWindow = usage?.contextWindow || (ctx.model as any)?.contextWindow || 0;
		const entries = ctx.sessionManager.getEntries();
		const messages: unknown[] = [];
		for (const entry of entries) {
			if (entry.type === "message") messages.push(entry.message);
		}
		const rawSegments = segmentSessionMessages(messages, ctx.getSystemPrompt());
		const estimatedTokens = segmentTotal(rawSegments);
		const usedTokens = measuredTokens ?? estimatedTokens;
		contextSnapshot = {
			segments: scaleSegments(rawSegments, usedTokens),
			usedTokens,
			contextWindow,
			usageIsEstimated: measuredTokens === undefined,
		};
		renderedContextSnapshotRevision = contextSnapshotRevision;
	} catch {
		// Keep the last snapshot while the session is initializing; retry next render.
	}
}

// 色条内文字颜色 (深色背景上的浅色文字)
const BAR_TEXT_COLOR = "#d8d8d8";

function centerText(text: string, width: number): string {
	if (width <= 0) return "";
	const textLen = Array.from(text).length;
	if (textLen > width) return "".repeat(width);
	const left = Math.floor((width - textLen) / 2);
	return " ".repeat(left) + text + " ".repeat(width - textLen - left);
}

function chooseLabel(labels: readonly string[], width: number): string {
	for (const label of labels) {
		if (Array.from(label).length <= width) return label;
	}
	return "";
}

// ── 色条渲染 (带文字) ──
function renderContextBar(snapshot: ContextSnapshot, width: number): string {
	if (snapshot.contextWindow <= 0 || width <= 0) return "";
	const freeTokens = Math.max(0, snapshot.contextWindow - snapshot.usedTokens);
	const values = [...CONTEXT_SEGMENTS.map((s) => snapshot.segments[s.key] || 0), freeTokens];

	// 可见段（token > 0）
	const visibleIndices = values.map((v, i) => v > 0 ? i : -1).filter((i) => i >= 0);
	const minColumns = new Array(values.length).fill(0);
	for (const i of visibleIndices) minColumns[i] = 1;
	const remaining = allocateProportionally(values, width - visibleIndices.length);
	const columns = minColumns.map((m, i) => m + (remaining[i] ?? 0));

	const parts: string[] = [];
	for (const [i, seg] of CONTEXT_SEGMENTS.entries()) {
		const col = columns[i] ?? 0;
		if (col > 0 && values[i]! > 0) {
			const label = chooseLabel(seg.labels, col);
			const text = label ? centerText(label, col) : " ".repeat(col);
			parts.push(bgHex(seg.color, fgHex(BAR_TEXT_COLOR, text)));
		}
	}
	const freeCol = columns[CONTEXT_SEGMENTS.length] ?? 0;
	if (freeCol > 0) {
		const freeLabel = chooseLabel(["free", "fr", "f"], freeCol);
		const text = freeLabel ? centerText(freeLabel, freeCol) : " ".repeat(freeCol);
		parts.push(bgHex(FREE_SEGMENT_FILL, fgHex("#a5a5a5", text)));
	}
	return parts.join("");
}

export function applyStatusline(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	updateContextSnapshot(ctx);
	usageBranchLength = -1;
	updateUsageTotals(ctx);

	ctx.ui.setFooter((tui, theme, footerData) => {
		let renderedExtensionStatusSignature = "";
		let cachedExtensionStatusLine = "";
		const getExtensionStatusLine = () => {
			if (!segmentConfig.extensions) return "";
			const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
			const signature = statuses.join("\u0000");
			if (signature !== renderedExtensionStatusSignature) {
				renderedExtensionStatusSignature = signature;
				cachedExtensionStatusLine = statuses.length > 0
					? theme.fg("dim", `${getIcons().extensions} ${statuses.join(theme.fg("dim", " | "))}`)
					: "";
			}
			return cachedExtensionStatusLine;
		};
		const unsubscribeBranch = footerData.onBranchChange(() => {
			// A fork/rewind can replace the branch at the same length, so rebuild
			// on the branch-change event rather than risking stale totals.
			usageBranchLength = -1;
			resetToolMetricsCursor(toolMetrics);
			updateUsageTotals(ctx);
			tui.requestRender();
		});

		return {
			dispose: unsubscribeBranch,
			invalidate: () => {},
			render(width: number): string[] {
				updateContextSnapshot(ctx);

				const icons = getIcons();

				// ── model (含 thinking 级别) ──
				let modelStr: string | null = null;
				if (segmentConfig.model) {
					const model = ctx.model as any;
					const modelId = model?.id || "no-model";
					const provider = model?.provider || "?";
					let level = cachedThinkingLevel;
					modelStr = theme.fg("accent", `${icons.model} ${provider}/${modelId}[${level}]`);
				}

				// ── git (异步刷新，render 只读缓存) ──
				// 显示：⎇ branch +N~M?K  +=已暂存 ~=未暂存 ?=未跟踪；0 的项省略。
				let gitStr: string | null = null;
				if (segmentConfig.git) {
					const cwd = ctx.sessionManager.getCwd();
					refreshGitStatus(gitStatus, cwd, () => tui.requestRender());
					if (gitStatus.branch) {
						const { staged, unstaged, untracked } = gitStatus;
						const dirty = staged + unstaged + untracked;
						const branchColor = dirty > 0 ? "warning" : "success";
						const parts: string[] = [theme.fg(branchColor, `${icons.git} ${gitStatus.branch}`)];
						if (staged > 0) parts.push(theme.fg("success", `+${staged}`));
						if (unstaged > 0) parts.push(theme.fg("warning", `~${unstaged}`));
						if (untracked > 0) parts.push(theme.fg("dim", `?${untracked}`));
						gitStr = parts.join(" ");
					}
				}

				// ── 累计 output / cost ──
				const totals = segmentConfig.context || segmentConfig.tools
					? updateUsageTotals(ctx)
					: createUsageTotals();
				const { input, output, cacheRead, cacheWrite } = totals;

				// ── 独立统计块：每个“图标 + 数值”只使用一种颜色 ──
				let contextStr: string | null = null;
				let inputStr: string | null = null;
				let outputStr: string | null = null;
				let cacheStr: string | null = null;
				if (segmentConfig.context) {
					try {
						const usage = ctx.getContextUsage();
						if (usage && typeof usage.tokens === "number") {
							const contextWindow = usage.contextWindow || (ctx.model as any)?.contextWindow || 128000;
							const percent = Math.max(0, (usage.tokens / contextWindow) * 100);
							const label = `${icons.context} ${fmtTokens(usage.tokens)}/${fmtTokens(contextWindow)} (${Math.round(percent)}%)`;
							const contextColor = percent < 70 ? "success" : percent < 85 ? "warning" : "error";
							contextStr = percent > 95 ? theme.bold(theme.fg(contextColor, label)) : theme.fg(contextColor, label);

							inputStr = theme.fg("accent", `↑ ${fmtTokens(input)}`);
							outputStr = theme.fg("success", `↓ ${fmtTokens(output)}`);
							// 缓存读取量与命中率共同描述一个缓存块：只显示一次图标，
							// 统一颜色；cacheWrite 仍会参与命中率计算，但不占紧凑状态栏宽度。
							const inputTotal = input + cacheRead + cacheWrite;
							if (cacheRead > 0 || cacheWrite > 0) {
								const hitRate = inputTotal > 0 ? cacheRead / inputTotal : 0;
								const cacheColor = hitRate >= 0.5 ? "success" : hitRate > 0 ? "warning" : "muted";
								cacheStr = theme.fg(cacheColor, `${icons.cache} ${fmtTokens(cacheRead)}/${Math.round(hitRate * 100)}%`);
							}
						}
					} catch {
						// Context usage is optional while a session is initializing.
					}
				}


				// ── tools (增量成功/失败指标) ──
				let toolsStr: string | null = null;
				if (segmentConfig.tools) {
					const metrics = updateToolMetrics(toolMetrics, ctx.sessionManager.getBranch());
					if (metrics.totalCalls > 0) {
						// 成功数/总数：一眼可读，错误时整个数字组使用错误色。
						const toolColor = metrics.error > 0 ? "error" : "success";
						toolsStr = theme.fg(toolColor, `${icons.tool} ${metrics.success}/${metrics.totalCalls}`);
					}
				}

				const separator = theme.fg("dim", " | ");
				const lines: string[] = [];

				// ── 行 1: 模型 + git 左对齐；Context/Token | 工具统计右对齐。 ──
				// 模型与 git 之间用分隔符；右侧 telemetry 内部仍用 | 分隔。
				const telemetryStr = [contextStr, inputStr, outputStr, cacheStr]
					.filter(Boolean)
					.join(" ");
				const rightStr = toolsStr ? [telemetryStr, toolsStr].filter(Boolean).join(separator) : telemetryStr;
				const leftStr = [modelStr, gitStr].filter(Boolean).join(separator);
				const topLine = renderFooterEnds(leftStr, rightStr, width);
				if (topLine) lines.push(topLine);

				// ── 行 2: path 与 context 色条固定各占约一半 ──
				const pathStr = segmentConfig.path
					? theme.fg("dim", `${icons.path} ${fmtPath(ctx.sessionManager.getCwd())}`)
					: "";
				// 第二行是路径与色条的连续布局，不显示竖线分隔符。
				const secondLineDivider = " ";
				const barContentWidth = Math.max(0, width - visibleWidth(secondLineDivider));
				const barWidth = Math.ceil(barContentWidth / 2);
				const bar = segmentConfig.bar ? renderContextBar(contextSnapshot, barWidth) : "";
				const primaryLine = renderPrimaryFooterBarLine(pathStr, bar, width, secondLineDivider);
				if (primaryLine) lines.push(primaryLine);

				// ── 行 3: extensions（状态未变时复用已格式化文本）──
				const extStr = getExtensionStatusLine();
				if (extStr) lines.push(visibleWidth(extStr) <= width ? extStr : truncateToWidth(extStr, width));

			return lines;
			},
		};
	});
}

export function restoreDefaultFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter(undefined);
}

export default function (pi: ExtensionAPI) {
	// The footer closure reads current session/model state at render time. Replacing
	// it after every agent/message/context event previously recreated listeners and
	// the git timer several times per turn without adding information. Reinstall
	// only when the session or model instance changes; normal TUI invalidation
	// refreshes the existing footer during streaming and after tool activity.
	pi.on("session_start", (_event, ctx) => {
		resetContextSnapshotCache();
		applyStatusline(ctx);
	});
	pi.on("model_select", (_event, ctx) => applyStatusline(ctx));
	pi.on("thinking_level_select", (event: any, ctx) => {
		cachedThinkingLevel = event.level;
		applyStatusline(ctx);
	});
	pi.on("session_compact", () => resetContextSnapshotCache());
	pi.on("session_tree", () => resetContextSnapshotCache());
	pi.on("context", () => resetContextSnapshotCache());

	// Context usage changes only when Pi commits a completed message to the
	// session. Avoid invalidating on every streaming message_update: that would
	// force a full history segmentation on every terminal repaint.
	pi.on("before_provider_request", () => resetContextSnapshotCache());
	pi.on("message_end", () => resetContextSnapshotCache());
}
