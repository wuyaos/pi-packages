/**
 * Session 代际屏障。
 *
 * 防止跨 session 切换时，旧 session 的异步刷新回调（git/runtime）写回
 * 已过期的 state 或触发陈旧的重绘。session_start 递增 generation，
 * 异步回调在写 state 前用 isCurrent(gen) 校验，非当前代即丢弃。
 */

export class SessionLifecycle {
	private generation = 0;
	private active = false;

	/** session_start 调用：开启新代，作废所有旧代的异步回调。 */
	start(): number {
		this.generation++;
		this.active = true;
		return this.generation;
	}

	/** session_shutdown 调用：标记不再接受任何回调。 */
	shutdown(): void {
		this.active = false;
	}

	/** 校验给定代是否仍为当前活动 session 的代。 */
	isCurrent(gen?: number): boolean {
		if (!this.active) return false;
		return gen === undefined || gen === this.generation;
	}

	/** 捕获当前代，供异步回调校验。 */
	currentGeneration(): number {
		return this.generation;
	}
}
