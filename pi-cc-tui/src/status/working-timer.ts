/**
 * Agent 运行计时器。
 *
 * agent_start 启动 250ms tick，agent_end/session_shutdown 停止。
 * render 同步读 state：workingSince 表示运行中，lastDoneIn 表示上次耗时。
 * tick 只触发 TUI 重绘，不持有任何渲染状态。interval 调用 unref() 避免
 * 阻止进程退出。
 */

export interface WorkingTimerState {
	/** 运行中：起始时间戳 ms；undefined 表示空闲。 */
	workingSince: number | undefined;
	/** 上次运行耗时 ms；session_start 时清空。 */
	lastDoneIn: number | undefined;
}

export function createWorkingTimerState(): WorkingTimerState {
	return { workingSince: undefined, lastDoneIn: undefined };
}

const TICK_INTERVAL_MS = 250;

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${s}s`;
	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	return `${h}h ${m}m ${s}s`;
}

export class WorkingTimer {
	private readonly state: WorkingTimerState;
	private readonly onTick: () => void;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(onTick: () => void) {
		this.state = createWorkingTimerState();
		this.onTick = onTick;
	}

	/** 开始计时；若已在运行先停止并保留 lastDoneIn 被新值覆盖。 */
	start(): void {
		this.stop();
		this.state.workingSince = Date.now();
		this.state.lastDoneIn = undefined;
		this.timer = setInterval(() => this.onTick(), TICK_INTERVAL_MS);
		this.timer.unref?.();
		this.onTick();
	}

	/** 停止计时；将 workingSince 转为 lastDoneIn 供 render 显示"done"。 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.state.workingSince !== undefined) {
			this.state.lastDoneIn = Date.now() - this.state.workingSince;
			this.state.workingSince = undefined;
		}
	}

	/** 新会话重置：停止并清空 lastDoneIn，不继承上一会话的耗时。 */
	reset(): void {
		this.stop();
		this.state.lastDoneIn = undefined;
	}

	getState(): WorkingTimerState {
		return this.state;
	}
}
