import { join } from "node:path";
import type { AnyModel } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  authDescription,
  readConfigFiles,
  redactUrl,
  sanitizeError,
  validateHttpUrl,
  validateProviderId,
  writeConfigTransaction,
} from "./config.ts";
import { buildDiscoveryCandidates, discoverModelsFromCandidates } from "./discovery.ts";
import { formatError, mcError, t, type UiLanguage } from "./i18n.ts";
import {
  showConnectionPanel,
  showPreviewPanel,
  showProviderPanel,
  showConfirmationPanel,
  type MenuPanelState,
  type OverviewPanelState,
  type PanelItem,
} from "./panel.ts";
import { candidateFromExternal, candidateFromInstalled, candidateFromManaged, mergeCandidates, selectModels, type ModelPanelState } from "./selector.ts";
import { CHAT_APIS, CLASSIFIER_APIS, IMAGE_APIS, PROXY_CHAT_APIS } from "./transport.ts";
import { resolveImageBaseUrl } from "./image-apis/common.ts";
import { SELF_IMAGE_APIS } from "./image-apis/index.ts";
import type {
  CandidateModel,
  ManagedModel,
  ModelConfigFile,
  ModelMetadataEntry,
  ModelsJsonFile,
  ModelsJsonProvider,
  ProviderConnectionConfig,
  ProviderDraft,
} from "./types.ts";
import { identityOf } from "./types.ts";
import { loadUiLanguage, saveUiLanguage } from "./ui-config.ts";
import { secretInput, withCancellableLoader } from "./ui.ts";
import { showModelTestFlow } from "./model-test.ts";
import { showContextProbeFlow } from "./context-probe.ts";
import { editModelParameters } from "./model-editor.ts";
import { acceptedThinkingMap, resolveThinkingMap, showThinkingProbeFlow } from "./thinking-probe.ts";
import { defaultChatThinking, protocolThinkingMap } from "./thinking-defaults.ts";


export interface StartupIssue {
  providerId?: string;
  error: unknown;
}

function displayError(language: UiLanguage, error: unknown, secrets: Array<string | undefined> = []): string {
  return formatError(language, error, sanitizeError(error, secrets));
}

async function confirmAction(
  ctx: ExtensionCommandContext,
  language: UiLanguage,
  title: string,
  summary: string[],
  details: string[],
  confirmLabel: string,
  severity: "warning" | "error" = "warning",
): Promise<boolean> {
  const result = await showConfirmationPanel(ctx, {
    title,
    summary,
    details,
    severity,
    defaultActionIndex: 0,
    cancelActionId: "cancel",
    actions: [
      { id: "cancel", label: t(language, "confirmCancel") },
      { id: "confirm", label: confirmLabel, shortcut: "ctrl+s", severity },
    ],
  });
  return result === "confirm";
}

function authModeLabel(language: UiLanguage, draft: ProviderDraft): string {
  if (draft.authMode === "models-json") {
    const envReference = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/u.test(draft.apiKeyRaw ?? "");
    return t(language, envReference ? "authEnvOption" : "authLiteralOption");
  }
  return draft.authMode === "reuse-pi" ? t(language, "authReuseOption")
    : draft.authMode === "temporary" ? t(language, "authTemporaryOption") : t(language, "authAnonymousOption");
}

function discoveryAuthLabel(language: UiLanguage, value: ProviderDraft["authHeader"]): string {
  const key = value === "auto" ? "authHeaderAuto"
    : value === "bearer" ? "authHeaderBearer"
      : value === "x-api-key" ? "authHeaderXApiKey"
        : value === "api-key" ? "authHeaderApiKey"
          : value === "x-goog-api-key" ? "authHeaderGoogle"
            : value === "anthropic" ? "authHeaderAnthropic" : "authHeaderNone";
  return t(language, key);
}

function modelTypeLabel(language: UiLanguage, type: ManagedModel["type"]): string {
  return type === "classifier" ? t(language, "selectorTypeClassifier")
    : type === "image" ? t(language, "selectorTypeImage")
      : t(language, "selectorTypeChat");
}

function imageApiLabel(language: UiLanguage, api: string): string {
  const key = api === "openai-images" ? "imageApiOpenai"
    : api === "gemini-images" ? "imageApiGemini"
      : api === "xai-images" ? "imageApiXai"
        : api === "dashscope-images" ? "imageApiDashscope" : "imageApiOpenrouter";
  return `${t(language, key)} (${api})`;
}

export function parseManagedChat(raw: Record<string, unknown>, provider: ModelsJsonProvider, config: ProviderConnectionConfig, applyDefaults = false): ManagedModel | undefined {
  if (typeof raw.id !== "string") return undefined;
  const api = typeof raw.api === "string" ? raw.api : (provider.api ?? config.chatApi ?? "openai-completions");
  const observedMap = typeof raw.thinkingLevelMap === "object" && raw.thinkingLevelMap && !Array.isArray(raw.thinkingLevelMap)
    ? raw.thinkingLevelMap as any
    : undefined;
  const resolvedThinking = applyDefaults
    ? defaultChatThinking(api, { reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined, thinkingLevelMap: observedMap }, "existing")
    : { reasoning: raw.reasoning === true, ...(observedMap !== undefined ? { thinkingLevelMap: observedMap } : {}) };
  const thinking = {
    reasoning: resolvedThinking.reasoning,
    ...(resolvedThinking.thinkingLevelMap !== undefined ? { thinkingLevelMap: resolvedThinking.thinkingLevelMap } : {}),
  };
  return {
    type: "chat",
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    api,
    ...(typeof raw.baseUrl === "string" ? { baseUrl: raw.baseUrl } : provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...thinking,
    input: Array.isArray(raw.input) ? raw.input.filter((v): v is "text" | "image" => v === "text" || v === "image") : ["text"],
    cost: typeof raw.cost === "object" && raw.cost ? raw.cost as ManagedModel["cost"] : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : 128_000,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : 16_384,
    ...(typeof raw.headers === "object" && raw.headers ? { headers: raw.headers as Record<string, string> } : {}),
  };
}

function draftFrom(providerId: string, provider: ModelsJsonProvider | undefined, config: ProviderConnectionConfig | undefined, isNew: boolean): ProviderDraft {
  const apiKeyRaw = provider?.apiKey;
  return {
    id: providerId,
    name: config?.name ?? provider?.name ?? providerId,
    owned: config?.owned ?? isNew,
    enabled: config?.enabled !== false,
    baseUrl: provider?.baseUrl,
    discoveryUrl: config?.discoveryUrl,
    authMode: config?.authMode ?? (apiKeyRaw ? "models-json" : isNew ? "anonymous" : "reuse-pi"),
    authHeader: config?.discoveryAuthHeader ?? "auto",
    apiKeyRaw,
    proxyUrl: config?.proxyUrl,
    chatApi: config?.chatApi ?? provider?.api ?? "openai-completions",
    classifierApi: config?.classifierApi ?? "typesafe-system-one",
    imageApi: config?.imageApi ?? "openrouter-images",
    defaultType: config?.defaultType ?? "chat",
  };
}

async function inputPositiveInteger(ctx: ExtensionCommandContext, language: UiLanguage, title: string, current: number): Promise<number> {
  const value = await ctx.ui.input(title, String(current));
  if (value === undefined || value.trim() === "") return current;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw mcError("MCFG_E_POSITIVE_INTEGER");
  return number;
}

async function editUrl(
  ctx: ExtensionCommandContext,
  language: UiLanguage,
  label: string,
  current: string | undefined,
  kind: "base" | "discovery" | "proxy",
): Promise<string | undefined> {
  const set = t(language, kind === "discovery" ? "discoveryUrlSet" : kind === "proxy" ? "proxySet" : "urlSet");
  const clear = t(language, kind === "discovery" ? "discoveryUrlClear" : kind === "proxy" ? "proxyDisable" : "urlRestore");
  const back = t(language, "back");
  const currentValue = current ? redactUrl(current, language) : kind === "base" ? t(language, "valueDefault") : kind === "proxy" ? t(language, "valueProxyDisabled") : t(language, "valueUnset");
  const action = await ctx.ui.select(`${label}: ${currentValue}`, [set, clear, back]);
  if (!action || action === back) return current;
  if (action === clear) return undefined;
  const value = await ctx.ui.input(label, current ?? "https://example.com/v1");
  if (value === undefined || !value.trim()) return current;
  return validateHttpUrl(value, label);
}

async function configureAuth(ctx: ExtensionCommandContext, language: UiLanguage, draft: ProviderDraft, allowTemporary: boolean): Promise<void> {
  const literal = t(language, "authLiteralOption");
  const env = t(language, "authEnvOption");
  const reuse = t(language, "authReuseOption");
  const temporary = t(language, "authTemporaryOption");
  const anonymous = t(language, "authAnonymousOption");
  const cancel = t(language, "mainCancel");
  const options = [literal, env, reuse, ...(allowTemporary ? [temporary] : []), anonymous, cancel];
  const choice = await ctx.ui.select(t(language, "authTitle"), options);
  if (!choice || choice === cancel) return;
  if (choice === literal) {
    const secret = await secretInput(ctx, language, t(language, "secretApiKey"));
    if (secret === undefined) return;
    if (!secret) throw mcError("MCFG_E_KEY_EMPTY");
    if (/^\[(?:已掩码|masked)\]$/iu.test(secret)) throw mcError("MCFG_E_KEY_MASKED");
    draft.apiKeyRaw = secret.startsWith("$") ? `$${secret}` : secret.startsWith("!") ? `$${secret}` : secret;
    draft.temporaryKey = undefined;
    draft.authMode = "models-json";
  } else if (choice === env) {
    const name = await ctx.ui.input(t(language, "envName"), "PROVIDER_API_KEY");
    if (name === undefined) return;
    const normalized = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) throw mcError("MCFG_E_ENV_NAME");
    draft.apiKeyRaw = `$${normalized}`;
    draft.temporaryKey = undefined;
    draft.authMode = "models-json";
  } else if (choice === reuse) {
    draft.apiKeyRaw = undefined;
    draft.temporaryKey = undefined;
    draft.authMode = "reuse-pi";
  } else if (choice === temporary) {
    const secret = await secretInput(ctx, language, t(language, "secretTemporary"));
    if (secret === undefined) return;
    if (!secret) throw mcError("MCFG_E_KEY_EMPTY");
    draft.temporaryKey = secret;
    draft.authMode = "temporary";
  } else {
    draft.apiKeyRaw = undefined;
    draft.temporaryKey = undefined;
    draft.authMode = "anonymous";
    draft.authHeader = "none";
  }
}

function connectionPanelFields(language: UiLanguage, draft: ProviderDraft): PanelItem[] {
  return [
    { id: "name", label: t(language, "fieldName", { value: draft.name }), details: [t(language, "panelDescName")] },
    { id: "id", label: t(language, "fieldId", { value: draft.id }), details: [t(language, "panelDescId")] },
    { id: "ownership", label: t(language, "fieldOwnership", { value: t(language, draft.owned ? "owned" : "externalOwned") }), details: [t(language, "panelDescOwnership")] },
    { id: "baseUrl", label: t(language, "fieldBaseUrl", { value: draft.baseUrl ? redactUrl(draft.baseUrl, language) : t(language, "valueDefault") }), details: [t(language, "panelDescBaseUrl")] },
    { id: "discoveryUrl", label: t(language, "fieldDiscoveryUrl", { value: draft.discoveryUrl ? redactUrl(draft.discoveryUrl, language) : t(language, "valueUnset") }), details: [t(language, "panelDescDiscoveryUrl")] },
    { id: "auth", label: t(language, "fieldAuth", { value: authModeLabel(language, draft) }), details: [t(language, "panelDescAuth")] },
    { id: "discoveryAuth", label: t(language, "fieldDiscoveryAuth", { value: discoveryAuthLabel(language, draft.authHeader) }), details: [t(language, "panelDescDiscoveryAuth")] },
    { id: "proxy", label: t(language, "fieldProxy", { value: draft.proxyUrl ? redactUrl(draft.proxyUrl, language) : t(language, "valueProxyDisabled") }), details: [t(language, "panelDescProxy")] },
    { id: "defaultType", label: t(language, "fieldDefaultType", { value: modelTypeLabel(language, draft.defaultType) }), details: [t(language, "panelDescDefaultType")] },
    { id: "chatApi", label: t(language, "fieldChatApi", { value: draft.chatApi }), details: [t(language, "panelDescChatApi")] },
    { id: "classifierApi", label: t(language, "fieldClassifierApi", { value: draft.classifierApi }), details: [t(language, "panelDescClassifierApi")] },
    { id: "imageApi", label: t(language, "fieldImageApi", { value: draft.imageApi }), details: [t(language, "panelDescImageApi")] },
  ];
}

async function editConnectionPanel(ctx: ExtensionCommandContext, language: UiLanguage, draft: ProviderDraft, state: MenuPanelState, canTakeover: boolean): Promise<"models" | "takeover" | "testModels" | "preview" | "back"> {
  while (true) {
    const result = await showConnectionPanel(ctx, language, draft.id, connectionPanelFields(language, draft), state, canTakeover);
    if (result.action !== "field") return result.action;
    try {
      switch (result.fieldId) {
        case "name": {
          const value = await ctx.ui.input(t(language, "providerDisplayName"), draft.name);
          if (value?.trim()) draft.name = value.trim();
          break;
        }
        case "id": ctx.ui.notify(t(language, "fieldIdReadonly"), "info"); break;
        case "ownership": {
          const next = !draft.owned;
          if (next && await confirmAction(ctx, language, t(language, "takeoverTitle"), [t(language, "takeoverBody")], [], t(language, "confirmTakeover"))) draft.owned = true;
          if (!next) draft.owned = false;
          break;
        }
        case "baseUrl": draft.baseUrl = await editUrl(ctx, language, t(language, "baseUrl"), draft.baseUrl, "base"); break;
        case "discoveryUrl": draft.discoveryUrl = await editUrl(ctx, language, t(language, "discoveryUrl"), draft.discoveryUrl, "discovery"); break;
        case "auth": await configureAuth(ctx, language, draft, true); break;
        case "discoveryAuth": {
          const choices = (["auto", "bearer", "x-api-key", "api-key", "x-goog-api-key", "anthropic", "none"] as const)
            .map((mode) => ({ mode, label: discoveryAuthLabel(language, mode) }));
          const value = await ctx.ui.select(t(language, "discoveryAuthTitle"), choices.map((choice) => choice.label));
          const selected = choices.find((choice) => choice.label === value);
          if (selected) draft.authHeader = selected.mode;
          break;
        }
        case "proxy": draft.proxyUrl = await editUrl(ctx, language, t(language, "proxyUrl"), draft.proxyUrl, "proxy"); break;
        case "defaultType": {
          const choices = (["chat", "classifier", "image"] as const).map((type) => ({ type, label: modelTypeLabel(language, type) }));
          const value = await ctx.ui.select(t(language, "defaultTypeTitle"), choices.map((item) => item.label));
          const selected = choices.find((item) => item.label === value);
          if (selected) draft.defaultType = selected.type;
          break;
        }
        case "chatApi": {
          const value = await ctx.ui.select("Chat API", [...CHAT_APIS]);
          if (value) draft.chatApi = value;
          break;
        }
        case "classifierApi": {
          const value = await ctx.ui.select("Classifier API", [...CLASSIFIER_APIS]);
          if (value) draft.classifierApi = value;
          break;
        }
        case "imageApi": {
          const choices = [...IMAGE_APIS].map((api) => ({ api, label: imageApiLabel(language, api) }));
          const value = await ctx.ui.select("Image API", choices.map((choice) => choice.label));
          const selected = choices.find((choice) => choice.label === value);
          if (selected) draft.imageApi = selected.api;
          break;
        }
      }
    } catch (error) {
      ctx.ui.notify(displayError(language, error, [draft.apiKeyRaw, draft.temporaryKey]), "error");
    }
  }
}

function installedModels(ctx: ExtensionCommandContext, providerId: string): AnyModel[] {
  return [
    ...ctx.modelRegistry.getModelsOfType("chat", providerId),
    ...ctx.modelRegistry.getModelsOfType("classifier", providerId),
    ...ctx.modelRegistry.getModelsOfType("image", providerId),
  ];
}

function previousManaged(provider: ModelsJsonProvider | undefined, config: ProviderConnectionConfig | undefined): ManagedModel[] {
  if (!provider || !config) return config?.models ? structuredClone(config.models) : [];
  const ids = new Set(config.managedChatIds ?? []);
  const chat = (provider.models ?? [])
    .filter((raw) => typeof raw.id === "string" && ids.has(raw.id))
    .map((raw) => parseManagedChat(raw, provider, config))
    .filter((model): model is ManagedModel => model !== undefined);
  return [...chat, ...structuredClone(config.models ?? [])];
}

function validateSelection(
  draft: ProviderDraft,
  selected: ManagedModel[],
  installed: AnyModel[],
  existingProvider: ModelsJsonProvider | undefined,
): void {
  if (draft.baseUrl) validateHttpUrl(draft.baseUrl, "Base URL");
  if (draft.discoveryUrl) validateHttpUrl(draft.discoveryUrl, "Discovery URL");
  if (draft.proxyUrl) validateHttpUrl(draft.proxyUrl, "Provider proxy URL");
  if (draft.owned) {
    const missingExistingUrl = (existingProvider?.models ?? []).some((model) => typeof model.baseUrl !== "string" && !draft.baseUrl);
    const effectiveModelUrl = (model: ManagedModel) => model.type === "image"
      ? resolveImageBaseUrl(model.api, model.baseUrl, draft.baseUrl)
      : model.baseUrl ?? draft.baseUrl;
    const missingSelectedUrl = selected.some((model) => !effectiveModelUrl(model));
    if (missingExistingUrl || missingSelectedUrl) throw mcError("MCFG_E_BASE_URL_REQUIRED");
    for (const model of existingProvider?.models ?? []) validateHttpUrl(String(model.baseUrl ?? draft.baseUrl), `${draft.id}/${String(model.id)} Base URL`);
    for (const model of selected) validateHttpUrl(effectiveModelUrl(model)!, `${draft.id}/${model.id} Base URL`);
  }
  if (!draft.owned && selected.some((model) => model.type !== "chat")) throw mcError("MCFG_E_NOT_OWNED", { provider: draft.id });
  if (!draft.owned && (draft.proxyUrl || draft.authMode === "anonymous") && !new Set<string>(getBuiltinProviders()).has(draft.id)) {
    throw mcError("MCFG_E_EXTERNAL_TRANSPORT");
  }
  const existingChatApis = new Set([
    ...installed.filter((model) => model.type !== "classifier" && model.type !== "image").map((model) => model.api),
    ...(existingProvider?.models ?? []).map((model) => typeof model.api === "string" ? model.api : (existingProvider?.api ?? draft.chatApi)),
  ]);
  if (draft.proxyUrl) {
    const unsupported = [...existingChatApis].filter((api) => !PROXY_CHAT_APIS.has(api));
    if (unsupported.length) throw mcError("MCFG_E_PROXY_UNSUPPORTED", { identity: `${draft.id}: ${unsupported.join(", ")}` });
  }
  if (draft.authMode === "anonymous") {
    const unsupported = [...existingChatApis].filter((api) => ["pi-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex"].includes(api));
    if (unsupported.length) throw mcError("MCFG_E_ANONYMOUS_UNSUPPORTED", { identity: `${draft.id}: ${unsupported.join(", ")}` });
  }
  for (const model of selected) {
    const supported = model.type === "chat" ? CHAT_APIS : model.type === "classifier" ? CLASSIFIER_APIS : IMAGE_APIS;
    if (!supported.has(model.api)) throw mcError("MCFG_E_UNSUPPORTED_API", { identity: `${draft.id}/${model.type}/${model.id}`, api: model.api });
    if (draft.proxyUrl && model.type === "chat" && !PROXY_CHAT_APIS.has(model.api)) throw mcError("MCFG_E_PROXY_UNSUPPORTED", { identity: `${draft.id}/${model.type}/${model.id}` });
    if (draft.authMode === "anonymous" && (["pi-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex"].includes(model.api)
      || model.type === "image" && SELF_IMAGE_APIS.has(model.api))) {
      throw mcError("MCFG_E_ANONYMOUS_UNSUPPORTED", { identity: `${draft.id}/${model.type}/${model.id}` });
    }
  }
  if (draft.authMode === "models-json" && !draft.apiKeyRaw) throw mcError("MCFG_E_AUTH_REQUIRED");
  if (draft.authMode === "models-json" && /^\[(?:已掩码|masked)\]$/iu.test(draft.apiKeyRaw ?? "")) throw mcError("MCFG_E_KEY_MASKED");
}

function chatToJson(model: ManagedModel): Record<string, unknown> {
  if (model.type !== "chat") throw mcError("MCFG_E_INTERNAL_CHAT_ONLY");
  const { type: _type, ...value } = model;
  return value;
}

export function removeProvider(
  files: { models: ModelsJsonFile; config: ModelConfigFile },
  providerId: string,
): { models: ModelsJsonFile; config: ModelConfigFile } {
  const models = structuredClone(files.models);
  const config = structuredClone(files.config);
  delete models.providers[providerId];
  delete config.providers[providerId];
  return { models, config };
}

export function applyChanges(
  files: { models: ModelsJsonFile; config: ModelConfigFile },
  providerId: string,
  draft: ProviderDraft,
  selected: ManagedModel[],
  adoptedChatIds: ReadonlySet<string> = new Set(),
  modelMetadata: ModelMetadataEntry[] = [],
): { models: ModelsJsonFile; config: ModelConfigFile } {
  const models = structuredClone(files.models);
  const config = structuredClone(files.config);
  const oldConfig = config.providers[providerId];
  const oldProvider = models.providers[providerId] ?? {};
  const provider = structuredClone(oldProvider);
  const oldManagedIds = new Set(oldConfig?.managedChatIds ?? []);
  const originalRows = new Map(
    (oldProvider.models ?? []).filter((row) => typeof row.id === "string").map((row) => [row.id as string, row]),
  );
  const managedScopeIds = new Set([...oldManagedIds, ...adoptedChatIds]);
  const unmanagedRows = (oldProvider.models ?? []).filter((row) => typeof row.id !== "string" || !managedScopeIds.has(row.id));
  const selectedChat = selected.filter((model) => model.type === "chat");
  provider.models = [...unmanagedRows, ...selectedChat.map((model) => ({
    ...structuredClone(originalRows.get(model.id) ?? {}),
    ...chatToJson(model),
  }))];
  if (draft.name) provider.name = draft.name;
  if (draft.baseUrl) provider.baseUrl = draft.baseUrl; else delete provider.baseUrl;
  if (draft.owned) provider.api = draft.chatApi;
  if (draft.authMode === "models-json") provider.apiKey = draft.apiKeyRaw; else delete provider.apiKey;
  models.providers[providerId] = provider;

  config.providers[providerId] = {
    ...(oldConfig ?? {}),
    name: draft.name,
    owned: draft.owned,
    enabled: draft.enabled,
    authMode: draft.authMode as "models-json" | "reuse-pi" | "anonymous",
    discoveryAuthHeader: draft.authHeader,
    chatApi: draft.chatApi,
    classifierApi: draft.classifierApi,
    imageApi: draft.imageApi,
    defaultType: draft.defaultType,
    managedChatIds: selectedChat.map((model) => model.id),
    models: selected.filter((model): model is Extract<ManagedModel, { type: "classifier" | "image" }> => model.type !== "chat"),
    modelMetadata: modelMetadata.map((entry) => structuredClone(entry)),
  };
  if (draft.discoveryUrl) config.providers[providerId]!.discoveryUrl = draft.discoveryUrl; else delete config.providers[providerId]!.discoveryUrl;
  if (draft.proxyUrl) config.providers[providerId]!.proxyUrl = draft.proxyUrl; else delete config.providers[providerId]!.proxyUrl;
  return { models, config };
}

function buildPreviewDetails(
  language: UiLanguage,
  providerId: string,
  before: ManagedModel[],
  after: ManagedModel[],
  oldConfig: ProviderConnectionConfig | undefined,
  oldProvider: ModelsJsonProvider | undefined,
  draft: ProviderDraft,
): { providerDetails: string[]; modelDetails: string[] } {
  const oldMap = new Map(before.map((model) => [identityOf(model, providerId), model]));
  const newMap = new Map(after.map((model) => [identityOf(model, providerId), model]));
  const added = [...newMap.keys()].filter((key) => !oldMap.has(key));
  const deleted = [...oldMap.keys()].filter((key) => !newMap.has(key));
  const retained = [...newMap.keys()].filter((key) => oldMap.has(key));
  const modified = retained.filter((key) => JSON.stringify(oldMap.get(key)) !== JSON.stringify(newMap.get(key)));
  const unchanged = retained.length - modified.length;
  const oldConnection = [
    `name=${oldConfig?.name ?? oldProvider?.name ?? providerId}`,
    `owned=${oldConfig?.owned ?? false}`,
    `enabled=${oldConfig?.enabled !== false}`,
    `base=${redactUrl(oldProvider?.baseUrl, language)}`,
    `discovery=${redactUrl(oldConfig?.discoveryUrl, language)}`,
    `auth=${authDescription(language, oldConfig, oldProvider)}`,
    `discoveryAuth=${oldConfig?.discoveryAuthHeader ?? "auto"}`,
    `proxy=${redactUrl(oldConfig?.proxyUrl, language)}`,
    `apis=${oldConfig?.chatApi ?? oldProvider?.api ?? "openai-completions"}/${oldConfig?.classifierApi ?? "typesafe-system-one"}/${oldConfig?.imageApi ?? "openrouter-images"}`,
    `defaults=${oldConfig?.defaultType ?? "chat"},${oldConfig?.defaultContextWindow ?? "legacy-unset"},${oldConfig?.defaultMaxTokens ?? "legacy-unset"}`,
  ].join(" | ");
  const isEnvReference = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/u.test(draft.apiKeyRaw ?? "");
  const newAuth = draft.authMode === "models-json"
    ? isEnvReference ? t(language, "valueEnv", { value: draft.apiKeyRaw! }) : t(language, "valueLiteralMasked")
    : draft.authMode === "reuse-pi" ? t(language, "valueReuseAuth") : t(language, "valueAnonymous");
  const nextConnection = [
    `name=${draft.name}`,
    `owned=${draft.owned}`,
    `enabled=${draft.enabled}`,
    `base=${redactUrl(draft.baseUrl, language)}`,
    `discovery=${redactUrl(draft.discoveryUrl, language)}`,
    `auth=${newAuth}`,
    `discoveryAuth=${draft.authHeader}`,
    `proxy=${redactUrl(draft.proxyUrl, language)}`,
    `apis=${draft.chatApi}/${draft.classifierApi}/${draft.imageApi}`,
    `defaults=${draft.defaultType},legacy-fallback-not-applied`,
  ].join(" | ");
  const describe = (key: ReturnType<typeof identityOf>) => {
    const model = newMap.get(key) ?? oldMap.get(key)!;
    return `${modelTypeLabel(language, model.type)}/${model.id}`;
  };
  const settingsChanged = oldConnection !== nextConnection;
  const keyWillUpdate = draft.authMode === "models-json" && oldProvider?.apiKey !== draft.apiKeyRaw;
  return {
    providerDetails: [
      settingsChanged ? t(language, "previewSettingsChanged") : t(language, "previewSettingsUnchanged"),
      ...(settingsChanged ? [t(language, "diffConnection", { before: oldConnection, after: nextConnection })] : []),
      ...(keyWillUpdate ? [t(language, "previewKeyUpdated")] : []),
    ],
    modelDetails: [
      ...(added.length ? [t(language, "previewModelsAdded", { items: added.map(describe).join(", ") })] : []),
      ...(deleted.length ? [t(language, "previewModelsRemoved", { items: deleted.map(describe).join(", ") })] : []),
      ...(modified.length ? [t(language, "previewModelsModified", { items: modified.map(describe).join(", ") })] : []),
      t(language, "previewModelsUnchanged", { count: unchanged }),
      t(language, "diffSafety"),
    ],
  };
}

export interface ProviderChoice {
  id: string;
  label: string;
  priority: number;
}

export function buildConfiguredProviderChoices(
  language: UiLanguage,
  builtinProviderIds: ReadonlySet<string>,
  models: ModelsJsonFile,
  config: ModelConfigFile,
): ProviderChoice[] {
  const ids = new Set([...Object.keys(models.providers), ...Object.keys(config.providers)]);
  const choices: ProviderChoice[] = [];
  for (const id of ids) {
    const owned = config.providers[id]?.owned === true;
    const builtin = builtinProviderIds.has(id);
    const name = config.providers[id]?.name ?? models.providers[id]?.name;
    const displayBase = name && name !== id ? `${name} (${id})` : id;
    const display = config.providers[id]?.enabled === false ? `${displayBase} · ${t(language, "providerDisabled")}` : displayBase;
    const status = t(language, builtin ? "providerTagBuiltin" : "providerTagCustom");
    choices.push(owned
      ? { id, label: t(language, "providerLabelCustom", { display, status }), priority: 0 }
      : builtin
        ? { id, label: t(language, "providerLabelBuiltin", { display, status }), priority: 1 }
        : { id, label: t(language, "providerLabelCustom", { display, status }), priority: 2 });
  }
  return choices.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function buildProviderPanelItems(
  ctx: ExtensionCommandContext,
  language: UiLanguage,
  models: ModelsJsonFile,
  config: ModelConfigFile,
): PanelItem[] {
  const builtinIds = new Set<string>(getBuiltinProviders());
  const choices = buildConfiguredProviderChoices(language, builtinIds, models, config);
  return choices.map((choice) => {
    const provider = models.providers[choice.id];
    const providerConfig = config.providers[choice.id];
    const installed = installedModels(ctx, choice.id);
    const chat = new Set(installed.filter((model) => model.type !== "classifier" && model.type !== "image").map((model) => model.id));
    const classifier = new Set(installed.filter((model) => model.type === "classifier").map((model) => model.id));
    const image = new Set(installed.filter((model) => model.type === "image").map((model) => model.id));
    for (const model of provider?.models ?? []) if (typeof model.id === "string") chat.add(model.id);
    for (const model of providerConfig?.models ?? []) (model.type === "classifier" ? classifier : image).add(model.id);
    const managedChatIds = new Set(providerConfig?.managedChatIds ?? []);
    const takeoverCount = (provider?.models ?? []).filter((model) => typeof model.id === "string" && !managedChatIds.has(model.id)).length;
    const protocols = new Set<string>();
    if (provider?.api) protocols.add(provider.api);
    if (providerConfig?.chatApi) protocols.add(providerConfig.chatApi);
    if (providerConfig?.classifierApi) protocols.add(providerConfig.classifierApi);
    if (providerConfig?.imageApi) protocols.add(providerConfig.imageApi);
    for (const model of provider?.models ?? []) if (typeof model.api === "string") protocols.add(model.api);
    for (const model of providerConfig?.models ?? []) protocols.add(model.api);
    return {
      id: choice.id,
      label: choice.label,
      canTakeoverExisting: takeoverCount > 0,
      enabled: providerConfig?.enabled !== false,
      details: [
        t(language, "panelSummaryName", { value: providerConfig?.name ?? provider?.name ?? choice.id }),
        t(language, "panelSummaryId", { value: choice.id }),
        t(language, "panelSummaryProtocol", { value: [...protocols].join(", ") || t(language, "valueUnset") }),
        t(language, "panelSummaryBaseUrl", { value: provider?.baseUrl ? redactUrl(provider.baseUrl, language) : t(language, "valueDefault") }),
        t(language, "panelSummaryDiscoveryUrl", { value: providerConfig?.discoveryUrl ? redactUrl(providerConfig.discoveryUrl, language) : t(language, "valueUnset") }),
        t(language, "panelSummaryAuth", { value: authDescription(language, providerConfig, provider) }),
        t(language, "panelSummaryProxy", { value: providerConfig?.proxyUrl ? redactUrl(providerConfig.proxyUrl, language) : t(language, "valueProxyDisabled") }),
      ],
      modelDetails: [
        t(language, "panelSummaryModels", { chat: chat.size, classifier: classifier.size, image: image.size }),
        ...(takeoverCount ? [t(language, "panelTakeoverCount", { count: takeoverCount })] : []),
      ],
    };
  });
}

export function buildBuiltinProviderChoices(language: UiLanguage, builtinProviderIds: Iterable<string>): ProviderChoice[] {
  return [...new Set(builtinProviderIds)]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, label: t(language, "providerLabelBuiltin", { display: id, status: t(language, "providerTagBuiltin") }), priority: 0 }));
}

async function chooseBuiltinProvider(ctx: ExtensionCommandContext, language: UiLanguage): Promise<{ id: string; isNew: false } | undefined> {
  const choices = buildBuiltinProviderChoices(language, getBuiltinProviders());
  const labelToId = new Map(choices.map((choice) => [choice.label, choice.id]));
  const back = t(language, "back");
  const selected = await ctx.ui.select(t(language, "newProviderTitle"), [...choices.map((choice) => choice.label), back]);
  if (!selected || selected === back) return undefined;
  const id = labelToId.get(selected);
  return id ? { id, isNew: false } : undefined;
}

async function chooseCustomProvider(
  ctx: ExtensionCommandContext,
  language: UiLanguage,
  runtimeIds: ReadonlySet<string>,
  models: ModelsJsonFile,
  config: ModelConfigFile,
): Promise<{ id: string; isNew: boolean } | undefined> {
  const raw = await ctx.ui.input(t(language, "newProviderId"), "my-provider");
  if (raw === undefined) return undefined;
  const id = validateProviderId(raw);
  const existingIds = new Set([...runtimeIds, ...getBuiltinProviders(), ...Object.keys(models.providers), ...Object.keys(config.providers)]);
  if (existingIds.has(id)) {
    ctx.ui.notify(t(language, "providerExists", { id }), "info");
    return { id, isNew: false };
  }
  return { id, isNew: true };
}

async function chooseLanguage(ctx: ExtensionCommandContext, agentDir: string, current: UiLanguage): Promise<UiLanguage> {
  const zh = t(current, "languageZh");
  const en = t(current, "languageEn");
  const choice = await ctx.ui.select(t(current, "languageTitle"), [zh, en, t(current, "mainCancel")]);
  if (!choice || choice === t(current, "mainCancel")) return current;
  const next: UiLanguage = choice === en ? "en" : "zh-CN";
  saveUiLanguage(agentDir, next);
  ctx.ui.notify(t(next, "languageSaved", { language: t(next, next === "en" ? "languageEn" : "languageZh") }), "info");
  return next;
}

function draftPanelItem(language: UiLanguage, draft: ProviderDraft, selected: ManagedModel[], adoptableCount: number): PanelItem {
  const builtin = new Set<string>(getBuiltinProviders()).has(draft.id);
  const displayBase = draft.name && draft.name !== draft.id ? `${draft.name} (${draft.id})` : draft.id;
  const display = draft.enabled ? displayBase : `${displayBase} · ${t(language, "providerDisabled")}`;
  const chat = selected.filter((model) => model.type === "chat").length;
  const classifier = selected.filter((model) => model.type === "classifier").length;
  const image = selected.filter((model) => model.type === "image").length;
  return {
    id: draft.id,
    label: t(language, builtin ? "providerLabelBuiltin" : "providerLabelCustom", { display, status: t(language, builtin ? "providerTagBuiltin" : "providerTagCustom") }),
    canTakeoverExisting: adoptableCount > 0,
    enabled: draft.enabled,
    details: [
      t(language, "providerEnabledStatus", { value: t(language, draft.enabled ? "providerEnabled" : "providerDisabled") }),
      t(language, "panelSummaryName", { value: draft.name }),
      t(language, "panelSummaryId", { value: draft.id }),
      t(language, "panelSummaryProtocol", { value: [draft.chatApi, draft.classifierApi, draft.imageApi].join(", ") }),
      t(language, "panelSummaryBaseUrl", { value: draft.baseUrl ? redactUrl(draft.baseUrl, language) : t(language, "valueDefault") }),
      t(language, "panelSummaryDiscoveryUrl", { value: draft.discoveryUrl ? redactUrl(draft.discoveryUrl, language) : t(language, "valueUnset") }),
      t(language, "panelSummaryAuth", { value: authModeLabel(language, draft) }),
      t(language, "panelSummaryProxy", { value: draft.proxyUrl ? redactUrl(draft.proxyUrl, language) : t(language, "valueProxyDisabled") }),
    ],
    modelDetails: [
      t(language, "panelSummaryModels", { chat, classifier, image }),
      t(language, "detailFetchHint"),
      ...(adoptableCount ? [t(language, "panelTakeoverCount", { count: adoptableCount })] : []),
    ],
  };
}

async function chooseProviderToAdd(
  ctx: ExtensionCommandContext,
  language: UiLanguage,
  runtimeIds: ReadonlySet<string>,
  models: ModelsJsonFile,
  config: ModelConfigFile,
): Promise<{ id: string; isNew: boolean } | undefined> {
  const builtin = t(language, "addBuiltinChoice");
  const custom = t(language, "addCustomChoice");
  const back = t(language, "back");
  const choice = await ctx.ui.select(t(language, "addProviderTitle"), [builtin, custom, back]);
  if (!choice || choice === back) return undefined;
  return choice === builtin
    ? chooseBuiltinProvider(ctx, language)
    : chooseCustomProvider(ctx, language, runtimeIds, models, config);
}

export function registerModelConfigCommand(pi: ExtensionAPI, startupIssues: StartupIssue[] = []): void {
  pi.registerCommand("model-config", {
    description: t("zh-CN", "commandDescription"),
    handler: async (args, ctx) => {
      const agentDir = getAgentDir();
      let language = loadUiLanguage(agentDir);
      const activeSecrets: Array<string | undefined> = [];
      if (ctx.mode !== "tui") {
        ctx.ui.notify(t(language, "tuiRequired"), "error");
        return;
      }
      try {
        if (args.trim().toLowerCase() === "language") {
          await chooseLanguage(ctx, agentDir, language);
          return;
        }
        let startupIssuesReported = false;
        const overviewState: OverviewPanelState = { search: "", focus: "list", actionIndex: 0, detailScroll: 0 };
        mainLoop: while (true) {
          if (!startupIssuesReported && startupIssues.length) {
            const localized = startupIssues.slice(0, 3).map((issue) => {
              const message = displayError(language, issue.error);
              return issue.providerId ? `${issue.providerId}: ${message}` : message;
            }).join("; ");
            const more = startupIssues.length > 3 ? t(language, "startupMore", { count: startupIssues.length - 3 }) : "";
            ctx.ui.notify(t(language, "startupIssues", { issues: localized, more }), "warning");
            startupIssuesReported = true;
          }

          const modelsPath = join(agentDir, "models.json");
          const configPath = join(agentDir, "model-config.json");
          const files = readConfigFiles(modelsPath, configPath);
          if (files.recoveredTxId) ctx.ui.notify(t(language, "transactionRecovered", { txId: files.recoveredTxId }), "warning");
          const overviewItems = buildProviderPanelItems(ctx, language, files.models, files.config);
          const overview = await showProviderPanel(ctx, language, overviewItems, overviewState);
          if (overview.action === "close") return;
          if (overview.action === "language") {
            language = await chooseLanguage(ctx, agentDir, language);
            continue;
          }

          const runtimeIds = new Set<string>();
          for (const type of ["chat", "classifier", "image"] as const) {
            for (const model of ctx.modelRegistry.getModelsOfType(type)) runtimeIds.add(model.provider);
          }
          if (overview.action === "delete") {
            const providerId = overview.providerId;
            const providerConfig = files.config.providers[providerId];
            const modelsProvider = files.models.providers[providerId];
            const builtin = new Set<string>(getBuiltinProviders()).has(providerId);
            if (ctx.model?.provider === providerId) {
              ctx.ui.notify(t(language, "deleteCurrentModelBlocked"), "warning");
              continue;
            }
            if (!builtin && !providerConfig?.owned && !modelsProvider) {
              ctx.ui.notify(t(language, "deleteThirdPartyBlocked"), "error");
              continue;
            }
            const confirmed = await confirmAction(ctx, language, t(language, "deleteProviderTitle", { provider: providerId }),
              [t(language, "deleteProviderSummary", { provider: providerId })],
              [
                t(language, "deleteProviderModels"),
                t(language, "deleteProviderOverlay"),
                t(language, "deleteProviderAuthRetained"),
                t(language, "deleteProviderOtherExtension"),
                ...(builtin ? [t(language, "deleteProviderBuiltinRestore")] : []),
              ],
              t(language, "confirmDeleteProvider"), "error");
            if (!confirmed) continue;
            try {
              const next = removeProvider(files, providerId);
              const transaction = writeConfigTransaction(files.modelsSnapshot, files.configSnapshot, next.models, next.config);
              ctx.ui.notify(t(language, "deleteProviderSuccess", { provider: providerId, count: transaction.backups.length }), "info");
            } catch (error) {
              ctx.ui.notify(displayError(language, error, activeSecrets), "error");
            }
            continue;
          }
          if (overview.action === "toggle") {
            const providerId = overview.providerId;
            const providerConfig = files.config.providers[providerId];
            const modelsProvider = files.models.providers[providerId];
            const builtin = new Set<string>(getBuiltinProviders()).has(providerId);
            const currentlyEnabled = providerConfig?.enabled !== false;
            if (currentlyEnabled && ctx.model?.provider === providerId) {
              ctx.ui.notify(t(language, "disableCurrentModelBlocked"), "warning");
              continue;
            }
            if (currentlyEnabled && !builtin && !providerConfig?.owned && !modelsProvider) {
              ctx.ui.notify(t(language, "disableThirdPartyBlocked"), "error");
              continue;
            }
            try {
              const nextConfig = structuredClone(files.config);
              nextConfig.providers[providerId] = {
                ...(providerConfig ?? { authMode: modelsProvider?.apiKey ? "models-json" : "reuse-pi" }),
                enabled: !currentlyEnabled,
              };
              const transaction = writeConfigTransaction(files.modelsSnapshot, files.configSnapshot, files.models, nextConfig);
              ctx.ui.notify(t(language, "toggleProviderSuccess", { provider: providerId, count: transaction.backups.length }), "info");
            } catch (error) {
              ctx.ui.notify(displayError(language, error, activeSecrets), "error");
            }
            continue;
          }
          const target = overview.action === "add"
            ? await chooseProviderToAdd(ctx, language, runtimeIds, files.models, files.config)
            : "providerId" in overview
              ? { id: overview.providerId, isNew: false }
              : undefined;
          if (!target) continue;

          const oldProvider = files.models.providers[target.id];
          const oldConfig = files.config.providers[target.id];
          const draft = draftFrom(target.id, oldProvider, oldConfig, target.isNew);
          const baselineDraft = structuredClone(draft);
          const managedBefore = previousManaged(oldProvider, oldConfig);
          const baselineSelected = structuredClone(managedBefore);
          const persistedMetadata = new Map((oldConfig?.modelMetadata ?? []).map((entry) => [`${entry.type}\0${entry.id}`, entry]));
          let selectedMetadata: ModelMetadataEntry[] = managedBefore.map((model) => {
            const stored = persistedMetadata.get(`${model.type}\0${model.id}`);
            if (stored) return structuredClone(stored);
            const raw = model.type === "chat" ? oldProvider?.models?.find((entry) => entry.id === model.id) : oldConfig?.models?.find((entry) => entry.type === model.type && entry.id === model.id);
            const explicitThinkingMap = model.type === "chat" && typeof (raw as any)?.thinkingLevelMap === "object" && (raw as any).thinkingLevelMap !== null && !Array.isArray((raw as any).thinkingLevelMap);
            return { type: model.type, id: model.id, contextSource: model.type === "image" ? undefined : typeof (raw as any)?.contextWindow === "number" ? "existing" : "compat", maxTokensSource: model.type === "chat" ? typeof (raw as any)?.maxTokens === "number" ? "existing" : "compat" : undefined, thinkingSource: explicitThinkingMap ? "existing" : undefined };
          });
          const baselineMetadata = structuredClone(selectedMetadata);

          let selectedDraft = structuredClone(managedBefore);
          const adoptedChatIds = new Set<string>();
          let cachedRemote: CandidateModel[] = [];
          let page: "connection" | "model" | "preview" = "connection";
          let previewOrigin: "connection" | "model" = "model";
          const connectionState: MenuPanelState = { focus: "list", actionIndex: 0, detailScroll: 0 };
          const modelState: ModelPanelState = { search: "", focus: "list", actionIndex: 0, detailScroll: 0 };
          const previewState: MenuPanelState = { selectedId: "provider", focus: "list", actionIndex: 0, detailScroll: 0 };
          activeSecrets.push(draft.apiKeyRaw);

          const adoptableIds = () => {
            const alreadyManaged = new Set(oldConfig?.managedChatIds ?? []);
            return (oldProvider?.models ?? [])
              .filter((model) => typeof model.id === "string" && !alreadyManaged.has(model.id) && !adoptedChatIds.has(model.id))
              .map((model) => model.id as string);
          };
          const selectionFingerprint = (models: ManagedModel[]) => JSON.stringify([...models].sort((a, b) => identityOf(a, target.id).localeCompare(identityOf(b, target.id))));
          const metadataFingerprint = (entries: ModelMetadataEntry[]) => JSON.stringify([...entries].sort((a, b) => `${a.type}\0${a.id}`.localeCompare(`${b.type}\0${b.id}`)));
          const isDirty = () => JSON.stringify(draft) !== JSON.stringify(baselineDraft)
            || selectionFingerprint(selectedDraft) !== selectionFingerprint(baselineSelected)
            || metadataFingerprint(selectedMetadata) !== metadataFingerprint(baselineMetadata)
            || adoptedChatIds.size > 0;
          const preparePreview = async (): Promise<boolean> => {
            if (draft.authMode === "temporary") {
              ctx.ui.notify(t(language, "temporarySaveBlocked"), "warning");
              return false;
            }
            try { validateSelection(draft, selectedDraft, installedModels(ctx, target.id), oldProvider); }
            catch (error) { ctx.ui.notify(displayError(language, error, activeSecrets), "error"); return false; }
            if ((managedBefore.length > 0 || adoptedChatIds.size > 0) && selectedDraft.length === 0) {
              const empty = await showConfirmationPanel(ctx, {
                title: t(language, "emptyTitle"), summary: [t(language, "emptyBody")], severity: "error",
                defaultActionIndex: 0, cancelActionId: "cancel",
                actions: [
                  { id: "cancel", label: t(language, "confirmCancel") },
                  { id: "confirm", label: t(language, "confirmEmpty"), shortcut: "ctrl+s", severity: "error" },
                ],
              });
              if (empty !== "confirm") return false;
            }
            return true;
          };
          const adoptExisting = async (): Promise<boolean> => {
            const ids = adoptableIds();
            if (!ids.length) { ctx.ui.notify(t(language, "takeoverModelsNone"), "info"); return false; }
            const action = await showConfirmationPanel(ctx, {
              title: t(language, "takeoverModelsTitle"), summary: [t(language, "takeoverModelsBody", { provider: target.id, count: ids.length })],
              details: [t(language, "diffSafety")], severity: "warning", defaultActionIndex: 0, cancelActionId: "cancel",
              actions: [
                { id: "cancel", label: t(language, "confirmCancel") },
                { id: "confirm", label: t(language, "confirmTakeover"), shortcut: "ctrl+t", severity: "warning" },
              ],
            });
            if (action !== "confirm") return false;
            const parseConfig: ProviderConnectionConfig = oldConfig ?? {
              authMode: draft.authMode === "temporary" ? "reuse-pi" : draft.authMode,
              chatApi: draft.chatApi,
            };
            const selectedKeys = new Set(selectedDraft.map((model) => identityOf(model, target.id)));
            for (const raw of oldProvider?.models ?? []) {
              if (typeof raw.id !== "string" || !ids.includes(raw.id)) continue;
              const model = parseManagedChat(raw, oldProvider!, parseConfig, true);
              if (model && !selectedKeys.has(identityOf(model, target.id))) selectedDraft.push(model);
              adoptedChatIds.add(raw.id);
            }
            return true;
          };

          providerSession: while (true) {
            if (page === "connection") {
              const connection = await editConnectionPanel(ctx, language, draft, connectionState, adoptableIds().length > 0);
              activeSecrets.push(draft.apiKeyRaw, draft.temporaryKey);
              if (connection === "models") { page = "model"; continue; }
              if (connection === "takeover") { if (await adoptExisting()) page = "model"; continue; }
              if (connection === "testModels") {
                if (!draft.enabled) { ctx.ui.notify(t(language, "testProviderDisabled"), "warning"); continue; }
                if (draft.authMode === "temporary" || isDirty()) { ctx.ui.notify(t(language, "testDraftDirty"), "warning"); continue; }
                const models = installedModels(ctx, target.id);
                if (!models.length) { ctx.ui.notify(t(language, "testNoModels"), "info"); continue; }
                await showModelTestFlow(ctx, language, models, [draft.apiKeyRaw, draft.temporaryKey]);
                continue;
              }
              if (connection === "preview") {
                if (await preparePreview()) { previewOrigin = "connection"; page = "preview"; }
                continue;
              }
              if (!isDirty()) continue mainLoop;
              const leave = await showConfirmationPanel(ctx, {
                title: t(language, "dirtyLeaveTitle"), summary: [t(language, "dirtyLeaveBody")], severity: "warning",
                defaultActionIndex: 0, cancelActionId: "edit",
                actions: [
                  { id: "edit", label: t(language, "dirtyReturnEdit") },
                  { id: "preview", label: t(language, "dirtyPreviewSave"), shortcut: "ctrl+s" },
                  { id: "discard", label: t(language, "dirtyDiscard"), shortcut: "ctrl+d", severity: "error" },
                ],
              });
              if (leave === "edit") continue;
              if (leave === "discard") continue mainLoop;
              if (await preparePreview()) { previewOrigin = "connection"; page = "preview"; }
              continue;
            }

            if (page === "model") {
              const installedRaw = installedModels(ctx, target.id);
              const installed = installedRaw.map(candidateFromInstalled);
              const managedChatIds = new Set(oldConfig?.managedChatIds ?? []);
              const parseConfig: ProviderConnectionConfig = oldConfig ?? {
                authMode: draft.authMode === "temporary" ? "reuse-pi" : draft.authMode,
                chatApi: draft.chatApi,
              };
              const external = (oldProvider?.models ?? [])
                .filter((model) => typeof model.id === "string" && !managedChatIds.has(model.id))
                .map((model) => parseManagedChat(model, oldProvider!, parseConfig, adoptedChatIds.has(typeof model.id === "string" ? model.id : "")))
                .filter((model): model is ManagedModel => model !== undefined)
                .map((model) => {
                  const raw = oldProvider?.models?.find((entry) => entry.id === model.id);
                  const explicitMap = typeof raw?.thinkingLevelMap === "object" && raw.thinkingLevelMap !== null && !Array.isArray(raw.thinkingLevelMap);
                  const defaultThinkingSource = model.type === "chat"
                    ? explicitMap ? "existing" as const : adoptedChatIds.has(model.id) && protocolThinkingMap(model.api) ? "protocol" as const : undefined
                    : undefined;
                  const metadata = persistedMetadata.get(`${model.type}\0${model.id}`) ?? { type: model.type, id: model.id, contextSource: model.type === "image" ? undefined : "compat", maxTokensSource: model.type === "chat" ? "compat" : undefined, thinkingSource: defaultThinkingSource };
                  return adoptedChatIds.has(model.id) ? candidateFromManaged(model, metadata) : candidateFromExternal(model, metadata);
                });
              const candidates = mergeCandidates(target.id, [...external, ...installed], managedBefore.map((model) => candidateFromManaged(model, persistedMetadata.get(`${model.type}\0${model.id}`))), cachedRemote);
              const selection = await selectModels(ctx, language, target.id, draft, candidates, selectedDraft, modelState, selectedMetadata);
              selectedDraft = selection.selected;
              selectedMetadata = selection.metadata.map((entry) => ({ ...(selectedMetadata.find((old) => old.type === entry.type && old.id === entry.id) ?? {}), ...entry }));
              if (selection.action === "back") { page = "connection"; continue; }
              if (selection.action === "edit") {
                const editTarget = selection.target;
                if (editTarget?.readOnlyReason === "external-config") { ctx.ui.notify(t(language, "editorExternalTakeover"), "warning"); continue; }
                const managedIndex = editTarget ? selectedDraft.findIndex((model) => model.id === editTarget.id && model.type === editTarget.type) : -1;
                if (managedIndex < 0) { ctx.ui.notify(t(language, "editorManagedOnly"), "warning"); continue; }
                const model = selectedDraft[managedIndex]!;
                const metadataIndex = selectedMetadata.findIndex((entry) => entry.type === model.type && entry.id === model.id);
                const metadata = metadataIndex >= 0 ? selectedMetadata[metadataIndex]! : { type: model.type, id: model.id };
                const edited = await editModelParameters(ctx, language, model, metadata);
                if (edited) { selectedDraft[managedIndex] = edited.model; if (metadataIndex >= 0) selectedMetadata[metadataIndex] = edited.metadata; else selectedMetadata.push(edited.metadata); }
                continue;
              }
              if (selection.action === "probeThinking") {
                const id = modelState.selectedId;
                const managedIndex = selectedDraft.findIndex((model) => model.id === id);
                const runtimeModel = installedRaw.find((model) => model.id === id);
                const model = managedIndex >= 0 ? selectedDraft[managedIndex] : undefined;
                if (!model || model.type !== "chat" || !runtimeModel || !draft.enabled || draft.authMode === "temporary" || isDirty()) { ctx.ui.notify(t(language, "thinkingProbeBlocked"), "warning"); continue; }
                const currentCandidate = candidates.find((candidate) => candidate.id === id && candidate.type === "chat");
                const resolved = resolveThinkingMap(currentCandidate?.source === "remote" ? (currentCandidate as any).thinkingLevelMap : undefined, (runtimeModel as any).thinkingLevelMap, model.thinkingLevelMap, model.api);
                if (!resolved.map) { ctx.ui.notify(t(language, "thinkingProbeBlocked"), "warning"); continue; }
                const probe = await showThinkingProbeFlow(ctx, language, runtimeModel, resolved.map, [draft.apiKeyRaw, draft.temporaryKey]);
                if (!probe) continue;
                model.reasoning = probe.accepted.length > 0;
                model.thinkingLevelMap = acceptedThinkingMap(resolved.map, probe.accepted);
                const metadataIndex = selectedMetadata.findIndex((entry) => entry.type === model.type && entry.id === model.id);
                const metadata = { ...(metadataIndex >= 0 ? selectedMetadata[metadataIndex] : { type: model.type, id: model.id }), thinkingSource: "probed" as const, verifiedAt: new Date().toISOString() };
                if (metadataIndex >= 0) selectedMetadata[metadataIndex] = metadata; else selectedMetadata.push(metadata);
                continue;
              }
              if (selection.action === "probe") {
                const id = modelState.selectedId;
                const managedIndex = selectedDraft.findIndex((model) => model.id === id);
                const runtimeModel = installedRaw.find((model) => model.id === id);
                if (!id || managedIndex < 0 || !runtimeModel || runtimeModel.type === "image" || !draft.enabled || draft.authMode === "temporary" || isDirty()) {
                  ctx.ui.notify(t(language, "probeBlocked"), "warning");
                  continue;
                }
                const probe = await showContextProbeFlow(ctx, language, runtimeModel, [draft.apiKeyRaw, draft.temporaryKey]);
                if (!probe?.lower) continue;
                const model = selectedDraft[managedIndex]!;
                if (model.type === "chat" && probe.lower < model.maxTokens) { ctx.ui.notify(t(language, "probeMaxConflict"), "warning"); continue; }
                if (model.type !== "image") model.contextWindow = probe.lower;
                const metadataIndex = selectedMetadata.findIndex((entry) => entry.type === model.type && entry.id === model.id);
                const metadata = { ...(metadataIndex >= 0 ? selectedMetadata[metadataIndex] : { type: model.type, id: model.id }), contextSource: "probed" as const, verifiedAt: probe.verifiedAt, probeLower: probe.lower, probeUpper: probe.upper, probeEstimated: probe.estimated };
                if (metadataIndex >= 0) selectedMetadata[metadataIndex] = metadata; else selectedMetadata.push(metadata);
                continue;
              }
              if (selection.action === "fetch") {
                const fallbackBases = [
                  ...(oldProvider?.models ?? []).map((model) => typeof model.baseUrl === "string" ? model.baseUrl : undefined),
                  ...installedRaw.map((model) => model.baseUrl),
                ];
                const discoveryCandidates = buildDiscoveryCandidates(draft, fallbackBases);
                if (!draft.discoveryUrl) {
                  const edit = t(language, "discoveryRequiredEdit");
                  const cancel = t(language, "discoveryRequiredCancel");
                  if (discoveryCandidates.length) {
                    const use = t(language, "discoveryUseCandidates", { url: redactUrl(discoveryCandidates[0], language), count: Math.max(0, discoveryCandidates.length - 1) });
                    const choice = await showConfirmationPanel(ctx, {
                      title: t(language, "discoveryDerivedTitle"), summary: [use], details: [t(language, "discoveryCandidateSafety")],
                      defaultActionIndex: 2, cancelActionId: "cancel",
                      actions: [
                        { id: "use", label: t(language, "discoveryUseAction"), shortcut: "ctrl+r" },
                        { id: "edit", label: edit },
                        { id: "cancel", label: cancel },
                      ],
                    });
                    if (choice === "edit") page = "connection";
                    else if (choice !== "use") continue;
                  } else {
                    const choice = await showConfirmationPanel(ctx, {
                      title: t(language, "discoveryRequired"), summary: [t(language, "discoveryNoCandidate")],
                      defaultActionIndex: 1, cancelActionId: "cancel",
                      actions: [{ id: "edit", label: edit }, { id: "cancel", label: cancel }],
                    });
                    if (choice === "edit") page = "connection";
                    continue;
                  }
                  if (page === "connection") continue;
                }
                if (!discoveryCandidates.length) { ctx.ui.notify(t(language, "discoveryRequired"), "warning"); continue; }
                const auth = draft.authMode === "reuse-pi" ? await ctx.modelRegistry.getProviderAuth(target.id) : undefined;
                const resolvedModelBase = draft.baseUrl ?? fallbackBases.find((value) => { if (!value) return false; try { validateHttpUrl(value, "Base URL"); return true; } catch { return false; } });
                const discoveryDraft = resolvedModelBase ? { ...draft, baseUrl: resolvedModelBase } : draft;
                const result = await withCancellableLoader(ctx, t(language, "fetching", { url: redactUrl(discoveryCandidates[0], language) }), (signal) => discoverModelsFromCandidates(discoveryDraft, discoveryCandidates, auth, signal));
                if (result.cancelled) { ctx.ui.notify(t(language, "fetchCancelled"), "info"); continue; }
                if (result.error) { ctx.ui.notify(displayError(language, result.error, [draft.apiKeyRaw, draft.temporaryKey]), "error"); continue; }
                draft.discoveryUrl = result.value!.url;
                cachedRemote = [...result.value!.models];
                continue;
              }
              if (await preparePreview()) { previewOrigin = "model"; page = "preview"; }
              continue;
            }

            const details = buildPreviewDetails(language, target.id, managedBefore, selectedDraft, oldConfig, oldProvider, draft);
            const preview = await showPreviewPanel(ctx, language, target.id, details.providerDetails, details.modelDetails, previewState);
            if (preview.action === "back") { page = previewOrigin; continue; }
            if (preview.action === "discard") {
              const discard = await showConfirmationPanel(ctx, {
                title: t(language, "discardConfirmTitle"), summary: [t(language, "discardConfirmBody")], severity: "error",
                defaultActionIndex: 0, cancelActionId: "cancel",
                actions: [
                  { id: "cancel", label: t(language, "dirtyReturnEdit") },
                  { id: "discard", label: t(language, "dirtyDiscard"), shortcut: "ctrl+d", severity: "error" },
                ],
              });
              if (discard === "discard") continue mainLoop;
              continue;
            }
            const compatItems = selectedMetadata.filter((entry) => entry.contextSource === "compat" || entry.maxTokensSource === "compat").map((entry) => entry.type + '/' + entry.id);
            const risk = compatItems.length ? [t(language, "compatSaveRisk", { items: compatItems.join(", ") })] : [];
            const confirmed = await confirmAction(ctx, language, t(language, "finalSaveTitle"), [t(language, "finalSaveBody"), ...risk], [...details.providerDetails, ...details.modelDetails], t(language, "confirmSave"));
            if (!confirmed) continue;
            try {
              const next = applyChanges(files, target.id, draft, selectedDraft, adoptedChatIds, selectedMetadata);
              const transaction = writeConfigTransaction(files.modelsSnapshot, files.configSnapshot, next.models, next.config);
              ctx.ui.notify(t(language, "saveSuccess", { count: transaction.backups.length }), "info");
              continue mainLoop;
            } catch (error) {
              ctx.ui.notify(displayError(language, error, activeSecrets), "error");
              page = previewOrigin;
              continue;
            }
          }
        }
      } catch (error) {
        ctx.ui.notify(displayError(language, error, activeSecrets), "error");
      }
    },
  });
}
