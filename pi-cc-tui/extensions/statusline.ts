/**
 * pi-cc-tui 状态栏：三行布局。
 * 行 1 左: model | git
 * 行 1 右: ctx(含 output) | tokens | cost
 * 行 2: 📂 path
 * 行 3: extensions
 * PI_STATUSLINE_GIT=1 时启用 git status --porcelain 统计，默认关闭。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const GIT_REFRESH_MS = 2000;
const gitEnabled = process.env.PI_STATUSLINE_GIT === "1";
const CONFIG_PATH = `${homedir()}/.pi/agent/config/cc-tui.json`;

interface GitStats {
	staged: number;
	modified: number;
	untracked: number;
}

/** 可配置段。thinking 已并入 model，output 已并入 context。 */
interface SegmentConfig {
	model: boolean;
	git: boolean;
	context: boolean;
	tokens: boolean;
	cost: boolean;
	path: boolean;
	extensions: boolean;
}

type SegmentName = keyof SegmentConfig;

const SEGMENT_NAMES: SegmentName[] = [
	"model",
	"path",
	"git",
	"context",
	"tokens",
	"cost",
	"extensions",
];

const DEFAULT_CONFIG: SegmentConfig = {
	model: true,
	git: true,
	context: true,
	tokens: false,
	cost: false,
	path: true,
	extensions: true,
};

function loadConfig(): SegmentConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			return { ...DEFAULT_CONFIG, ...raw.segments };
		}
	} catch {
		// Invalid or unreadable config falls back to defaults.
	}
	return { ...DEFAULT_CONFIG };
}

function saveConfig(config: SegmentConfig): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ segments: config }, null, 2));
	} catch {
		// The live setting still applies even if persistence fails.
	}
}

let segmentConfig = loadConfig();
let gitStats: GitStats | null = null;
let gitTimer: ReturnType<typeof setInterval> | null = null;
let activePi: ExtensionAPI | null = null;

let providerStartTime: number | null = null;
let firstTokenTime: number | null = null;
let tokenCount = 0;
let lastTTFT: number | null = null;
let lastTPS: number | null = null;

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

function fmtPath(p: string): string {
	const home = homedir();
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function isSegmentName(value: string): value is SegmentName {
	return SEGMENT_NAMES.includes(value as SegmentName);
}

function configSummary(): string {
	return SEGMENT_NAMES.map((name) => `${name}:${segmentConfig[name] ? "on" : "off"}`).join(" · ");
}

/** 组装分隔的段字符串 */
function joinSegments(parts: string[], theme: { fg: (token: string, text: string) => string }): string {
	return parts.join(`${theme.fg("dim", " | ")}`);
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
				// ── model (含 thinking 级别) ──
				let modelStr: string | null = null;
				if (segmentConfig.model) {
					const modelId = (ctx.model as any)?.id || "no-model";
					let level = "off";
				try {
					level = (ctx as any)?.thinkingLevel || activePi?.getThinkingLevel() || "off";
				} catch {
					level = "off";
				}
					modelStr = theme.fg("accent", `model:${modelId}[${level}]`);
				}

				// ── git ──
				let gitStr: string | null = null;
				if (segmentConfig.git) {
					const branch = footerData.getGitBranch();
					if (branch) {
						const hasChanges = Boolean(
							gitStats && (gitStats.staged || gitStats.modified || gitStats.untracked),
						);
						let value = theme.fg(hasChanges ? "warning" : "success", `git:${branch}`);
						if (gitEnabled && gitStats) {
							const gitParts: string[] = [];
							if (gitStats.staged > 0) gitParts.push(theme.fg("success", `+${gitStats.staged}`));
							if (gitStats.modified > 0) gitParts.push(theme.fg("warning", `~${gitStats.modified}`));
							if (gitStats.untracked > 0) gitParts.push(theme.fg("error", `?${gitStats.untracked}`));
							if (gitParts.length > 0) value += ` ${gitParts.join(" ")}`;
						}
						gitStr = value;
					}
				}

				// ── 累计 output / cost ──
				let output = 0;
				let cost = 0;
				if (segmentConfig.context || segmentConfig.cost) {
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && (entry.message as any).role === "assistant") {
							const usage = (entry.message as any).usage;
							output += usage?.output || 0;
							cost += usage?.cost?.total || 0;
						}
					}
				}

				// ── context (含 output) ──
				let ctxStr: string | null = null;
				if (segmentConfig.context) {
					try {
						const usage = ctx.getContextUsage();
						if (usage && typeof usage.tokens === "number") {
							const contextWindow = (usage as any)?.contextWindow || (ctx.model as any)?.contextWindow || 128000;
							const percent = Math.max(0, (usage.tokens / contextWindow) * 100);
							const label = `▤ ${fmtTokens(usage.tokens)}/${fmtTokens(contextWindow)} (${Math.round(percent)}%)`;
							let value: string;
							if (percent < 70) value = theme.fg("success", label);
							else if (percent < 85) value = theme.fg("warning", label);
							else if (percent <= 95) value = theme.fg("error", label);
							else value = theme.bold(theme.fg("error", label));
							// 合并 output
							value += ` ${theme.fg("muted", `↑${fmtTokens(output)}`)}`;
							ctxStr = value;
						}
					} catch {
						// Context usage is optional while a session is initializing.
					}
				}

				// ── tokens (TTFT/TPS) ──
				let tokensStr: string | null = null;
				if (segmentConfig.tokens && (lastTTFT !== null || lastTPS !== null)) {
					const tokenParts: string[] = [];
					if (lastTTFT !== null) {
						const label = `TTFT:${lastTTFT.toFixed(1)}s`;
						tokenParts.push(theme.fg(lastTTFT > 3 ? "error" : "success", label));
					}
					if (lastTPS !== null) {
						const label = `${Math.round(lastTPS)} TPS`;
						tokenParts.push(theme.fg(lastTPS < 10 ? "error" : "success", label));
					}
					tokensStr = tokenParts.join(" ");
				}

				// ── cost ──
				let costStr: string | null = null;
				if (segmentConfig.cost) {
					const label = `cost:$${cost.toFixed(3)}`;
					const color = cost < 0.1 ? "muted" : cost <= 1 ? "dim" : "warning";
					costStr = theme.fg(color, label);
				}

				// ── 行 1: 左右对齐 ──
				const leftParts = [modelStr, gitStr].filter(Boolean) as string[];
				const rightParts = [ctxStr, tokensStr, costStr].filter(Boolean) as string[];

				const leftStr = joinSegments(leftParts, theme);
				const rightStr = joinSegments(rightParts, theme);

				let line1: string;
				if (leftStr && rightStr) {
					const gap = width - visibleWidth(leftStr) - visibleWidth(rightStr);
					if (gap >= 2) {
						line1 = leftStr + " ".repeat(gap) + rightStr;
					} else {
						// 不够放，合并用分隔符
						line1 = truncateToWidth(`${leftStr}${theme.fg("dim", " | ")}${rightStr}`, width);
					}
				} else if (leftStr) {
					line1 = leftStr;
				} else if (rightStr) {
					line1 = rightStr;
				} else {
					line1 = "";
				}

				const lines: string[] = [];
				if (line1) lines.push(line1);

				// ── 行 2: path ──
				if (segmentConfig.path) {
					const pathStr = theme.fg("dim", `📂 ${fmtPath(ctx.sessionManager.getCwd())}`);
					lines.push(visibleWidth(pathStr) <= width ? pathStr : truncateToWidth(pathStr, width));
				}

				// ── 行 3: extensions ──
				if (segmentConfig.extensions) {
					const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
					if (statuses.length > 0) {
						const extStr = theme.fg("dim", statuses.join(" "));
						lines.push(visibleWidth(extStr) <= width ? extStr : truncateToWidth(extStr, width));
					}
				}

				return lines;
			},
		};
	});
}

export function restoreDefaultFooter(ctx: ExtensionContext): void {
	clearGitTimer();
	ctx.ui.setFooter(undefined);
}

export default function (pi: ExtensionAPI) {
	activePi = pi;

	pi.on("session_start", (_event, ctx) => applyStatusline(ctx));
	pi.on("agent_end", (_event, ctx) => applyStatusline(ctx));
	pi.on("model_select", (_event, ctx) => applyStatusline(ctx));
	pi.on("thinking_level_select", (_event, ctx) => applyStatusline(ctx));
	pi.on("session_compact", (_event, ctx) => applyStatusline(ctx));
	pi.on("session_tree", (_event, ctx) => applyStatusline(ctx));
	pi.on("session_shutdown", () => clearGitTimer());

	pi.on("before_provider_request", () => {
		providerStartTime = Date.now();
		firstTokenTime = null;
		tokenCount = 0;
	});

	pi.on("message_update", (event) => {
		if (!providerStartTime) return;
		const message = (event as any).message;
		if (message?.role !== "assistant") return;
		const output = message.usage?.output || 0;
		if (output <= 0) return;

		if (!firstTokenTime) {
			firstTokenTime = Date.now();
			lastTTFT = (firstTokenTime - providerStartTime) / 1000;
		}
		tokenCount = output;
		const elapsed = (Date.now() - firstTokenTime) / 1000;
		if (elapsed > 0.1) lastTPS = tokenCount / elapsed;
	});

	pi.registerCommand("cc-tui", {
		description: "配置 pi-cc-tui 状态栏段",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const action = tokens[0] || "list";

			if (action === "list") {
				ctx.ui.notify(configSummary(), "info");
				return;
			}

			if (action === "all" || action === "none") {
				const enabled = action === "all";
				for (const name of SEGMENT_NAMES) segmentConfig[name] = enabled;
			} else if (action === "only") {
				const names = tokens.slice(1);
				const invalid = names.filter((name) => !isSegmentName(name));
				if (invalid.length > 0) {
					ctx.ui.notify(`未知段: ${invalid.join(", ")}`, "warning");
					return;
				}
				for (const name of SEGMENT_NAMES) segmentConfig[name] = false;
				for (const name of names) segmentConfig[name as SegmentName] = true;
			} else if (action === "show" || action === "hide") {
				const names = tokens.slice(1);
				if (names.length === 0) {
					ctx.ui.notify(`用法: /cc-tui ${action} <${SEGMENT_NAMES.join("|")}>`, "warning");
					return;
				}
				const invalid = names.filter((name) => !isSegmentName(name));
				if (invalid.length > 0) {
					ctx.ui.notify(`未知段: ${invalid.join(", ")}`, "warning");
					return;
				}
				for (const name of names) segmentConfig[name as SegmentName] = action === "show";
			} else {
				ctx.ui.notify("用法: /cc-tui [list|all|none|only|show|hide]", "warning");
				return;
			}

			saveConfig(segmentConfig);
			segmentConfig = loadConfig();
			applyStatusline(ctx);
			ctx.ui.notify(configSummary(), "info");
		},
	});

	pi.registerCommand("statusline-git", {
		description: "显示 git 状态统计开关的重启配置",
		handler: async (_args, ctx) => {
			const next = gitEnabled ? "0" : "1";
			ctx.ui.notify(`重启 pi 后生效: PI_STATUSLINE_GIT=${next}`, "info");
		},
	});
}
