/** pi-cc-tui 交互式配置菜单 (overlay TUI)。 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Focusable } from "@earendil-works/pi-tui";
import type { SegmentConfig, SegmentName } from "./statusline.ts";
import { getIconMode, getIcons } from "../src/ui/icons.ts";
import { renderBorderLine, renderBoxLine, resolveBorderStyle } from "../src/ui/box.ts";

export interface MenuResult {
	/** 需要重新应用 statusline */
	changed: boolean;
}

interface MenuItem {
	kind: "toggle";
	name: SegmentName;
	label: string;
	description: string;
}

interface ActionItem {
	kind: "action";
	action: "enableAll" | "disableAll";
	label: string;
	description: string;
}

type Row = MenuItem | ActionItem;

export class ConfigMenuComponent implements Focusable {
	focused = false;
	private selected = 0;
	private rows: Row[] = [];
	private theme: Theme;
	private done: (result: MenuResult | undefined) => void;
	private config: SegmentConfig;
	private changed = false;
	private readonly width = 64;

	constructor(
		theme: Theme,
		done: (result: MenuResult | undefined) => void,
		config: SegmentConfig,
		previewLines: number,
	) {
		this.theme = theme;
		this.done = done;
		this.config = config;

		const icons = getIcons();
		this.rows = [
			{ kind: "action", action: "enableAll", label: `${icons.actionEnable} 全部开启`, description: "开启所有段" },
			{ kind: "action", action: "disableAll", label: `${icons.actionDisable} 全部关闭`, description: "关闭所有段" },
			{ kind: "toggle", name: "model", label: "model", description: "模型名+thinking level" },
			{ kind: "toggle", name: "git", label: "git", description: "git 分支+状态统计" },
			{ kind: "toggle", name: "path", label: "path", description: `项目路径 ${icons.path}` },
			{ kind: "toggle", name: "context", label: "context", description: `上下文 token 用量 ${icons.context}` },
			{ kind: "toggle", name: "tokens", label: "ttft/tps", description: "首 token 延迟+吞吐" },
			{ kind: "toggle", name: "cost", label: "cost", description: "累计费用 $" },
			{ kind: "toggle", name: "bar", label: "bar", description: "上下文色条" },
			{ kind: "toggle", name: "extensions", label: "extensions", description: "扩展状态 (telegram+ 等)" },
		];

		// 忽略 previewLines 参数（保留接口兼容）
		void previewLines;
	}

	private getToggleState(name: SegmentName): boolean {
		return this.config[name] ?? false;
	}

	private toggleSegment(name: SegmentName): void {
		this.config[name] = !this.config[name];
		this.changed = true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(this.changed ? { changed: true } : undefined);
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const row = this.rows[this.selected];
			if (!row) return;
			if (row.kind === "toggle") {
				this.toggleSegment(row.name);
			} else {
				// action
				if (row.action === "enableAll") {
					for (const r of this.rows) {
						if (r.kind === "toggle") this.config[r.name] = true;
					}
					this.changed = true;
				} else {
					for (const r of this.rows) {
						if (r.kind === "toggle") this.config[r.name] = false;
					}
					this.changed = true;
				}
			}
			return;
		}

		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(this.rows.length - 1, this.selected + 1);
		}
	}

	render(_width: number): string[] {
		const w = this.width;
		const th = this.theme;
		const icons = getIcons();
		const glyphs = resolveBorderStyle("rounded", getIconMode());
		const lines: string[] = [];
		const paintBorder = (text: string) => th.fg("border", text);
		const row = (content: string) => renderBoxLine({
			content,
			width: w,
			glyphs,
			paint: paintBorder,
		});

		lines.push(renderBorderLine({ width: w, side: "top", glyphs, paint: paintBorder }));
		lines.push(row(` ${th.fg("accent", "⚙ pi-cc-tui 配置")}`));
		lines.push(row(""));

		for (let i = 0; i < this.rows.length; i++) {
			const item = this.rows[i]!;
			const isSel = i === this.selected;
			const prefix = isSel ? ` ${icons.selected} ` : "   ";

			if (item.kind === "toggle") {
				const on = this.getToggleState(item.name);
				const check = on ? th.fg("success", icons.enabled) : th.fg("dim", icons.disabled);
				const label = isSel ? th.fg("accent", item.label) : th.fg("text", item.label);
				const desc = th.fg("dim", `  ${item.description}`);
				lines.push(row(`${prefix}${check} ${label}${desc}`));
			} else {
				const label = isSel ? th.fg("accent", item.label) : th.fg("text", item.label);
				lines.push(row(`${prefix}  ${label}`));
			}

			// 分隔线
			if (item.kind === "action" && item.action === "disableAll") {
				lines.push(row(` ${th.fg("dim", "── 段 ──")}`));
			}
		}

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", "↑↓ 移动 • Enter 切换 • Esc 退出")}`));
		lines.push(renderBorderLine({ width: w, side: "bottom", glyphs, paint: paintBorder }));

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function () {}
