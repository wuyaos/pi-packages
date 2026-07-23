/**
 * Incremental, bounded tool success/error metrics for the footer.
 *
 * Mirrors the usage-totals cursor pattern: we walk the session branch once per
 * new entry rather than rescanning on every render, so footer rendering stays
 * O(1) in session history length. Tool names are capped to keep the per-tool
 * map and the rendered summary bounded.
 */

export const MAX_TRACKED_TOOL_NAMES = 32;
export const MAX_SUMMARY_TOOL_ENTRIES = 6;

export interface ToolMetricsEntry {
	readonly name: string;
	readonly success: number;
	readonly error: number;
}

export interface ToolMetricsSnapshot {
	readonly totalCalls: number;
	readonly success: number;
	readonly error: number;
	readonly entries: readonly ToolMetricsEntry[];
}

export interface ToolMetricsState {
	branchLength: number;
	totalCalls: number;
	success: number;
	error: number;
	byName: Map<string, { success: number; error: number }>;
}

export function createToolMetricsState(): ToolMetricsState {
	return { branchLength: 0, totalCalls: 0, success: 0, error: 0, byName: new Map() };
}

function ensureEntry(state: ToolMetricsState, name: string): { success: number; error: number } {
	let entry = state.byName.get(name);
	if (!entry) {
		// Bound the map: when full, drop the entry with the fewest total calls.
		if (state.byName.size >= MAX_TRACKED_TOOL_NAMES) {
			let minName: string | undefined;
			let minTotal = Number.POSITIVE_INFINITY;
			for (const [tool, value] of state.byName) {
				const total = value.success + value.error;
				if (total < minTotal) {
					minTotal = total;
					minName = tool;
				}
			}
			if (minName) state.byName.delete(minName);
		}
		entry = { success: 0, error: 0 };
		state.byName.set(name, entry);
	}
	return entry;
}

function recordResult(state: ToolMetricsState, name: string, isError: boolean): void {
	const entry = ensureEntry(state, name);
	if (isError) entry.error++;
	else entry.success++;
	state.totalCalls++;
	if (isError) state.error++;
	else state.success++;
}

/**
 * Walk new branch entries only. A rewind/fork that shrinks the branch resets
 * the cursor so the next pass rebuilds from zero.
 */
export function updateToolMetrics(
	state: ToolMetricsState,
	branch: readonly unknown[],
): ToolMetricsSnapshot {
	if (state.branchLength < 0 || branch.length < state.branchLength) {
		state.branchLength = 0;
		state.totalCalls = 0;
		state.success = 0;
		state.error = 0;
		state.byName.clear();
	}
	for (let index = state.branchLength; index < branch.length; index += 1) {
		const entry: any = branch[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "toolResult") continue;
		const name = typeof message.toolName === "string" && message.toolName ? message.toolName : "tool";
		recordResult(state, name, Boolean(message.isError));
	}
	state.branchLength = branch.length;
	return summarizeToolMetrics(state);
}

/** Build a bounded, render-ready snapshot without mutating state. */
export function summarizeToolMetrics(state: ToolMetricsState): ToolMetricsSnapshot {
	const entries = [...state.byName.entries()]
		.map(([name, value]) => ({
			name,
			success: value.success,
			error: value.error,
		}))
		.sort((left, right) => (right.success + right.error) - (left.success + left.error))
		.slice(0, MAX_SUMMARY_TOOL_ENTRIES);
	return Object.freeze({
		totalCalls: state.totalCalls,
		success: state.success,
		error: state.error,
		entries: Object.freeze(entries),
	});
}

/** Reset cursor so the next update rebuilds from scratch (used on branch change). */
export function resetToolMetricsCursor(state: ToolMetricsState): void {
	state.branchLength = -1;
}
