import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { t, type UiLanguage } from "./i18n.ts";

export interface PanelItem {
  id: string;
  label: string;
  details: string[];
  modelDetails?: string[];
  canTakeoverExisting?: boolean;
  enabled?: boolean;
}

export interface OverviewPanelState {
  search: string;
  selectedId?: string;
  focus: "search" | "list" | "details" | "actions";
  actionIndex: number;
  detailScroll: number;
}

export interface MenuPanelState {
  selectedId?: string;
  focus: "list" | "details" | "actions";
  actionIndex: number;
  detailScroll: number;
}

export type ProviderPanelResult =
  | { action: "enter"; providerId: string }
  | { action: "toggle" | "delete"; providerId: string }
  | { action: "add" | "language" | "close" };

export type ConnectionPanelResult =
  | { action: "field"; fieldId: string }
  | { action: "models" | "takeover" | "testModels" | "preview" | "back" };

export type PreviewPanelResult = { action: "save" | "back" | "discard" };

export interface FooterAction {
  id: string;
  label: string;
  key: string;
  enabled?: boolean;
}

export const MODEL_CONFIG_OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: { anchor: "center", width: "96%", maxHeight: "90%", margin: 1 },
} as const;

function terminalRows(tui: TUI): number {
  return Number.isFinite(tui.terminal?.rows) && tui.terminal.rows > 0 ? tui.terminal.rows : 24;
}

export function overlayViewportRows(tui: TUI): number {
  return Math.max(4, Math.floor(terminalRows(tui) * 0.9));
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(1, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function renderPanelBox(lines: string[], width: number, title: string, theme: Theme): string[] {
  const inner = Math.max(1, width - 2);
  const titleText = truncateToWidth(` ${title} `, inner, "…");
  const titleWidth = visibleWidth(titleText);
  const left = Math.max(0, Math.floor((inner - titleWidth) / 2));
  const right = Math.max(0, inner - titleWidth - left);
  const border = (value: string) => theme.fg("border", value);
  return [
    `${border(`╭${"─".repeat(left)}`)}${theme.fg("accent", theme.bold(titleText))}${border(`${"─".repeat(right)}╮`)}`,
    ...lines.map((line) => `${border("│")}${pad(line, inner)}${border("│")}`),
    border(`╰${"─".repeat(inner)}╯`),
  ];
}

function joinColumns(left: string[], right: string[], leftWidth: number, rightWidth: number, gap = 2): string[] {
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => `${pad(left[index] ?? "", leftWidth)}${" ".repeat(gap)}${pad(right[index] ?? "", rightWidth)}`);
}

function wrapped(theme: Theme, lines: string[], width: number): string[] {
  return lines.flatMap((line) => wrapTextWithAnsi(theme.fg("muted", line), Math.max(1, width)));
}

function viewportStart(index: number, count: number, visible: number): number {
  return Math.max(0, Math.min(index - Math.floor(visible / 2), Math.max(0, count - visible)));
}

export function renderActionFooter(actions: FooterAction[], selectedIndex: number, focused: boolean, width: number, theme: Theme): string[] {
  const rows: string[] = [];
  let current = "";
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index]!;
    const selected = focused && index === selectedIndex;
    const marker = selected ? "→ " : "  ";
    const raw = `${marker}${action.label}`;
    const styled = theme.fg(action.enabled === false ? "dim" : selected ? "accent" : "muted", selected ? theme.bold(raw) : raw);
    if (current && visibleWidth(current) + 2 + visibleWidth(styled) > width) {
      rows.push(truncateToWidth(current, width, ""));
      current = styled;
    } else current = current ? `${current}  ${styled}` : styled;
  }
  if (current || rows.length === 0) rows.push(truncateToWidth(current, width, ""));
  return rows;
}

function moveFocus<T extends string>(current: T, order: readonly T[], reverse: boolean): T {
  const index = Math.max(0, order.indexOf(current));
  return order[(index + (reverse ? -1 : 1) + order.length) % order.length]!;
}

class OverviewPanel implements Component, Focusable {
  private readonly search: Input;
  private filtered: PanelItem[] = [];
  private selectedIndex = 0;
  private detailMaxScroll = 0;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly language: UiLanguage,
    private readonly items: PanelItem[],
    private readonly state: OverviewPanelState,
    private readonly done: (result: ProviderPanelResult) => void,
  ) {
    this.search = new Input({ prompt: t(language, "panelSearchProviderPrompt"), placeholder: t(language, "panelSearchProviderPlaceholder") });
    this.search.setValue(state.search);
    this.search.onSubmit = () => this.enterCurrent();
    this.applyFilter();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.updateInputFocus(); }

  private actions(): FooterAction[] {
    return [
      { id: "enter", label: t(this.language, "overviewEnter"), key: "enter", enabled: !!this.current() },
      { id: "search", label: t(this.language, "overviewSearch"), key: "/" },
      { id: "toggle", label: t(this.language, this.current()?.enabled === false ? "overviewEnable" : "overviewDisable"), key: Key.ctrl("x"), enabled: !!this.current() },
      { id: "delete", label: t(this.language, "overviewDelete"), key: Key.ctrl("delete"), enabled: !!this.current() },
      { id: "add", label: t(this.language, "overviewAdd"), key: Key.ctrl("n") },
      { id: "close", label: t(this.language, "overviewClose"), key: Key.escape },
      { id: "language", label: t(this.language, "overviewLanguage"), key: Key.f2 },
    ];
  }

  private current(): PanelItem | undefined { return this.filtered[this.selectedIndex]; }
  private updateInputFocus(): void { this.search.focused = this._focused && this.state.focus === "search"; }
  private request(): void { this.updateInputFocus(); this.tui.requestRender(); }
  private syncCurrent(): void { this.state.selectedId = this.current()?.id; }

  private applyFilter(): void {
    const query = this.search.getValue().trim().toLowerCase();
    this.state.search = this.search.getValue();
    this.filtered = query ? this.items.filter((item) => `${item.id} ${item.label}`.toLowerCase().includes(query)) : [...this.items];
    const remembered = this.state.selectedId ? this.filtered.findIndex((item) => item.id === this.state.selectedId) : -1;
    this.selectedIndex = remembered >= 0 ? remembered : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.syncCurrent();
  }

  private enterCurrent(): void {
    const current = this.current();
    if (current) this.done({ action: "enter", providerId: current.id });
  }

  private activate(action: FooterAction | undefined): void {
    if (!action || action.enabled === false) return;
    if (action.id === "enter") this.enterCurrent();
    else if (action.id === "toggle" || action.id === "delete") { const current = this.current(); if (current) this.done({ action: action.id, providerId: current.id }); }
    else if (action.id === "search") { this.state.focus = "search"; this.request(); }
    else this.done({ action: action.id as "add" | "close" | "language" });
  }

  handleInput(data: string): void {
    if (data === "/") { this.state.focus = "search"; this.request(); return; }
    if (matchesKey(data, Key.f2)) { this.done({ action: "language" }); return; }
    if (matchesKey(data, Key.ctrl("n"))) { this.done({ action: "add" }); return; }
    if (matchesKey(data, Key.ctrl("x"))) { const current = this.current(); if (current) this.done({ action: "toggle", providerId: current.id }); return; }
    if (matchesKey(data, Key.ctrl("delete"))) { const current = this.current(); if (current) this.done({ action: "delete", providerId: current.id }); return; }
    if (matchesKey(data, Key.escape)) { this.done({ action: "close" }); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
      this.state.focus = moveFocus(this.state.focus, ["search", "list", "details", "actions"] as const, matchesKey(data, "shift+tab"));
      this.request();
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (this.state.focus === "actions") { const actions = this.actions(); this.state.actionIndex = (this.state.actionIndex - 1 + actions.length) % actions.length; this.request(); return; }
      if (this.state.focus === "details") this.state.focus = "list";
      this.request();
      return;
    }
    if (matchesKey(data, Key.right)) {
      if (this.state.focus === "actions") { const actions = this.actions(); this.state.actionIndex = (this.state.actionIndex + 1) % actions.length; this.request(); return; }
      if (this.state.focus === "search" || this.state.focus === "list") this.state.focus = "details";
      else if (this.state.focus === "details") this.state.focus = "actions";
      this.request();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      if (this.state.focus === "actions") { this.request(); return; } else if ((this.state.focus === "search" || this.state.focus === "list" || this.state.focus === "details") && this.filtered.length) {
        this.selectedIndex = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + delta));
        this.state.detailScroll = 0;
        this.syncCurrent();
      }
      this.request();
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.state.detailScroll = Math.min(this.detailMaxScroll, Math.max(0, this.state.detailScroll + (matchesKey(data, Key.pageUp) ? -5 : 5)));
      this.request();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.state.focus === "actions") this.activate(this.actions()[this.state.actionIndex]);
      else this.enterCurrent();
      return;
    }
    if (matchesKey(data, Key.space) && this.state.focus === "actions") {
      this.activate(this.actions()[this.state.actionIndex]);
      return;
    }
    if (this.state.focus === "search") {
      this.search.handleInput(data);
      this.applyFilter();
      this.request();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const innerWidth = Math.max(1, safeWidth - 2);
    const wide = innerWidth >= 68;
    const contentBudget = Math.max(2, overlayViewportRows(this.tui) - 2);
    const footer = renderActionFooter(this.actions(), this.state.actionIndex, this.state.focus === "actions", innerWidth, this.theme);
    const top = this.search.render(innerWidth);
    const bodyBudget = Math.max(0, contentBudget - top.length - footer.length - 1);
    const leftWidth = wide ? Math.max(24, Math.floor((innerWidth - 2) * 0.4)) : innerWidth;
    const rightWidth = wide ? innerWidth - leftWidth - 2 : innerWidth;
    const visible = Math.max(0, bodyBudget);
    const start = viewportStart(this.selectedIndex, this.filtered.length, visible);
    const left: string[] = [];
    for (let index = start; index < Math.min(start + visible, this.filtered.length); index++) {
      const selected = index === this.selectedIndex;
      const indicator = selected ? "→ " : "  ";
      const item = this.filtered[index]!;
      const label = truncateToWidth(item.label, Math.max(1, leftWidth - 2), "…");
      const styled = item.enabled === false
        ? this.theme.fg("dim", selected ? this.theme.bold(label) : label)
        : selected ? this.theme.fg("accent", this.theme.bold(label)) : label;
      left.push(truncateToWidth(`${indicator}${styled}`, leftWidth, ""));
    }
    if (!this.filtered.length && visible > 0) left.push(this.theme.fg("muted", t(this.language, "panelNoConfiguredProviders")));
    const current = this.current();
    const detailAll = current ? [this.theme.fg("accent", this.theme.bold(current.label)), ...wrapped(this.theme, current.details, rightWidth)] : [t(this.language, "panelNoProviderSelected")];
    this.detailMaxScroll = Math.max(0, detailAll.length - bodyBudget);
    this.state.detailScroll = Math.min(this.state.detailScroll, this.detailMaxScroll);
    const right = detailAll.slice(this.state.detailScroll, this.state.detailScroll + bodyBudget);
    const body = wide ? joinColumns(left, right, leftWidth, rightWidth) : this.state.focus === "details" ? right : left;
    const content = [...top, ...body.slice(0, bodyBudget), ...footer].slice(0, contentBudget);
    return renderPanelBox(content, safeWidth, t(this.language, "mainTitle"), this.theme);
  }

  invalidate(): void { this.search.invalidate(); }
}

class MenuDetailPanel implements Component, Focusable {
  private selectedIndex = 0;
  private detailMaxScroll = 0;
  private _focused = false;
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly language: UiLanguage,
    private readonly title: string,
    private readonly items: PanelItem[],
    private readonly actions: FooterAction[],
    private readonly state: MenuPanelState,
    private readonly itemActivates: boolean,
    private readonly done: (result: { kind: "item" | "action" | "language" | "back"; id?: string }) => void,
  ) {
    const remembered = state.selectedId ? items.findIndex((item) => item.id === state.selectedId) : -1;
    this.selectedIndex = remembered >= 0 ? remembered : 0;
    this.syncCurrent();
  }
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }
  private current(): PanelItem | undefined { return this.items[this.selectedIndex]; }
  private syncCurrent(): void { this.state.selectedId = this.current()?.id; }
  private request(): void { this.tui.requestRender(); }
  private activate(action: FooterAction | undefined): void { if (action) this.done({ kind: "action", id: action.id }); }

  handleInput(data: string): void {
    const shortcut = this.actions.find((action) => matchesKey(data, action.key as any));
    if (shortcut && !(matchesKey(data, Key.enter) && this.state.focus === "actions")) { this.activate(shortcut); return; }
    if (matchesKey(data, Key.escape)) { this.done({ kind: "back" }); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
      this.state.focus = moveFocus(this.state.focus, ["list", "details", "actions"] as const, matchesKey(data, "shift+tab"));
      this.request();
      return;
    }
    if (matchesKey(data, Key.left)) { if (this.state.focus === "actions") this.state.actionIndex = (this.state.actionIndex - 1 + this.actions.length) % this.actions.length; else this.state.focus = "list"; this.request(); return; }
    if (matchesKey(data, Key.right) && this.state.focus === "actions") { this.state.actionIndex = (this.state.actionIndex + 1) % this.actions.length; this.request(); return; }
    if (matchesKey(data, Key.right) && this.state.focus === "list") { this.state.focus = "details"; this.request(); return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      if (this.state.focus === "actions") { this.request(); return; }
      else if ((this.state.focus === "list" || this.state.focus === "details") && this.items.length) {
        this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
        this.state.detailScroll = 0;
        this.syncCurrent();
      }
      this.request();
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.state.detailScroll = Math.min(this.detailMaxScroll, Math.max(0, this.state.detailScroll + (matchesKey(data, Key.pageUp) ? -5 : 5)));
      this.request();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      if (this.state.focus === "actions") this.activate(this.actions[this.state.actionIndex]);
      else if (this.itemActivates && (this.state.focus === "list" || this.state.focus === "details")) this.done({ kind: "item", id: this.current()?.id });
      else if (this.state.focus === "list") { this.state.focus = "details"; this.request(); }
      else if (this.state.focus === "details") { this.state.focus = "actions"; this.request(); }
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const innerWidth = Math.max(1, safeWidth - 2);
    const wide = innerWidth >= 68;
    const contentBudget = Math.max(2, overlayViewportRows(this.tui) - 2);
    this.state.actionIndex = Math.min(this.state.actionIndex, Math.max(0, this.actions.length - 1));
    const footer = renderActionFooter(this.actions, this.state.actionIndex, this.state.focus === "actions", innerWidth, this.theme);
    const bodyBudget = Math.max(0, contentBudget - footer.length);
    const leftWidth = wide ? Math.max(24, Math.floor((innerWidth - 2) * 0.4)) : innerWidth;
    const rightWidth = wide ? innerWidth - leftWidth - 2 : innerWidth;
    const visible = Math.max(0, bodyBudget);
    const start = viewportStart(this.selectedIndex, this.items.length, visible);
    const left: string[] = [];
    for (let index = start; index < Math.min(start + visible, this.items.length); index++) {
      const selected = index === this.selectedIndex;
      const indicator = selected ? "→ " : "  ";
      const label = truncateToWidth(this.items[index]!.label, Math.max(1, leftWidth - 2), "…");
      left.push(truncateToWidth(`${indicator}${selected ? this.theme.fg("accent", this.theme.bold(label)) : label}`, leftWidth, ""));
    }
    const rightAll = this.current() ? wrapped(this.theme, this.current()!.details, rightWidth) : [];
    this.detailMaxScroll = Math.max(0, rightAll.length - bodyBudget);
    this.state.detailScroll = Math.min(this.state.detailScroll, this.detailMaxScroll);
    const right = rightAll.slice(this.state.detailScroll, this.state.detailScroll + bodyBudget);
    const body = wide ? joinColumns(left, right, leftWidth, rightWidth) : this.state.focus === "details" ? right : left;
    return renderPanelBox([...body.slice(0, bodyBudget), ...footer].slice(0, contentBudget), safeWidth, this.title, this.theme);
  }
  invalidate(): void {}
}

export interface ConfirmationAction {
  id: string;
  label: string;
  shortcut?: string;
  severity?: "normal" | "warning" | "error";
}

export interface ConfirmationPanelOptions {
  title: string;
  summary: string[];
  details?: string[];
  actions: ConfirmationAction[];
  defaultActionIndex: number;
  cancelActionId: string;
  severity?: "warning" | "error";
}

class ConfirmationPanel implements Component {
  private actionIndex: number;
  constructor(private tui: TUI, private theme: Theme, private options: ConfirmationPanelOptions, private done: (id: string) => void) {
    this.actionIndex = Math.max(0, Math.min(options.defaultActionIndex, options.actions.length - 1));
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.done(this.options.cancelActionId); return; }
    const shortcut = this.options.actions.find((action) => action.shortcut && matchesKey(data, action.shortcut as any));
    if (shortcut) { this.done(shortcut.id); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab") || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const reverse = matchesKey(data, "shift+tab") || matchesKey(data, Key.left);
      this.actionIndex = (this.actionIndex + (reverse ? -1 : 1) + this.options.actions.length) % this.options.actions.length;
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) return;
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) this.done(this.options.actions[this.actionIndex]!.id);
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const wide = inner >= 68;
    const leftWidth = wide ? Math.max(24, Math.floor((inner - 2) * 0.45)) : inner;
    const rightWidth = wide ? inner - leftWidth - 2 : inner;
    const color = this.options.severity === "error" ? "error" : "warning";
    const summary = this.options.summary.flatMap((line) => wrapTextWithAnsi(this.theme.fg(color, line), leftWidth));
    const details = (this.options.details ?? []).flatMap((line) => wrapTextWithAnsi(this.theme.fg("muted", line), rightWidth));
    const body = wide ? joinColumns(summary, details, leftWidth, rightWidth) : [...summary, ...(details.length ? ["", ...details] : [])];
    const actionRows = renderActionFooter(this.options.actions.map((action) => ({ id: action.id, label: action.label, key: action.shortcut ?? "" })), this.actionIndex, true, inner, this.theme);
    const budget = Math.max(2, overlayViewportRows(this.tui) - 2);
    return renderPanelBox([...body.slice(0, Math.max(0, budget - actionRows.length)), ...actionRows], width, this.options.title, this.theme);
  }
  invalidate() {}
}

export async function showConfirmationPanel(ctx: ExtensionCommandContext, options: ConfirmationPanelOptions): Promise<string> {
  return ctx.ui.custom((tui, theme, _keys, done) => new ConfirmationPanel(tui, theme, options, done), MODEL_CONFIG_OVERLAY_OPTIONS);
}

export async function showProviderPanel(ctx: ExtensionCommandContext, language: UiLanguage, items: PanelItem[], state: OverviewPanelState = { search: "", focus: "list", actionIndex: 0, detailScroll: 0 }): Promise<ProviderPanelResult> {
  return ctx.ui.custom((tui, theme, _keys, done) => new OverviewPanel(tui, theme, language, items, state, done), MODEL_CONFIG_OVERLAY_OPTIONS);
}

export async function showConnectionPanel(
  ctx: ExtensionCommandContext,
  language: UiLanguage,
  providerId: string,
  fields: PanelItem[],
  state: MenuPanelState = { focus: "list", actionIndex: 0, detailScroll: 0 },
  canTakeover = false,
): Promise<ConnectionPanelResult> {
  const actions: FooterAction[] = [
    { id: "edit", label: t(language, "connectionModify"), key: Key.enter },
    { id: "models", label: t(language, "detailConfigureModels"), key: Key.ctrl("m") },
    ...(canTakeover ? [{ id: "takeover", label: t(language, "detailTakeover"), key: Key.ctrl("t") }] : []),
    { id: "testModels", label: t(language, "detailTestModels"), key: Key.ctrl("p") },
    { id: "preview", label: t(language, "connectionPreview"), key: Key.ctrl("s") },
    { id: "back", label: t(language, "connectionBack"), key: Key.escape },
  ];
  const result = await ctx.ui.custom<{ kind: "item" | "action" | "language" | "back"; id?: string }>((tui, theme, _keys, done) =>
    new MenuDetailPanel(tui, theme, language, t(language, "providerTitle", { id: providerId }), fields, actions, state, true, done), MODEL_CONFIG_OVERLAY_OPTIONS);
  if (result.kind === "back" || result.id === "back") return { action: "back" };
  if (result.kind === "item" && result.id) return { action: "field", fieldId: result.id };
  if (result.id === "edit" && state.selectedId) return { action: "field", fieldId: state.selectedId };
  if (result.id === "models" || result.id === "takeover" || result.id === "testModels" || result.id === "preview") return { action: result.id };
  return { action: "back" };
}

export async function showPreviewPanel(
  ctx: ExtensionCommandContext,
  language: UiLanguage,
  providerId: string,
  providerDetails: string[],
  modelDetails: string[],
  state: MenuPanelState = { selectedId: "provider", focus: "list", actionIndex: 0, detailScroll: 0 },
): Promise<PreviewPanelResult> {
  const items: PanelItem[] = [
    { id: "provider", label: t(language, "previewProviderSettings", { provider: providerId }), details: providerDetails },
    { id: "models", label: t(language, "previewModelConfig", { provider: providerId }), details: modelDetails },
  ];
  const actions: FooterAction[] = [
    { id: "save", label: t(language, "previewConfirmSave"), key: Key.ctrl("s") },
    { id: "back", label: t(language, "previewBackEdit"), key: Key.escape },
    { id: "discard", label: t(language, "previewDiscard"), key: Key.ctrl("d") },
  ];
  const result = await ctx.ui.custom<{ kind: "item" | "action" | "language" | "back"; id?: string }>((tui, theme, _keys, done) =>
    new MenuDetailPanel(tui, theme, language, t(language, "previewTitle"), items, actions, state, false, done), MODEL_CONFIG_OVERLAY_OPTIONS);
  if (result.kind === "back" || result.id === "back") return { action: "back" };
  if (result.id === "save" || result.id === "discard") return { action: result.id };
  return showPreviewPanel(ctx, language, providerId, providerDetails, modelDetails, state);
}
