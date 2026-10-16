import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { validateHttpUrl } from "./config.ts";
import { MODEL_CONFIG_OVERLAY_OPTIONS, renderPanelBox } from "./panel.ts";
import { t, type UiLanguage } from "./i18n.ts";
import { protocolThinkingMap } from "./thinking-defaults.ts";
import type { ProviderDraft, ThinkingLevelMap } from "./types.ts";

/** Defaults applied when the minimal probe request fails or cannot be trusted. */
export const AUTO_PROBE_TIMEOUT_MS = 15_000;
export const AUTO_PROBE_MAX_TOKENS_REQUEST = 100_000;
const PROBE_PROMPT = "用中文写一段约300字的描写";

export interface AutoProbeResult {
  /** Inferred output ceiling. Context window is intentionally not probed. */
  maxTokens: number;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

export interface ProbeChatParamsOptions {
  fetch?: typeof fetch;
  apiKey?: string;
  baseUrl: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

/**
 * Pure inference from a minimal chat-completions response. Returns null whenever the
 * observation is not trustworthy, so callers can fall back to compatibility defaults.
 */
export function inferAutoProbeParams(
  payload: {
    finishReason?: unknown;
    reasoningContent?: unknown;
    reasoningTokens?: unknown;
    completionTokens?: unknown;
  },
  api: string,
): AutoProbeResult | null {
  const reasoningTokens = typeof payload.reasoningTokens === "number" && Number.isFinite(payload.reasoningTokens) && payload.reasoningTokens > 0
    ? Math.floor(payload.reasoningTokens)
    : 0;
  const hasReasoningContent = typeof payload.reasoningContent === "string" && payload.reasoningContent.trim().length > 0;
  const reasoning = hasReasoningContent || reasoningTokens > 0;
  const finish = payload.finishReason;
  if (finish === "length") {
    // Truncated mid-reasoning: the model wanted at least its reasoning budget twice.
    const maxTokens = reasoningTokens > 0 ? Math.max(2 * reasoningTokens, 16_384) : Math.max(Math.floor(Number(payload.completionTokens)) || 0, 16_384);
    const protocol = reasoning ? protocolThinkingMap(api) : undefined;
    return { maxTokens, reasoning, ...(protocol ? { thinkingLevelMap: protocol } : {}) };
  }
  if (finish === "stop") return { maxTokens: 32_768, reasoning };
  // tool_calls / content_filter / unknown shapes are not trustworthy for sizing.
  return null;
}

/**
 * One minimal paid-capable request against an OpenAI-compatible /chat/completions
 * endpoint. Never throws: every failure path resolves to null so the save flow can
 * silently keep compatibility defaults. URL handling reuses validateHttpUrl, matching
 * discovery SSRF rules (HTTP(S) only, no embedded credentials or secret queries).
 */
export async function probeChatParams(model: { id: string; api: string }, options: ProbeChatParamsOptions): Promise<AutoProbeResult | null> {
  try {
    const base = validateHttpUrl(options.baseUrl, "Base URL").replace(/\/+$/u, "");
    const url = validateHttpUrl(`${base}/chat/completions`, "Probe URL");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    const combined = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? AUTO_PROBE_TIMEOUT_MS)]);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: AUTO_PROBE_MAX_TOKENS_REQUEST,
      }),
      signal: combined,
    });
    if (!response.ok) return null;
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { return null; }
    const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
    if (!choice || typeof choice !== "object") return null;
    return inferAutoProbeParams({
      finishReason: choice.finish_reason,
      reasoningContent: choice.message?.reasoning_content,
      reasoningTokens: body?.usage?.completion_tokens_details?.reasoning_tokens,
      completionTokens: body?.usage?.completion_tokens,
    }, model.api);
  } catch {
    // Abort (user Esc or timeout) and any transport/validation failure fall back to defaults.
    return null;
  }
}

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(validateHttpUrl(value, "Base URL")).origin; } catch { return undefined; }
}

/**
 * Resolve the credential used by the probe request, applying the same origin
 * containment as discovery for reused Pi credentials: an existing key is never
 * forwarded to a different origin than the one it was issued for.
 */
export function resolveProbeApiKey(
  draft: Pick<ProviderDraft, "authMode" | "apiKeyRaw" | "temporaryKey">,
  piAuth: { auth?: { apiKey?: string; baseUrl?: string } } | undefined,
  baseUrl: string,
): string | undefined {
  if (draft.authMode === "models-json") {
    const raw = draft.apiKeyRaw;
    const envMatch = raw?.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/u);
    if (envMatch) return process.env[envMatch[1] ?? envMatch[2]!];
    if (raw?.startsWith("$$") || raw?.startsWith("$!")) return raw.slice(1);
    return raw;
  }
  if (draft.authMode === "temporary") return draft.temporaryKey;
  if (draft.authMode === "reuse-pi") {
    const key = piAuth?.auth?.apiKey;
    if (!key) return undefined;
    const authOrigin = originOf(piAuth?.auth?.baseUrl);
    const modelOrigin = originOf(baseUrl);
    if (!authOrigin || !modelOrigin || authOrigin !== modelOrigin) return undefined;
    return key;
  }
  return undefined;
}

/** Chat models whose metadata still marks context/maxTokens as unverified compat defaults. */
export function probeTargetsFor(
  models: ReadonlyArray<{ type: string; id: string }>,
  metadata: ReadonlyArray<{ type: string; id: string; contextSource?: string; maxTokensSource?: string }>,
): Array<{ type: string; id: string }> {
  return models.filter((model) => {
    if (model.type !== "chat") return false;
    const entry = metadata.find((item) => item.type === model.type && item.id === model.id);
    return !entry || entry.contextSource === "compat" || entry.maxTokensSource === "compat";
  });
}

export interface ProbeQueueEntry<T> {
  label: string;
  run: (signal: AbortSignal) => Promise<T | null>;
}

export interface ProbeQueueOutcome<T> {
  result: T | null;
  /** True when this entry was skipped because the user pressed Esc earlier. */
  cancelled: boolean;
}

/** Serial runner shared by the TUI panel and tests; one request at a time, abort stops the rest. */
export async function runProbeQueue<T>(
  entries: ReadonlyArray<ProbeQueueEntry<T>>,
  signal: AbortSignal,
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<Array<ProbeQueueOutcome<T>>> {
  const outcomes: Array<ProbeQueueOutcome<T>> = [];
  for (const entry of entries) {
    if (signal.aborted) { outcomes.push({ result: null, cancelled: true }); continue; }
    onProgress?.(outcomes.length, entries.length, entry.label);
    const result = await entry.run(signal);
    outcomes.push({ result, cancelled: false });
    onProgress?.(outcomes.length, entries.length, entry.label);
  }
  return outcomes;
}

class AutoProbePanel<T> implements Component {
  private controller = new AbortController();
  private done = 0;
  private current = "";
  constructor(
    private tui: TUI,
    private theme: Theme,
    private language: UiLanguage,
    private entries: ReadonlyArray<ProbeQueueEntry<T>>,
    done: (outcomes: Array<ProbeQueueOutcome<T>>) => void,
  ) {
    void runProbeQueue(this.entries, this.controller.signal, (completed, _total, label) => {
      this.done = completed;
      this.current = label;
      this.tui.requestRender();
    }).then((outcomes) => {
      this.done = outcomes.length;
      this.current = "";
      this.tui.requestRender();
      done(outcomes);
    });
  }
  handleInput(data: string): void { if (matchesKey(data, Key.escape)) this.controller.abort(new DOMException("Cancelled", "AbortError")); }
  render(width: number): string[] {
    const lines = [t(this.language, "autoProbeProgress", { done: this.done, total: this.entries.length, model: this.current })];
    return renderPanelBox(lines, width, t(this.language, "autoProbePanelTitle"), this.theme);
  }
  invalidate(): void {}
  dispose(): void { this.controller.abort(); }
}

/**
 * Unified boxed progress panel for the pre-save auto probe. Shows X/Y completed and
 * lets Esc cancel the remaining (not in-flight) requests; completed results are kept.
 */
export async function runAutoProbeFlow<T>(
  ctx: ExtensionCommandContext,
  language: UiLanguage,
  entries: ReadonlyArray<ProbeQueueEntry<T>>,
): Promise<Array<ProbeQueueOutcome<T>>> {
  return ctx.ui.custom<Array<ProbeQueueOutcome<T>>>(
    (tui, theme, _keys, done) => new AutoProbePanel(tui, theme, language, entries, done),
    MODEL_CONFIG_OVERLAY_OPTIONS,
  );
}
