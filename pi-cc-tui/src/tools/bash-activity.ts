/**
 * Per-tool-call Bash activity lifecycle.
 *
 * State remains owned by Pi's public ToolRenderContext. This registry only
 * schedules bounded redraws and releases every timer when a result settles or
 * the extension shuts down/reloads.
 */

export const BASH_REFRESH_MS = 200;

export type BashActivityState = {
	startedAt?: number;
	endedAt?: number;
	refreshTimer?: ReturnType<typeof setInterval>;
};

export type BashTimerApi = Readonly<{
	now: () => number;
	setInterval: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
	clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}>;

const DEFAULT_TIMER_API: BashTimerApi = {
	now: () => Date.now(),
	setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
	clearInterval: (timer) => clearInterval(timer),
};

export function formatBashElapsed(milliseconds: number): string {
	const safe = Math.max(0, milliseconds);
	if (safe < 1_000) return `${Math.floor(safe / 100) / 10}s`;
	if (safe < 60_000) return `${(safe / 1_000).toFixed(1)}s`;
	const minutes = Math.floor(safe / 60_000);
	return `${minutes}m ${Math.floor((safe % 60_000) / 1_000)}s`;
}

export function bashElapsed(state: BashActivityState, now = Date.now()): number | undefined {
	if (state.startedAt === undefined) return undefined;
	return Math.max(0, (state.endedAt ?? now) - state.startedAt);
}

/** Holds only active calls, so settled tool rows cannot retain timers or state. */
export class BashActivityRegistry {
	private readonly active = new Set<BashActivityState>();

	constructor(private readonly timers: BashTimerApi = DEFAULT_TIMER_API) {}

	observe(
		state: BashActivityState,
		options: { executionStarted: boolean; isPartial: boolean; isError: boolean; invalidate: () => void },
	): void {
		if (options.executionStarted && state.startedAt === undefined) {
			state.startedAt = this.timers.now();
			state.endedAt = undefined;
		}

		if (options.isPartial && !options.isError && state.startedAt !== undefined) {
			this.active.add(state);
			if (!state.refreshTimer) {
				state.refreshTimer = this.timers.setInterval(options.invalidate, BASH_REFRESH_MS);
			}
			return;
		}

		if (!options.isPartial || options.isError) this.settle(state);
	}

	settle(state: BashActivityState): void {
		if (state.startedAt !== undefined) state.endedAt ??= this.timers.now();
		if (state.refreshTimer) {
			this.timers.clearInterval(state.refreshTimer);
			state.refreshTimer = undefined;
		}
		this.active.delete(state);
	}

	/** Required on reload/shutdown: no orphaned interval survives a TUI replacement. */
	dispose(): void {
		for (const state of this.active) this.settle(state);
		this.active.clear();
	}

	get activeCount(): number {
		return this.active.size;
	}
}
