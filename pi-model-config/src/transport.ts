import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { FetchFunction, ProviderEnv, ProviderHeaders, Transport } from "@earendil-works/pi-ai";
import { IMAGE_API_NAMES, type ProviderDraft } from "./types.ts";
import { validateHttpUrl } from "./config.ts";
import { mcError } from "./i18n.ts";

export const ANONYMOUS_SENTINEL = "pi-model-config-anonymous";

export const PROXY_CHAT_APIS = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "pi-messages",
  "bedrock-converse-stream",
]);
export const CHAT_APIS = new Set([
  ...PROXY_CHAT_APIS,
  "google-generative-ai",
  "google-vertex",
]);
export const CLASSIFIER_APIS = new Set([
  "typesafe-system-one",
  "cloudflare-workers-ai-system-one",
  "openai-decisions",
]);
export const IMAGE_APIS = new Set(IMAGE_API_NAMES);

export function assertSupportedProtocol(draft: ProviderDraft, type: "chat" | "classifier" | "image"): void {
  const api = type === "chat" ? draft.chatApi : type === "classifier" ? draft.classifierApi : draft.imageApi;
  const supported = type === "chat" ? CHAT_APIS : type === "classifier" ? CLASSIFIER_APIS : IMAGE_APIS;
  if (!supported.has(api)) throw mcError("MCFG_E_UNSUPPORTED_API", { identity: `${draft.id}/${type}`, api });
  if (draft.proxyUrl && type === "chat" && !PROXY_CHAT_APIS.has(api)) {
    throw mcError("MCFG_E_PROXY_UNSUPPORTED", { identity: `${draft.id}/${type}/${api}` });
  }
  if (draft.authMode === "anonymous" && (api === "pi-messages" || api === "bedrock-converse-stream" || api === "google-generative-ai" || api === "google-vertex")) {
    throw mcError("MCFG_E_ANONYMOUS_UNSUPPORTED", { identity: `${draft.id}/${type}/${api}` });
  }
}

/** A provider-local fetch. It never mutates process.env or the global dispatcher. */
const proxyFetchCache = new Map<string, FetchFunction>();

export function createProviderFetch(proxyUrl: string): FetchFunction {
  const normalized = validateHttpUrl(proxyUrl, "proxyUrl");
  const cached = proxyFetchCache.get(normalized);
  if (cached) return cached;
  const dispatcher = new ProxyAgent(normalized);
  const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Do not auto-follow: adapter credentials/custom headers must never cross an origin boundary.
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      redirect: "manual",
      dispatcher,
    }) as unknown as Response;
  }) as FetchFunction;
  proxyFetchCache.set(normalized, providerFetch);
  return providerFetch;
}

export interface TransportOptions {
  fetch?: FetchFunction;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: ProviderEnv;
  transport?: Transport;
}

export function applyProviderTransport<T extends TransportOptions>(
  options: T | undefined,
  config: { proxyUrl?: string; anonymous: boolean; api: string },
): T {
  const next = { ...(options ?? {}) } as T;
  if (config.proxyUrl) {
    if (config.api === "bedrock-converse-stream") {
      next.env = { ...next.env, HTTP_PROXY: config.proxyUrl, HTTPS_PROXY: config.proxyUrl };
    } else {
      next.fetch = createProviderFetch(config.proxyUrl);
    }
    if (config.api === "openai-codex-responses") next.transport = "sse";
  }
  if (config.anonymous) {
    next.apiKey = ANONYMOUS_SENTINEL;
    next.headers = {
      ...next.headers,
      authorization: null,
      "x-api-key": null,
      "x-goog-api-key": null,
      "cf-aig-authorization": null,
    };
  }
  return next;
}
