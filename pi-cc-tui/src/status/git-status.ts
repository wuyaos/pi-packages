/**
 * Git 状态缓存与异步刷新。
 *
 * 状态栏 render 是同步且高频调用，绝不能在 render 里 spawn git。这里维护
 * 一个进程级缓存：render 只读缓存（O(1)），并在缓存过期时触发一次异步
 * `git status --porcelain=v2 -b` 刷新，完成后回调通知 TUI 重新渲染。
 */

import { execFile } from "node:child_process";

/** 进程级单例缓存；cwd 变化或刷新间隔到期才会重新拉取。 */
export interface GitStatusState {
	cwd: string;
	/** null = 非 git 仓库 / git 不可用 / detached HEAD 时为短哈希。 */
	branch: string | null;
	/** 已暂存变更文件数（staged）。 */
	staged: number;
	/** 未暂存变更文件数（unstaged）。 */
	unstaged: number;
	/** 未跟踪文件数（untracked）。 */
	untracked: number;
	/** 上次刷新完成时间戳 ms。 */
	stamp: number;
	/** 异步刷新进行中，避免重入。 */
	pending: boolean;
	/** 标记为非 git 仓库，拉长重试间隔避免频繁 spawn。 */
	notARepo: boolean;
}

export function createGitStatusState(): GitStatusState {
	return { cwd: "", branch: null, staged: 0, unstaged: 0, untracked: 0, stamp: 0, pending: false, notARepo: false };
}

/** 正常仓库 2s 刷新一次；非 git 目录 60s 才重试一次。 */
const REFRESH_INTERVAL_MS = 2000;
const NOT_A_REPO_INTERVAL_MS = 60_000;
const GIT_TIMEOUT_MS = 2000;

interface ParsedGitStatus {
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
}

/**
 * 解析 `git status --porcelain=v2 -b` 输出。
 * - `# branch.head <name>`：分支名；`(detached)` 表示 detached HEAD。
 * - `# branch.oid <sha>`：当前提交哈希，detached 时用作显示。
 * - `1`/`2 <XY> ...`：XY 两字符，X=暂存区状态，Y=工作区状态；非空格即有变更。
 * - `u <XY> ...`：未合并冲突，同时计入 staged 与 unstaged。
 * - `? <path>`：未跟踪文件。
 */
function parsePorcelainV2(stdout: string): ParsedGitStatus {
	let branch: string | null = null;
	let oid: string | null = null;
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		if (line.startsWith("# branch.head ")) {
			const name = line.slice("# branch.head ".length).trim();
			branch = name === "(detached)" ? null : name;
			continue;
		}
		if (line.startsWith("# branch.oid ")) {
			oid = line.slice("# branch.oid ".length).trim();
			continue;
		}
		if (line.startsWith("#")) continue;
		const head = line[0];
		if (head === "?") {
			untracked++;
			continue;
		}
		if (head === "u") {
			staged++;
			unstaged++;
			continue;
		}
		if (head === "1" || head === "2") {
			// XY 字段紧跟类型标记，如 `1 .M N...` 中 XY = `.M`；`.` 表示未修改。
			const x = line[2];
			const y = line[3];
			if (x && x !== "." && x !== " ") staged++;
			if (y && y !== "." && y !== " ") unstaged++;
		}
	}
	if (branch === null && oid && oid !== "(initial)") branch = oid.slice(0, 7);
	return { branch, staged, unstaged, untracked };
}

/**
 * 若缓存过期则触发一次异步 git 刷新；render 永远同步返回当前缓存值。
 * 刷新完成后调用 `onUpdated`（通常 `tui.requestRender()`）让 TUI 重绘。
 */
export function refreshGitStatus(
	state: GitStatusState,
	cwd: string,
	onUpdated: () => void,
): void {
	const now = Date.now();
	const interval = state.notARepo ? NOT_A_REPO_INTERVAL_MS : REFRESH_INTERVAL_MS;
	// 同一 cwd 且未到刷新间隔：直接复用缓存。
	if (state.cwd === cwd && now - state.stamp < interval) return;
	// 已有同 cwd 的异步刷新在飞：等它回来即可。
	if (state.pending && state.cwd === cwd) return;

	state.cwd = cwd;
	state.pending = true;
	execFile(
		"git",
		["-C", cwd, "status", "--porcelain=v2", "-b", "--no-ahead-behind"],
		{ timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
		(err, stdout) => {
			state.pending = false;
			state.stamp = Date.now();
			if (err) {
				// 非 git 仓库 / 未安装 git / 超时：标记并拉长重试间隔。
				state.notARepo = true;
				state.branch = null;
				state.staged = 0;
				state.unstaged = 0;
				state.untracked = 0;
				onUpdated();
				return;
			}
			state.notARepo = false;
			const parsed = parsePorcelainV2(String(stdout));
			state.branch = parsed.branch;
			state.staged = parsed.staged;
			state.unstaged = parsed.unstaged;
			state.untracked = parsed.untracked;
			onUpdated();
		},
	);
}
