import type { AnyModel } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { MODEL_CONFIG_OVERLAY_OPTIONS, overlayViewportRows, renderActionFooter, renderPanelBox, showConfirmationPanel, type FooterAction } from "./panel.ts";
import { sanitizeError } from "./config.ts";
import { t, type UiLanguage } from "./i18n.ts";

export type ModelTestStatus = "success" | "auth" | "rate-limit" | "timeout" | "unsupported" | "aborted" | "error";

export interface ModelTestResult {
  model: AnyModel;
  status: ModelTestStatus;
  latencyMs: number;
  usage?: unknown;
  error?: string;
}

export interface ModelTestTimeouts { chat: number; classifier: number; image: number }
export const MODEL_TEST_CONCURRENCY = 2;
export const MODEL_TEST_TIMEOUTS: ModelTestTimeouts = { chat: 15_000, classifier: 15_000, image: 120_000 };

function classifyFailure(error: unknown, signal: AbortSignal): ModelTestStatus {
  if (signal.aborted) return signal.reason?.name === "TimeoutError" ? "timeout" : "aborted";
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:401|403)\b|auth|credential|api.?key/iu.test(message)) return "auth";
  if (/\b429\b|rate.?limit/iu.test(message)) return "rate-limit";
  if (/unsupported|not implemented|unknown provider/iu.test(message)) return "unsupported";
  return "error";
}

async function testOne(model: AnyModel, registry: any, rootSignal: AbortSignal, timeouts: ModelTestTimeouts, activeSecrets: Array<string | undefined>): Promise<ModelTestResult> {
  const started = performance.now();
  const timeout = model.type === "image" ? timeouts.image : model.type === "classifier" ? timeouts.classifier : timeouts.chat;
  const signal = AbortSignal.any([rootSignal, AbortSignal.timeout(timeout)]);
  try {
    let usage: unknown;
    if (model.type === "classifier") {
      const result = await registry.classify(model, {
        state: { text: "ok" },
        questions: { ok: { type: "bool", instructions: "Is the input ok?", criteria: { true: "yes", false: "no" } } },
      }, { signal });
      if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? result.stopReason);
      usage = result.usage;
    } else if (model.type === "image") {
      const result = await registry.generateImages(model, { input: [{ type: "text", text: "A single red dot" }] }, { signal });
      if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? result.stopReason);
      usage = result.usage;
    } else {
      const stream = registry.streamSimple(model, {
        messages: [{ role: "user", content: [{ type: "text", text: "ok" }], timestamp: Date.now() }],
      }, { signal, maxTokens: 1 });
      let terminal = false;
      for await (const event of stream) {
        if (event.type === "error") {
          const reason = event.error?.errorMessage ?? event.errorMessage ?? event.reason ?? event.error?.stopReason ?? "stream error";
          throw new Error(String(reason));
        }
        if (event.type === "done") {
          terminal = true;
          usage = event.message?.usage ?? event.usage;
        }
      }
      if (!terminal) throw new Error("stream ended without terminal done event");
    }
    return { model, status: "success", latencyMs: Math.round(performance.now() - started), usage };
  } catch (error) {
    return {
      model,
      status: classifyFailure(error, signal),
      latencyMs: Math.round(performance.now() - started),
      error: sanitizeError(error, activeSecrets),
    };
  }
}

export async function runModelAvailabilityTests(
  models: AnyModel[],
  registry: any,
  signal: AbortSignal,
  concurrency = MODEL_TEST_CONCURRENCY,
  timeouts = MODEL_TEST_TIMEOUTS,
  activeSecrets: Array<string | undefined> = [],
): Promise<ModelTestResult[]> {
  const results = new Array<ModelTestResult>(models.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= models.length) return;
      if (signal.aborted) {
        results[index] = { model: models[index]!, status: "aborted", latencyMs: 0 };
        continue;
      }
      results[index] = await testOne(models[index]!, registry, signal, timeouts, activeSecrets);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, models.length || 1)) }, worker));
  return results;
}

class TestSelectionPanel implements Component {
  private index = 0;
  private selected = new Set<string>();
  constructor(private tui: TUI, private theme: Theme, private language: UiLanguage, private models: AnyModel[], private done: (models: AnyModel[] | undefined) => void) {
    for (const model of models) if (model.type !== "image") this.selected.add(`${model.type}\0${model.id}`);
  }
  private key(model: AnyModel) { return `${model.type}\0${model.id}`; }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.done(undefined); return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      this.index = Math.max(0, Math.min(this.models.length - 1, this.index + delta));
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
      const model = this.models[this.index]; if (!model) return;
      const key = this.key(model); if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key);
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, Key.ctrl("s"))) this.done(this.models.filter((model) => this.selected.has(this.key(model))));
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const budget = Math.max(2, overlayViewportRows(this.tui) - 2);
    const rows = this.models.slice(Math.max(0, this.index - Math.max(1, budget - 4)), this.index + 1).map((model) => {
      const actual = this.models.indexOf(model);
      return `${actual === this.index ? "→ " : "  "}[${this.selected.has(this.key(model)) ? "✓" : " "}] [${model.type}] ${model.id}`;
    });
    const footer = [t(this.language, "testSelectionHelp")];
    return renderPanelBox([...rows, ...footer].slice(0, budget), width, t(this.language, "testSelectionTitle"), this.theme).map((line) => truncateToWidth(line, width, ""));
  }
  invalidate() {}
}

class TestRunPanel implements Component {
  private controller = new AbortController();
  private results: ModelTestResult[] = [];
  constructor(private tui: TUI, private theme: Theme, private language: UiLanguage, models: AnyModel[], registry: any, activeSecrets: Array<string | undefined>, done: (results: ModelTestResult[]) => void) {
    void runModelAvailabilityTests(models, registry, this.controller.signal, MODEL_TEST_CONCURRENCY, MODEL_TEST_TIMEOUTS, activeSecrets).then((results) => { this.results = results; this.tui.requestRender(); done(results); });
  }
  handleInput(data: string): void { if (matchesKey(data, Key.escape)) this.controller.abort(new DOMException("Cancelled", "AbortError")); }
  render(width: number): string[] {
    const lines = this.results.length ? this.results.map((result) => `${result.status === "success" ? "✓" : "×"} [${result.model.type}] ${result.model.id} · ${result.status} · ${result.latencyMs}ms`) : [t(this.language, "testRunning")];
    return renderPanelBox(lines.slice(0, Math.max(1, overlayViewportRows(this.tui) - 2)), width, t(this.language, "testResultsTitle"), this.theme);
  }
  invalidate() {}
  dispose() { this.controller.abort(); }
}

class TestResultsPanel implements Component {
  private actionIndex = 0;
  constructor(private tui: TUI, private theme: Theme, private language: UiLanguage, private results: ModelTestResult[], private done: (action: "retry" | "back") => void) {}
  private actions(): FooterAction[] {
    return [
      { id: "back", label: t(this.language, "testResultsBack"), key: Key.escape },
      { id: "retry", label: t(this.language, "testResultsRetry"), key: Key.enter, enabled: this.results.some((result) => result.status !== "success") },
    ];
  }
  private activate(): void {
    const action = this.actions()[this.actionIndex];
    if (action?.enabled === false) return;
    if (action?.id === "retry" || action?.id === "back") this.done(action.id);
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.done("back"); return; }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const delta = matchesKey(data, Key.left) ? -1 : 1;
      this.actionIndex = (this.actionIndex + delta + this.actions().length) % this.actions().length;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) return;
    if (matchesKey(data, Key.enter)) this.activate();
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const actions = renderActionFooter(this.actions(), this.actionIndex, true, inner, this.theme);
    const budget = Math.max(2, overlayViewportRows(this.tui) - 2);
    const lines = this.results.map((result) => {
      const usage = result.usage ? ` · usage=${JSON.stringify(result.usage)}` : "";
      return `${result.status === "success" ? "✓" : "×"} [${result.model.type}] ${result.model.id} · ${result.status} · ${result.latencyMs}ms${usage}${result.error ? ` · ${result.error}` : ""}`;
    });
    const body = [...lines, t(this.language, "testResultsHelp")].slice(0, Math.max(0, budget - actions.length));
    return renderPanelBox([...body, ...actions], width, t(this.language, "testResultsTitle"), this.theme);
  }
  invalidate() {}
}

export async function showModelTestFlow(ctx: ExtensionCommandContext, language: UiLanguage, models: AnyModel[], activeSecrets: Array<string | undefined> = []): Promise<void> {
  let selected = await ctx.ui.custom<AnyModel[] | undefined>((tui, theme, _keys, done) => new TestSelectionPanel(tui, theme, language, models, done), MODEL_CONFIG_OVERLAY_OPTIONS);
  while (selected?.length) {
    const imageCount = selected.filter((model) => model.type === "image").length;
    if (imageCount) {
      const image = await showConfirmationPanel(ctx, {
        title: t(language, "testImageConfirmTitle"), summary: [t(language, "testImageConfirmBody", { count: imageCount })], severity: "error",
        defaultActionIndex: 0, cancelActionId: "cancel",
        actions: [{ id: "cancel", label: t(language, "confirmCancel") }, { id: "run", label: t(language, "testImageRun"), shortcut: "ctrl+i", severity: "error" }],
      });
      if (image !== "run") return;
    }
    const paid = await showConfirmationPanel(ctx, {
      title: t(language, "testRunConfirmTitle"), summary: [t(language, "testRunConfirmBody", { count: selected.length })], severity: "warning",
      defaultActionIndex: 0, cancelActionId: "cancel",
      actions: [{ id: "cancel", label: t(language, "confirmCancel") }, { id: "run", label: t(language, "testRunAction"), shortcut: "ctrl+s", severity: "warning" }],
    });
    if (paid !== "run") return;
    const results = await ctx.ui.custom<ModelTestResult[]>((tui, theme, _keys, done) => new TestRunPanel(tui, theme, language, selected!, ctx.modelRegistry, activeSecrets, done), MODEL_CONFIG_OVERLAY_OPTIONS);
    const action = await ctx.ui.custom<"retry" | "back">((tui, theme, _keys, done) => new TestResultsPanel(tui, theme, language, results, done), MODEL_CONFIG_OVERLAY_OPTIONS);
    if (action === "back") return;
    selected = results.filter((result) => result.status !== "success").map((result) => result.model);
  }
}
