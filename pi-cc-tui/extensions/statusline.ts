/**
 * omp 风格状态栏：模型、路径、git、上下文 token、累计输出。
 * PI_STATUSLINE_GIT=1 时启用 git status --porcelain 统计，默认关闭。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";

const GIT_REFRESH_MS = 2000;
const gitEnabled = process.env.PI_STATUSLINE_GIT === "1";

interface GitStats {
	staged: number;
	modified: number;
	untracked: number;
}

let gitStats: GitStats | null = null;
let gitTimer: ReturnType<typeof setInterval> | null = null;

function clearGitTimer(): void {
	if (gitTimer) {
		clearInterval(gitTimer);
		gitTimer = null;
	}
}

function execAsync(cmd: string, args: string[], opts: Record<string, unknown>): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, opts, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout as string);
		});
	});
}

async function getGitStats(cwd: string): Promise<GitStats | null> {
	try {
		const stdout = await execAsync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		let staged = 0;
		let modified = 0;
		let untracked = 0;
		for (const line of stdout.split("\n")) {
			if (!line) continue;
			const x = line[0];
			const y = line[1];
			if (x === "?" && y === "?") {
				untracked++;
			} else {
				if (x !== " " && x !== "?") staged++;
				if (y !== " " && y !== "?") modified++;
			}
		}
		return { staged, modified, untracked };
	} catch {
		return null;
	}
}

function fmtTokens(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function fmtPath(path: string): string {
	const home = homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function applyStatusline(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	clearGitTimer();

	ctx.ui.setFooter((tui, theme, footerData) => {
		const refreshGit = async () => {
			if (!gitEnabled) return;
			const stats = await getGitStats(ctx.sessionManager.getCwd());
			if (stats) gitStats = stats;
			tui.requestRender();
		};

		if (gitEnabled) {
			void refreshGit();
			gitTimer = setInterval(() => void refreshGit(), GIT_REFRESH_MS);
			gitTimer.unref?.();
		}

		const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: () => {
				unsubscribeBranch();
				clearGitTimer();
			},
			invalidate: () => {
				if (gitEnabled) void refreshGit();
			},
			render(width: number): string[] {
				const model = (ctx.model as any)?.id || "no-model";
				const modelStr = theme.fg("accent", model);
				const pathStr = theme.fg("dim", fmtPath(ctx.sessionManager.getCwd()));

				let gitStr = "";
				const branch = footerData.getGitBranch();
				if (branch) {
					const hasChanges = Boolean(
						gitStats && (gitStats.staged || gitStats.modified || gitStats.untracked),
					);
					gitStr = theme.fg(hasChanges ? "warning" : "success", branch);
					if (gitEnabled && gitStats) {
						const gitParts: string[] = [];
						if (gitStats.staged > 0) gitParts.push(theme.fg("success", `+${gitStats.staged}`));
						if (gitStats.modified > 0) gitParts.push(theme.fg("warning", `~${gitStats.modified}`));
						if (gitStats.untracked > 0) gitParts.push(theme.fg("error", `?${gitStats.untracked}`));
						if (gitParts.length > 0) gitStr += ` ${gitParts.join(" ")}`;
					}
				}

				let contextStr = "";
				try {
					const usage = ctx.getContextUsage();
					if (usage && typeof usage.tokens === "number") {
						const contextWindow = (ctx.model as any)?.context_window || 128000;
						contextStr = theme.fg(
							"borderAccent",
							`${fmtTokens(usage.tokens)}/${fmtTokens(contextWindow)}`,
						);
					}
				} catch {
					// Context usage is optional while a session is initializing.
				}

				let output = 0;
				for (const entry of ctx.sessionManager.getBranch()) {
					if (entry.type === "message" && (entry.message as any).role === "assistant") {
						output += (entry.message as any).usage?.output || 0;
					}
				}
				const outputStr = theme.fg("muted", `↑${fmtTokens(output)}`);

				const parts = [modelStr, pathStr];
				if (gitStr) parts.push(gitStr);
				if (contextStr) parts.push(contextStr);
				parts.push(outputStr);
				const line = parts.join("  ");
				return [visibleWidth(line) <= width ? line : truncateToWidth(line, width)];
			},
		};
	});
}

export function restoreDefaultFooter(ctx: ExtensionContext): void {
	clearGitTimer();
	ctx.ui.setFooter(undefined);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => applyStatusline(ctx));
	pi.on("session_shutdown", () => clearGitTimer());

	pi.registerCommand("statusline-git", {
		description: "显示 git 状态统计开关的重启配置",
		handler: async (_args, ctx) => {
			const next = gitEnabled ? "0" : "1";
			ctx.ui.notify(`重启 pi 后生效: PI_STATUSLINE_GIT=${next}`, "info");
		},
	});
}
