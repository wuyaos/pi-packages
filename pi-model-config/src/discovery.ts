import type { AuthResult, FetchFunction } from "@earendil-works/pi-ai";
import type { CandidateModel, DiscoveryAuthHeader, ManagedModelType, ProviderDraft } from "./types.ts";
import { identityOf } from "./types.ts";
import { createProviderFetch } from "./transport.ts";
import { validateHttpUrl } from "./config.ts";
import { mcError, ModelConfigError } from "./i18n.ts";
import { defaultChatThinking } from "./thinking-defaults.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
export const COMPAT_CONTEXT_WINDOW = 128_000;
export const COMPAT_MAX_TOKENS = 16_384;

interface DiscoveryCredentials {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface DiscoveryResult {
  models: CandidateModel[];
  url: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizedBase(value: string | undefined): URL | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    url.search = "";
    url.hash = "";
    validateHttpUrl(url.toString(), "Base URL");
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url;
  } catch {
    return undefined;
  }
}

function withPath(base: URL, path: string): string {
  const url = new URL(base);
  url.pathname = path.startsWith("/") ? path : `/${path}`;
  url.search = "";
  url.hash = "";
  return validateHttpUrl(url.toString(), "Discovery URL");
}

function pathWithModels(path: string): string {
  const clean = path.replace(/\/+$/u, "") || "/";
  if (/(?:^|\/)models$/iu.test(clean)) return clean;
  return clean === "/" ? "/models" : `${clean}/models`;
}

function openAiCandidates(base: URL): string[] {
  const path = base.pathname.replace(/\/+$/u, "") || "/";
  if (/(?:^|\/)models$/iu.test(path)) return [withPath(base, path)];
  if (/\/v\d+(?:beta\d*)?$/iu.test(path)) return unique([withPath(base, `${path}/models`), withPath(base, "/models")]);
  if (path === "/") return [withPath(base, "/v1/models"), withPath(base, "/models")];
  return unique([withPath(base, pathWithModels(path)), withPath(base, "/v1/models"), withPath(base, "/models")]);
}

function versionedCandidate(base: URL, version: string): string[] {
  const path = base.pathname.replace(/\/+$/u, "") || "/";
  if (/(?:^|\/)models$/iu.test(path)) return [withPath(base, path)];
  if (path.endsWith(`/${version}`)) return [withPath(base, `${path}/models`)];
  return [withPath(base, `/${version}/models`)];
}

function codexCandidates(base: URL): string[] {
  const path = base.pathname.replace(/\/+$/u, "") || "/";
  let preferred: string;
  if (/\/backend-api$/iu.test(path)) preferred = `${path}/codex/models`;
  else if (/\/codex\/responses$/iu.test(path)) preferred = path.replace(/\/responses$/iu, "/models");
  else if (/\/codex$/iu.test(path)) preferred = `${path}/models`;
  else if (/\/codex\/models$/iu.test(path)) preferred = path;
  else if (path === "/" || /\/v1$/iu.test(path)) preferred = "/backend-api/codex/models";
  else return [];
  return unique([withPath(base, preferred), withPath(base, "/v1/models")]);
}

/** Build conservative, same-origin discovery candidates. Explicit Discovery URL always wins. */
export function buildDiscoveryCandidates(
  draft: Pick<ProviderDraft, "discoveryUrl" | "baseUrl" | "chatApi" | "proxyUrl">,
  fallbackBaseUrls: Iterable<string | undefined> = [],
): string[] {
  if (draft.discoveryUrl) {
    try { return [validateHttpUrl(draft.discoveryUrl, "Discovery URL")]; } catch { return []; }
  }
  const bases: URL[] = [];
  if (draft.baseUrl !== undefined) {
    const explicit = normalizedBase(draft.baseUrl);
    if (!explicit) return [];
    bases.push(explicit);
  } else {
    for (const value of fallbackBaseUrls) {
      const base = normalizedBase(value);
      if (base) bases.push(base);
    }
  }
  const base = bases[0];
  if (!base) return [];
  const api = draft.chatApi;
  if (["azure-openai-responses", "bedrock-converse-stream", "google-vertex", "pi-messages"].includes(api)) return [];
  if (api === "google-generative-ai") return draft.proxyUrl ? [] : versionedCandidate(base, "v1beta");
  if (api === "anthropic-messages") return versionedCandidate(base, "v1");
  if (api === "mistral-conversations") return versionedCandidate(base, "v1");
  if (api === "openai-codex-responses") return codexCandidates(base);
  if (api === "openai-completions" || api === "openai-responses") return openAiCandidates(base);
  return [];
}

function positiveInteger(record: Record<string, unknown>, names: string[], fallback: number): number {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
}

function stringField(record: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) if (typeof record[name] === "string" && (record[name] as string).trim()) return (record[name] as string).trim();
  return undefined;
}

function sanitizeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || [...id].length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(id)) return undefined;
  return id;
}

function sanitizeName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const clean = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return fallback;
  return [...clean].slice(0, MAX_NAME_LENGTH).join("");
}

function inferredType(record: Record<string, unknown>, fallback: ManagedModelType): ManagedModelType {
  const raw = stringField(record, ["type", "model_type", "task"])?.toLowerCase();
  if (raw === "classifier" || raw === "classification") return "classifier";
  if (raw === "image" || raw === "image-generation" || raw === "text-to-image") return "image";
  if (raw === "chat" || raw === "language" || raw === "llm") return "chat";
  return fallback;
}

function modalities(record: Record<string, unknown>, names: string[], fallback: ("text" | "image")[]): ("text" | "image")[] {
  for (const name of names) {
    const value = record[name];
    if (!Array.isArray(value)) continue;
    const parsed = value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
    if (parsed.length) return [...new Set(parsed)];
  }
  return fallback;
}

function numericCost(record: Record<string, unknown>): CandidateModel["cost"] {
  const source = [record.cost, record.pricing].find((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value));
  const read = (names: string[]) => {
    for (const name of names) {
      const value = source?.[name];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  };
  return {
    input: read(["input", "input_price", "prompt"]),
    output: read(["output", "output_price", "completion"]),
    cacheRead: read(["cacheRead", "cache_read"]),
    cacheWrite: read(["cacheWrite", "cache_write"]),
  };
}

function thinkingMap(record: Record<string, unknown>): Record<string, string | null> | undefined {
  const raw = record.thinkingLevelMap ?? record.thinking_level_map;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const entries = Object.entries(raw as Record<string, unknown>).filter(([key, value]) => levels.has(key) && (typeof value === "string" || value === null));
  return Object.fromEntries(entries) as Record<string, string | null>;
}

function explicitReasoning(record: Record<string, unknown>): boolean | undefined {
  if (typeof record.reasoning === "boolean") return record.reasoning;
  const capabilities = typeof record.capabilities === "object" && record.capabilities !== null && !Array.isArray(record.capabilities)
    ? record.capabilities as Record<string, unknown>
    : undefined;
  if (typeof capabilities?.reasoning === "boolean") return capabilities.reasoning;
  if (Array.isArray(record.supported_reasoning_levels)) return record.supported_reasoning_levels.some((value) => typeof value === "string" && value.trim());
  return undefined;
}

function normalizeRemote(value: unknown, draft: ProviderDraft): CandidateModel | undefined {
  const record: Record<string, unknown> = typeof value === "string"
    ? { id: value }
    : typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  const id = sanitizeId(stringField(record, ["id", "model", "model_id", "slug"]));
  if (!id) return undefined;
  const name = sanitizeName(stringField(record, ["name", "display_name", "displayName"]), id);
  const type = inferredType(record, draft.defaultType);
  const explicitContext = positiveInteger(record, ["context_window", "contextWindow", "context_length", "max_context_tokens", "max_input_tokens"], 0);
  const contextWindow = explicitContext || COMPAT_CONTEXT_WINDOW;
  const explicitMax = positiveInteger(record, ["max_output_tokens", "maxTokens", "max_tokens", "max_completion_tokens"], 0);
  const requestedMax = explicitMax || COMPAT_MAX_TOKENS;
  const common = {
    id,
    name,
    api: type === "chat" ? draft.chatApi : type === "classifier" ? draft.classifierApi : draft.imageApi,
    ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
    input: modalities(record, ["input_modalities", "inputModalities", "input"], ["text"]),
    cost: numericCost(record),
    source: "remote" as const,
    mutableType: true,
    contextSource: type === "image" ? undefined : (explicitContext ? "remote" as const : "compat" as const),
    maxTokensSource: type === "chat" ? (explicitMax ? "remote" as const : "compat" as const) : undefined,
  };
  if (type === "classifier") return { ...common, type, contextWindow };
  if (type === "image") {
    const output = modalities(record, ["output_modalities", "outputModalities", "output"], ["image"]);
    return { ...common, type, output: output.includes("image") ? output : ["image", ...output] };
  }
  const thinking = defaultChatThinking(draft.chatApi, { reasoning: explicitReasoning(record), thinkingLevelMap: thinkingMap(record) }, "remote");
  return { ...common, type, ...thinking, contextWindow, maxTokens: Math.min(requestedMax, contextWindow) };
}

function paginationReason(body: Record<string, unknown>, response: Response): string | undefined {
  const link = response.headers.get("link");
  if (link && /rel\s*=\s*["']?next/iu.test(link)) return "Link rel=next";
  if (body.has_more === true || body.hasMore === true) return "has_more=true";
  for (const key of ["next", "next_page", "nextPage", "next_cursor", "nextCursor"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) return key;
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) return key;
    if (value === true) return key;
    if (typeof value === "object" && value !== null && (!Array.isArray(value) || value.length > 0)) return key;
  }
  return undefined;
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

async function readTextLimited(response: Response, limit: number, strict: boolean): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (strict && Number.isFinite(length) && length > limit) {
    await cancelBody(response);
    throw mcError("MCFG_E_DISCOVERY_BODY_LIMIT", { limit });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        if (strict) throw mcError("MCFG_E_DISCOVERY_BODY_LIMIT", { limit });
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function safeErrorDetail(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^"'\s,;}]+/giu, "$1[REDACTED]")
    .replace(/(["']?(?:x-api-key|x-goog-api-key|api[-_ ]?key|token)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:key|token|api_key)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1024);
}

async function fetchWithSafeRedirects(initialUrl: string, fetchImpl: FetchFunction, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const response = await fetchImpl(current, { ...init, signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) {
      await cancelBody(response);
      throw mcError("MCFG_E_REDIRECT_LOCATION", { status: response.status });
    }
    const next = new URL(location, current);
    await cancelBody(response);
    if (next.origin !== current.origin) throw mcError("MCFG_E_REDIRECT_ORIGIN");
    current = next;
  }
  throw mcError("MCFG_E_REDIRECT_LIMIT");
}

function effectiveAuthHeader(draft: ProviderDraft): DiscoveryAuthHeader {
  if (draft.authHeader !== "auto") return draft.authHeader;
  if (draft.chatApi === "anthropic-messages") return "anthropic";
  if (draft.chatApi === "google-generative-ai") return "x-goog-api-key";
  if (draft.chatApi === "azure-openai-responses") return "api-key";
  return "bearer";
}

function validOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(validateHttpUrl(value, "Base URL")).origin; } catch { return undefined; }
}

export async function discoverModels(
  draft: ProviderDraft,
  piAuth: AuthResult | undefined,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<CandidateModel[]> {
  if (!draft.discoveryUrl) throw mcError("MCFG_E_DISCOVERY_URL");
  const url = validateHttpUrl(draft.discoveryUrl, "Discovery URL");
  const authHeader = effectiveAuthHeader(draft);
  const credentials: DiscoveryCredentials = {};
  if (draft.authMode === "models-json") {
    const raw = draft.apiKeyRaw;
    const envMatch = raw?.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/u);
    if (envMatch) {
      const name = envMatch[1] ?? envMatch[2]!;
      credentials.apiKey = process.env[name];
      if (!credentials.apiKey) throw mcError("MCFG_E_ENV_MISSING", { name });
    } else if (raw?.startsWith("$$") || raw?.startsWith("$!")) credentials.apiKey = raw.slice(1);
    else credentials.apiKey = raw;
  } else if (draft.authMode === "temporary") credentials.apiKey = draft.temporaryKey;
  else if (draft.authMode === "reuse-pi") {
    credentials.apiKey = piAuth?.auth.apiKey;
    const resolvedHeaders = Object.fromEntries(Object.entries(piAuth?.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (!credentials.apiKey && !Object.keys(resolvedHeaders).length) throw mcError("MCFG_E_PI_AUTH");
    credentials.headers = authHeader === "none" ? {} : resolvedHeaders;
    const hasCredentialMaterial = authHeader !== "none" && (!!credentials.apiKey || Object.keys(resolvedHeaders).length > 0);
    const modelOrigin = validOrigin(draft.baseUrl) ?? validOrigin(piAuth?.auth.baseUrl);
    if (hasCredentialMaterial && (!modelOrigin || new URL(url).origin !== modelOrigin)) throw mcError("MCFG_E_DISCOVERY_AUTH_ORIGIN");
  }

  const headers = new Headers({ accept: "application/json", ...credentials.headers });
  if (credentials.apiKey && authHeader === "bearer") headers.set("authorization", `Bearer ${credentials.apiKey}`);
  if (credentials.apiKey && authHeader === "x-api-key") headers.set("x-api-key", credentials.apiKey);
  if (credentials.apiKey && authHeader === "api-key") headers.set("api-key", credentials.apiKey);
  if (credentials.apiKey && authHeader === "x-goog-api-key") headers.set("x-goog-api-key", credentials.apiKey);
  if (authHeader === "anthropic") {
    if (credentials.apiKey) headers.set("x-api-key", credentials.apiKey);
    headers.set("anthropic-version", "2023-06-01");
  }
  if (authHeader === "none") {
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("api-key");
    headers.delete("x-goog-api-key");
  }

  const fetchImpl = draft.proxyUrl ? createProviderFetch(draft.proxyUrl) : globalThis.fetch;
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const response = await fetchWithSafeRedirects(url, fetchImpl, { headers }, combined);
  if (!response.ok) {
    const detail = safeErrorDetail(await readTextLimited(response, MAX_ERROR_BYTES, false));
    throw mcError("MCFG_E_DISCOVERY_HTTP", { status: response.status, detail: detail ? `: ${detail}` : "" });
  }
  const text = await readTextLimited(response, MAX_BODY_BYTES, true);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw mcError("MCFG_E_DISCOVERY_JSON"); }
  const object = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (object) {
    const reason = paginationReason(object, response);
    if (reason) throw mcError("MCFG_E_PAGINATION", { reason });
  }
  const rows = Array.isArray(body)
    ? body
    : object
      ? [object.data, object.models, object.list, object.result].find(Array.isArray)
      : undefined;
  if (!rows) throw mcError("MCFG_E_DISCOVERY_SHAPE");
  const models = rows.map((row) => normalizeRemote(row, draft)).filter((row): row is CandidateModel => row !== undefined);
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = identityOf(model, draft.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function discoverModelsFromCandidates(
  draft: ProviderDraft,
  candidates: readonly string[],
  piAuth: AuthResult | undefined,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<DiscoveryResult> {
  if (!candidates.length) throw mcError("MCFG_E_DISCOVERY_URL");
  const normalized = candidates.map((candidate) => validateHttpUrl(candidate, "Discovery URL"));
  const origin = new URL(normalized[0]!).origin;
  if (normalized.some((candidate) => new URL(candidate).origin !== origin)) throw mcError("MCFG_E_REDIRECT_ORIGIN");
  for (let index = 0; index < normalized.length; index++) {
    const url = normalized[index]!;
    try {
      const models = await discoverModels({ ...draft, discoveryUrl: url }, piAuth, signal, timeoutMs);
      return { models, url };
    } catch (error) {
      const status = error instanceof ModelConfigError && error.code === "MCFG_E_DISCOVERY_HTTP" ? Number(error.params.status) : undefined;
      if (index < normalized.length - 1 && (status === 404 || status === 405)) continue;
      throw error;
    }
  }
  throw mcError("MCFG_E_DISCOVERY_URL");
}
