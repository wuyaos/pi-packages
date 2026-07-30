/**
 * 运行时检测与图标映射。
 *
 * 状态栏 render 同步高频调用，绝不在 render 里 spawn 进程。这里维护进程级
 * 单例缓存：render 只读缓存（O(1)），缓存过期时触发一次异步探测，完成后
 * 回调通知 TUI 重新渲染。模式参照 git-status.ts。
 *
 * 运行时清单与检测信号移植自 OldSuns/pi-open-tui 的 runtime.ts；图标映射
 * 按本地四模式（unicode/ascii/nerd/emoji）扩展。
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IconMode } from "../ui/icons.ts";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 2500;
/** 命中运行时后 10s 内不重探；版本不会频繁变化。 */
const REFRESH_INTERVAL_MS = 10_000;
/** 无任何运行时信号的非项目目录 60s 才重试，避免频繁 spawn。 */
const NOT_A_PROJECT_INTERVAL_MS = 60_000;

export interface RuntimeInfo {
	name: string;
	version?: string;
}

export interface RuntimeInfoState {
	/** 当前目标 cwd；探测异步进行中时已同步更新为目标 cwd。 */
	cwd: string;
	/** 上次探测结果；infoCwd 不匹配当前 cwd 时视为无效。 */
	info: RuntimeInfo | null;
	/** info 对应的 cwd，用于 render 校验。 */
	infoCwd: string;
	/** 上次探测完成时间戳 ms。 */
	stamp: number;
	/** 异步探测进行中，避免重入。 */
	pending: boolean;
	/** 标记为非项目目录，拉长重试间隔。 */
	notAProject: boolean;
}

export function createRuntimeInfoState(): RuntimeInfoState {
	return { cwd: "", info: null, infoCwd: "", stamp: 0, pending: false, notAProject: false };
}

interface RuntimeDef {
	name: string;
	files: readonly string[];
	folders?: readonly string[];
	extensions?: readonly string[];
	env?: string;
	versionCommand?: { cmd: string; args?: string[]; pattern?: RegExp };
}

const RUNTIMES: readonly RuntimeDef[] = [
	{ name: "nodejs", files: ["package.json", ".nvmrc", ".node-version"], versionCommand: { cmd: "node", args: ["--version"], pattern: /v(\d+\.\d+\.\d+)/ } },
	{ name: "rust", files: ["Cargo.toml"], versionCommand: { cmd: "rustc", args: ["--version"], pattern: /rustc\s+(\d+\.\d+\.\d+)/ } },
	{ name: "go", files: ["go.mod"], versionCommand: { cmd: "go", args: ["version"], pattern: /go(\d+\.\d+\.\d+)/ } },
	{ name: "python", files: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", ".python-version"], versionCommand: { cmd: "python3", args: ["--version"], pattern: /Python\s+(\d+\.\d+\.\d+)/ } },
	{ name: "ruby", files: ["Gemfile", ".ruby-version"], versionCommand: { cmd: "ruby", args: ["--version"], pattern: /ruby\s+(\d+\.\d+\.\d+)/ } },
	{ name: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts", ".java-version"], versionCommand: { cmd: "java", args: ["-version"], pattern: /version\s+"(\d+\.\d+[\.\d]*)"/ } },
	{ name: "swift", files: ["Package.swift"], versionCommand: { cmd: "swift", args: ["--version"], pattern: /Swift\s+(\d+\.\d+)/ } },
	{ name: "kotlin", files: ["build.gradle.kts", "settings.gradle.kts"] },
	{ name: "cpp", files: ["CMakeLists.txt", "Makefile"] },
	{ name: "c", files: ["Makefile", "CMakeLists.txt"] },
	{ name: "deno", files: ["deno.json", "deno.jsonc", "deno.lock"], versionCommand: { cmd: "deno", args: ["--version"], pattern: /deno\s+(\d+\.\d+\.\d+)/ } },
	{ name: "bun", files: ["bun.lock", "bun.lockb"], versionCommand: { cmd: "bun", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "php", files: ["composer.json"], versionCommand: { cmd: "php", args: ["--version"], pattern: /PHP\s+(\d+\.\d+\.\d+)/ } },
	{ name: "haskell", files: ["stack.yaml", "cabal.project", ".cabal"], versionCommand: { cmd: "ghc", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "julia", files: ["Project.toml", "Manifest.toml"], versionCommand: { cmd: "julia", args: ["--version"], pattern: /julia\s+(\d+\.\d+\.\d+)/ } },
	{ name: "lua", files: ["stylua.toml", ".luarc.json"], versionCommand: { cmd: "lua", args: ["-v"], pattern: /Lua\s+(\d+\.\d+)/ } },
	{ name: "elixir", files: ["mix.exs"], versionCommand: { cmd: "elixir", args: ["--version"], pattern: /Elixir\s+(\d+\.\d+\.\d+)/ } },
	{ name: "erlang", files: ["rebar.config", "erlang.mk"] },
	{ name: "gleam", files: ["gleam.toml"], versionCommand: { cmd: "gleam", args: ["--version"], pattern: /gleam\s+(\d+\.\d+\.\d+)/ } },
	{ name: "crystal", files: ["shard.yml"], versionCommand: { cmd: "crystal", args: ["--version"], pattern: /Crystal\s+(\d+\.\d+\.\d+)/ } },
	{ name: "dart", files: ["pubspec.yaml"], versionCommand: { cmd: "dart", args: ["--version"], pattern: /Dart\s+SDK\s+version:\s+(\d+\.\d+\.\d+)/ } },
	{ name: "nim", files: ["nim.cfg", ".nimble"] },
	{ name: "zig", files: ["build.zig"], versionCommand: { cmd: "zig", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "ocaml", files: [".opam", "dune", "dune-project"] },
	{ name: "clojure", files: ["project.clj", "deps.edn"] },
	{ name: "scala", files: ["build.sbt", ".scala", ".metals"] },
	{ name: "perl", files: ["Makefile.PL", "cpanfile"] },
	{ name: "r", files: [".Rproj", "DESCRIPTION"] },
	{ name: "elm", files: ["elm.json"] },
	{ name: "haxe", files: ["haxelib.json", ".haxerc"] },
	{ name: "vagrant", files: ["Vagrantfile"] },
	{ name: "terraform", files: ["main.tf", "variables.tf"], folders: [".terraform"] },
	{ name: "helm", files: ["Chart.yaml", "helmfile.yaml"] },
	{ name: "solidity", files: [], extensions: [".sol"] },
	{ name: "fortran", files: ["fpm.toml"], extensions: [".f", ".f90", ".f95"] },
	{ name: "mojo", files: [], extensions: [".mojo"] },
	{ name: "red", files: [], extensions: [".red", ".reds"] },
	{ name: "raku", files: ["META6.json"], extensions: [".raku", ".rakumod"] },
	{ name: "purescript", files: ["spago.dhall", "spago.yaml"] },
	{ name: "fennel", files: [], extensions: [".fnl"] },
	{ name: "odin", files: [], extensions: [".odin"] },
	{ name: "v", files: ["v.mod", "vpkg.json"], extensions: [".v"] },
	{ name: "xmake", files: ["xmake.lua"] },
	{ name: "gradle", files: ["build.gradle", "build.gradle.kts"], folders: ["gradle"] },
	{ name: "maven", files: ["pom.xml"] },
	{ name: "cmake", files: ["CMakeLists.txt", "CMakeCache.txt"] },
	{ name: "meson", files: ["meson.build"], env: "MESON_DEVENV" },
	{ name: "nix", files: ["flake.nix", "shell.nix"], env: "IN_NIX_SHELL" },
	{ name: "guix", files: [], env: "GUIX_ENVIRONMENT" },
	{ name: "conda", files: [], env: "CONDA_DEFAULT_ENV" },
	{ name: "pixi", files: ["pixi.toml", "pixi.lock"], env: "PIXI_ENVIRONMENT_NAME" },
	{ name: "spack", files: [], env: "SPACK_ENV" },
	{ name: "pulumi", files: ["Pulumi.yaml", "Pulumi.yml"] },
	{ name: "typst", files: ["template.typ"], extensions: [".typ"] },
	{ name: "buf", files: ["buf.yaml", "buf.gen.yaml", "buf.work.yaml"] },
	{ name: "dotnet", files: [".csproj", ".fsproj", "global.json", "Directory.Build.props"] },
	{ name: "cobol", files: [], extensions: [".cbl", ".cob"] },
];

// ── 图标映射 ──
// Nerd Font 私有区码点移植自 OldSuns/pi-open-tui；ASCII 短名同源。
// unicode/emoji 模式用 emoji 表，未覆盖的运行时 fallback 到 ASCII 短名。
const NERD_RUNTIME_SYMBOLS: Record<string, string> = {
	nodejs: "\uE718",
	rust: "\uE7A8",
	go: "\uE626",
	python: "\uE73C",
	ruby: "\uE739",
	java: "\uE256",
	cpp: "\uE61D",
	c: "\uE61E",
	swift: "\uE755",
	kotlin: "\uE634",
	deno: "\uE7FB",
	bun: "\uE6FB",
	php: "\uE73D",
	haskell: "\uE777",
	julia: "\uE624",
	lua: "\uE620",
	elixir: "\uE62B",
	erlang: "\uE7B1",
	gleam: "\uE6B4",
	crystal: "\uE62F",
	dart: "\uE7C0",
	nim: "\uE677",
	zig: "\uE6A9",
	ocaml: "\uE67A",
	clojure: "\uE76A",
	scala: "\uE747",
	perl: "\uE769",
	r: "\uE68A",
	elm: "\uE62C",
	haxe: "\uE7B7",
	vagrant: "\uE21A",
	terraform: "\uE1A5",
};

const ASCII_RUNTIME_SYMBOLS: Record<string, string> = {
	nodejs: "node",
	rust: "rs",
	go: "go",
	python: "py",
	ruby: "rb",
	java: "java",
	swift: "swift",
	kotlin: "kt",
	cpp: "c++",
	c: "c",
	deno: "deno",
	bun: "bun",
	php: "php",
	haskell: "hs",
	julia: "jl",
	lua: "lua",
	elixir: "ex",
	erlang: "erl",
	gleam: "gleam",
	crystal: "cr",
	dart: "dart",
	nim: "nim",
	zig: "zig",
	ocaml: "ml",
	clojure: "clj",
	scala: "scala",
	perl: "pl",
	r: "R",
	elm: "elm",
	haxe: "hx",
	vagrant: "vag",
	terraform: "tf",
};

const EMOJI_RUNTIME_SYMBOLS: Record<string, string> = {
	nodejs: "🟢",
	rust: "🦀",
	go: "🐹",
	python: "🐍",
	ruby: "💎",
	java: "☕",
	swift: "🐦",
	kotlin: "🟣",
	cpp: "🔧",
	c: "🔧",
	deno: "🦕",
	bun: "🍞",
	php: "🐘",
	haskell: "λ",
	julia: "🟣",
	lua: "🌙",
	elixir: "💧",
	erlang: "📞",
	gleam: "✨",
	crystal: "🔮",
	dart: "🎯",
	nim: "👑",
	zig: "⚡",
	ocaml: "🐫",
	clojure: "🟦",
	scala: "🟥",
	perl: "🐪",
	r: "📊",
	elm: "🌳",
	haxe: "🦔",
	vagrant: "📦",
	terraform: "🏗️",
};

/**
 * 按图标模式返回运行时符号。
 * - nerd：Nerd Font 码点；未覆盖用 ▪。
 * - ascii：短名；未覆盖用运行时原名。
 * - unicode/emoji：emoji；未覆盖 fallback 到 ASCII 短名，再 fallback 到原名。
 */
export function runtimeSymbol(name: string, mode: IconMode): string {
	if (mode === "nerd") return NERD_RUNTIME_SYMBOLS[name] ?? "▪";
	if (mode === "ascii") return ASCII_RUNTIME_SYMBOLS[name] ?? name;
	return EMOJI_RUNTIME_SYMBOLS[name] ?? ASCII_RUNTIME_SYMBOLS[name] ?? name;
}

// ── 检测逻辑 ──

function matchesDef(cwd: string, def: RuntimeDef): boolean {
	if (def.env && process.env[def.env]) return true;
	if (def.files.some((f) => existsSync(join(cwd, f)))) return true;
	if (def.folders?.some((f) => existsSync(join(cwd, f)))) return true;
	if (def.extensions) {
		try {
			const entries = readdirSync(cwd);
			if (entries.some((e) => def.extensions!.some((ext) => e.endsWith(ext)))) return true;
		} catch { /* ignore unreadable cwd */ }
	}
	return false;
}

async function fetchVersion(def: RuntimeDef, cwd: string): Promise<string | undefined> {
	if (!def.versionCommand) return undefined;
	try {
		const { stdout } = await execFileAsync(def.versionCommand.cmd, def.versionCommand.args ?? [], {
			cwd,
			timeout: VERSION_TIMEOUT_MS,
			maxBuffer: 64 * 1024,
		});
		if (def.versionCommand.pattern) {
			const match = stdout.match(def.versionCommand.pattern);
			return match?.[1];
		}
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * 若缓存过期则触发一次异步运行时探测；render 永远同步返回当前缓存值。
 * 切换 cwd 时立即清空 info，避免短暂显示上一项目的运行时。探测完成后
 * 调用 `onUpdated`（通常 `tui.requestRender()`）让 TUI 重绘。
 */
export function refreshRuntimeInfo(
	state: RuntimeInfoState,
	cwd: string,
	onUpdated: () => void,
): void {
	const now = Date.now();
	const interval = state.notAProject ? NOT_A_PROJECT_INTERVAL_MS : REFRESH_INTERVAL_MS;
	if (state.cwd === cwd && now - state.stamp < interval) return;
	if (state.pending && state.cwd === cwd) return;

	// 切换 cwd 时立即作废旧 info，render 不会读到跨项目的陈旧值。
	if (state.cwd !== cwd) {
		state.info = null;
		state.infoCwd = "";
	}
	state.cwd = cwd;
	state.pending = true;

	// 同步扫文件找首个命中的运行时（O(候选文件数)，无 spawn）。
	let matched: RuntimeDef | null = null;
	for (const def of RUNTIMES) {
		if (matchesDef(cwd, def)) {
			matched = def;
			break;
		}
	}

	if (!matched) {
		state.pending = false;
		state.stamp = Date.now();
		state.notAProject = true;
		state.info = null;
		state.infoCwd = "";
		onUpdated();
		return;
	}

	state.notAProject = false;
	fetchVersion(matched, cwd).then((version) => {
		state.pending = false;
		state.stamp = Date.now();
		state.info = { name: matched!.name, version };
		state.infoCwd = cwd;
		onUpdated();
	}).catch(() => {
		state.pending = false;
		state.stamp = Date.now();
		state.info = { name: matched!.name };
		state.infoCwd = cwd;
		onUpdated();
	});
}
