import type { AnyModel } from "@earendil-works/pi-ai";
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
import { COMPAT_CONTEXT_WINDOW, COMPAT_MAX_TOKENS } from "./discovery.ts";
import { MODEL_CONFIG_OVERLAY_OPTIONS, overlayViewportRows, renderActionFooter, renderPanelBox, type FooterAction } from "./panel.ts";
import type { CandidateModel, ManagedModel, ManagedModelType, ModelMetadataEntry, ProviderDraft, SelectionResult, ThinkingLevelMap, ThinkingMetadataSource } from "./types.ts";
import { hiddenRemoteKey, identityOf } from "./types.ts";
import { protocolThinkingMap } from "./thinking-defaults.ts";
import { describeThinking } from "./model-editor.ts";

function modelTypeLabel(language: UiLanguage, type: ManagedModelType): string {
  return type === "classifier" ? t(language, "selectorTypeClassifier")
    : type === "image" ? t(language, "selectorTypeImage")
      : t(language, "selectorTypeChat");
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(1, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function joinColumns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => `${pad(left[index] ?? "", leftWidth)}  ${pad(right[index] ?? "", rightWidth)}`);
}

function cloneManaged(model: ManagedModel): ManagedModel {
  return structuredClone(model);
}

function stripCandidate(model: CandidateModel): ManagedModel {
  const { source: _source, mutableType: _mutable, readOnly: _readOnly, readOnlyReason: _reason, contextSource: _contextSource, maxTokensSource: _maxTokensSource, thinkingSource: _thinkingSource, ...managed } = model;
  return managed as ManagedModel;
}

export function candidateFromInstalled(model: AnyModel): CandidateModel {
  const common = {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    input: [...model.input],
    cost: { ...model.cost },
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    source: "installed" as const,
    mutableType: false,
    contextSource: model.type === "image" ? undefined : "catalog" as const,
    maxTokensSource: model.type === "chat" ? "catalog" as const : undefined,
    readOnly: true,
    readOnlyReason: "runtime-catalog" as const,
  };
  if (model.type === "classifier") return { ...common, type: "classifier", contextWindow: model.contextWindow };
  if (model.type === "image") return { ...common, type: "image", output: [...model.output] };
  return {
    ...common,
    type: "chat",
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap }, thinkingSource: "catalog" as const } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export function candidateFromManaged(model: ManagedModel, metadata?: ModelMetadataEntry): CandidateModel {
  return { ...cloneManaged(model), source: "managed", mutableType: false, contextSource: metadata?.contextSource ?? (model.type === "image" ? undefined : "existing"), maxTokensSource: metadata?.maxTokensSource ?? (model.type === "chat" ? "existing" : undefined), thinkingSource: metadata?.thinkingSource ?? (model.type === "chat" && model.thinkingLevelMap ? "existing" : undefined) } as CandidateModel;
}

/** A models.json row belongs to this provider configuration and is immediately editable.
 * It becomes managed on the next save; only runtime catalog rows remain read-only. */
export function candidateFromExternal(model: ManagedModel, metadata?: ModelMetadataEntry): CandidateModel {
  return { ...cloneManaged(model), source: "external", mutableType: false, contextSource: metadata?.contextSource ?? (model.type === "image" ? undefined : "existing"), maxTokensSource: metadata?.maxTokensSource ?? (model.type === "chat" ? "existing" : undefined), thinkingSource: metadata?.thinkingSource ?? (model.type === "chat" && model.thinkingLevelMap ? "existing" : undefined) } as CandidateModel;
}

export function mergeCandidates(provider: string, installed: CandidateModel[], managed: CandidateModel[], remote: CandidateModel[]): CandidateModel[] {
  const rows = new Map<string, CandidateModel>();
  for (const model of managed) rows.set(identityOf(model, provider), model);
  for (const model of installed) {
    const key = identityOf(model, provider);
    if (!rows.has(key)) rows.set(key, model);
  }
  for (const model of remote) {
    const key = identityOf(model, provider);
    // Discovery may fill only a subset of metadata. Existing installed/managed/external
    // entries remain authoritative unless a future explicit field editor changes them.
    if (!rows.has(key)) rows.set(key, model);
  }
  return [...rows.values()].sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export interface ModelPanelState {
  search: string;
  selectedId?: string;
  focus: "search" | "list" | "details" | "actions";
  actionIndex: number;
  detailScroll: number;
}

interface CycleMetadata {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  thinkingSource?: ThinkingMetadataSource;
}

class ModelSelector implements Component, Focusable {
  private search: Input;
  private cycleMetadata = new WeakMap<object, CycleMetadata>();
  private selected = new Set<string>();
  private filtered: CandidateModel[] = [];
  private index = 0;
  private status = "";
  private detailMaxScroll = 0;
  private _focused = false;
  private finished = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly language: UiLanguage,
    private readonly provider: string,
    private readonly draft: ProviderDraft,
    private readonly rows: CandidateModel[],
    private readonly initialSelected: ManagedModel[] | undefined,
    private readonly state: ModelPanelState,
    private readonly done: (result: SelectionResult) => void,
    private readonly initialMetadata: ModelMetadataEntry[] | undefined,
  ) {
    this.search = new Input({ prompt: t(language, "selectorSearchPrompt"), placeholder: t(language, "selectorSearchPlaceholder") });
    this.search.setValue(state.search);
    if (initialSelected) {
      const selectedModels = new Map(initialSelected.map((model) => [identityOf(model, provider), model]));
      const selectedMetadata = new Map((initialMetadata ?? []).map((entry) => [identityOf(entry, provider), entry]));
      for (const row of rows) {
        const key = identityOf(row, provider);
        const selected = selectedModels.get(key);
        const metadata = selectedMetadata.get(key);
        if (selected && !row.readOnly) Object.assign(row, cloneManaged(selected));
        if (metadata && !row.readOnly) Object.assign(row, {
          contextSource: metadata.contextSource,
          maxTokensSource: metadata.maxTokensSource,
          thinkingSource: metadata.thinkingSource,
        });
      }
    }
    for (const row of rows) {
      this.cycleMetadata.set(row, {
        ...(row.type !== "image" ? { contextWindow: row.contextWindow } : {}),
        ...(row.type === "chat" ? { maxTokens: row.maxTokens, reasoning: row.reasoning, thinkingLevelMap: row.thinkingLevelMap ? { ...row.thinkingLevelMap } : undefined, thinkingSource: row.thinkingSource } : {}),
      });
      if (row.source === "managed" || row.source === "external") this.selected.add(identityOf(row, provider));
    }
    if (initialSelected) {
      for (const row of rows) if (!row.readOnly) this.selected.delete(identityOf(row, provider));
      for (const model of initialSelected) this.selected.add(identityOf(model, provider));
    }
    this.search.onSubmit = () => this.toggleCurrent();
    this.refresh();
    const remembered = state.selectedId ? this.filtered.findIndex((row) => row.id === state.selectedId) : -1;
    if (remembered >= 0) this.index = remembered;
    this.syncCurrent();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && this.state.focus === "search";
  }

  private request(): void {
    this.search.focused = this._focused && this.state.focus === "search";
    this.tui.requestRender();
  }

  private current(): CandidateModel | undefined { return this.filtered[this.index]; }
  private syncCurrent(): void { this.state.selectedId = this.current()?.id; }

  private selectedRows(): CandidateModel[] { return this.rows.filter((row) => !row.readOnly && this.selected.has(this.key(row))); }
  private selectedModels(): ManagedModel[] { return this.selectedRows().map(stripCandidate); }
  private selectedMetadata(): ModelMetadataEntry[] { return this.selectedRows().map((row) => ({ type: row.type, id: row.id, contextSource: row.contextSource, maxTokensSource: row.maxTokensSource, thinkingSource: row.type === "chat" ? row.thinkingSource : undefined })); }

  private refresh(): void {
    const query = this.search.getValue().trim().toLowerCase();
    this.state.search = this.search.getValue();
    this.filtered = query
      ? this.rows.filter((row) => `${row.id} ${row.name}`.toLowerCase().includes(query))
      : [...this.rows];
    this.index = Math.min(this.index, Math.max(0, this.filtered.length - 1));
    this.syncCurrent();
    this.invalidate();
    this.request();
  }

  private key(model: CandidateModel): string { return identityOf(model, this.provider); }

  private toggleCurrent(): void {
    const row = this.filtered[this.index];
    if (!row) return;
    if (row.readOnly) {
      this.status = t(this.language, row.readOnlyReason === "runtime-catalog" ? "selectorReadonlyRuntime" : "selectorReadonlyStatus");
      this.tui.requestRender();
      return;
    }
    this.status = "";
    const key = this.key(row);
    if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key);
    this.tui.requestRender();
  }

  private hideCurrentRemote(): void {
    const row = this.current();
    if (!row || row.source !== "remote") return;
    const hidden = new Set(this.draft.hiddenRemoteIds ?? []);
    hidden.add(hiddenRemoteKey(row));
    this.draft.hiddenRemoteIds = [...hidden].sort((a, b) => a.localeCompare(b));
    this.selected.delete(this.key(row));
    const index = this.rows.indexOf(row);
    if (index >= 0) this.rows.splice(index, 1);
    this.status = t(this.language, "selectorRemoteHidden", { id: row.id });
    this.refresh();
  }

  private cycleType(): void {
    const row = this.filtered[this.index];
    if (!row?.mutableType) return;
    const types: ManagedModelType[] = ["chat", "classifier", "image"];
    const nextType = types[(types.indexOf(row.type) + 1) % types.length]!;
    const oldKey = this.key(row);
    const metadata = this.cycleMetadata.get(row) ?? {};
    const nextKey = identityOf({ id: row.id, type: nextType }, this.provider);
    if (this.rows.some((candidate) => candidate !== row && this.key(candidate) === nextKey)) {
      this.status = t(this.language, "selectorTypeConflict", { type: modelTypeLabel(this.language, nextType), identity: `${modelTypeLabel(this.language, nextType)}/${row.id}` });
      this.tui.requestRender();
      return;
    }
    this.status = "";
    const wasSelected = this.selected.delete(oldKey);
    const common = {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      input: row.input,
      cost: row.cost,
      source: row.source,
      mutableType: true,
    };
    let next: CandidateModel;
    if (nextType === "classifier") {
      next = { ...common, type: nextType, api: this.draft.classifierApi, contextWindow: metadata.contextWindow ?? COMPAT_CONTEXT_WINDOW };
    } else if (nextType === "image") {
      next = { ...common, type: nextType, api: this.draft.imageApi, output: ["image"] };
    } else {
      const protocolMap = metadata.thinkingLevelMap ? undefined : protocolThinkingMap(this.draft.chatApi);
      next = {
        ...common,
        type: nextType,
        api: this.draft.chatApi,
        reasoning: metadata.reasoning ?? true,
        ...(metadata.thinkingLevelMap ? { thinkingLevelMap: { ...metadata.thinkingLevelMap }, thinkingSource: metadata.thinkingSource }
          : protocolMap ? { thinkingLevelMap: protocolMap, thinkingSource: "protocol" as const } : {}),
        contextWindow: metadata.contextWindow ?? COMPAT_CONTEXT_WINDOW,
        maxTokens: metadata.maxTokens ?? COMPAT_MAX_TOKENS,
      };
    }
    this.cycleMetadata.set(next, metadata);
    const rowIndex = this.rows.indexOf(row);
    if (rowIndex >= 0) this.rows[rowIndex] = next;
    if (wasSelected) this.selected.add(this.key(next));
    this.refresh();
  }

  private actions(): FooterAction[] {
    return [
      { id: "search", label: t(this.language, "modelSearch"), key: "/" },
      { id: "selectFiltered", label: t(this.language, "modelSelectFiltered"), key: Key.ctrl("a") },
      { id: "deselectFiltered", label: t(this.language, "modelDeselectFiltered"), key: Key.ctrl("d") },
      { id: "cycleType", label: t(this.language, "modelCycleType"), key: Key.ctrl("t") },
      { id: "edit", label: t(this.language, "modelEditParameters"), key: Key.ctrl("e") },
      { id: "probe", label: t(this.language, "modelProbeContext"), key: Key.ctrl("k") },
      { id: "probeThinking", label: t(this.language, "modelProbeThinking"), key: Key.ctrl("l") },
      { id: "fetch", label: t(this.language, "modelFetch"), key: Key.ctrl("r") },
      { id: "hideRemote", label: t(this.language, "modelHideRemote"), key: Key.ctrl("delete"), enabled: this.current()?.source === "remote" },
      { id: "preview", label: t(this.language, "modelPreview"), key: Key.ctrl("s") },
      { id: "back", label: t(this.language, "modelBack"), key: Key.escape },
    ];
  }

  private finish(action: SelectionResult["action"]): void {
    if (this.finished) return;
    this.finished = true;
    const current = this.current();
    this.done({
      action,
      cancelled: action === "back",
      selected: this.selectedModels(),
      metadata: this.selectedMetadata(),
      ...(current ? { target: { id: current.id, type: current.type, source: current.source, readOnlyReason: current.readOnlyReason } } : {}),
    });
  }

  private activate(action: FooterAction | undefined): void {
    if (!action) return;
    if (action.id === "search") { this.state.focus = "search"; this.request(); return; }
    if (action.id === "selectFiltered") { for (const row of this.filtered) if (!row.readOnly) this.selected.add(this.key(row)); this.request(); return; }
    if (action.id === "deselectFiltered") { for (const row of this.filtered) if (!row.readOnly) this.selected.delete(this.key(row)); this.request(); return; }
    if (action.id === "cycleType") { this.cycleType(); return; }
    if (action.id === "hideRemote") { this.hideCurrentRemote(); return; }
    this.finish(action.id as SelectionResult["action"]);
  }

  handleInput(data: string): void {
    if (data === "/") { this.state.focus = "search"; this.request(); return; }
    if (matchesKey(data, Key.ctrl("r"))) { this.finish("fetch"); return; }
    if (matchesKey(data, Key.ctrl("delete"))) { this.hideCurrentRemote(); return; }
    if (matchesKey(data, Key.ctrl("e"))) { this.finish("edit"); return; }
    if (matchesKey(data, Key.ctrl("k"))) { this.finish("probe"); return; }
    if (matchesKey(data, Key.ctrl("l"))) { this.finish("probeThinking"); return; }
    if (matchesKey(data, Key.ctrl("s"))) { this.finish("preview"); return; }
    if (matchesKey(data, Key.escape)) { this.finish("back"); return; }
    if (matchesKey(data, Key.ctrl("t"))) { this.cycleType(); return; }
    if (matchesKey(data, Key.ctrl("a"))) {
      for (const row of this.filtered) if (!row.readOnly) this.selected.add(this.key(row));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      for (const row of this.filtered) if (!row.readOnly) this.selected.delete(this.key(row));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
      const order: Array<ModelPanelState["focus"]> = ["search", "list", "details", "actions"];
      const current = Math.max(0, order.indexOf(this.state.focus));
      const delta = matchesKey(data, "shift+tab") ? -1 : 1;
      this.state.focus = order[(current + delta + order.length) % order.length]!;
      this.request();
      return;
    }
    if (matchesKey(data, Key.left)) { if (this.state.focus === "actions") { const actions = this.actions(); this.state.actionIndex = (this.state.actionIndex - 1 + actions.length) % actions.length; } else if (this.state.focus === "details") this.state.focus = "list"; this.request(); return; }
    if (matchesKey(data, Key.right)) { if (this.state.focus === "actions") { const actions = this.actions(); this.state.actionIndex = (this.state.actionIndex + 1) % actions.length; } else if (this.state.focus === "search" || this.state.focus === "list") this.state.focus = "details"; else if (this.state.focus === "details") this.state.focus = "actions"; this.request(); return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      if (this.state.focus === "actions") { this.request(); return; } else if ((this.state.focus === "search" || this.state.focus === "list" || this.state.focus === "details") && this.filtered.length) {
        this.index = Math.max(0, Math.min(this.filtered.length - 1, this.index + delta));
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
      else this.toggleCurrent();
      return;
    }
    if (matchesKey(data, Key.space) && this.state.focus === "actions") {
      this.activate(this.actions()[this.state.actionIndex]);
      return;
    }
    if (this.state.focus !== "search") return;
    this.search.handleInput(data);
    this.refresh();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    if (safeWidth < 24) return renderPanelBox([truncateToWidth(this.theme.fg("warning", t(this.language, "selectorNarrow")), Math.max(1, safeWidth - 2), "")], safeWidth, t(this.language, "selectorTitle", { provider: this.provider }), this.theme);
    const innerWidth = Math.max(1, safeWidth - 2);
    const wide = innerWidth >= 68;
    const contentBudget = Math.max(2, overlayViewportRows(this.tui) - 2);
    const actions = this.actions();
    this.state.actionIndex = Math.min(this.state.actionIndex, actions.length - 1);
    const actionFooter = renderActionFooter(actions, this.state.actionIndex, this.state.focus === "actions", innerWidth, this.theme);
    const searchLines = this.search.render(innerWidth);
    const statusLines = this.status ? [this.theme.fg("warning", this.status)] : [];
    const externalCount = this.rows.filter((row) => row.readOnly).length;
    const countLine = this.theme.fg("muted", t(this.language, "selectorFooter", { filtered: this.filtered.length, total: this.rows.length, selected: this.selected.size, readonly: externalCount }));
    const bodyBudget = Math.max(0, contentBudget - searchLines.length - statusLines.length - actionFooter.length - 1);
    const leftWidth = wide ? Math.max(28, Math.floor((innerWidth - 2) * 0.5)) : innerWidth;
    const rightWidth = wide ? innerWidth - leftWidth - 2 : innerWidth;
    const left: string[] = [];
    if (!this.filtered.length) left.push(this.theme.fg("muted", t(this.language, "selectorNoMatches")));
    const visible = Math.max(0, bodyBudget);
    const start = Math.max(0, Math.min(this.index - Math.floor(visible / 2), Math.max(0, this.filtered.length - visible)));
    for (let i = start; i < Math.min(start + visible, this.filtered.length); i++) {
      const row = this.filtered[i]!;
      const checked = this.selected.has(this.key(row));
      const currentRow = i === this.index;
      const indicator = currentRow ? "→ " : "  ";
      const check = checked ? this.theme.fg("success", "✓") : " ";
      const source = row.readOnly ? t(this.language, "selectorReadonlyTag") : "";
      const prefix = `${indicator}[${check}] [${modelTypeLabel(this.language, row.type)}] `;
      const suffix = ` · ${row.name}${source ? ` · ${source}` : ""}`;
      const available = Math.max(1, leftWidth - visibleWidth(prefix) - visibleWidth(suffix));
      const content = `${prefix}${truncateToWidth(row.id, available, "…")}${suffix}`;
      left.push(truncateToWidth(currentRow ? this.theme.fg("accent", this.theme.bold(content)) : content, leftWidth, ""));
    }
    const current = this.current();
    const detailText = current ? [
      t(this.language, "panelModelName", { value: current.name }),
      t(this.language, "panelModelId", { value: current.id }),
      t(this.language, "panelModelType", { value: modelTypeLabel(this.language, current.type) }),
      t(this.language, "panelModelApi", { value: current.api }),
      ...(current.type !== "image" ? [current.contextSource === "compat" ? t(this.language, "compatContextDisplay") : t(this.language, "panelModelContext", { value: current.contextWindow })] : []),
      ...(current.type === "chat" ? [current.maxTokensSource === "compat" ? t(this.language, "compatMaxDisplay") : t(this.language, "panelModelMaxTokens", { value: current.maxTokens }), describeThinking(this.language, current, { thinkingSource: current.thinkingSource })] : []),
      t(this.language, "panelModelInput", { value: current.input.join(", ") || t(this.language, "valueUnset") }),
      ...(current.type === "image" ? [t(this.language, "panelModelOutput", { value: current.output.join(", ") || t(this.language, "valueUnset") })] : []),
      t(this.language, "panelModelCost", { input: current.cost.input, output: current.cost.output, cacheRead: current.cost.cacheRead, cacheWrite: current.cost.cacheWrite }),
      t(this.language, "panelModelBaseUrl", { value: current.baseUrl ?? t(this.language, "valueDefault") }),
      ...(current.readOnly ? [t(this.language, current.readOnlyReason === "runtime-catalog" ? "panelModelReadonlyRuntime" : "panelModelReadonly")] : []),
    ] : [];
    const rightAll = detailText.flatMap((line) => wrapTextWithAnsi(this.theme.fg("muted", line), rightWidth));
    this.detailMaxScroll = Math.max(0, rightAll.length - bodyBudget);
    this.state.detailScroll = Math.min(this.state.detailScroll, this.detailMaxScroll);
    const right = rightAll.slice(this.state.detailScroll, this.state.detailScroll + bodyBudget);
    const body = wide ? joinColumns(left.slice(0, bodyBudget), right, leftWidth, rightWidth) : this.state.focus === "details" ? right : left.slice(0, bodyBudget);
    const content = [...searchLines, ...statusLines, ...body.slice(0, bodyBudget), countLine, ...actionFooter].slice(0, contentBudget);
    return renderPanelBox(content, safeWidth, t(this.language, "selectorTitle", { provider: this.provider }), this.theme);
  }

  invalidate(): void { this.search.invalidate(); }
}

export async function selectModels(
  ctx: ExtensionCommandContext,
  language: UiLanguage,
  provider: string,
  draft: ProviderDraft,
  rows: CandidateModel[],
  initialSelected?: ManagedModel[],
  state: ModelPanelState = { search: "", focus: "list", actionIndex: 0, detailScroll: 0 },
  initialMetadata?: ModelMetadataEntry[],
): Promise<SelectionResult> {
  return ctx.ui.custom<SelectionResult>((tui, theme, _keybindings, done) => new ModelSelector(tui, theme, language, provider, draft, rows, initialSelected, state, done, initialMetadata), MODEL_CONFIG_OVERLAY_OPTIONS);
}
