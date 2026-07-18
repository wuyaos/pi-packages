/**
 * pi-cc-tui 状态栏：模型、thinking、git、上下文、速度、输出、花费和扩展状态。
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

interface SegmentConfig {
	model: boolean;
	git: boolean;
	context: boolean;
	output: boolean;
	cost: boolean;
	tokens: boolean;
	thinking: boolean;
	extensions: boolean;
}

type SegmentName = keyof SegmentConfig;

const SEGMENT_NAMES: SegmentName[] = [
	"model",
	"git",
	"context",
	"output",
	"cost",
	"tokens",
	"thinking",
	"extensions",
];

const RENDER_ORDER: SegmentName[] = [
	"model",
	"thinking",
	"git",
	"context",
	"tokens",
	"output",
	"cost",
	"extensions",
];

const DEFAULT_CONFIG: SegmentConfig = {
	model: true,
	git: true,
	context: true,
	output: true,
	cost: false,
	tokens: false,
	thinking: false,
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

function isSegmentName(value: string): value is SegmentName {
	return SEGMENT_NAMES.includes(value as SegmentName);
}

function configSummary(): string {
	return SEGMENT_NAMES.map((name) => `${name}:${segmentConfig[name] ? "on" : "off"}`).join(" · ");
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
				const segments = new Map<SegmentName, string>();

				if (segmentConfig.model) {
					const model = (ctx.model as any)?.id || "no-model";
					segments.set("model", theme.fg("accent", model));
				}

				if (segmentConfig.thinking) {
					const level = activePi?.getThinkingLevel() || "off";
					let value = theme.fg("accent", `think:${level}`);
					if (level === "off") value = theme.fg("dim", `think:${level}`);
					else if (level === "low" || level === "minimal") value = theme.fg("success", `think:${level}`);
					else if (level === "high") value = theme.fg("warning", `think:${level}`);
					else if (level === "xhigh" || level === "max") value = theme.bold(theme.fg("error", `think:${level}`));
					segments.set("thinking", value);
				}

				if (segmentConfig.git) {
					const branch = footerData.getGitBranch();
					if (branch) {
						const hasChanges = Boolean(
							gitStats && (gitStats.staged || gitStats.modified || gitStats.untracked),
						);
						let value = theme.fg(hasChanges ? "warning" : "success", branch);
						if (gitEnabled && gitStats) {
							const gitParts: string[] = [];
							if (gitStats.staged > 0) gitParts.push(theme.fg("success", `+${gitStats.staged}`));
							if (gitStats.modified > 0) gitParts.push(theme.fg("warning", `~${gitStats.modified}`));
							if (gitStats.untracked > 0) gitParts.push(theme.fg("error", `?${gitStats.untracked}`));
							if (gitParts.length > 0) value += ` ${gitParts.join(" ")}`;
						}
						segments.set("git", value);
					}
				}

				if (segmentConfig.context) {
					try {
						const usage = ctx.getContextUsage();
						if (usage && typeof usage.tokens === "number") {
							const contextWindow = (ctx.model as any)?.context_window || 128000;
							const percent = Math.max(0, (usage.tokens / contextWindow) * 100);
							const label = `${fmtTokens(usage.tokens)}/${fmtTokens(contextWindow)} (${Math.round(percent)}%)`;
							let value: string;
							if (percent < 70) value = theme.fg("success", label);
							else if (percent < 85) value = theme.fg("warning", label);
							else if (percent <= 95) value = theme.fg("error", label);
							else value = theme.bold(theme.fg("error", label));
							segments.set("context", value);
						}
					} catch {
						// Context usage is optional while a session is initializing.
					}
				}

				let output = 0;
				let cost = 0;
				if (segmentConfig.output || segmentConfig.cost) {
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && (entry.message as any).role === "assistant") {
							const usage = (entry.message as any).usage;
							output += usage?.output || 0;
							cost += usage?.cost?.total || 0;
						}
					}
				}

				if (segmentConfig.tokens && (lastTTFT !== null || lastTPS !== null)) {
					const tokenParts: string[] = [];
					if (lastTTFT !== null) {
						const label = `TTFT ${lastTTFT.toFixed(1)}s`;
						tokenParts.push(theme.fg(lastTTFT > 3 ? "error" : "success", label));
					}
					if (lastTPS !== null) {
						const label = `${Math.round(lastTPS)} TPS`;
						tokenParts.push(theme.fg(lastTPS < 10 ? "error" : "success", label));
					}
					segments.set("tokens", tokenParts.join("/"));
				}

				if (segmentConfig.output) {
					segments.set("output", theme.fg("muted", `↑${fmtTokens(output)}`));
				}

				if (segmentConfig.cost) {
					const label = `$${cost.toFixed(3)}`;
					const color = cost < 0.1 ? "muted" : cost <= 1 ? "dim" : "warning";
					segments.set("cost", theme.fg(color, label));
				}

				if (segmentConfig.extensions) {
					const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
					if (statuses.length > 0) {
						segments.set("extensions", theme.fg("dim", statuses.join(" ")));
					}
				}

				const visibleSegments = RENDER_ORDER.flatMap((name) => {
					const value = segmentConfig[name] ? segments.get(name) : undefined;
					return value ? [value] : [];
				});
				const separator = ` ${theme.fg("dim", "❯")} `;
				const line = visibleSegments.join(separator);
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
	activePi = pi;

	pi.on("session_start", (_event, ctx) => applyStatusline(ctx));
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
