/**
 * Session-branch usage aggregation for the CC-TUI statusline.
 *
 * The source of truth is Pi's persisted assistant-message `usage` object. Its
 * fields mirror the counters displayed by CC-TUI: input, output, cacheRead
 * and cacheWrite are separate quantities and must never be inferred from
 * `totalTokens` or rounded before aggregation.
 */

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export const EMPTY_USAGE_TOTALS: Readonly<UsageTotals> = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
});

export function createUsageTotals(): UsageTotals {
	return { ...EMPTY_USAGE_TOTALS };
}

function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Add exactly the four independent Pi usage counters shown in the footer. */
export function addUsage(totals: UsageTotals, usage: unknown): void {
	if (!usage || typeof usage !== "object") return;
	const value = usage as Record<string, unknown>;
	totals.input += usageNumber(value.input);
	totals.output += usageNumber(value.output);
	totals.cacheRead += usageNumber(value.cacheRead);
	totals.cacheWrite += usageNumber(value.cacheWrite);
}

/**
 * Pi records model usage on assistant message entries. Do not include
 * `totalTokens`: it overlaps input/output/cache counters and would double-count.
 */
export function addAssistantEntryUsage(totals: UsageTotals, entry: unknown): void {
	if (!entry || typeof entry !== "object") return;
	const value = entry as { type?: unknown; message?: { role?: unknown; usage?: unknown } };
	if (value.type !== "message" || value.message?.role !== "assistant") return;
	addUsage(totals, value.message.usage);
}
