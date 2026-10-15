import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerConfiguredProviders } from "../src/runtime.ts";

test("disabled models.json provider registers a legacy empty-model overlay", () => {
  const registrations: any[] = [];
  const pi = { registerProvider: (...args: any[]) => registrations.push(args) } as any;
  const issues = registerConfiguredProviders(pi, { version: 1, providers: {
    custom: { enabled: false, owned: false, authMode: "reuse-pi" },
  } }, { providers: { custom: { models: [{ id: "chat" }] } } }, "en");
  assert.deepEqual(issues, []);
  assert.equal(registrations[0][0], "custom");
  assert.deepEqual(registrations[0][1].models, []);
});

test("disabled builtin provider is allowed without a models.json entry", () => {
  const registrations: any[] = []; const pi = { registerProvider: (...args: any[]) => registrations.push(args) } as any;
  const issues = registerConfiguredProviders(pi, { version: 1, providers: { anthropic: { enabled: false, owned: false, authMode: "reuse-pi" } } }, { providers: {} }, "en");
  assert.deepEqual(issues, []); assert.equal(registrations[0][0], "anthropic"); assert.deepEqual(registrations[0][1].models, []);
});

test("disabled unowned config-only third-party provider is rejected", () => {
  const pi = { registerProvider: () => { throw new Error("must not register"); } } as any;
  const issues = registerConfiguredProviders(pi, { version: 1, providers: {
    thirdparty: { enabled: false, owned: false, authMode: "reuse-pi" },
  } }, { providers: {} }, "en");
  assert.equal(issues.length, 1);
  assert.equal((issues[0]!.error as any).code, "MCFG_E_DISABLE_THIRD_PARTY");
});

test("real ModelRuntime disable then unregister restores models.json catalog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-runtime-reload-"));
  try {
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { custom: {
      baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture", api: "openai-completions",
      models: [{ id: "chat", name: "Chat", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 16 }],
    } } }));
    const sdkRoot = process.env.PI_MODEL_CONFIG_TEST_SDK!;
    const { ModelRuntime } = await import(pathToFileURL(join(sdkRoot, "dist/core/model-runtime.js")).href);
    const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false });
    assert.equal(runtime.getAllModels("custom").length, 1);
    runtime.registerProvider("custom", { models: [] });
    assert.equal(runtime.getAllModels("custom").length, 0);
    runtime.unregisterProvider("custom");
    assert.equal(runtime.getAllModels("custom").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enabled safe provider unregisters this extension's prior disabled overlay", () => {
  const unregistered: string[] = [];
  const pi = { unregisterProvider: (id: string) => unregistered.push(id), registerProvider() {} } as any;
  const issues = registerConfiguredProviders(pi, { version: 1, providers: {
    custom: { enabled: true, owned: false, authMode: "reuse-pi" },
  } }, { providers: { custom: { models: [] } } }, "en");
  assert.deepEqual(issues, []);
  assert.deepEqual(unregistered, ["custom"]);
});

test("enabled unowned config-only third-party provider is not unregistered", () => {
  const unregistered: string[] = [];
  const pi = { unregisterProvider: (id: string) => unregistered.push(id), registerProvider() {} } as any;
  const issues = registerConfiguredProviders(pi, { version: 1, providers: {
    thirdparty: { enabled: true, owned: false, authMode: "reuse-pi" },
  } }, { providers: {} }, "en");
  assert.deepEqual(issues, []);
  assert.deepEqual(unregistered, []);
});

test("owned chat missing context/max registers with Pi compat defaults and no error", () => {
  const registered: any[] = [];
  const pi = { registerProvider(...args: any[]) { registered.push(args.length === 1 ? args[0] : args[1]); } } as any;
  const issues = registerConfiguredProviders(pi, { version: 1, providers: { owned: { enabled: true, owned: true, authMode: "reuse-pi" } } }, { providers: { owned: { baseUrl: "http://127.0.0.1/v1", models: [{ id: "missing", api: "openai-completions" }] } } }, "en");
  assert.equal(issues.length, 0);
  const models = registered.flatMap((config) => config.getModels ? config.getModels() : config.models ?? []);
  const missing = models.find((model: any) => model.id === "missing");
  assert.equal(missing?.contextWindow, 128000);
  assert.equal(missing?.maxTokens, 16384);
});

test("invalid entries are skipped without blocking registration of valid models", () => {
  const registered: any[] = [];
  const pi = { registerProvider(...args: any[]) { registered.push(args.length === 1 ? args[0] : args[1]); } } as any;
  const issues = registerConfiguredProviders(pi, { version: 1, providers: { owned: { enabled: true, owned: true, authMode: "reuse-pi" } } }, {
    providers: {
      owned: {
        baseUrl: "http://127.0.0.1/v1",
        models: [
          { id: "valid-a", api: "openai-completions", contextWindow: 1000000, maxTokens: 128000 },
          { id: "missing-fields", api: "openai-completions" },
          { id: "", api: "openai-completions", contextWindow: 1000000, maxTokens: 128000 },
          { id: "bad-type", type: "image", api: "openai-images" },
        ],
      },
    },
  }, "en");
  // 有效条目仍注册；无效条目只记录 issue 不阻止
  assert.equal(issues.length, 2);
  const allModels = registered.flatMap((config) => config.getModels ? config.getModels() : config.models ?? []);
  assert.ok(allModels.some((model: any) => model.id === "valid-a"));
  assert.ok(allModels.some((model: any) => model.id === "missing-fields"), "missing-fields 以兼容默认注册");
  assert.ok(!allModels.some((model: any) => model.id === "bad-type"));
});
