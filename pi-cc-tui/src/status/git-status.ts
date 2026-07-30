/**
 * Git 状态缓存与异步刷新。
 *
 * 状态栏 render 是同步且高频调用，绝不能在 render 里 spawn git。这里维护
 * 一个进程级缓存：render 只读缓存（O(1)），并在缓存过期时触发一次异步
 * `git status --porcelain=v2 -b --show-stash` 刷新，完成后回调通知 TUI 重绘。
 *
 * 解析覆盖：branch/detached HEAD、ahead/behind、staged/modified/untracked、
 * conflicted/renamed/deleted、stashed。stash 在 --show-stash 不支持（git <2.35）
 * 时 fallback 到 `git stash list --count`。
 */

import { execFile } from "node:child_process";

/** 进程级单例缓存；cwd 变化或刷新间隔到期才会重新拉取。 */
export interface GitStatusState {
	cwd: string;
	/** null = detached HEAD 或非 git 仓库；detached 时 render 显示 "HEAD"。 */
	branch: string | null;
	/** detached HEAD 短哈希（7 位）；非 detached 为 null。 */
	oid: string | null;
	ahead: number;
	behind: number;
	/** 已暂存（staged）文件数。 */
	staged: number;
	/** 未暂存修改（modified）文件数。 */
	modified: number;
	untracked: number;
	conflicted: number;
	renamed: number;
	deleted: number;
	stashed: number;
	/** 上次刷新完成时间戳 ms。 */
	stamp: number;
	/** 异步刷新进行中，避免重入。 */
	pending: boolean;
	/** 标记为非 git 仓库，拉长重试间隔避免频繁 spawn。 */
	notARepo: boolean;
}

export function createGitStatusState(): GitStatusState {
	return {
		cwd: "", branch: null, oid: null,
		ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0,
		conflicted: 0, renamed: 0, deleted: 0, stashed: 0,
		stamp: 0, pending: false, notARepo: false,
	};
}

/** 正常仓库 2s 刷新一次；非 git 目录 60s 才重试一次。 */
const REFRESH_INTERVAL_MS = 2000;
const NOT_A_REPO_INTERVAL_MS = 60_000;
const GIT_TIMEOUT_MS = 2000;

interface ParsedGitStatus {
	branch: string | null;
	oid: string | null;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
	conflicted: number;
	renamed: number;
	deleted: number;
	stashed: number;
	/** `# stash` 行是否出现；false 时需 fallback 到 stash list。 */
	stashSeen: boolean;
}

/**
 * 解析 `git status --porcelain=v2 -b --show-stash` 输出。
 * - `# branch.head <name>`：分支名；`(detached)` 表示 detached HEAD。
 * - `# branch.oid <sha>`：当前提交哈希，detached 时用作显示。
 * - `# branch.ab +<ahead> -<behind>`：领先/落后上游的提交数。
 * - `# stash <count>`：stash 数量（--show-stash，git 2.35+）。
 * - `1 <XY> ...`：普通变更，X=暂存区状态，Y=工作区状态；`.` 表示未修改。
 * - `2 <XY> ...`：重命名/复制。
 * - `u <XY> ...`：未合并冲突。
 * - `? <path>`：未跟踪文件。
 */
function parsePorcelainV2(stdout: string): ParsedGitStatus {
	let branch: string | null = null;
	let oid: string | null = null;
	let ahead = 0;
	let behind = 0;
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	let conflicted = 0;
	let renamed = 0;
	let deleted = 0;
	let stashed = 0;
	let stashSeen = false;

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
		if (line.startsWith("# branch.ab ")) {
			const parts = line.slice("# branch.ab ".length).trim().split(/\s+/);
			for (const p of parts) {
				if (p.startsWith("+")) ahead = parseInt(p.slice(1), 10) || 0;
				else if (p.startsWith("-")) behind = parseInt(p.slice(1), 10) || 0;
			}
			continue;
		}
		if (line.startsWith("# stash ")) {
			stashSeen = true;
			stashed = parseInt(line.slice("# stash ".length).trim(), 10) || 0;
			continue;
		}
		if (line.startsWith("#")) continue;

		const head = line[0];
		if (head === "?") {
			untracked++;
			continue;
		}
		if (head === "u") {
			conflicted++;
			continue;
		}
		if (head === "2") {
			renamed++;
			continue;
		}
		if (head === "1") {
			const x = line[2];
			const y = line[3];
			// 冲突状态码：U/CC/AA（双方均有未合并变更）。
			if (x === "U" || y === "U" || (x === "C" && y === "C") || (x === "A" && y === "A")) {
				conflicted++;
			} else if (x === "D" || y === "D") {
				deleted++;
			} else {
				if (x && x !== "." && x !== " ") staged++;
				if (y === "M" || y === "D") modified++;
			}
		}
	}
	return { branch, oid, ahead, behind, staged, modified, untracked, conflicted, renamed, deleted, stashed, stashSeen };
}

function resetState(state: GitStatusState): void {
	state.branch = null;
	state.oid = null;
	state.ahead = 0;
	state.behind = 0;
	state.staged = 0;
	state.modified = 0;
	state.untracked = 0;
	state.conflicted = 0;
	state.renamed = 0;
	state.deleted = 0;
	state.stashed = 0;
}

/**
 * 若缓存过期则触发一次异步 git 刷新；render 永远同步返回当前缓存值。
 * 刷新完成后调用 `onUpdated`（通常 `tui.requestRender()`）让 TUI 重绘。
 * stash 在 --show-stash 不支持时 fallback 到 `git stash list --count`。
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
		["-C", cwd, "status", "--porcelain=v2", "-b", "--show-stash"],
		{ timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
		(err, stdout) => {
			state.pending = false;
			state.stamp = Date.now();
			if (err) {
				// 非 git 仓库 / 未安装 git / 超时：标记并拉长重试间隔。
				state.notARepo = true;
				resetState(state);
				onUpdated();
				return;
			}
			state.notARepo = false;
			const parsed = parsePorcelainV2(String(stdout));
			state.branch = parsed.branch;
			state.oid = parsed.oid && parsed.oid !== "(initial)" ? parsed.oid.slice(0, 7) : null;
			state.ahead = parsed.ahead;
			state.behind = parsed.behind;
			state.staged = parsed.staged;
			state.modified = parsed.modified;
			state.untracked = parsed.untracked;
			state.conflicted = parsed.conflicted;
			state.renamed = parsed.renamed;
			state.deleted = parsed.deleted;
			state.stashed = parsed.stashed;

			// --show-stash 不支持（git <2.35）时 fallback 到 stash list --count。
			if (!parsed.stashSeen) {
				execFile(
					"git",
					["-C", cwd, "stash", "list", "--count"],
					{ timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 },
					(e, out) => {
						if (!e && out) {
							const c = parseInt(out.trim(), 10);
							if (!Number.isNaN(c)) state.stashed = c;
						}
						onUpdated();
					},
				);
				return;
			}
			onUpdated();
		},
	);
}
