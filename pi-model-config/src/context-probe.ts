import type { AnyModel } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { MODEL_CONFIG_OVERLAY_OPTIONS, renderPanelBox, showConfirmationPanel } from "./panel.ts";
import { sanitizeError } from "./config.ts";
import { t, type UiLanguage } from "./i18n.ts";

export type ProbeStatus = "success" | "context-overflow" | "auth" | "rate-limit" | "timeout" | "unsupported" | "aborted" | "error";
export interface ProbeStep { target: number; status: ProbeStatus; latencyMs: number; actualInput?: number; estimated: boolean; error?: string; usage?: unknown }
export interface ProbeResult { lower?: number; upper?: number; estimated: boolean; steps: ProbeStep[]; verifiedAt: string }
const STEPS = [32_000, 64_000, 128_000, 256_000];

function status(error: unknown, signal: AbortSignal): ProbeStatus {
  if (signal.aborted) return signal.reason?.name === "TimeoutError" ? "timeout" : "aborted";
  const message = error instanceof Error ? error.message : String(error);
  if (/context[_ -]?(?:length|window).*exceed|maximum context|too many tokens|prompt.*too long/iu.test(message)) return "context-overflow";
  if (/\b(?:401|403)\b|auth|credential|api.?key/iu.test(message)) return "auth";
  if (/\b429\b|rate.?limit/iu.test(message)) return "rate-limit";
  if (/unsupported|not implemented/iu.test(message)) return "unsupported";
  return "error";
}
function usageInput(usage: any): number | undefined {
  for (const value of [usage?.inputTokens, usage?.input, usage?.promptTokens, usage?.totalTokens]) if (typeof value === "number" && value > 0) return Math.floor(value);
  return undefined;
}

export async function runContextProbe(model: AnyModel, registry: any, ceiling: number, signal: AbortSignal, activeSecrets: Array<string | undefined> = [], options: { timeoutMs?: number; steps?: number[]; payloadBuilder?: (target: number) => string } = {}): Promise<ProbeResult> {
  const result: ProbeResult = { estimated: true, steps: [], verifiedAt: new Date().toISOString() };
  for (const target of (options.steps ?? STEPS).filter((step) => step <= ceiling)) {
    if (signal.aborted) { result.steps.push({ target, status: "aborted", latencyMs: 0, estimated: true }); break; }
    const started = performance.now();
    const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
    const text = options.payloadBuilder?.(target) ?? "x ".repeat(target);
    try {
      let usage: any;
      if (model.type === "classifier") {
        const response = await registry.classify(model, { state: { text }, questions: { ok: { type: "bool", instructions: "Return true", criteria: { true: "true", false: "false" } } } }, { signal: stepSignal });
        if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? response.stopReason);
        usage = response.usage;
      } else if (model.type === "chat") {
        const stream = registry.streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] }, { signal: stepSignal, maxTokens: 1 });
        let done = false;
        for await (const event of stream) {
          if (event.type === "error") throw new Error(String(event.error?.errorMessage ?? event.errorMessage ?? event.reason ?? "stream error"));
          if (event.type === "done") { done = true; usage = event.message?.usage ?? event.usage; }
        }
        if (!done) throw new Error("stream ended without done");
      } else return { ...result, steps: [{ target, status: "unsupported", latencyMs: 0, estimated: true }] };
      const actual = usageInput(usage);
      const lower = actual ?? target;
      result.lower = lower;
      result.estimated = actual === undefined;
      result.steps.push({ target, status: "success", latencyMs: Math.round(performance.now() - started), actualInput: actual, estimated: actual === undefined, usage });
    } catch (error) {
      const failure = status(error, stepSignal);
      result.steps.push({ target, status: failure, latencyMs: Math.round(performance.now() - started), estimated: true, error: sanitizeError(error, activeSecrets) });
      if (failure === "context-overflow") result.upper = target;
      break;
    }
  }
  return result;
}

class ProbeRunPanel implements Component {
  private controller = new AbortController();
  private result?: ProbeResult;
  constructor(private tui: TUI, private theme: Theme, private language: UiLanguage, model: AnyModel, registry: any, ceiling: number, activeSecrets: Array<string | undefined>, done: (result: ProbeResult) => void) {
    void runContextProbe(model, registry, ceiling, this.controller.signal, activeSecrets).then((result) => { this.result = result; this.tui.requestRender(); done(result); });
  }
  handleInput(data: string): void { if (matchesKey(data, Key.escape)) this.controller.abort(new DOMException("Cancelled", "AbortError")); }
  render(width: number): string[] { return renderPanelBox([this.result ? "done" : t(this.language, "testRunning")], width, t(this.language, "probeChooseTitle"), this.theme); }
  invalidate() {}
  dispose() { this.controller.abort(); }
}

export async function showContextProbeFlow(ctx: ExtensionCommandContext, language: UiLanguage, model: AnyModel, activeSecrets: Array<string | undefined> = []): Promise<ProbeResult | undefined> {
  const ceilingChoice = await showConfirmationPanel(ctx, {
    title: t(language, "probeChooseTitle"), summary: [t(language, "probeCostWarning")], defaultActionIndex: 0, cancelActionId: "cancel",
    actions: [...STEPS.map((step) => ({ id: String(step), label: `${step / 1000}K` })), { id: "cancel", label: t(language, "probeBack") }],
  });
  const ceiling = Number(ceilingChoice);
  if (!Number.isFinite(ceiling)) return undefined;
  const confirm = await showConfirmationPanel(ctx, { title: t(language, "probeChooseTitle"), summary: [t(language, "probeCostWarning")], defaultActionIndex: 0, cancelActionId: "cancel", actions: [{ id: "cancel", label: t(language, "confirmCancel") }, { id: "run", label: t(language, "contextProbeRun"), shortcut: "ctrl+k", severity: "warning" }] });
  if (confirm !== "run") return undefined;
  const result = await ctx.ui.custom<ProbeResult>((tui, theme, _keys, done) => new ProbeRunPanel(tui, theme, language, model, ctx.modelRegistry, ceiling, activeSecrets, done), MODEL_CONFIG_OVERLAY_OPTIONS);
  const details = result.steps.map((step) => `${step.target}: ${step.status} · ${step.latencyMs}ms${step.actualInput ? ` · input=${step.actualInput}` : " · estimated"}`);
  const actions = [{ id: "keep", label: t(language, "probeKeep") }, ...(result.lower ? [{ id: "use", label: t(language, "probeUse"), shortcut: "ctrl+s" }] : []), { id: "back", label: t(language, "probeBack") }];
  const choice = await showConfirmationPanel(ctx, { title: t(language, "probeChooseTitle"), summary: [result.lower ? `lower=${result.lower}${result.upper ? ` upper=${result.upper}` : ""}` : t(language, "probeNoSuccess")], details, defaultActionIndex: 0, cancelActionId: "back", actions });
  return choice === "use" ? result : undefined;
}
