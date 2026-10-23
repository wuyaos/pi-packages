import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { SelectList } from "@earendil-works/pi-tui";
import { overlayViewportRows } from "./panel.ts";

/**
 * Scrolling, searchable replacement for ctx.ui.select.
 *
 * Pi's built-in ExtensionSelectorComponent renders every option without a
 * window, so lists taller than the terminal become unscrollable (selection
 * moves but the list cannot). This component wraps pi-tui's SelectList, which
 * implements proper viewport scrolling, plus a type-to-filter input, inside
 * ctx.ui.custom.
 */
export async function selectScrolling(
  ctx: ExtensionCommandContext,
  title: string,
  options: string[],
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    return new ScrollingSelect(tui, theme, title, options, done);
  });
}

class ScrollingSelect implements Component, Focusable {
  private search: Input;
  private list!: SelectList;
  private maxVisible: number;
  private selectTheme: {
    selectedPrefix: (text: string) => string;
    selectedText: (text: string) => string;
    description: (text: string) => string;
    scrollInfo: (text: string) => string;
    noMatch: (text: string) => string;
  };
  private filtered: Array<{ value: string; label: string }> = [];
  private all: Array<{ value: string; label: string }>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly title: string,
    options: string[],
    private readonly done: (value: string | undefined) => void,
  ) {
    this.search = new Input({ prompt: "search:", placeholder: "type to filter" });
    this.search.focused = true;
    this.search.onSubmit = () => this.confirm();
    this.all = options.map((value) => ({ value, label: value }));
    const selectTheme = {
      selectedPrefix: (text: string) => this.theme.fg("accent", text),
      selectedText: (text: string) => this.theme.fg("accent", text),
      description: (text: string) => this.theme.fg("muted", text),
      scrollInfo: (text: string) => this.theme.fg("muted", text),
      noMatch: (text: string) => this.theme.fg("muted", text),
    };
    // Cap at ~55% of the overlay viewport so title, search and hints still fit.
    this.maxVisible = Math.max(5, Math.min(options.length, Math.floor(overlayViewportRows(tui) * 0.55)));
    this.selectTheme = selectTheme;
    this.applyFilter();
  }

  private _focused = false;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }

  private request(): void { this.tui.requestRender(); }

  private applyFilter(): void {
    const query = this.search.getValue().trim().toLowerCase();
    this.filtered = query
      ? this.all.filter((item) => item.value.toLowerCase().includes(query))
      : this.all;
    this.list = new SelectList(this.filtered, this.maxVisible, this.selectTheme);
  }

  private confirm(): void {
    const item = this.list.getSelectedItem();
    this.done(item ? item.value : undefined);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.done(undefined); return; }
    if (matchesKey(data, Key.enter)) { this.confirm(); return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.list.handleInput(data);
      this.request();
      return;
    }
    this.search.handleInput(data);
    this.applyFilter();
    this.request();
  }

  render(width: number): string[] {
    const title = this.theme.fg("accent", this.theme.bold(this.title));
    const count = this.theme.fg("muted", `${this.filtered.length}/${this.all.length}`);
    return [
      title,
      ...this.search.render(width),
      count,
      ...this.list.render(width),
      this.theme.fg("muted", "↑↓ navigate · enter select · esc cancel"),
    ];
  }

  invalidate(): void { this.search.invalidate(); }
}
