/**
 * 恢复列表面板（单选行 + 设备筛选）。
 *
 * 盒式风格；←/→ 循环切换设备筛选（默认「全部设备」），筛选变化时行列表
 * 重建、光标重置。行文案由调用方注入（含语言与本机徽标）。
 *
 * Import: import { … } from "./restore-panel"
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bottomBorder, lineInBox, sidePad, topBorder } from "../_shared/box-drawing";
import { filterRowsByDevice, type RestoreRow } from "./restore-rows";

export interface RestorePanelTexts {
  /** 筛选行模板，含 {value} 占位。 */
  filterLabel: string;
  /** 「全部设备」筛选值文案。 */
  allDevices: string;
}

export interface RestorePanelOptions {
  title: string;
  rows: readonly RestoreRow[];
  texts: RestorePanelTexts;
  /** 本机设备名；行内设备名等于它时由 formatRow 决定是否加徽标。 */
  formatRow: (row: RestoreRow) => string;
}

export class RestorePanelComponent {
  private readonly devices: (string | undefined)[];
  private deviceIdx = 0;
  private selectedIdx = 0;
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly maxVisibleRows = 14;

  constructor(
    private readonly options: RestorePanelOptions,
    private readonly tui: { requestRender(): void },
    private readonly theme: any,
    private readonly done: (row: RestoreRow | undefined) => void,
  ) {
    const seen = new Set<string>();
    this.devices = [undefined];
    for (const row of options.rows) {
      if (!seen.has(row.device)) {
        seen.add(row.device);
        this.devices.push(row.device);
      }
    }
  }

  private visibleRows(): RestoreRow[] {
    return filterRowsByDevice(this.options.rows, this.devices[this.deviceIdx]);
  }

  currentRow(): RestoreRow | undefined {
    return this.visibleRows()[this.selectedIdx];
  }

  currentDevice(): string | undefined {
    return this.devices[this.deviceIdx];
  }

  private moveDevice(delta: number): void {
    this.deviceIdx = (this.deviceIdx + delta + this.devices.length) % this.devices.length;
    this.selectedIdx = 0;
    this.scrollOffset = 0;
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.left)) {
      this.moveDevice(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.moveDevice(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.currentRow());
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(undefined);
      return;
    }
    const rows = this.visibleRows();
    const len = rows.length;
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
    lines.push(topBorder(boxW, th.fg("accent", th.bold(` ${this.options.title} `)), th));

    const deviceLabel = this.currentDevice() ?? this.options.texts.allDevices;
    lines.push(lineInBox(th.fg("dim", this.options.texts.filterLabel.replace("{value}", deviceLabel)), boxW, th));

    const rows = this.visibleRows();
    if (rows.length === 0) {
      lines.push(lineInBox(th.fg("dim", "  (no rows)"), boxW, th));
      lines.push(bottomBorder(boxW, th));
      lines.push("  " + th.fg("dim", "←→") + th.fg("muted", ":device  ") + th.fg("dim", "Esc") + th.fg("muted", ":cancel"));
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }

    if (this.selectedIdx < this.scrollOffset) this.scrollOffset = this.selectedIdx;
    if (this.selectedIdx >= this.scrollOffset + this.maxVisibleRows) {
      this.scrollOffset = this.selectedIdx - this.maxVisibleRows + 1;
    }

    const contentW = boxW - 6;
    const visible = rows.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleRows);
    for (let i = 0; i < visible.length; i += 1) {
      const idx = this.scrollOffset + i;
      const isSelected = idx === this.selectedIdx;
      const text = this.options.formatRow(visible[i]!);
      const line = isSelected
        ? th.fg("accent", " ▶ ") + truncateToWidth(th.fg("accent", th.bold(text)), contentW)
        : "   " + truncateToWidth(th.fg("text", text), contentW);
      lines.push(lineInBox(line, boxW, th));
    }
    if (rows.length > this.maxVisibleRows) {
      const from = this.scrollOffset + 1;
      const to = Math.min(this.scrollOffset + this.maxVisibleRows, rows.length);
      lines.push(lineInBox(th.fg("dim", `─ ${from}-${to} of ${rows.length} ─`), boxW, th));
    }
    lines.push(bottomBorder(boxW, th));

    const hint = th.fg("dim", "←→") + th.fg("muted", ":device  ") + th.fg("dim", "↑↓") + th.fg("muted", ":navigate  ") + th.fg("dim", "↵") + th.fg("muted", ":restore  ") + th.fg("dim", "Esc") + th.fg("muted", ":cancel");
    const padWidth = Math.max(0, Math.min(width - 4, Math.max(boxW - 2, visibleWidth(hint))));
    lines.push("  " + sidePad(hint, padWidth));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

/**
 * 恢复列表面板。headless（无 TUI）模式下取最新一行（时间倒序第一行）。
 */
export async function selectRestoreRow(
  ctx: ExtensionCommandContext,
  options: RestorePanelOptions,
): Promise<RestoreRow | undefined> {
  if (!ctx.hasUI) return options.rows[0];
  return ctx.ui.custom<RestoreRow | undefined>((tui, theme, _keybindings, done) => {
    const component = new RestorePanelComponent(options, tui, theme, done);
    return {
      handleInput: (data: string) => component.handleInput(data),
      render: (w: number) => component.render(w),
      invalidate: () => component.invalidate(),
    };
  });
}
