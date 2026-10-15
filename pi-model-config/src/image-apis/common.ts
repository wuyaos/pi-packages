import type { AssistantImages, FetchFunction, ImageModel, ImagesContext, ImagesOptions, ProviderHeaders } from "@earendil-works/pi-ai";
import { sanitizeError, validateHttpUrl } from "../config.ts";

export const IMAGE_API_DEFAULT_BASE_URLS = {
  "openai-images": "https://api.openai.com/v1",
  "gemini-images": "https://generativelanguage.googleapis.com",
  "xai-images": "https://api.x.ai/v1",
  "dashscope-images": "https://dashscope.aliyuncs.com/api/v1",
} as const;

export type BuiltinImageApi = keyof typeof IMAGE_API_DEFAULT_BASE_URLS;

const ANONYMOUS_SENTINEL = "pi-model-config-anonymous";

export function imageDefaultBaseUrl(api: string): string | undefined {
  return IMAGE_API_DEFAULT_BASE_URLS[api as BuiltinImageApi];
}

/** Model URLs override provider URLs; protocol defaults only apply to the four self-owned APIs. */
export function resolveImageBaseUrl(api: string, modelBaseUrl?: string, providerBaseUrl?: string): string | undefined {
  return modelBaseUrl || providerBaseUrl || imageDefaultBaseUrl(api);
}

export function normalizeBaseUrl(value: string, requiredPath?: string): string {
  const url = new URL(validateHttpUrl(value, "Image Base URL"));
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (requiredPath && !url.pathname.endsWith(requiredPath)) {
    url.pathname = `${url.pathname === "/" ? "" : url.pathname}${requiredPath}`;
  }
  return url.toString().replace(/\/$/u, "");
}

export function promptFromContext(context: ImagesContext): string {
  return context.input.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
}

function asHeaders(value: ProviderHeaders | undefined): Record<string, string | null | undefined> {
  return { ...(value as Record<string, string | null | undefined> | undefined) };
}

function hasHeader(headers: Record<string, string | null | undefined>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

export function requestHeaders(
  model: ImageModel<string>,
  options: ImagesOptions | undefined,
  authentication: Record<string, string | undefined>,
): Record<string, string> {
  const merged = {
    ...asHeaders(model.headers),
    ...asHeaders(options?.headers),
  };
  for (const [name, value] of Object.entries(authentication)) {
    if (value && !hasHeader(merged, name)) merged[name] = value;
  }
  if (!hasHeader(merged, "content-type")) merged["content-type"] = "application/json";
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function apiKey(options: ImagesOptions | undefined): string | undefined {
  const key = options?.apiKey;
  return key && key !== ANONYMOUS_SENTINEL ? key : undefined;
}

export function fetchFor(options: ImagesOptions | undefined): FetchFunction {
  return options?.fetch ?? (globalThis.fetch as FetchFunction);
}

export function imageResult(model: ImageModel<string>): AssistantImages {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function activeSecrets(options: ImagesOptions | undefined, extra: readonly string[] = []): string[] {
  const metadata = options?.metadata as { secrets?: unknown } | undefined;
  const supplied = Array.isArray(metadata?.secrets) ? metadata.secrets.filter((value): value is string => typeof value === "string") : [];
  return [...extra, ...supplied, options?.apiKey].filter((value): value is string => !!value && value !== ANONYMOUS_SENTINEL);
}

export function failedImageResult(
  model: ImageModel<string>,
  error: unknown,
  options: ImagesOptions | undefined,
  extraSecrets: readonly string[] = [],
): AssistantImages {
  const result = imageResult(model);
  result.stopReason = options?.signal?.aborted ? "aborted" : "error";
  result.errorMessage = sanitizeError(error, activeSecrets(options, extraSecrets));
  return result;
}

export async function responseJson(response: Response, options?: ImagesOptions, extraSecrets: readonly string[] = []): Promise<unknown> {
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 200); } catch { /* status remains useful without a readable body */ }
    const safeDetail = detail ? `: ${sanitizeError(detail, activeSecrets(options, extraSecrets))}` : "";
    throw new Error(`Image API request failed: HTTP ${response.status}${safeDetail}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Image API returned invalid JSON");
  }
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

export function dataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

function privateHostname(hostname: string): boolean {
  let normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (mappedIpv4) normalized = mappedIpv4[1]!;
  else if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    normalized = `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::" || normalized === "0:0:0:0:0:0:0:0" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u)?.slice(1).map(Number);
  if (ipv4 && ipv4.every((part) => part >= 0 && part <= 255)) {
    const [a, b] = ipv4;
    return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
  }
  return normalized.startsWith("fc") || normalized.startsWith("fd") || /^(?:fe8|fe9|fea|feb)[0-9a-f]:/u.test(normalized);
}

export function validatePublicImageUrl(value: string): URL {
  const normalized = validateHttpUrl(value, "DashScope image URL");
  const url = new URL(normalized);
  if (privateHostname(url.hostname)) throw new Error("DashScope image URL targets a private network address");
  return url;
}

function redirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function timedSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Image download timed out")), timeoutMs);
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
}

async function readLimitedBody(response: Response, limit: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error(`Image download exceeds ${limit} byte limit`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(`Image download exceeds ${limit} byte limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error(`Image download exceeds ${limit} byte limit`); }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return undefined;
}

export interface DownloadImageUrlOptions {
  fetch?: FetchFunction;
  signal?: AbortSignal;
  timeoutMs?: number;
  sizeLimit?: number;
}

/** Downloads a public image without credentials. Every manually followed redirect is revalidated for SSRF. */
export async function downloadImageUrl(urlValue: string, options: DownloadImageUrlOptions = {}): Promise<{ mimeType: string; data: string }> {
  const initial = validatePublicImageUrl(urlValue);
  const fetcher = options.fetch ?? (globalThis.fetch as FetchFunction);
  const timed = timedSignal(options.signal, options.timeoutMs ?? 30_000);
  const sizeLimit = options.sizeLimit ?? 10 * 1024 * 1024;
  try {
    let current = initial;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetcher(current, { method: "GET", redirect: "manual", signal: timed.signal });
      if (redirectStatus(response.status)) {
        if (redirects === 5) throw new Error("Image download redirect limit exceeded");
        const location = response.headers.get("location");
        if (!location) throw new Error(`Image download redirect ${response.status} lacks Location`);
        // Signed-image CDNs may change public origins; each redirect must still pass URL and SSRF validation.
        const next = validatePublicImageUrl(new URL(location, current).toString());
        await response.body?.cancel();
        current = next;
        continue;
      }
      if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
      const bytes = await readLimitedBody(response, sizeLimit);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      const mimeType = contentType?.startsWith("image/") ? contentType : sniffImageMime(bytes) ?? "image/jpeg";
      return { mimeType, data: dataUrl(mimeType, Buffer.from(bytes).toString("base64")) };
    }
    throw new Error("Image download redirect limit exceeded");
  } finally {
    timed.dispose();
  }
}
