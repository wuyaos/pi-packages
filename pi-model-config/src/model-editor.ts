import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ManagedModel, ModelMetadataEntry, ThinkingMetadataSource } from "./types.ts";
import { MODEL_CONFIG_OVERLAY_OPTIONS, overlayViewportRows, renderActionFooter, renderPanelBox, showConfirmationPanel, type FooterAction } from "./panel.ts";
import { t, type UiLanguage } from "./i18n.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = typeof THINKING_LEVELS[number];

type EditorFieldId =
  | "name" | "context" | "maxTokens" | "reasoning"
  | `thinking:${ThinkingLevelName}`
  | "input:text" | "input:image" | "output:text" | "output:image"
  | "cost:input" | "cost:output" | "cost:cacheRead" | "cost:cacheWrite";

interface EditorField {
  id: EditorFieldId;
  label: string;
  value: string;
  editable: "input" | "toggle";
}

export function parsePositiveScaledInteger(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/u);
  if (!match) return undefined;
  const scale = !match[2] ? 1 : match[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
  const number = Number(match[1]) * scale;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function parseNonNegative(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(normalized)) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function defaultThinkingLevel(model: ManagedModel): ThinkingLevelName {
  if (model.type !== "chat" || !model.reasoning) return "off";
  const available = THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
  if (available.includes("medium")) return "medium";
  const mediumIndex = THINKING_LEVELS.indexOf("medium");
  for (let index = mediumIndex + 1; index < THINKING_LEVELS.length; index++) if (available.includes(THINKING_LEVELS[index]!)) return THINKING_LEVELS[index]!;
  for (let index = mediumIndex - 1; index >= 0; index--) if (available.includes(THINKING_LEVELS[index]!)) return THINKING_LEVELS[index]!;
  return available[0] ?? "off";
}

function thinkingSourceLabel(language: UiLanguage, source: ThinkingMetadataSource | undefined): string {
  switch (source) {
    case "existing": return t(language, "thinkingSourceExisting");
    case "remote": return t(language, "thinkingSourceRemote");
    case "catalog": return t(language, "thinkingSourceCatalog");
    case "protocol": return t(language, "thinkingSourceProtocol");
    case "user": return t(language, "thinkingSourceUser");
    case "probed": return t(language, "thinkingSourceProbed");
    default: return t(language, "thinkingSourceDefault");
  }
}

export function describeThinking(language: UiLanguage, model: ManagedModel, metadata: Pick<ModelMetadataEntry, "thinkingSource">): string {
  return t(language, "editorThinkingSummary", {
    level: defaultThinkingLevel(model),
    source: thinkingSourceLabel(language, metadata.thinkingSource),
  });
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(1, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function joinColumns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => `${pad(left[index] ?? "", leftWidth)}  ${pad(right[index] ?? "", rightWidth)}`);
}

function mapValue(model: Extract<ManagedModel, { type: "chat" }>, level: ThinkingLevelName, language: UiLanguage): string {
  const value = model.thinkingLevelMap?.[level];
  return value === null ? t(language, "editorMapDisabled") : value === undefined ? t(language, "editorMapDefault") : value;
}

function editableText(model: ManagedModel, id: EditorFieldId): string {
  if (id === "name") return model.name;
  if (id === "context" && model.type !== "image") return String(model.contextWindow);
  if (id === "maxTokens" && model.type === "chat") return String(model.maxTokens);
  if (id.startsWith("thinking:") && model.type === "chat") {
    const value = model.thinkingLevelMap?.[id.slice("thinking:".length) as ThinkingLevelName];
    return value ?? "";
  }
  if (id.startsWith("cost:")) return String(model.cost[id.slice("cost:".length) as keyof typeof model.cost]);
  return "";
}

interface EditorResult {
  action: "return" | "apply";
  model: ManagedModel;
  metadata: ModelMetadataEntry;
}

class ModelParameterEditor implements Component, Focusable {
  private index = 0;
  private _focused = false;
  private editing?: { id: EditorFieldId; input: Input };

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly language: UiLanguage,
    private readonly model: ManagedModel,
    private readonly metadata: ModelMetadataEntry,
    private readonly done: (result: EditorResult) => void,
  ) {}

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; if (this.editing) this.editing.input.focused = value; }

  private fields(): EditorField[] {
    const fields: EditorField[] = [{ id: "name", label: t(this.language, "editorName"), value: this.model.name, editable: "input" }];
    if (this.model.type !== "image") fields.push({ id: "context", label: t(this.language, "editorContext"), value: String(this.model.contextWindow), editable: "input" });
    if (this.model.type === "chat") {
      fields.push(
        { id: "maxTokens", label: t(this.language, "editorMaxTokens"), value: String(this.model.maxTokens), editable: "input" },
        { id: "reasoning", label: t(this.language, "editorReasoning"), value: this.model.reasoning ? t(this.language, "valueYes") : t(this.language, "valueNo"), editable: "toggle" },
        ...THINKING_LEVELS.map((level) => ({ id: `thinking:${level}` as const, label: `${t(this.language, "editorThinkingMap")} / ${level}`, value: mapValue(this.model as Extract<ManagedModel, { type: "chat" }>, level, this.language), editable: "input" as const })),
      );
    }
    fields.push(
      { id: "input:text", label: `${t(this.language, "editorInput")} / text`, value: this.model.input.includes("text") ? "✓" : "", editable: "toggle" },
      { id: "input:image", label: `${t(this.language, "editorInput")} / image`, value: this.model.input.includes("image") ? "✓" : "", editable: "toggle" },
    );
    if (this.model.type === "image") fields.push(
      { id: "output:text", label: `${t(this.language, "editorOutput")} / text`, value: this.model.output.includes("text") ? "✓" : "", editable: "toggle" },
      { id: "output:image", label: `${t(this.language, "editorOutput")} / image`, value: this.model.output.includes("image") ? "✓" : "", editable: "toggle" },
    );
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) fields.push({ id: `cost:${key}`, label: `${t(this.language, "editorCost")} / ${key}`, value: String(this.model.cost[key]), editable: "input" });
    return fields;
  }

  private current(): EditorField | undefined { return this.fields()[this.index]; }
  private request(): void { if (this.editing) this.editing.input.focused = this._focused; this.tui.requestRender(); }

  private markUser(id: EditorFieldId): void {
    if (id === "context") this.metadata.contextSource = "user";
    if (id === "maxTokens") this.metadata.maxTokensSource = "user";
    if (id === "reasoning" || id.startsWith("thinking:")) this.metadata.thinkingSource = "user";
  }

  private commit(id: EditorFieldId, raw: string): void {
    if (id === "name") {
      if (!raw.trim()) { this.tui.requestRender(); return; }
      this.model.name = raw.trim();
    } else if (id === "context" && this.model.type !== "image") {
      const value = parsePositiveScaledInteger(raw);
      if (!value) this.notify("editorPositiveError");
      else if (this.model.type === "chat" && value < this.model.maxTokens) this.notify("editorMaxError");
      else { this.model.contextWindow = value; this.markUser(id); }
    } else if (id === "maxTokens" && this.model.type === "chat") {
      const value = parsePositiveScaledInteger(raw);
      if (!value) this.notify("editorPositiveError");
      else if (value > this.model.contextWindow) this.notify("editorMaxError");
      else { this.model.maxTokens = value; this.markUser(id); }
    } else if (id.startsWith("thinking:") && this.model.type === "chat") {
      const level = id.slice("thinking:".length) as ThinkingLevelName;
      const value = raw.trim();
      const map = { ...(this.model.thinkingLevelMap ?? {}) };
      if (!value) delete map[level];
      else if (value === "-" || value.toLowerCase() === "null") map[level] = null;
      else map[level] = value;
      this.model.thinkingLevelMap = map;
      this.markUser(id);
    } else if (id.startsWith("cost:")) {
      const key = id.slice("cost:".length) as keyof typeof this.model.cost;
      const value = parseNonNegative(raw);
      if (value === undefined) this.notify("editorCostError");
      else this.model.cost[key] = value;
    }
    this.request();
  }

  private notify(key: "editorPositiveError" | "editorMaxError" | "editorCostError" | "editorModalityEmpty" | "editorModalityRequired"): void {
    // The command context owns notifications; model-editor is intentionally pure TUI.
    this.status = t(this.language, key, key === "editorModalityRequired" ? { modality: "image" } : undefined);
    this.tui.requestRender();
  }

  private status = "";

  private toggle(id: EditorFieldId): void {
    if (id === "reasoning" && this.model.type === "chat") {
      this.model.reasoning = !this.model.reasoning;
      this.markUser(id);
    } else if (id.startsWith("input:")) {
      const modality = id.slice("input:".length) as "text" | "image";
      const next = new Set(this.model.input);
      if (next.has(modality)) {
        if (next.size === 1) { this.notify("editorModalityEmpty"); return; }
        next.delete(modality);
      } else next.add(modality);
      this.model.input = [...next];
    } else if (id.startsWith("output:") && this.model.type === "image") {
      const modality = id.slice("output:".length) as "text" | "image";
      const next = new Set(this.model.output);
      if (next.has(modality)) {
        if (modality === "image") { this.notify("editorModalityRequired"); return; }
        next.delete(modality);
      } else next.add(modality);
      this.model.output = [...next];
    }
    this.status = "";
    this.request();
  }

  private beginEdit(field: EditorField): void {
    if (field.editable === "toggle") { this.toggle(field.id); return; }
    const input = new Input({ prompt: "", placeholder: t(this.language, "editorInlineHint") });
    input.setValue(editableText(this.model, field.id));
    input.handleInput("\x1b[F"); // End: edit existing values in place instead of prepending.
    input.onSubmit = () => {
      const editing = this.editing;
      if (!editing) return;
      this.editing = undefined;
      this.commit(editing.id, editing.input.getValue());
    };
    this.editing = { id: field.id, input };
    input.focused = this._focused;
    this.request();
  }

  private valid(): boolean {
    if (this.model.type === "chat" && this.model.maxTokens > this.model.contextWindow) { this.notify("editorMaxError"); return false; }
    if (!this.model.input.length) { this.notify("editorModalityEmpty"); return false; }
    if (this.model.type === "image" && !this.model.output.includes("image")) { this.notify("editorModalityRequired"); return false; }
    if (Object.values(this.model.cost).some((value) => !Number.isFinite(value) || value < 0)) { this.notify("editorCostError"); return false; }
    return true;
  }

  private apply(): void {
    if (this.editing) {
      const editing = this.editing;
      this.editing = undefined;
      this.commit(editing.id, editing.input.getValue());
    }
    if (this.valid()) this.done({ action: "apply", model: structuredClone(this.model), metadata: structuredClone(this.metadata) });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("s"))) { this.apply(); return; }
    if (matchesKey(data, Key.escape)) {
      if (this.editing) { this.editing = undefined; this.status = ""; this.request(); }
      else this.done({ action: "return", model: structuredClone(this.model), metadata: structuredClone(this.metadata) });
      return;
    }
    if (this.editing) { this.editing.input.handleInput(data); this.request(); return; }
    const fields = this.fields();
    if (matchesKey(data, Key.up)) { this.index = Math.max(0, this.index - 1); this.status = ""; this.request(); return; }
    if (matchesKey(data, Key.down)) { this.index = Math.min(fields.length - 1, this.index + 1); this.status = ""; this.request(); return; }
    if (matchesKey(data, Key.enter)) { const field = this.current(); if (field) this.beginEdit(field); }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const inner = Math.max(1, safeWidth - 2);
    const wide = inner >= 68;
    const contentBudget = Math.max(2, overlayViewportRows(this.tui) - 2);
    const actions: FooterAction[] = [
      { id: "edit", label: t(this.language, "editorModify"), key: Key.enter },
      { id: "apply", label: t(this.language, "editorApply"), key: Key.ctrl("s") },
      { id: "back", label: t(this.language, "editorReturn"), key: Key.escape },
    ];
    const footer = renderActionFooter(actions, 0, false, inner, this.theme);
    const heading = [this.theme.fg("muted", describeThinking(this.language, this.model, this.metadata)), this.theme.fg("muted", t(this.language, "editorMapHint"))];
    const status = this.status ? [this.theme.fg("error", this.status)] : [];
    const bodyBudget = Math.max(0, contentBudget - heading.length - status.length - footer.length);
    const leftWidth = wide ? Math.max(26, Math.floor((inner - 2) * 0.43)) : inner;
    const rightWidth = wide ? inner - leftWidth - 2 : inner;
    const fields = this.fields();
    this.index = Math.min(this.index, Math.max(0, fields.length - 1));
    const visible = Math.max(1, bodyBudget);
    const start = Math.max(0, Math.min(this.index - Math.floor(visible / 2), Math.max(0, fields.length - visible)));
    const left: string[] = [];
    const right: string[] = [];
    for (let index = start; index < Math.min(start + visible, fields.length); index++) {
      const field = fields[index]!;
      const current = index === this.index;
      const label = `${current ? "→ " : "  "}${field.label}`;
      left.push(current ? this.theme.fg("accent", this.theme.bold(truncateToWidth(label, leftWidth, "…"))) : truncateToWidth(label, leftWidth, "…"));
      if (current && this.editing?.id === field.id) right.push(...this.editing.input.render(rightWidth));
      else right.push(this.theme.fg(current ? "accent" : "muted", truncateToWidth(field.value || t(this.language, "valueUnset"), rightWidth, "…")));
    }
    const body = wide ? joinColumns(left, right, leftWidth, rightWidth) : left;
    return renderPanelBox([...heading, ...status, ...body.slice(0, bodyBudget), ...footer].slice(0, contentBudget), safeWidth, t(this.language, "editorTitle", { model: this.model.id }), this.theme);
  }

  invalidate(): void { this.editing?.input.invalidate(); }
}

async function showModelParameterEditor(ctx: ExtensionCommandContext, language: UiLanguage, model: ManagedModel, metadata: ModelMetadataEntry): Promise<EditorResult> {
  return ctx.ui.custom<EditorResult>((tui, theme, _keys, done) => new ModelParameterEditor(tui, theme, language, structuredClone(model), structuredClone(metadata), done), MODEL_CONFIG_OVERLAY_OPTIONS);
}

export async function editModelParameters(ctx: ExtensionCommandContext, language: UiLanguage, source: ManagedModel, metadata: ModelMetadataEntry): Promise<{ model: ManagedModel; metadata: ModelMetadataEntry } | undefined> {
  const result = await showModelParameterEditor(ctx, language, source, metadata);
  if (result.action !== "apply") return undefined;
  const confirm = await showConfirmationPanel(ctx, {
    title: t(language, "editorConfirmTitle"),
    summary: [`${result.model.type}/${result.model.id}`, result.model.name, describeThinking(language, result.model, result.metadata)],
    details: [JSON.stringify(result.model)],
    defaultActionIndex: 0,
    cancelActionId: "cancel",
    actions: [{ id: "cancel", label: t(language, "confirmCancel") }, { id: "apply", label: t(language, "editorApply"), shortcut: "ctrl+s" }],
  });
  return confirm === "apply" ? { model: result.model, metadata: result.metadata } : undefined;
}
