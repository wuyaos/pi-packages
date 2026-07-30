/**
 * Turn 级遥测：测量每次 agent 运行的 TPS/TTFT/duration/tokens/stall/cost，
 * 在 agent_settled 后通过 ctx.ui.notify 弹一行瞬时通知。
 *
 * 测量口径移植自 OldSuns/pi-open-tui 的 telemetry.ts：
 * - TPS = 整轮 output tokens / 所有 LLM turn 的 generation 时间之和
 *   （turn_start → assistant message_end，含 TTFT/reasoning/buffering/stall，
 *   排除 tool 执行时间）
 * - Stall = 同一 message 内相邻 message_update 间隔 ≥ 1000ms
 * - TTFT = turn_start 到第一个有 token 产出的 message_update
 * - $/M = 该轮 usage.cost.total / totalTokens（单价，非会话累计）
 *
 * 通知用文本符号（↑↓!$）+ theme.fg 着色，不依赖 Nerd Font，所有终端可显示。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TelemetryConfig } from "../config/cc-tui-config.ts";

const STALL_THRESHOLD_MS = 1000;

interface MessageTiming {
	lastUpdateMs: number;
	firstOutputMs: number | null;
	inStall: boolean;
}

interface TurnTiming {
	startMs: number;
	firstTokenMs: number | null;
	currentMessage: MessageTiming | null;
	messages: AssistantMessage[];
	generationMs: number;
	stallMs: number;
	stallCount: number;
}

interface AssistantUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens: number;
	cost: { total: number };
}

interface AssistantMessage {
	role: "assistant";
	usage: AssistantUsage;
}

export interface TurnTelemetry {
	tps: number | null;
	ttftMs: number;
	totalMs: number;
	inputTokens: number;
	outputTokens: number;
	stallMs: number;
	stallCount: number;
	rateUsdPerMTokens: number | null;
	generationMs: number;
	totalTokens: number;
	costUsd: number;
	measurementMs: number | null;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return !!message && typeof message === "object" && (message as { role?: string }).role === "assistant";
}

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
	}
	const m = n / 1_000_000;
	return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${s}s`;
	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	return `${h}h ${m}m ${s}s`;
}

function formatTurnDuration(ms: number): string {
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);
}

/**
 * 聚合一次 agent 运行内所有 turn 的遥测。
 * 事件参数用宽松类型：pi 的事件结构在运行时由调用方保证，tracker 内部
 * 只访问已知字段（message.usage / assistantMessageEvent.type/delta）。
 */
export class TurnTelemetryTracker {
	private readonly now: () => number;
	private turn: TurnTiming | undefined;
	private agentStartMs: number | null = null;
	private agentTurns: TurnTelemetry[] = [];

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	handle(event: { type: string; [key: string]: unknown }): TurnTelemetry | undefined {
		switch (event.type) {
			case "agent_start":
				if (this.agentStartMs === null) {
					this.agentStartMs = this.now();
					this.agentTurns = [];
				}
				return;
			case "agent_settled":
				return this.endAgent();
			case "turn_start":
				this.startTurn();
				return;
			case "message_start":
				this.startMessage((event as { message: unknown }).message);
				return;
			case "message_update":
				this.updateMessage(event as { message: unknown; assistantMessageEvent: { type: string; delta: string } });
				return;
			case "message_end":
				this.endMessage((event as { message: unknown }).message);
				return;
			case "tool_execution_start":
				return;
			case "turn_end":
				return this.endTurnAndCollect();
		}
		return undefined;
	}

	private startTurn(): void {
		this.turn = {
			startMs: this.now(),
			firstTokenMs: null,
			currentMessage: null,
			messages: [],
			generationMs: 0,
			stallMs: 0,
			stallCount: 0,
		};
	}

	private startMessage(message: unknown): void {
		if (!this.turn || !isAssistantMessage(message)) return;
		const now = this.now();
		this.turn.currentMessage = {
			lastUpdateMs: now,
			firstOutputMs: null,
			inStall: false,
		};
	}

	private updateMessage(event: { message: unknown; assistantMessageEvent: { type: string; delta: string } }): void {
		const turn = this.turn;
		const current = turn?.currentMessage;
		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) return;
		if (streamEvent.delta.length === 0) return;
		const message = event.message;
		if (!turn || !current || !isAssistantMessage(message)) return;

		const now = this.now();
		if (current.firstOutputMs === null) {
			current.firstOutputMs = now;
			turn.firstTokenMs ??= now;
			current.lastUpdateMs = now;
			return;
		}

		const gap = now - current.lastUpdateMs;
		if (gap >= STALL_THRESHOLD_MS) {
			if (!current.inStall) turn.stallCount++;
			current.inStall = true;
			turn.stallMs += gap;
		} else {
			current.inStall = false;
		}
		current.lastUpdateMs = now;
	}

	private endMessage(message: unknown): void {
		const turn = this.turn;
		if (!turn || !isAssistantMessage(message)) return;

		const current = turn.currentMessage;
		if (current) {
			const endMs = this.now();
			turn.generationMs = endMs - turn.startMs;
			if (current.firstOutputMs === null && (message as AssistantMessage).usage.output > 0) {
				turn.firstTokenMs ??= endMs;
			}
			turn.currentMessage = null;
		}
		turn.messages.push(message as AssistantMessage);
	}

	private endTurnAndCollect(): TurnTelemetry | undefined {
		const telemetry = this.endTurn();
		if (telemetry && this.agentStartMs !== null) this.agentTurns.push(telemetry);
		return telemetry;
	}

	private endTurn(): TurnTelemetry | undefined {
		const turn = this.turn;
		this.turn = undefined;
		if (!turn || turn.firstTokenMs === null || turn.messages.length === 0) return undefined;

		const endMs = this.now();
		let inputTokens = 0;
		let outputTokens = 0;
		let totalTokens = 0;
		let costUsd = 0;
		for (const message of turn.messages) {
			const u = message.usage;
			inputTokens += u.input ?? 0;
			outputTokens += u.output ?? 0;
			totalTokens += u.totalTokens ?? 0;
			costUsd += u.cost?.total ?? 0;
		}
		if (![inputTokens, outputTokens, totalTokens, costUsd].every(Number.isFinite)) {
			throw new Error("Invalid assistant usage in turn telemetry");
		}

		const measurementMs = outputTokens > 0 && turn.generationMs > 0 ? turn.generationMs : null;
		const tps = measurementMs === null
			? null
			: round(outputTokens / (measurementMs / 1000), 1);
		const validCost = Number.isFinite(costUsd) && costUsd > 0;
		const validTokens = Number.isFinite(totalTokens) && totalTokens > 0;
		return {
			tps,
			ttftMs: turn.firstTokenMs - turn.startMs,
			totalMs: endMs - turn.startMs,
			inputTokens,
			outputTokens,
			stallMs: turn.stallMs,
			stallCount: turn.stallCount,
			rateUsdPerMTokens: validCost && validTokens
				? round(costUsd / (totalTokens / 1_000_000), 2)
				: null,
			generationMs: turn.generationMs,
			totalTokens,
			costUsd: validCost ? costUsd : 0,
			measurementMs,
		};
	}

	private endAgent(): TurnTelemetry | undefined {
		const startMs = this.agentStartMs;
		const turns = this.agentTurns;
		this.agentStartMs = null;
		this.agentTurns = [];
		if (startMs === null || turns.length === 0) return undefined;

		const outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0);
		const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
		const totalTokens = turns.reduce((sum, turn) => sum + turn.totalTokens, 0);
		const costUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0);
		const stallMs = turns.reduce((sum, turn) => sum + turn.stallMs, 0);
		const stallCount = turns.reduce((sum, turn) => sum + turn.stallCount, 0);
		const generationMs = turns.reduce((sum, turn) => sum + turn.generationMs, 0);
		const measurementMs = outputTokens > 0 && generationMs > 0 ? generationMs : null;
		const tps = measurementMs === null
			? null
			: round(outputTokens / (measurementMs / 1000), 1);
		const validRate = costUsd > 0 && totalTokens > 0;
		return {
			tps,
			ttftMs: turns[0]!.ttftMs,
			totalMs: this.now() - startMs,
			inputTokens,
			outputTokens,
			stallMs,
			stallCount,
			rateUsdPerMTokens: validRate ? round(costUsd / (totalTokens / 1_000_000), 2) : null,
			generationMs,
			totalTokens,
			costUsd,
			measurementMs,
		};
	}
}

/**
 * 格式化 turn 遥测为单行通知。各段可独立开关；TPS 无有效测量时显示 "—"。
 * 用 theme.fg 着色 + 文本符号，不依赖 Nerd Font。
 */
export function formatTurnTelemetry(
	telemetry: TurnTelemetry,
	theme: Theme,
	config: TelemetryConfig,
): string {
	const sep = ` ${theme.fg("dim", "|")} `;
	const parts: string[] = [];
	if (config.tps) {
		const value = telemetry.tps === null ? "—" : `${telemetry.tps.toFixed(1)} tok/s`;
		parts.push(theme.fg(telemetry.tps === null ? "muted" : "accent", `TPS ${value}`));
	}
	if (config.ttft) {
		parts.push(theme.fg("text", `TTFT ${formatTurnDuration(telemetry.ttftMs)}`));
	}
	if (config.duration) {
		parts.push(theme.fg("success", `+ ${formatTurnDuration(telemetry.totalMs)}`));
	}
	if (config.tokens) {
		parts.push(theme.fg("accent", `↑ ${fmtTokens(telemetry.inputTokens)}`));
		parts.push(theme.fg("success", `↓ ${fmtTokens(telemetry.outputTokens)}`));
	}
	if (config.stalls && telemetry.stallMs > 0) {
		parts.push(theme.fg("warning", `! stall ${telemetry.stallCount}x/${formatTurnDuration(telemetry.stallMs)}`));
	}
	if (config.cost && telemetry.rateUsdPerMTokens !== null) {
		parts.push(theme.fg("warning", `$ ${telemetry.rateUsdPerMTokens.toFixed(2)}/M`));
	}
	return parts.join(sep);
}
