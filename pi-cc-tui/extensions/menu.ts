/** pi-cc-tui 双栏交互式配置菜单。 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Focusable } from "@earendil-works/pi-tui";
import type { SegmentConfig, SegmentName } from "./statusline.ts";
import { getIconMode, getIcons, type IconMode } from "../src/ui/icons.ts";

import { renderBorderLine, renderBoxLine, resolveBorderStyle } from "../src/ui/box.ts";
import { padText } from "../src/ui/text.ts";

export interface MenuResult {
	changed: boolean;
	iconMode: IconMode;
	startupResourcesVisible: boolean;
	startupResourcesChanged: boolean;
}

type CategoryId = "appearance" | "statusline";
type MenuPane = "categories" | "settings";

type ToggleRow = Readonly<{
	kind: "toggle";
	name: SegmentName;
	label: string;
	description: string;
}>;

type ActionRow = Readonly<{
	kind: "action";
	action: "enableAll" | "disableAll" | "cycleIcons" | "toggleStartupResources";
	label: string;
	description: string;
}>;

type Row = ToggleRow | ActionRow;
type Category = Readonly<{ id: CategoryId; label: string; hint: string; rows: readonly Row[] }>;

export class ConfigMenuComponent implements Focusable {
	focused = false;
	private categoryIndex = 0;
	/** Left pane is the first-level menu; right pane is its settings page. */
	private pane: MenuPane = "categories";
	private readonly selectedRows: Record<CategoryId, number> = { appearance: 0, statusline: 0 };
	private readonly theme: Theme;
	private readonly done: (result: MenuResult | undefined) => void;
	private readonly config: SegmentConfig;
	private iconMode: IconMode;
	private startupResourcesVisible: boolean;
	private startupResourcesChanged = false;
	private changed = false;
	private readonly width = 86;
	private readonly categories: readonly Category[];

	constructor(
		theme: Theme,
		done: (result: MenuResult | undefined) => void,
		config: SegmentConfig,
		iconMode: IconMode,
		startupResourcesVisible: boolean,
	) {
		this.theme = theme;
		this.done = done;
		this.config = config;
		this.iconMode = iconMode;
		this.startupResourcesVisible = startupResourcesVisible;
		const icons = getIcons();
		this.categories = [
			{
				id: "appearance",
				label: "外观",
				hint: "图标显示",
				rows: [
					{ kind: "action", action: "cycleIcons", label: "图标模式", description: "unicode → ascii → nerd → emoji" },
					{ kind: "action", action: "toggleStartupResources", label: "启动资源清单", description: "Context、Skills、Prompts、Extensions、Themes" },
				],
			},
			{
				id: "statusline",
				label: "状态栏",
				hint: "页脚信息段",
				rows: [
					{ kind: "action", action: "enableAll", label: `${icons.actionEnable} 全部开启`, description: "开启所有状态栏段" },
					{ kind: "action", action: "disableAll", label: `${icons.actionDisable} 全部关闭`, description: "关闭所有状态栏段" },
					{ kind: "toggle", name: "model", label: "模型", description: "模型名与 thinking level" },
					{ kind: "toggle", name: "context", label: "上下文用量", description: "当前上下文、输入、输出与缓存" },
					{ kind: "toggle", name: "tools", label: "工具统计", description: "成功数／总数" },
					{ kind: "toggle", name: "path", label: "项目路径", description: "当前项目路径" },
					{ kind: "toggle", name: "bar", label: "上下文色条", description: "当前上下文分段概览" },
					{ kind: "toggle", name: "git", label: "Git 状态", description: "分支名与变更文件数" },
					{ kind: "toggle", name: "extensions", label: "扩展状态", description: "扩展提供的状态文本" },
				],
			},
		];
	}

	private get category(): Category {
		return this.categories[this.categoryIndex]!;
	}

	private get selected(): number {
		return this.selectedRows[this.category.id];
	}

	private set selected(value: number) {
		this.selectedRows[this.category.id] = Math.max(0, Math.min(this.category.rows.length - 1, value));
	}

	private toggleSegment(name: SegmentName): void {
		this.config[name] = !this.config[name];
		this.changed = true;
	}

	private cycleIcons(): void {
		const modes: readonly IconMode[] = ["unicode", "ascii", "nerd", "emoji"];
		this.iconMode = modes[(modes.indexOf(this.iconMode) + 1) % modes.length]!;
		this.changed = true;
	}

	private activate(row: Row): void {
		if (row.kind === "toggle") {
			this.toggleSegment(row.name);
			return;
		}
		if (row.action === "cycleIcons") {
			this.cycleIcons();
			return;
		}
		if (row.action === "toggleStartupResources") {
			this.startupResourcesVisible = !this.startupResourcesVisible;
			this.startupResourcesChanged = true;
			this.changed = true;
			return;
		}
		for (const item of this.categories.find((category) => category.id === "statusline")!.rows) {
			if (item.kind === "toggle") this.config[item.name] = row.action === "enableAll";
		}
		this.changed = true;
	}

	handleInput(data: string): void {
		// Escape is a true back operation first: it never discards a configuration
		// change while the user is merely leaving a secondary settings page.
		if (matchesKey(data, "escape")) {
			if (this.pane === "settings") {
				this.pane = "categories";
				return;
			}
			if (this.changed) {
				this.done({
					changed: true,
					iconMode: this.iconMode,
					startupResourcesVisible: this.startupResourcesVisible,
					startupResourcesChanged: this.startupResourcesChanged,
				});
			} else {
				this.done(undefined);
			}
			return;
		}
		if (matchesKey(data, "left")) {
			this.pane = "categories";
			return;
		}
		if (matchesKey(data, "right")) {
			this.pane = "settings";
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.pane === "categories") this.categoryIndex = Math.max(0, this.categoryIndex - 1);
			else this.selected--;
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.pane === "categories") this.categoryIndex = Math.min(this.categories.length - 1, this.categoryIndex + 1);
			else this.selected++;
			return;
		}
		if (data === " ") {
			if (this.pane === "categories") {
				this.pane = "settings";
				return;
			}
			const row = this.category.rows[this.selected];
			if (row) this.activate(row);
		}
	}

	private isEnabled(row: Row): boolean | undefined {
		if (row.kind === "toggle") return this.config[row.name] ?? false;
		return undefined;
	}

	render(_width: number): string[] {
		const width = this.width;
		const th = this.theme;
		const icons = getIcons();
		const glyphs = resolveBorderStyle("rounded", getIconMode());
		const innerWidth = width - 2;
		const leftWidth = 19;
		const divider = " │ ";
		const rightWidth = innerWidth - leftWidth - divider.length;
		const paintBorder = (text: string) => th.fg("border", text);
		const row = (content: string) => renderBoxLine({ content, width, glyphs, paint: paintBorder });
		const twoColumn = (left: string, right: string) => row(`${padText(left, leftWidth)}${th.fg("borderMuted", divider)}${padText(right, rightWidth)}`);
		const lines: string[] = [];

		lines.push(renderBorderLine({ width, side: "top", glyphs, label: "⚙ CC-TUI 配置", paint: paintBorder }));
		const categoryHeading = this.pane === "categories" ? "分类 · 选择后按 → 或 Space 进入" : "分类 · ← 返回此处";
		const settingsHeading = this.pane === "settings"
			? `${this.category.label} · ${this.category.hint}`
			: "设置 · 按 → 或 Space 进入分类后修改";
		lines.push(twoColumn(th.fg("accent", categoryHeading), th.fg("accent", settingsHeading)));
		lines.push(twoColumn(th.fg("borderMuted", "───────────────────"), th.fg("borderMuted", "────────────────────────────────────────────────────────────")));

		const maxRows = Math.max(this.categories.length, this.category.rows.length);
		for (let index = 0; index < maxRows; index++) {
			const category = this.categories[index];
			const left = category
				? category.id === this.category.id
					? this.pane === "categories"
						? th.bg("selectedBg", th.fg("accent", `${icons.selected} ${category.label}`))
						: th.fg("accent", `  ${category.label}`)
					: th.fg("text", `  ${category.label}`)
				: "";
			const item = this.category.rows[index];
			let right = "";
			if (item) {
				const selected = this.pane === "settings" && index === this.selected;
				const enabled = this.isEnabled(item);
				const marker = enabled === undefined ? "  " : enabled ? th.fg("success", `${icons.enabled} `) : th.fg("dim", `${icons.disabled} `);
				const label = item.kind === "action" && item.action === "cycleIcons"
					? `${item.label}：${this.iconMode}`
					: item.kind === "action" && item.action === "toggleStartupResources"
						? `${item.label}：${this.startupResourcesVisible ? "显示" : "隐藏"}`
						: item.label;
				const text = `${selected ? `${icons.selected} ` : "  "}${marker}${selected ? th.fg("accent", label) : th.fg("text", label)}  ${th.fg("dim", item.description)}`;
				right = selected ? th.bg("selectedBg", text) : text;
			}
			lines.push(twoColumn(left, right));
		}

		lines.push(twoColumn("", ""));
		const leftHelp = this.pane === "categories" ? "↑ ↓ 分类 · →/Space 进入" : "←/Esc 返回分类";
		const rightHelp = this.pane === "settings" ? "↑ ↓ 选择 · Space 修改" : "选择分类后进入设置";
		lines.push(twoColumn(th.fg("dim", leftHelp), th.fg("dim", `${rightHelp} · Esc 保存退出`)));
		lines.push(renderBorderLine({ width, side: "bottom", glyphs, paint: paintBorder }));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function () {}
