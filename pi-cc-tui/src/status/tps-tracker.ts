/**
 * Bounded short-window TPS and working-duration tracker.
 *
 * The statusline already tracks cumulative TTFT/TPS. This module adds a
 * responsive rolling-window rate: it keeps a bounded ring buffer of token
 * samples and computes tokens-per-second over the last few seconds, so the
 * footer reflects current streaming speed rather than a session-wide average.
 *
 * Pure and dependency-free: callers drive it with an injected `now()` so it
 * stays unit-testable without real timers.
 */

export const TPS_SAMPLE_LIMIT = 128;
export const TPS_WINDOW_MS = 5_000;

export interface TpsSample {
	timestamp: number;
	cumulativeTokens: number;
}

export interface TpsTracker {
	samples: TpsSample[];
	startedAt: number | null;
	lastAt: number | null;
}

export function createTpsTracker(): TpsTracker {
	return { samples: [], startedAt: null, lastAt: null };
}

/** Reset the active window so the next sample starts a fresh working duration. */
export function resetTpsTracker(tracker: TpsTracker): void {
	tracker.samples.length = 0;
	tracker.startedAt = null;
	tracker.lastAt = null;
}

function pushSample(tracker: TpsTracker, sample: TpsSample): void {
	if (tracker.samples.length >= TPS_SAMPLE_LIMIT) {
		// Evict the oldest sample; the ring buffer stays bounded.
		tracker.samples.shift();
	}
	tracker.samples.push(sample);
}

/**
 * Record a cumulative token count. The caller passes the model's running
 * output token total; we store the delta boundary for later rate computation.
 */
export function recordTpsTokens(tracker: TpsTracker, cumulativeTokens: number, now: number): void {
	if (tracker.startedAt === null) tracker.startedAt = now;
	tracker.lastAt = now;
	pushSample(tracker, { timestamp: now, cumulativeTokens: Math.max(0, cumulativeTokens) });
}

function firstSampleInWindow(tracker: TpsTracker, now: number, windowMs: number): TpsSample | undefined {
	const cutoff = now - windowMs;
	for (const sample of tracker.samples) {
		if (sample.timestamp >= cutoff) return sample;
	}
	return tracker.samples[0];
}

/**
 * Responsive tokens-per-second over the short window. Falls back to the
 * cumulative rate when there is not enough elapsed time for a stable window.
 */
export function shortWindowTps(tracker: TpsTracker, now: number, windowMs = TPS_WINDOW_MS): number | null {
	if (tracker.samples.length === 0 || tracker.lastAt === null) return null;
	const last = tracker.samples[tracker.samples.length - 1]!;
	const baseline = firstSampleInWindow(tracker, now, windowMs) ?? tracker.samples[0]!;
	const elapsedMs = last.timestamp - baseline.timestamp;
	if (elapsedMs <= 0) return null;
	const delta = last.cumulativeTokens - baseline.cumulativeTokens;
	if (delta < 0) return null;
	return delta / (elapsedMs / 1000);
}

/** Elapsed seconds since the active window started, or null when idle. */
export function workingDurationSeconds(tracker: TpsTracker, now: number): number | null {
	if (tracker.startedAt === null || tracker.lastAt === null) return null;
	const idle = now - tracker.lastAt;
	// Close the window after a short idle gap so a new generation restarts.
	if (idle > TPS_WINDOW_MS * 2) return null;
	return Math.max(0, (tracker.lastAt - tracker.startedAt) / 1000);
}
