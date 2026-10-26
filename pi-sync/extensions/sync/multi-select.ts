/**
 * 盒式多选组件（pi-sync 专用）。
 *
 * 与 _shared/enhanced-select 同风格：主题化边框、滚动、帮助行。
 * 交互：空格切换勾选、↑↓/PgUp/PgDn/Home/End 导航、Enter 或 Ctrl+S 确认返回
 * 勾选集合、Esc 取消返回 undefined。disabled 项置灰且不可勾选。
 *
 * Import: import { … } from "./multi-select"
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bottomBorder, lineInBox, sidePad, topBorder } from "../_shared/box-drawing";

export interface MultiSelectItem {
  id: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface MultiSelectResult {
  checked: string[];
}

export class MultiSelectComponent {
  private readonly checkedSet: Set<string>;
  private selectedIdx = 0;
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly maxVisibleRows = 14;

  constructor(
    private readonly title: string,
    private readonly items: MultiSelectItem[],
    private readonly footer: string,
    private readonly tui: { requestRender(): void },
    private readonly theme: any,
    private readonly done: (result: MultiSelectResult | undefined) => void,
  ) {
    this.checkedSet = new Set(items.filter((item) => item.checked && !item.disabled).map((item) => item.id));
    const firstEnabled = items.findIndex((item) => !item.disabled);
    this.selectedIdx = firstEnabled === -1 ? 0 : firstEnabled;
  }

  checkedIds(): string[] {
    return this.items.filter((item) => this.checkedSet.has(item.id)).map((item) => item.id);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) {
      this.done({ checked: this.checkedIds() });
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(undefined);
      return;
    }
    if (data === " ") {
      const item = this.items[this.selectedIdx];
      if (item && !item.disabled) {
        if (this.checkedSet.has(item.id)) this.checkedSet.delete(item.id);
        else this.checkedSet.add(item.id);
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    const len = this.items.length;
    if (len === 0) return;
    if (matchesKey(data, Key.up)) {
      this.selectedIdx = this.selectedIdx > 0 ? this.selectedIdx - 1 : len - 1;
    } else if (matchesKey(data, Key.down)) {
      this.selectedIdx = this.selectedIdx < len - 1 ? this.selectedIdx + 1 : 0;
    } else if (matchesKey(data, Key.pageUp)) {
      this.selectedIdx = Math.max(0, this.selectedIdx - 10);
    } else if (matchesKey(data, Key.pageDown)) {
      this.selectedIdx = Math.min(len - 1, this.selectedIdx + 10);
    } else if (matchesKey(data, Key.home)) {
      this.selectedIdx = 0;
    } else if (matchesKey(data, Key.end)) {
      this.selectedIdx = len - 1;
    } else {
      return;
    }
    this.invalidate();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const lines: string[] = [""];
    const boxW = Math.min(width - 2, 76);
    lines.push(topBorder(boxW, th.fg("accent", th.bold(` ${this.title} `)), th));

    if (this.selectedIdx < this.scrollOffset) this.scrollOffset = this.selectedIdx;
    if (this.selectedIdx >= this.scrollOffset + this.maxVisibleRows) {
      this.scrollOffset = this.selectedIdx - this.maxVisibleRows + 1;
    }

    const contentW = boxW - 6;
    const visible = this.items.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleRows);
    for (let i = 0; i < visible.length; i += 1) {
      const item = visible[i]!;
      const idx = this.scrollOffset + i;
      const isSelected = idx === this.selectedIdx;
      const box = `${this.checkedSet.has(item.id) ? "[x]" : "[ ]"} `;
      const prefix = item.disabled ? "   " : box;
      let line: string;
      if (isSelected) {
        line = th.fg("accent", " ▶ ") + truncateToWidth(th.fg("accent", th.bold(prefix + item.label)), contentW);
      } else if (item.disabled) {
        line = "   " + th.fg("dim", truncateToWidth(prefix + item.label, contentW));
      } else {
        line = "   " + truncateToWidth(th.fg("text", prefix + item.label), contentW);
      }
      lines.push(lineInBox(line, boxW, th));
    }
    if (this.items.length > this.maxVisibleRows) {
      const from = this.scrollOffset + 1;
      const to = Math.min(this.scrollOffset + this.maxVisibleRows, this.items.length);
      lines.push(lineInBox(th.fg("dim", `─ ${from}-${to} of ${this.items.length} ─`), boxW, th));
    }
    lines.push(bottomBorder(boxW, th));

    const footer = this.footer ? ` ${this.footer}  ` : " ";
    const hint = th.fg("dim", "space") + th.fg("muted", ":toggle  ") + th.fg("dim", "↑↓") + th.fg("muted", ":navigate  ") + footer + th.fg("dim", "Esc") + th.fg("muted", ":cancel");
    const padWidth = Math.max(0, Math.min(width - 4, Math.max(boxW - 2, visibleWidth(hint))));
    lines.push("  " + sidePad(hint, padWidth));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

/**
 * 盒式多选。headless（无 TUI）模式下不可交互，返回初始勾选集合。
 */
export async function multiSelect(
  ctx: ExtensionCommandContext,
  title: string,
  items: MultiSelectItem[],
  footer = "",
): Promise<MultiSelectResult | undefined> {
  if (!ctx.hasUI) {
    return { checked: items.filter((item) => item.checked && !item.disabled).map((item) => item.id) };
  }
  return ctx.ui.custom<MultiSelectResult | undefined>((tui, theme, _keybindings, done) => {
    const component = new MultiSelectComponent(title, items, footer, tui, theme, done);
    return {
      handleInput: (data: string) => component.handleInput(data),
      render: (w: number) => component.render(w),
      invalidate: () => component.invalidate(),
    };
  });
}
