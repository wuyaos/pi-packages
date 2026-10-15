import type { AnyModel } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { sanitizeError } from "./config.ts";
import { MODEL_CONFIG_OVERLAY_OPTIONS, renderPanelBox, showConfirmationPanel } from "./panel.ts";
import { THINKING_LEVELS, type ThinkingLevelName } from "./model-editor.ts";
import type { ThinkingLevelMap, ThinkingMetadataSource } from "./types.ts";
import { protocolThinkingMap } from "./thinking-defaults.ts";
import { t, type UiLanguage } from "./i18n.ts";

export const THINKING_PROBE_RUN_SHORTCUT = "ctrl+l";

export { protocolThinkingMap } from "./thinking-defaults.ts";

export type ThinkingProbeStatus = "accepted" | "rejected" | "auth" | "rate-limit" | "timeout" | "unsupported" | "aborted" | "error";
export interface ThinkingProbeStep { level: ThinkingLevelName; status: ThinkingProbeStatus; latencyMs: number; error?: string }
export interface ThinkingProbeResult { steps: ThinkingProbeStep[]; accepted: ThinkingLevelName[] }

export function resolveThinkingMap(explicitRemote: ThinkingLevelMap | undefined, runtime: ThinkingLevelMap | undefined, existing: ThinkingLevelMap | undefined, api: string): { map?: ThinkingLevelMap; source?: ThinkingMetadataSource } {
  // A discovered remote map may explicitly be empty. In contrast, an empty runtime
  // catalog map supplies no resolved wire values and should fall back to the protocol.
  if (explicitRemote !== undefined) return { map: explicitRemote, source: "remote" };
  if (runtime !== undefined && Object.keys(runtime).length > 0) return { map: runtime, source: "catalog" };
  // The draft can contain a deliberate user-edited empty map, so preserve it.
  if (existing !== undefined) return { map: existing, source: "existing" };
  const protocol = protocolThinkingMap(api);
  return protocol ? { map: protocol, source: "protocol" } : {};
}

export function acceptedThinkingMap(map: ThinkingLevelMap, accepted: readonly ThinkingLevelName[]): ThinkingLevelMap {
  const acceptedLevels = new Set(accepted);
  return Object.fromEntries(THINKING_LEVELS.flatMap((level) => {
    const value = map[level];
    return typeof value === "string" && acceptedLevels.has(level) ? [[level, value]] : [];
  })) as ThinkingLevelMap;
}
function classify(error: unknown, signal: AbortSignal): ThinkingProbeStatus {
  if (signal.aborted) return signal.reason?.name === "TimeoutError" ? "timeout" : "aborted";
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:401|403)\b|auth|credential|api.?key/iu.test(message)) return "auth";
  if (/\b429\b|rate.?limit/iu.test(message)) return "rate-limit";
  if (/unsupported|invalid.*reason|thinking.*not|effort.*not/iu.test(message)) return "rejected";
  return "error";
}
export async function runThinkingProbe(model: AnyModel, registry: any, map: ThinkingLevelMap, signal: AbortSignal, activeSecrets: Array<string | undefined> = [], timeoutMs = 30_000): Promise<ThinkingProbeResult> {
  const result: ThinkingProbeResult = { steps: [], accepted: [] };
  // streamSimple normally resolves its reasoning level through the runtime catalog.
  // Probe against the selected resolved map instead, never against stale model metadata.
  const probeModel = { ...model, thinkingLevelMap: { ...map } } as AnyModel;
  for (const level of THINKING_LEVELS) {
    if (signal.aborted) { result.steps.push({ level, status: "aborted", latencyMs: 0 }); break; }
    const mapped = map[level];
    if (typeof mapped !== "string") {
      result.steps.push({ level, status: "unsupported", latencyMs: 0 });
      continue;
    }
    const started = performance.now(); const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      if (model.type !== "chat") { result.steps.push({ level, status: "unsupported", latencyMs: 0 }); break; }
      const stream = registry.streamSimple(probeModel, { messages: [{ role: "user", content: [{ type: "text", text: "ok" }], timestamp: Date.now() }] }, { signal: stepSignal, maxTokens: 1, reasoning: level === "off" ? undefined : level });
      let done = false;
      for await (const event of stream) { if (event.type === "error") throw new Error(String(event.error?.errorMessage ?? event.errorMessage ?? event.reason ?? "stream error")); if (event.type === "done") done = true; }
      if (!done) throw new Error("stream ended without done");
      result.accepted.push(level); result.steps.push({ level, status: "accepted", latencyMs: Math.round(performance.now() - started) });
    } catch (error) { const status = classify(error, stepSignal); result.steps.push({ level, status, latencyMs: Math.round(performance.now() - started), error: sanitizeError(error, activeSecrets) }); if (status !== "rejected") break; }
  }
  return result;
}
class ThinkingRunPanel implements Component {
  private controller = new AbortController();
  constructor(private theme: Theme, private language: UiLanguage, model: AnyModel, registry: any, map: ThinkingLevelMap, secrets: Array<string | undefined>, done: (result: ThinkingProbeResult) => void) { void runThinkingProbe(model, registry, map, this.controller.signal, secrets).then(done); }
  handleInput(data: string): void { if (matchesKey(data, Key.escape)) this.controller.abort(new DOMException("Cancelled", "AbortError")); }
  render(width: number): string[] { return renderPanelBox([t(this.language, "testRunning")], width, t(this.language, "thinkingProbeTitle"), this.theme); }
  invalidate() {}
  dispose() { this.controller.abort(); }
}

export async function showThinkingProbeFlow(ctx: ExtensionCommandContext, language: UiLanguage, model: AnyModel, map: ThinkingLevelMap, activeSecrets: Array<string | undefined> = []): Promise<ThinkingProbeResult | undefined> {
  const confirm = await showConfirmationPanel(ctx, { title: t(language, "thinkingProbeTitle"), summary: [t(language, "thinkingProbeWarning")], defaultActionIndex: 0, cancelActionId: "cancel", actions: [{ id: "cancel", label: t(language, "confirmCancel") }, { id: "run", label: t(language, "probeRun"), shortcut: THINKING_PROBE_RUN_SHORTCUT }] });
  if (confirm !== "run") return undefined;
  const result = await ctx.ui.custom<ThinkingProbeResult>((_tui, theme, _keys, done) => new ThinkingRunPanel(theme, language, model, ctx.modelRegistry, map, activeSecrets, done), MODEL_CONFIG_OVERLAY_OPTIONS);
  const choice = await showConfirmationPanel(ctx, { title: t(language, "thinkingProbeTitle"), summary: [`accepted: ${result.accepted.join(", ") || "none"}`], details: result.steps.map((step) => `${step.level}: ${step.status} · ${step.latencyMs}ms`), defaultActionIndex: 0, cancelActionId: "back", actions: [{ id: "keep", label: t(language, "probeKeep") }, ...(result.accepted.length ? [{ id: "apply", label: t(language, "probeUse"), shortcut: "ctrl+s" }] : []), { id: "back", label: t(language, "probeBack") }] });
  return choice === "apply" ? result : undefined;
}
