import type { AnyModel } from "@earendil-works/pi-ai";

export const MODEL_TYPES = ["chat", "classifier", "image"] as const;
export const IMAGE_API_NAMES = ["openrouter-images", "openai-images", "gemini-images", "xai-images", "dashscope-images"] as const;
export type ManagedModelType = (typeof MODEL_TYPES)[number];
export type ImageApiName = (typeof IMAGE_API_NAMES)[number];
export type ModelIdentity = `${string}\u0000${ManagedModelType}\u0000${string}`;

export type AuthMode = "models-json" | "reuse-pi" | "anonymous";
export type DiscoveryAuthMode = AuthMode | "temporary";
export type ThinkingMetadataSource = "existing" | "remote" | "catalog" | "directory" | "protocol" | "user"
  /** @deprecated Retained only for legacy model-config.json round-trip compatibility. */
  | "probed";
export type ThinkingLevelMap = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
export type ModelMetadataSource = "existing" | "remote" | "catalog" | "directory" | "user" | "compat"
  /** @deprecated Retained only for legacy model-config.json round-trip compatibility. */
  | "probed";

export interface ModelMetadataEntry {
  type: ManagedModelType;
  id: string;
  contextSource?: ModelMetadataSource;
  maxTokensSource?: ModelMetadataSource;
  verifiedAt?: string;
  /** @deprecated Retained only for legacy model-config.json round-trip compatibility. */
  probeLower?: number;
  /** @deprecated Retained only for legacy model-config.json round-trip compatibility. */
  probeUpper?: number;
  /** @deprecated Retained only for legacy model-config.json round-trip compatibility. */
  probeEstimated?: boolean;
  thinkingSource?: ThinkingMetadataSource;
  directoryFields?: string[];
  directoryMatchMethod?: "exact" | "canonical" | "variant";
}

export type DiscoveryAuthHeader = "auto" | "bearer" | "x-api-key" | "api-key" | "x-goog-api-key" | "anthropic" | "none";

export interface ManagedModelBase {
  id: string;
  name: string;
  api: string;
  baseUrl?: string;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  headers?: Record<string, string>;
}

export interface ManagedChatModel extends ManagedModelBase {
  type: "chat";
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  contextWindow: number;
  maxTokens: number;
}

export interface ManagedClassifierModel extends ManagedModelBase {
  type: "classifier";
  contextWindow: number;
}

export interface ManagedImageModel extends ManagedModelBase {
  type: "image";
  output: ("text" | "image")[];
}

export type ManagedModel = ManagedChatModel | ManagedClassifierModel | ManagedImageModel;

export interface ProviderConnectionConfig {
  name?: string;
  owned?: boolean;
  enabled?: boolean;
  discoveryUrl?: string;
  authMode: AuthMode;
  discoveryAuthHeader?: DiscoveryAuthHeader;
  proxyUrl?: string;
  chatApi?: string;
  classifierApi?: string;
  imageApi?: ImageApiName;
  defaultType?: ManagedModelType;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  managedChatIds?: string[];
  /** Remote catalog keys (`type\0id`) hidden by the user; retained across discovery refreshes. */
  hiddenRemoteIds?: string[];
  models?: Array<ManagedClassifierModel | ManagedImageModel>;
  modelMetadata?: ModelMetadataEntry[];
}

export interface ModelConfigFile {
  $schema?: string;
  version: 1;
  providers: Record<string, ProviderConnectionConfig>;
  [key: string]: unknown;
}

export interface ModelsJsonProvider {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ModelsJsonFile {
  $schema?: string;
  providers: Record<string, ModelsJsonProvider>;
  [key: string]: unknown;
}

export interface ProviderDraft {
  id: string;
  name: string;
  owned: boolean;
  enabled: boolean;
  baseUrl?: string;
  discoveryUrl?: string;
  authMode: DiscoveryAuthMode;
  authHeader: DiscoveryAuthHeader;
  apiKeyRaw?: string;
  temporaryKey?: string;
  proxyUrl?: string;
  chatApi: string;
  classifierApi: string;
  imageApi: ImageApiName;
  defaultType: ManagedModelType;
  hiddenRemoteIds?: string[];
}

export type CandidateModel = ManagedModel & {
  source: "managed" | "external" | "installed" | "remote";
  mutableType: boolean;
  /** Read-only entries are visible but cannot be toggled: only runtime catalog rows. */
  readOnly?: boolean;
  readOnlyReason?: "runtime-catalog";
  contextSource?: ModelMetadataSource;
  maxTokensSource?: ModelMetadataSource;
  thinkingSource?: ThinkingMetadataSource;
  directoryFields?: string[];
  directoryMatchMethod?: "exact" | "canonical" | "variant";
};

export interface SelectionResult {
  action: "preview" | "complete" | "completeBatch" | "edit" | "back" | "language";
  cancelled: boolean;
  selected: ManagedModel[];
  metadata: ModelMetadataEntry[];
  completionTargets?: CandidateModel[];
  target?: Pick<CandidateModel, "id" | "type" | "source" | "readOnlyReason">;
}

export interface ConfigSnapshot {
  path: string;
  exists: boolean;
  text?: string;
}

/** Persistent remote-hide identity. Legacy id-only entries are interpreted as chat-only on read. */
export function hiddenRemoteKey(model: Pick<ManagedModel, "id" | "type">): string { return `${model.type}\u0000${model.id}`; }

export function isHiddenRemote(model: Pick<ManagedModel, "id" | "type">, hiddenKeys: readonly string[]): boolean {
  const key = hiddenRemoteKey(model);
  // Compatibility: prior releases stored bare IDs; treating those as chat-only prevents
  // a legacy hidden chat model from also hiding classifier/image models with the same ID.
  return hiddenKeys.includes(key) || model.type === "chat" && hiddenKeys.includes(model.id);
}

export function normalizeHiddenRemoteKeys(hiddenKeys: readonly string[]): string[] {
  return [...new Set(hiddenKeys.map((key) => key.includes("\u0000") ? key : hiddenRemoteKey({ type: "chat", id: key })))].sort((a, b) => a.localeCompare(b));
}

export function identityOf(model: Pick<ManagedModel, "id" | "type"> & { provider?: string }, provider?: string): ModelIdentity {
  const p = provider ?? model.provider ?? "";
  return `${p}\u0000${model.type}\u0000${model.id}`;
}

export function modelTypeOf(model: AnyModel | Record<string, unknown>): ManagedModelType {
  return model.type === "classifier" || model.type === "image" ? model.type : "chat";
}
