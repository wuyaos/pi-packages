// Metadata extraction/matching adapted from dsh-model-kit (MIT) and agegr/pi-web (MIT).
// Copyright (c) 2026 PerseusNana7mi; Copyright (c) 2026 agegr. See ../LICENSE.
// https://github.com/PerseusNana7mi/dsh-model-kit / https://github.com/agegr/pi-web
// No price recommendations or effort-map writes are used here.
export type DirectoryData = Record<string, unknown>;
export type DirectoryMatchMethod = "exact" | "canonical" | "variant" | "none";
export interface ProviderHint { providerId: string; providerName?: string; baseUrl?: string }
export interface DirectorySource { provider: string; id: string; matchMethod: Exclude<DirectoryMatchMethod, "none"> }
export interface DirectoryResult {
  matchMethod: DirectoryMatchMethod;
  fields: { name?: string; contextWindow?: number; maxTokens?: number; input?: ("text" | "image")[]; reasoning?: boolean };
  sources: Partial<Record<"name" | "contextWindow" | "maxTokens" | "input" | "reasoning", DirectorySource[]>>;
  reasoning?: boolean;
  effortHint?: { provider: string; id: string; values: string[] };
}
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const lower = (value: string) => value.trim().toLowerCase();
const providerKey = (value: string) => lower(value).replace(/[^a-z0-9]/gu, "");
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const host = (value: string) => { try { return new URL(value).hostname.toLowerCase().replace(/\.$/u, ""); } catch { return ""; } };
export const DIRECTORY_TTL_MS = 60 * 60 * 1000;
let cache: { data: DirectoryData; expires: number } | undefined;
let pending: Promise<DirectoryData> | undefined;

/** Public catalog request: never receives provider credentials or custom headers. */
export async function fetchModelsDirectory(fetchImpl: typeof fetch = globalThis.fetch): Promise<DirectoryData> {
  if (cache && Date.now() < cache.expires) return cache.data;
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetchImpl("https://models.dev/api.json", { signal: AbortSignal.timeout(30_000), redirect: "error", credentials: "omit" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: unknown = await response.json();
      if (!Object.keys(object(data)).length || !Object.values(object(data)).some((row) => Object.keys(object(object(row).models)).length)) throw new Error("Invalid catalog");
      cache = { data: data as DirectoryData, expires: Date.now() + DIRECTORY_TTL_MS };
      return cache.data;
    } catch {
      throw new Error("Models.dev directory unavailable; check your network/proxy settings and retry. Models.dev 目录不可用，请检查网络/代理设置后重试。");
    }
  })();
  try { return await pending; } finally { pending = undefined; }
}

/** Only known affixes; fuzzy/global variant matching is deliberately forbidden. */
export function normalizeDirectoryVariant(value: string): string {
  return lower(value).replace(/^(?:us|eu|apac)\./u, "")
    .replace(/^(?:anthropic|amazon|meta|mistral|cohere|google|openai|deepseek|qwen)\./u, "")
    .replace(/(?:-v\d+:\d+|-latest|-preview|-\d{8})$/gu, "")
    .replace(/(?:-v\d+:\d+|-latest|-preview|-\d{8})$/gu, "");
}
interface Entry { provider: string; id: string; raw: Row }
const entryCache = new WeakMap<DirectoryData, Entry[]>();
function directoryEntries(directory: DirectoryData): Entry[] {
  let entries = entryCache.get(directory);
  if (!entries) {
    entries = Object.entries(directory).flatMap(([provider, raw]) => Object.entries(object(object(raw).models)).map(([id, row]) => ({ provider, id, raw: object(row) })));
    entryCache.set(directory, entries);
  }
  return entries;
}
const officialFamilies: Array<[RegExp, string[]]> = [
  [/^(?:gpt-|o[134](?:-|$)|chatgpt|codex)/u, ["openai"]],
  [/^claude/u, ["anthropic"]], [/^gemini/u, ["google"]], [/^deepseek/u, ["deepseek"]],
  [/^qwen/u, ["alibaba", "alibaba-cn", "qwen"]], [/^(?:llama|meta-llama)/u, ["meta"]],
  [/^kimi-/u, ["moonshotai", "moonshotai-cn"]], [/^glm-/u, ["zai", "zhipuai"]],
  [/^minimax-/u, ["minimax", "minimax-cn"]],
  [/^(?:mistral|magistral|codestral|devstral|ministral)/u, ["mistral"]], [/^grok/u, ["xai"]],
];
function officialFor(id: string): string[] {
  const bare = normalizeDirectoryVariant(id.split("/").at(-1)!);
  return officialFamilies.find(([pattern]) => pattern.test(bare))?.[1] ?? [];
}

export function matchModelsDirectory(directory: DirectoryData, id: string, hint: ProviderHint): DirectoryResult {
  const providers = Object.entries(directory).map(([provider, raw]) => ({ provider, row: object(raw) }));
  const names = [hint.providerId, hint.providerName ?? ""].filter(Boolean).map(providerKey);
  const byName = providers.filter(({ provider, row }) => names.includes(providerKey(provider)) || typeof row.name === "string" && names.includes(providerKey(row.name)));
  const hostname = host(hint.baseUrl ?? "");
  const byHost = hostname ? providers.filter(({ row }) => {
    const expected = typeof row.api === "string" ? host(row.api) : "";
    return expected && (hostname === expected || hostname.endsWith(`.${expected}`));
  }) : [];
  // Contradictory endpoint/name evidence must not select another provider's variants.
  const routed = byHost.length ? byName.length ? byHost.filter((p) => byName.includes(p)) : byHost : byName;
  const entries = directoryEntries(directory);
  const query = lower(id);
  let matches = entries.filter((e) => routed.some((p) => p.provider === e.provider) && (lower(e.id) === query || `${lower(e.provider)}/${lower(e.id)}` === query));
  let method: DirectoryMatchMethod = matches.length === 1 ? "exact" : "none";
  let chosen = matches.length === 1 ? matches[0] : undefined;
  // Canonical references are provider-qualified, never a global fuzzy lookup.
  if (chosen && typeof chosen.raw.canonical_model_id === "string") {
    const reference = lower(chosen.raw.canonical_model_id);
    const canonical = entries.find((e) => `${lower(e.provider)}/${lower(e.id)}` === reference);
    if (canonical) { chosen = canonical; method = "canonical"; }
  }
  if (!chosen && routed.length) {
    matches = entries.filter((e) => routed.some((p) => p.provider === e.provider) && normalizeDirectoryVariant(e.id) === normalizeDirectoryVariant(id));
    if (matches.length === 1) { chosen = matches[0]; method = "variant"; }
  }
  if (!chosen) return { matchMethod: "none", fields: {}, sources: {} };
  const source: DirectorySource = { provider: chosen.provider, id: chosen.id, matchMethod: method as DirectorySource["matchMethod"] };
  const result: DirectoryResult = { matchMethod: method, fields: {}, sources: {} };
  const raw = chosen.raw;
  if (typeof raw.name === "string" && raw.name.trim()) { result.fields.name = Array.from(raw.name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim()).slice(0, 256).join(""); result.sources.name = [source]; }
  const limit = object(raw.limit);
  if (positive(limit.context)) { result.fields.contextWindow = limit.context; result.sources.contextWindow = [source]; }
  if (positive(limit.output)) { result.fields.maxTokens = limit.output; result.sources.maxTokens = [source]; }
  const input = object(raw.modalities).input;
  if (Array.isArray(input)) {
    const supported = [...new Set(input.filter((v): v is "text" | "image" => v === "text" || v === "image"))];
    if (supported.length) { result.fields.input = supported; result.sources.input = [source]; }
  }
  // Consensus uses exact/canonical identity evidence, not a second global variant search.
  const canonicalIdentity = `${lower(chosen.provider)}/${lower(chosen.id)}`;
  const evidence = entries.filter((e) => lower(e.id) === lower(chosen.id) || lower(String(e.raw.canonical_model_id ?? "")) === canonicalIdentity);
  const unique = [...new Map(evidence.map((e) => [e.provider, e])).values()];
  const official = officialFor(chosen.id);
  let yes = 0, no = 0, total = 0;
  for (const e of unique) {
    const weight = official.includes(e.provider) ? 5 : 1;
    total += weight;
    if (e.raw.reasoning === true) yes += weight;
    if (e.raw.reasoning === false) no += weight;
  }
  if (yes !== no && Math.max(yes, no) / total >= 0.6) {
    result.reasoning = yes > no;
    result.fields.reasoning = result.reasoning;
    result.sources.reasoning = unique.filter((e) => e.raw.reasoning === result.reasoning).map((e) => ({ provider: e.provider, id: e.id, matchMethod: source.matchMethod }));
  }
  const officialEntry = unique.filter((e) => official.includes(e.provider));
  if (officialEntry.length === 1) {
    const e = officialEntry[0]!;
    const options = Array.isArray(e.raw.reasoning_options) ? e.raw.reasoning_options : [];
    const values = [...new Set(options.flatMap((v) => object(v).type === "effort" && Array.isArray(object(v).values) ? (object(v).values as unknown[]).filter((v): v is string => typeof v === "string") : []))];
    if (values.length) result.effortHint = { provider: e.provider, id: e.id, values };
  }
  return result;
}
