/**
 * 统一的语义图标表。
 *
 * 界面模块只能引用语义名，不能在业务渲染中散落硬编码图标。这样同一份
 * Footer、菜单、工具、Widget 和 Overlay 可以切换为 Unicode、ASCII 或 Nerd Font
 * 外观；未来持久化配置只需调用 createIconSet()，无需修改各渲染模块。
 */

export const ICON_NAMES = [
	"actionEnable",
	"actionDisable",
	"cache",
	"context",
	"diff",
	"disabled",
	"enabled",
	"error",
	"extensions",
	"git",
	"model",
	"path",
	"running",
	"selected",
	"success",
	"thinking",
	"todo",
	"tool",
	"user",
] as const;

export type IconName = (typeof ICON_NAMES)[number];
export type IconMode = "unicode" | "ascii" | "nerd" | "emoji";
export type IconSet = Readonly<Record<IconName, string>>;
export type IconOverrides = Partial<Record<IconName, string>>;

const UNICODE_ICONS: IconSet = {
	actionEnable: "✓",
	actionDisable: "✕",
	cache: "⚡",
	context: "▤",
	diff: "≠",
	disabled: "○",
	enabled: "●",
	error: "✕",
	extensions: "⊕",
	git: "⎇",
	model: "◆",
	path: "⌂",
	running: "◌",
	selected: "▶",
	success: "✓",
	thinking: "✻",
	todo: "☐",
	tool: "◆",
	user: "›",
};

const ASCII_ICONS: IconSet = {
	actionEnable: "+",
	actionDisable: "-",
	cache: "cache",
	context: "ctx",
	diff: "~",
	disabled: "o",
	enabled: "*",
	error: "x",
	extensions: "ext",
	git: "git",
	model: "model",
	path: "cwd",
	running: "...",
	selected: ">",
	success: "ok",
	thinking: "...",
	todo: "[ ]",
	tool: "tool",
	user: "user",
};

// Nerd Font glyphs are intentionally opt-in; the default remains Unicode so
// terminals without a patched font never display replacement boxes.
const EMOJI_ICONS: IconSet = {
	actionEnable: "✅",
	actionDisable: "⛔",
	cache: "⚡",
	context: "🧠",
	diff: "📝",
	disabled: "⚪",
	enabled: "🟢",
	error: "❌",
	extensions: "🧩",
	git: "🌿",
	model: "🤖",
	path: "📁",
	running: "🔄",
	selected: "👉",
	success: "✅",
	thinking: "💭",
	todo: "☑️",
	tool: "🛠️",
	user: "👤",
};

const NERD_ICONS: IconSet = {
	actionEnable: "\uf00c",
	actionDisable: "\uf00d",
	cache: "\uf49b",
	context: "\uf2db",
	diff: "\uf0c9",
	disabled: "\uf10c",
	enabled: "\uf111",
	error: "\uf00d",
	extensions: "\uf12e",
	git: "\ue702",
	model: "\uf0e7",
	path: "\uf07b",
	running: "\uf110",
	selected: "\uf061",
	success: "\uf00c",
	thinking: "\uf085",
	todo: "\uf00c",
	tool: "\uf0ad",
	user: "\uf2bd",
};

const ICONS_BY_MODE: Readonly<Record<IconMode, IconSet>> = {
	unicode: UNICODE_ICONS,
	ascii: ASCII_ICONS,
	nerd: NERD_ICONS,
	emoji: EMOJI_ICONS,
};

let runtimeIcons: IconSet | undefined;
let runtimeIconMode: IconMode | undefined;

/** Safely normalize user configuration or PI_CC_TUI_ICON_MODE. */
export function normalizeIconMode(value: unknown): IconMode {
	return value === "ascii" || value === "nerd" || value === "unicode" || value === "emoji"
		? value
		: "unicode";
}

/**
 * Build an immutable icon set. Empty overrides are ignored to keep every
 * semantic icon renderable even when a hand-edited config contains bad data.
 */
export function createIconSet(options: {
	mode?: unknown;
	overrides?: IconOverrides;
} = {}): IconSet {
	const base = ICONS_BY_MODE[normalizeIconMode(options.mode)];
	const merged: Record<IconName, string> = { ...base };
	for (const name of ICON_NAMES) {
		const override = options.overrides?.[name];
		if (typeof override === "string" && override.length > 0) merged[name] = override;
	}
	return Object.freeze(merged);
}

/** Set the process-local icon source after loading cc-tui user configuration. */
export function configureIcons(options: { mode?: unknown; overrides?: IconOverrides }): IconSet {
	runtimeIconMode = normalizeIconMode(options.mode);
	runtimeIcons = createIconSet(options);
	return runtimeIcons;
}

/** The active mode lets border and layout modules match icon fallbacks. */
export function getIconMode(): IconMode {
	return runtimeIconMode ?? normalizeIconMode(process.env.PI_CC_TUI_ICON_MODE);
}

/**
 * Runtime defaults to PI_CC_TUI_ICON_MODE until persisted cc-tui configuration
 * is loaded. All UI modules call this one resolver rather than reading config
 * or environment variables independently.
 */
export function getIcons(): IconSet {
	return runtimeIcons ?? createIconSet({ mode: process.env.PI_CC_TUI_ICON_MODE });
}
