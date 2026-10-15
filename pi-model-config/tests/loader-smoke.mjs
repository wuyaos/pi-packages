import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..");
const sdkRoot = resolve(process.env.PI_SDK_ROOT ?? "C:/app/scoop/persist/nodejs24/bin/node_modules/@earendil-works/pi-coding-agent");
const sdkPackage = join(sdkRoot, "package.json");
if (!existsSync(sdkPackage)) throw new Error(`Pi SDK not found: ${sdkPackage}`);
const sdk = createRequire(sdkPackage)(sdkPackage);
if (sdk.version !== "1.2.0") throw new Error(`Expected Pi SDK 1.2.0, found ${sdk.version}`);

const agentDir = mkdtempSync(join(tmpdir(), "pi-model-config-loader-smoke-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const models = {
  providers: {
    "disabled-smoke": {
      name: "Disabled Smoke",
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      models: [{ id: "disabled-chat", name: "Disabled Chat", api: "openai-completions", reasoning: false, input: ["text"], cost, contextWindow: 4096, maxTokens: 512 }],
    },
    "model-config-smoke": {
      name: "Model Config Smoke",
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      models: [{
        id: "dummy-chat",
        name: "Dummy Chat",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost,
        contextWindow: 4_096,
        maxTokens: 512,
      }],
    },
  },
};
const config = {
  version: 1,
  providers: {
    "disabled-smoke": {
      name: "Disabled Smoke",
      enabled: false,
      owned: false,
      authMode: "reuse-pi",
      managedChatIds: [],
      models: [],
    },
    "model-config-smoke": {
      name: "Model Config Smoke",
      owned: true,
      authMode: "anonymous",
      chatApi: "openai-completions",
      classifierApi: "typesafe-system-one",
      imageApi: "openrouter-images",
      managedChatIds: ["dummy-chat"],
      models: [
        {
          type: "classifier",
          id: "dummy-classifier",
          name: "Dummy Classifier",
          api: "typesafe-system-one",
          input: ["text"],
          cost,
          contextWindow: 4_096,
        },
        {
          type: "image",
          id: "dummy-image",
          name: "Dummy Image",
          api: "openrouter-images",
          input: ["text"],
          output: ["image"],
          cost,
        },
      ],
    },
  },
};

try {
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
  writeFileSync(join(agentDir, "model-config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  // Deliberately use Pi's real loader without adding Jiti aliases in this helper.
  const { loadExtensions } = await import(pathToFileURL(join(sdkRoot, "dist/core/extensions/loader.js")).href);
  const result = await loadExtensions([join(packageRoot, "extensions/model-config.ts")], repoRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.ok(extension.commands.has("model-config"));

  const disabled = result.runtime.pendingProviderRegistrations.find((registration) => registration.name === "disabled-smoke");
  assert.ok(disabled);
  assert.deepEqual(disabled.config.models, []);
  const pending = result.runtime.pendingNativeProviderRegistrations;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].extensionPath, join(packageRoot, "extensions/model-config.ts"));
  assert.equal(pending[0].provider.id, "model-config-smoke");
  assert.equal(typeof pending[0].provider.stream, "function");
  assert.equal(typeof pending[0].provider.streamSimple, "function");
  assert.equal(typeof pending[0].provider.classify, "function");
  assert.equal(typeof pending[0].provider.generateImages, "function");
  const catalog = pending[0].provider.getAllModels?.() ?? pending[0].provider.getModels();
  assert.deepEqual(new Set(catalog.map((model) => model.type)), new Set(["chat", "classifier", "image"]));

  console.log(`LOADER_SMOKE_SDK_VERSION=${sdk.version}`);
  console.log(`LOADER_SMOKE_COMMANDS=${[...extension.commands.keys()].join(",")}`);
  console.log(`LOADER_SMOKE_PENDING_NATIVE=${pending.map(({ provider }) => provider.id).join(",")}`);
  console.log(`LOADER_SMOKE_MODEL_TYPES=${catalog.map((model) => model.type).sort().join(",")}`);
  console.log("LOADER_SMOKE_RESULT=pass");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
}
