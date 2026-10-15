import {
  createProvider,
  type Api,
  type ApiKeyAuth,
  type ClassifierApi,
  type ImageApi,
  type Provider,
  type ProviderClassifier,
  type ProviderImages,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelConfigFile, ModelsJsonFile, ModelsJsonProvider, ProviderConnectionConfig } from "./types.ts";
import { validateHttpUrl } from "./config.ts";
import { mcError, t, type UiLanguage } from "./i18n.ts";
import { ANONYMOUS_SENTINEL, applyProviderTransport, CHAT_APIS, CLASSIFIER_APIS, IMAGE_APIS, PROXY_CHAT_APIS, type TransportOptions } from "./transport.ts";

interface HostApiImplementations {
  chat: Map<string, ProviderStreams>;
  classifier: Map<string, ProviderClassifier>;
  image: Map<string, ProviderImages>;
}

/**
 * The extension loader exposes @earendil-works/pi-ai/providers/all as a host-owned
 * virtual/aliased module in every runtime. Derive API implementations from those
 * native Provider objects instead of importing unsupported api/*.lazy subpaths,
 * which are not part of the loader's virtual module table.
 */
const HOST_BUILTIN_PROVIDERS = builtinProviders();

function collectHostApiImplementations(providers: readonly Provider[]): HostApiImplementations {
  const chat = new Map<string, ProviderStreams>();
  const classifier = new Map<string, ProviderClassifier>();
  const image = new Map<string, ProviderImages>();
  for (const provider of providers) {
    const models = provider.getAllModels?.() ?? provider.getModels();
    for (const model of models) {
      if (model.type === "classifier") {
        if (provider.classify && !classifier.has(model.api)) {
          classifier.set(model.api, {
            classify: (requestModel, context, options) => provider.classify!(requestModel, context, options),
          });
        }
        continue;
      }
      if (model.type === "image") {
        if (provider.generateImages && !image.has(model.api)) {
          image.set(model.api, {
            generateImages: (requestModel, context, options) => provider.generateImages!(requestModel, context, options),
          });
        }
        continue;
      }
      if (!chat.has(model.api)) {
        chat.set(model.api, {
          stream: (requestModel, context, options) => provider.stream(requestModel, context, options),
          streamSimple: (requestModel, context, options) => provider.streamSimple(requestModel, context, options),
          ...(provider.fetchDeferred ? {
            fetchDeferred: (requestModel, handle, options) => provider.fetchDeferred!(requestModel, handle, options),
          } : {}),
          ...(provider.cancelDeferred ? {
            cancelDeferred: (requestModel, handle, options) => provider.cancelDeferred!(requestModel, handle, options),
          } : {}),
        });
      }
    }
  }
  return { chat, classifier, image };
}

const HOST_APIS = collectHostApiImplementations(HOST_BUILTIN_PROVIDERS);

function requiredImplementation<T>(implementations: ReadonlyMap<string, T>, api: string, operation: string): T {
  const implementation = implementations.get(api);
  if (!implementation) throw mcError("MCFG_E_UNSUPPORTED_API", { identity: operation, api });
  return implementation;
}

function wrapStreams(api: string, config: ProviderConnectionConfig): ProviderStreams {
  const base = requiredImplementation(HOST_APIS.chat, api, "chat");
  const transport = <T extends TransportOptions>(options: T | undefined): T => applyProviderTransport(options, {
    proxyUrl: config.proxyUrl,
    anonymous: config.authMode === "anonymous",
    api,
  });
  return {
    stream: (model, context, options) => base.stream(model, context, transport(options)),
    streamSimple: (model, context, options) => base.streamSimple(model, context, transport(options)),
    ...(base.fetchDeferred ? { fetchDeferred: (model, handle, options) => base.fetchDeferred!(model, handle, transport(options)) } : {}),
    ...(base.cancelDeferred ? { cancelDeferred: (model, handle, options) => base.cancelDeferred!(model, handle, transport(options)) } : {}),
  };
}

function wrapClassifier(api: string, config: ProviderConnectionConfig): ProviderClassifier {
  const base = requiredImplementation(HOST_APIS.classifier, api, "classifier");
  return {
    classify: (model, context, options) => base.classify(model, context, applyProviderTransport(options, {
      proxyUrl: config.proxyUrl,
      anonymous: config.authMode === "anonymous",
      api,
    })),
  };
}

function wrapImages(api: string, config: ProviderConnectionConfig): ProviderImages {
  const base = requiredImplementation(HOST_APIS.image, api, "image");
  return {
    generateImages: (model, context, options) => base.generateImages(model, context, applyProviderTransport(options, {
      proxyUrl: config.proxyUrl,
      anonymous: config.authMode === "anonymous",
      api,
    })),
  };
}

function authFor(config: ProviderConnectionConfig, modelsProvider: ModelsJsonProvider | undefined, language: UiLanguage): ApiKeyAuth {
  return {
    name: config.authMode === "anonymous" ? t(language, "authAnonymous") : config.authMode === "reuse-pi" ? t(language, "authReuse") : t(language, "authModelsJson"),
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (config.authMode === "anonymous") return { auth: { apiKey: ANONYMOUS_SENTINEL }, source: t(language, "authSourceAnonymous") };
      if (credential?.type === "api_key" && credential.key) {
        return { auth: { apiKey: credential.key }, env: credential.env, source: t(language, "authSourceStored") };
      }
      if (config.authMode === "reuse-pi") return undefined;
      const raw = modelsProvider?.apiKey;
      if (!raw) return undefined;
      const match = raw.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/u);
      const escapedLiteral = raw.startsWith("$$") || raw.startsWith("$!");
      const key = match ? await ctx.env(match[1] ?? match[2]!) : escapedLiteral ? raw.slice(1) : raw;
      signal.throwIfAborted();
      return key ? { auth: { apiKey: key }, source: match ? (match[1] ?? match[2]) : "models.json" } : undefined;
    },
  };
}

function normalizeChatModels(providerId: string, provider: ModelsJsonProvider, config: ProviderConnectionConfig) {
  const baseUrl = provider.baseUrl;
  return (provider.models ?? []).map((raw) => ({
    type: "chat" as const,
    id: String(raw.id),
    name: typeof raw.name === "string" ? raw.name : String(raw.id),
    api: typeof raw.api === "string" ? raw.api : (provider.api ?? config.chatApi ?? "openai-completions"),
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : (baseUrl ?? ""),
    reasoning: raw.reasoning === true,
    ...(typeof raw.thinkingLevelMap === "object" && raw.thinkingLevelMap ? { thinkingLevelMap: raw.thinkingLevelMap as any } : {}),
    input: (Array.isArray(raw.input) ? raw.input.filter((v): v is "text" | "image" => v === "text" || v === "image") : ["text"]) as ("text" | "image")[],
    cost: typeof raw.cost === "object" && raw.cost ? raw.cost as { input: number; output: number; cacheRead: number; cacheWrite: number } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : 128_000,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : 16_384,
    ...(typeof raw.headers === "object" && raw.headers ? { headers: raw.headers as Record<string, string> } : {}),
    provider: providerId,
  }));
}

function validateRuntimeConfig(providerId: string, config: ProviderConnectionConfig, modelsProvider: ModelsJsonProvider | undefined): void {
  if (config.discoveryUrl) validateHttpUrl(config.discoveryUrl, `${providerId} Discovery URL`);
  if (config.proxyUrl) validateHttpUrl(config.proxyUrl, `${providerId}.proxyUrl`);
  const chatApis = new Set<string>();
  for (const model of modelsProvider?.models ?? []) {
    if (typeof model.id !== "string" || !model.id) throw mcError("MCFG_E_MODEL_SHAPE", { file: "models.json", provider: providerId });
    if (model.type === "classifier" || model.type === "image") {
      throw mcError("MCFG_E_TYPE_API", { identity: `${providerId}/chat/${model.id}`, api: String(model.api ?? model.type) });
    }
    const api = typeof model.api === "string" ? model.api : (modelsProvider?.api ?? config.chatApi ?? "openai-completions");
    if (!CHAT_APIS.has(api)) throw mcError("MCFG_E_UNSUPPORTED_API", { identity: `${providerId}/chat/${model.id}`, api });
    chatApis.add(api);
    if (config.owned) validateHttpUrl(String(model.baseUrl ?? modelsProvider?.baseUrl ?? ""), `${providerId}/${model.id} Base URL`);
    if (config.owned && (typeof model.contextWindow !== "number" || typeof model.maxTokens !== "number")) throw mcError("MCFG_E_MODEL_SHAPE", { file: "models.json", provider: providerId });
  }
  for (const model of config.models ?? []) {
    const supported = model.type === "classifier" ? CLASSIFIER_APIS : model.type === "image" ? IMAGE_APIS : undefined;
    if (!supported) throw mcError("MCFG_E_MODEL_SHAPE", { file: "model-config.json", provider: providerId });
    if (!supported.has(model.api)) throw mcError("MCFG_E_TYPE_API", { identity: `${providerId}/${model.type}/${model.id}`, api: model.api });
    if (config.owned) validateHttpUrl(model.baseUrl ?? modelsProvider?.baseUrl ?? "", `${providerId}/${model.id} Base URL`);
    if (config.owned && model.type === "classifier" && typeof model.contextWindow !== "number") throw mcError("MCFG_E_MODEL_SHAPE", { file: "model-config.json", provider: providerId });
  }
  if (!config.owned && (config.models?.length ?? 0) > 0) {
    throw mcError("MCFG_E_NOT_OWNED", { provider: providerId });
  }
  for (const api of chatApis) {
    if (config.proxyUrl && !PROXY_CHAT_APIS.has(api)) {
      throw mcError("MCFG_E_PROXY_UNSUPPORTED", { identity: `${providerId}/chat/${api}` });
    }
    if (config.authMode === "anonymous" && ["pi-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex"].includes(api)) {
      throw mcError("MCFG_E_ANONYMOUS_UNSUPPORTED", { identity: `${providerId}/chat/${api}` });
    }
  }
}

function registerOwnedProvider(pi: ExtensionAPI, providerId: string, config: ProviderConnectionConfig, modelsProvider: ModelsJsonProvider, language: UiLanguage): void {
  const chatModels = normalizeChatModels(providerId, modelsProvider, config);
  const extraModels = (config.models ?? []).map((model) => ({ ...model, provider: providerId, baseUrl: model.baseUrl ?? modelsProvider.baseUrl ?? "" }));
  const allModels = [...chatModels, ...extraModels];
  if (allModels.length === 0) return;
  const chatApis = new Set(chatModels.map((model) => model.api));
  const classifierApis = new Set(extraModels.filter((model) => model.type === "classifier").map((model) => model.api));
  const imageApis = new Set(extraModels.filter((model) => model.type === "image").map((model) => model.api));
  const api = Object.fromEntries([...chatApis].map((id) => [id, wrapStreams(id, config)])) as Partial<Record<Api, ProviderStreams>>;
  const classifiers = Object.fromEntries([...classifierApis].map((id) => [id, wrapClassifier(id, config)])) as Partial<Record<ClassifierApi, ProviderClassifier>>;
  const images = Object.fromEntries([...imageApis].map((id) => [id, wrapImages(id, config)])) as Partial<Record<ImageApi, ProviderImages>>;
  pi.registerProvider(createProvider({
    id: providerId,
    name: config.name ?? modelsProvider.name ?? providerId,
    baseUrl: modelsProvider.baseUrl,
    headers: modelsProvider.headers,
    auth: { apiKey: authFor(config, modelsProvider, language) },
    models: allModels,
    ...(Object.keys(api).length ? { api } : {}),
    ...(Object.keys(classifiers).length ? { classifiers } : {}),
    ...(Object.keys(images).length ? { images } : {}),
  }));
}

function wrapBuiltinProvider(base: Provider, config: ProviderConnectionConfig, language: UiLanguage): Provider {
  const transport = <T extends TransportOptions>(options: T | undefined, api: string): T => applyProviderTransport(options, {
    proxyUrl: config.proxyUrl,
    anonymous: config.authMode === "anonymous",
    api,
  });
  return {
    id: base.id,
    name: base.name,
    baseUrl: base.baseUrl,
    headers: base.headers,
    auth: config.authMode === "anonymous" ? { apiKey: authFor(config, undefined, language) } : base.auth,
    getModels: () => base.getModels(),
    ...(base.getAllModels ? { getAllModels: () => base.getAllModels!() } : {}),
    ...(base.refreshModels ? { refreshModels: (context) => base.refreshModels!(context) } : {}),
    ...(base.filterModels ? { filterModels: (models, credential) => base.filterModels!(models, credential) } : {}),
    ...(base.filterAllModels ? { filterAllModels: (models, credential) => base.filterAllModels!(models, credential) } : {}),
    stream: (model, context, options) => base.stream(model, context, transport(options, model.api)),
    streamSimple: (model, context, options) => base.streamSimple(model, context, transport(options, model.api)),
    ...(base.fetchDeferred ? { fetchDeferred: (model, handle, options) => base.fetchDeferred!(model, handle, transport(options, model.api)) } : {}),
    ...(base.cancelDeferred ? { cancelDeferred: (model, handle, options) => base.cancelDeferred!(model, handle, transport(options, model.api)) } : {}),
    ...(base.generateImages ? { generateImages: (model, context, options) => base.generateImages!(model, context, transport(options, model.api)) } : {}),
    ...(base.classify ? { classify: (model, context, options) => base.classify!(model, context, transport(options, model.api)) } : {}),
  };
}

function registerBuiltinOverlay(pi: ExtensionAPI, providerId: string, config: ProviderConnectionConfig, language: UiLanguage): void {
  const base = HOST_BUILTIN_PROVIDERS.find((provider) => provider.id === providerId);
  if (!base) throw mcError("MCFG_E_NOT_BUILTIN", { provider: providerId });
  const allModels = base.getAllModels?.() ?? base.getModels();
  const unsupportedProxy = config.proxyUrl
    ? allModels.filter((model) => model.type !== "classifier" && model.type !== "image" && !PROXY_CHAT_APIS.has(model.api))
    : [];
  if (unsupportedProxy.length) throw mcError("MCFG_E_PROXY_UNSUPPORTED", { identity: providerId });
  const unsupportedAnonymous = config.authMode === "anonymous"
    ? allModels.filter((model) => ["pi-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex"].includes(model.api))
    : [];
  if (unsupportedAnonymous.length) throw mcError("MCFG_E_ANONYMOUS_UNSUPPORTED", { identity: providerId });
  pi.registerProvider(wrapBuiltinProvider(base, config, language));
}

function registerDisabledProvider(pi: ExtensionAPI, providerId: string, config: ProviderConnectionConfig, modelsProvider: ModelsJsonProvider | undefined): void {
  const builtin = HOST_BUILTIN_PROVIDERS.some((provider) => provider.id === providerId);
  if (!builtin && !config.owned && !modelsProvider) throw mcError("MCFG_E_DISABLE_THIRD_PARTY", { provider: providerId });
  pi.registerProvider(providerId, { models: [] });
}

export interface ProviderRegistrationIssue {
  providerId: string;
  error: unknown;
}

export function registerConfiguredProviders(
  pi: ExtensionAPI,
  configFile: ModelConfigFile,
  modelsFile: ModelsJsonFile,
  language: UiLanguage,
): ProviderRegistrationIssue[] {
  const issues: ProviderRegistrationIssue[] = [];
  for (const [providerId, config] of Object.entries(configFile.providers)) {
    try {
      const modelsProvider = modelsFile.providers[providerId];
      if (config.enabled === false) {
        registerDisabledProvider(pi, providerId, config, modelsProvider);
        continue;
      }
      validateRuntimeConfig(providerId, config, modelsProvider);
      if (config.owned) {
        if (!modelsProvider) throw mcError("MCFG_E_OWNED_PROVIDER_MISSING", { provider: providerId });
        registerOwnedProvider(pi, providerId, config, modelsProvider, language);
      } else if (config.proxyUrl || config.authMode === "anonymous") {
        registerBuiltinOverlay(pi, providerId, config, language);
      } else {
        const safeOverlayOwner = HOST_BUILTIN_PROVIDERS.some((provider) => provider.id === providerId) || !!modelsProvider;
        if (safeOverlayOwner) pi.unregisterProvider(providerId);
      }
    } catch (error) {
      issues.push({ providerId, error });
    }
  }
  return issues;
}
