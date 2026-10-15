import type { AnyModel } from "@earendil-works/pi-ai";

export const MODEL_TYPES = ["chat", "classifier", "image"] as const;
export type ManagedModelType = (typeof MODEL_TYPES)[number];
export type ModelIdentity = `${string}\u0000${ManagedModelType}\u0000${string}`;

export type AuthMode = "models-json" | "reuse-pi" | "anonymous";
export type DiscoveryAuthMode = AuthMode | "temporary";
export type ThinkingMetadataSource = "existing" | "remote" | "catalog" | "protocol" | "user" | "probed";
export type ThinkingLevelMap = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
export type ModelMetadataSource = "existing" | "remote" | "catalog" | "user" | "compat" | "probed";

export interface ModelMetadataEntry {
  type: ManagedModelType;
  id: string;
  contextSource?: ModelMetadataSource;
  maxTokensSource?: ModelMetadataSource;
  verifiedAt?: string;
  probeLower?: number;
  probeUpper?: number;
  probeEstimated?: boolean;
  thinkingSource?: ThinkingMetadataSource;
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
  imageApi?: string;
  defaultType?: ManagedModelType;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  managedChatIds?: string[];
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
  imageApi: string;
  defaultType: ManagedModelType;
}

export type CandidateModel = ManagedModel & {
  source: "managed" | "external" | "installed" | "remote";
  mutableType: boolean;
  /** Read-only entries are visible but cannot be toggled until an explicit supported ownership action. */
  readOnly?: boolean;
  readOnlyReason?: "external-config" | "runtime-catalog";
  contextSource?: ModelMetadataSource;
  maxTokensSource?: ModelMetadataSource;
  thinkingSource?: ThinkingMetadataSource;
};

export interface SelectionResult {
  action: "preview" | "fetch" | "edit" | "probe" | "probeThinking" | "back" | "language";
  cancelled: boolean;
  selected: ManagedModel[];
  metadata: ModelMetadataEntry[];
  target?: Pick<CandidateModel, "id" | "type" | "source" | "readOnlyReason">;
}

export interface ConfigSnapshot {
  path: string;
  exists: boolean;
  text?: string;
}

export function identityOf(model: Pick<ManagedModel, "id" | "type"> & { provider?: string }, provider?: string): ModelIdentity {
  const p = provider ?? model.provider ?? "";
  return `${p}\u0000${model.type}\u0000${model.id}`;
}

export function modelTypeOf(model: AnyModel | Record<string, unknown>): ManagedModelType {
  return model.type === "classifier" || model.type === "image" ? model.type : "chat";
}
