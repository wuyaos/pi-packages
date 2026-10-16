/**
 * 备份/恢复执行进度面板（pi-sync 专用）。
 *
 * 与 multi-select 同款盒式风格：标题、进度行（已完成 X/Y）、当前类别、
 * 已完成条目行（✅/❌）。纯展示组件，不接收输入、不可取消；
 * 调用方在全部完成后调用 handle.finish() 关闭面板。
 *
 * headless（无 TUI）模式下面板为空操作，update/finish 立即返回。
 *
 * Import: import { … } from "./progress-panel"
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { bottomBorder, lineInBox, topBorder } from "../_shared/box-drawing";

export interface ProgressPanelRow {
  ok: boolean;
  /** 已格式化的条目文案（如归档文件名）。 */
  text: string;
}

export interface ProgressPanelState {
  /** 进度行（已格式化，如「进度：1/3」）。 */
  status: string;
  /** 当前类别行（已格式化；全部完成时为空串）。 */
  current: string;
  rows: ProgressPanelRow[];
}

export class ProgressPanelComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly title: string,
    private readonly state: ProgressPanelState,
    private readonly tui: { requestRender(): void },
    private readonly theme: any,
  ) {}

  /** 状态被外部原地修改后调用：清缓存并请求重绘。 */
  refresh(): void {
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

    lines.push(lineInBox(th.fg("dim", this.state.status), boxW, th));
    if (this.state.current) {
      lines.push(lineInBox(th.fg("text", this.state.current), boxW, th));
    }
    for (const row of this.state.rows) {
      const line = `${row.ok ? "✅" : "❌"} ${row.text}`;
      lines.push(lineInBox(row.ok ? th.fg("text", line) : th.fg("dim", line), boxW, th));
    }
    lines.push(bottomBorder(boxW, th));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

export interface ProgressPanelHandle {
  /** 用最新状态整体替换面板内容。 */
  update(state: ProgressPanelState): void;
  /** 关闭面板并等待 custom 交互结束（真实 TUI 下）。 */
  finish(): Promise<void>;
}

/**
 * 打开进度面板。文案由调用方格式化（本地化），组件只负责渲染。
 */
export function showProgressPanel(ctx: ExtensionCommandContext, title: string): ProgressPanelHandle {
  if (!ctx.hasUI) {
    return { update() {}, finish: async () => {} };
  }
  const state: ProgressPanelState = { status: "", current: "", rows: [] };
  // 优先用 Widget（非阻塞，不抢键盘焦点，对话可继续）；旧宿主回退 custom 面板。
  const widgetApi = ctx.ui as ExtensionCommandContext["ui"] & {
    setWidget?: (key: string, content: unknown, options?: unknown) => void;
  };
  if (typeof widgetApi.setWidget === "function") {
    const key = "pi-sync-progress";
    let component: ProgressPanelComponent | undefined;
    let requestRender: (() => void) | undefined;
    widgetApi.setWidget(key, ((tui: { requestRender(): void }, theme: unknown) => {
      requestRender = () => tui.requestRender();
      component = new ProgressPanelComponent(title, state, { requestRender: () => tui.requestRender() }, theme);
      return component;
    }) as never);
    return {
      update(next) {
        Object.assign(state, next);
        component?.invalidate();
        requestRender?.();
      },
      async finish() {
        try { widgetApi.setWidget!(key, undefined); } catch { /* 宿主可能已销毁 */ }
      },
    };
  }
  let component: ProgressPanelComponent | undefined;
  let tuiRef: { requestRender(): void } | undefined;
  let closeFn: (() => void) | undefined;
  const closed = ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    closeFn = done;
    tuiRef = tui;
    component = new ProgressPanelComponent(title, state, tui, theme);
    return {
      handleInput: () => {},
      render: (w: number) => component!.render(w),
      invalidate: () => component!.invalidate(),
    };
  });
  return {
    update(next) {
      Object.assign(state, next);
      component?.refresh();
    },
    async finish() {
      closeFn?.();
      await closed;
    },
  };
}