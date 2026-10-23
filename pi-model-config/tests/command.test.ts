import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL , fileURLToPath } from "node:url";
import test from "node:test";
import type { ManagedChatModel } from "../src/types.ts";
import { buildDiscoveryCandidates } from "../src/discovery.ts";
import { applyChanges, buildBuiltinProviderChoices, buildConfiguredProviderChoices, parseManagedChat, registerModelConfigCommand, removeProvider } from "../src/command.ts";
import { parseModelConfig, snapshot } from "../src/config.ts";

const sdkRoot = process.env.PI_MODEL_CONFIG_TEST_SDK!;
const loader = await import(pathToFileURL(join(sdkRoot, "dist/core/extensions/loader.js")).href);
const events = await import(pathToFileURL(join(sdkRoot, "dist/core/event-bus.js")).href);

async function loadCommand(): Promise<any> {
  const extension = await loader.loadExtensionFromFactory(
    (pi: any) => registerModelConfigCommand(pi),
    process.cwd(),
    events.createEventBus(),
    loader.createExtensionRuntime(),
    "<pi-model-config-command-test>",
  );
  const command = extension.commands.get("model-config");
  assert.ok(command, "model-config command should be registered through the Pi SDK loader");
  return command;
}

function context(ui: any, model?: any): any {
  return {
    mode: "tui",
    model,
    hasUI: true,
    ui,
    modelRegistry: {
      getModelsOfType: () => [],
      getProviderAuth: async () => undefined,
    },
  };
}

test("configured and builtin provider choices are separated and bilingual", () => {
  const models = { providers: { configured: { name: "Configured Name", models: [] }, custom: { models: [] } } } as any;
  const config = {
    version: 1,
    providers: {
      custom: { owned: true, authMode: "anonymous" },
      "config-only": { authMode: "reuse-pi" },
    },
  } as any;

  const zh = buildConfiguredProviderChoices("zh-CN", new Set(["configured"]), models, config);
  assert.deepEqual(zh.map((item) => item.id), ["custom", "configured", "config-only"]);
  assert.match(zh.find((item) => item.id === "custom")!.label, /自定义/u);
  assert.match(zh.find((item) => item.id === "configured")!.label, /Configured Name \(configured\).*内置/u);
  assert.match(zh.find((item) => item.id === "config-only")!.label, /自定义/u);
  assert.doesNotMatch(zh.map((item) => item.label).join("\n"), /已配置（未验证）|外部\/只读/u);
  assert.equal(zh.some((item) => item.id === "extension-only"), false);

  const en = buildConfiguredProviderChoices("en", new Set(["configured"]), models, config);
  assert.match(en.find((item) => item.id === "custom")!.label, /Custom/u);
  assert.match(en.find((item) => item.id === "configured")!.label, /Built-in/u);

  const builtinZh = buildBuiltinProviderChoices("zh-CN", ["openai", "anthropic"]);
  assert.deepEqual(builtinZh.map((item) => item.id), ["anthropic", "openai"]);
  assert.ok(builtinZh.every((item) => item.label.includes("内置")));
  const builtinEn = buildBuiltinProviderChoices("en", ["openai"]);
  assert.match(builtinEn[0]!.label, /Built-in/u);
});

test("configured provider choices use a deterministic ID tie-breaker", () => {
  const choices = buildConfiguredProviderChoices("en", new Set(), { providers: { zeta: {}, alpha: {}, disabled: {} } }, { version: 1, providers: { zeta: { authMode: "reuse-pi" }, alpha: { authMode: "reuse-pi" }, disabled: { authMode: "reuse-pi", enabled: false } } });
  assert.deepEqual(choices.map((choice) => choice.id), ["alpha", "zeta", "disabled"]);
});

test("hidden remote IDs must be string arrays", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-hidden-remote-shape-"));
  try {
    const path = join(dir, "model-config.json");
    writeFileSync(path, JSON.stringify({ version: 1, providers: { p: { authMode: "reuse-pi", hiddenRemoteIds: ["ok", 1] } } }));
    assert.throws(() => parseModelConfig(snapshot(path)), (error: any) => error?.code === "MCFG_E_PROVIDER_SHAPE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyChanges omits empty hidden remote IDs", () => {
  const draft: any = { id: "p", name: "p", owned: false, enabled: true, authMode: "reuse-pi", authHeader: "auto", chatApi: "openai-completions", classifierApi: "typesafe-system-one", imageApi: "openrouter-images", defaultType: "chat", hiddenRemoteIds: [] };
  const next = applyChanges({ models: { providers: { p: { models: [] } } }, config: { version: 1, providers: { p: { authMode: "reuse-pi", hiddenRemoteIds: ["chat\u0000old"] } } } }, "p", draft, [], new Set());
  assert.equal("hiddenRemoteIds" in next.config.providers.p, false);
});

test("Discovery candidate derivation normalizes paths, removes query/hash, and uses resolved model bases", () => {
  const candidates = (baseUrl: string | undefined, fallback: string[] = []) => buildDiscoveryCandidates({ baseUrl, chatApi: "openai-completions" }, fallback);
  assert.equal(candidates("https://api.example.com/v1")[0], "https://api.example.com/v1/models");
  assert.equal(candidates("https://api.example.com/v1/")[0], "https://api.example.com/v1/models");
  assert.deepEqual(candidates("https://api.example.com/v1/models/"), ["https://api.example.com/v1/models"]);
  assert.equal(candidates("https://api.example.com/root?token=secret#part")[0], "https://api.example.com/root/models");
  assert.equal(candidates(undefined, ["https://resolved.example.com/custom/v1"])[0], "https://resolved.example.com/custom/v1/models");
  assert.deepEqual(candidates("not-a-url", ["https://resolved.example.com/v1"]), []);
});

test("takeover chat defaults thinking without overriding explicit existing values", () => {
  const provider: any = { api: "openai-responses" };
  const config: any = { authMode: "reuse-pi", chatApi: "openai-responses" };
  const defaulted = parseManagedChat({ id: "defaulted" }, provider, config, true) as any;
  assert.equal(defaulted.reasoning, true);
  assert.equal(defaulted.thinkingLevelMap.off, null);
  const explicit = parseManagedChat({ id: "explicit", reasoning: false, thinkingLevelMap: { high: "existing-high", max: null } }, provider, config, true) as any;
  assert.equal(explicit.reasoning, false);
  assert.deepEqual(explicit.thinkingLevelMap, { high: "existing-high", max: null });
  const unknown = parseManagedChat({ id: "unknown" }, { api: "unknown-api" } as any, { authMode: "reuse-pi", chatApi: "unknown-api" } as any, true) as any;
  assert.equal(unknown.reasoning, true);
  assert.equal(unknown.thinkingLevelMap, undefined);
});

test("adopting existing models preserves raw metadata and removing an adopted model leaves other providers unchanged", () => {
  const raw = { id: "existing", name: "Existing", api: "openai-completions", customField: { keep: true }, contextWindow: 777 };
  const files: any = {
    models: { providers: { target: { baseUrl: "http://127.0.0.1/v1", models: [raw] }, other: { models: [{ id: "other", custom: 1 }] } } },
    config: { version: 1, providers: { target: { authMode: "reuse-pi", owned: false, managedChatIds: [] } } },
  };
  const draft: any = {
    id: "target", name: "target", owned: false, enabled: true, baseUrl: "http://127.0.0.1/v1", authMode: "reuse-pi", authHeader: "bearer",
    chatApi: "openai-completions", classifierApi: "typesafe-system-one", imageApi: "openrouter-images",
    defaultType: "chat", defaultContextWindow: 128000, defaultMaxTokens: 8192,
  };
  const selected: ManagedChatModel = {
    type: "chat", id: "existing", name: "Existing", api: "openai-completions", input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 777, maxTokens: 8192,
  };
  const adopted = applyChanges(files, "target", draft, [selected], new Set(["existing"]));
  assert.equal((adopted.models.providers.target.models![0] as any).customField.keep, true);
  assert.equal((adopted.models.providers.target.models![0] as any).contextWindow, 777);
  assert.equal((adopted.models.providers.target.models![0] as any).maxTokens, 8192);
  assert.equal((adopted.models.providers.target.models![0] as any).reasoning, false);
  assert.deepEqual(adopted.config.providers.target.managedChatIds, ["existing"]);
  assert.deepEqual(adopted.models.providers.other, files.models.providers.other);

  const disabled = applyChanges(files, "target", { ...draft, enabled: false }, [selected], new Set(["existing"]));
  assert.equal(disabled.config.providers.target.enabled, false);

  const removed = applyChanges(files, "target", draft, [], new Set(["existing"]));
  assert.deepEqual(removed.models.providers.target.models, []);
  assert.deepEqual(removed.config.providers.target.managedChatIds, []);
  assert.deepEqual(removed.models.providers.other, files.models.providers.other);

  const edited = applyChanges(files, "target", draft, [{ ...selected, reasoning: true, thinkingLevelMap: { off: null, high: "high", max: null } }], new Set(["existing"]));
  const written = edited.models.providers.target.models![0] as any;
  assert.equal(written.reasoning, true);
  assert.deepEqual(written.thinkingLevelMap, { off: null, high: "high", max: null });
  assert.deepEqual(written.customField, { keep: true });
});

test("compat metadata persists explicit Pi values while image remains context-free", () => {
  const files: any = { models: { providers: { p: { models: [] } } }, config: { version: 1, providers: {} } };
  const draft: any = { id: "p", name: "p", owned: false, enabled: true, authMode: "reuse-pi", authHeader: "auto", chatApi: "openai-completions", classifierApi: "typesafe-system-one", imageApi: "openrouter-images", defaultType: "chat" };
  const chat: any = { type: "chat", id: "c", name: "c", api: "openai-completions", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 128000, maxTokens: 16384 };
  const image: any = { type: "image", id: "i", name: "i", api: "openrouter-images", input: ["text"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const next = applyChanges(files, "p", draft, [chat, image], new Set(), [{ type: "chat", id: "c", contextSource: "compat", maxTokensSource: "compat" }, { type: "image", id: "i" }]);
  assert.equal((next.models.providers.p.models![0] as any).contextWindow, 128000); assert.equal((next.models.providers.p.models![0] as any).maxTokens, 16384);
  assert.equal("contextWindow" in next.config.providers.p.models![0], false);
  assert.equal(next.config.providers.p.modelMetadata![0].contextSource, "compat");
});

function notifications() {
  const rows: Array<{ message: string; type?: string }> = [];
  return {
    rows,
    notify(message: string, type?: string) { rows.push({ message, type }); },
  };
}

async function withAgentDir<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("removeProvider removes only the target entries from both transaction values", () => {
  const files: any = {
    models: { providers: { custom: { models: [{ id: "c" }] }, other: { models: [{ id: "o" }] } } },
    config: { version: 1, providers: { custom: { authMode: "reuse-pi", owned: true }, other: { authMode: "anonymous" } } },
  };
  const next = removeProvider(files, "custom");
  assert.equal(next.models.providers.custom, undefined);
  assert.equal(next.config.providers.custom, undefined);
  assert.deepEqual(next.models.providers.other, files.models.providers.other);
  assert.deepEqual(next.config.providers.other, files.config.providers.other);
});

async function runDeleteOverview(dir: string, providerId: string, confirm: boolean, model?: any): Promise<Array<{ message: string; type?: string }>> {
  const command = await loadCommand();
  const notices = notifications();
  let visits = 0;
  const ui = { ...notices, select: async () => undefined, input: async () => undefined, custom: async (factory: any) => new Promise((resolve, reject) => {
    const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } }; const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
    Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => {
      const rendered = component.render(100).join("\n");
      if (visits++ > 10) { reject(new Error(`delete flow stalled: ${rendered}`)); return; }
      if (rendered.includes(`Delete provider ${providerId}?`) || rendered.includes(`删除服务商 ${providerId}？`)) component.handleInput(confirm ? "\x13" : "\r");
      else if (rendered.includes("Models and Providers") || rendered.includes("模型与服务商配置")) component.handleInput(rendered.includes(providerId) ? "\x1b[3^" : "\x1b");
      else component.handleInput("\x1b");
    }, reject);
  }) };
  await command.handler("", context(ui, model));
  return notices.rows;
}

test("provider deletion confirms by default, commits both files, and leaves auth.json untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-delete-custom-"));
  try {
    const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json"); const authPath = join(dir, "auth.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { custom: { apiKey: "$KEY", models: [{ id: "c" }] }, other: { models: [] } } }));
    writeFileSync(configPath, JSON.stringify({ version: 1, providers: { custom: { authMode: "models-json", owned: true, models: [] }, other: { authMode: "anonymous" } } }));
    writeFileSync(authPath, "{\"credentials\":{\"custom\":{\"token\":\"keep\"}}}");
    await withAgentDir(dir, async () => { const notices = await runDeleteOverview(dir, "custom", true); assert.ok(notices.some((row) => row.message.includes("deleted") || row.message.includes("删除"))); });
    assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers.custom, undefined);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).providers.custom, undefined);
    assert.equal(readFileSync(authPath, "utf8"), "{\"credentials\":{\"custom\":{\"token\":\"keep\"}}}");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("builtin deletion removes overlays and states that reload restores Pi catalog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-delete-builtin-"));
  try {
    const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { models: [] } } }));
    writeFileSync(configPath, JSON.stringify({ version: 1, providers: { openai: { authMode: "reuse-pi", models: [] } } }));
    await withAgentDir(dir, async () => { await runDeleteOverview(dir, "openai", true); });
    assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers.openai, undefined);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).providers.openai, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delete refuses current-session and unowned third-party providers before confirmation", async () => {
  for (const fixture of [
    { id: "current", models: { providers: { current: { models: [] } } }, config: { version: 1, providers: { current: { authMode: "reuse-pi", owned: true, models: [] } } }, model: { provider: "current", id: "c" }, expected: "当前会话" },
    { id: "third-party", models: { providers: {} }, config: { version: 1, providers: { "third-party": { authMode: "reuse-pi", owned: false, models: [] } } }, model: undefined, expected: "第三方" },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "pi-model-config-delete-blocked-"));
    try {
      const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
      writeFileSync(modelsPath, JSON.stringify(fixture.models)); writeFileSync(configPath, JSON.stringify(fixture.config));
      await withAgentDir(dir, async () => { const notices = await runDeleteOverview(dir, fixture.id, true, fixture.model); assert.ok(notices.some((row) => row.message.toLowerCase().includes(fixture.expected))); });
      assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")), fixture.models);
      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), fixture.config);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("delete confirmation defaults to cancel without writing either file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-delete-cancel-"));
  try {
    const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
    const models = { providers: { custom: { models: [] } } }; const config = { version: 1, providers: { custom: { authMode: "reuse-pi", owned: true, models: [] } } };
    writeFileSync(modelsPath, JSON.stringify(models)); writeFileSync(configPath, JSON.stringify(config));
    await withAgentDir(dir, async () => { await runDeleteOverview(dir, "custom", false); });
    assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")), models);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), config);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("overview cancel creates no configuration files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-command-cancel-"));
  try {
    await withAgentDir(dir, async () => {
      const command = await loadCommand();
      const ui = {
        ...notifications(), select: async () => undefined, input: async () => undefined,
        custom: async (factory: any) => new Promise((resolve, reject) => {
          const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } }; const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
          Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => component.handleInput("\x1b"), reject);
        }),
      };
      await command.handler("", context(ui));
      assert.equal(existsSync(join(dir, "models.json")), false);
      assert.equal(existsSync(join(dir, "model-config.json")), false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("current-session provider disable is blocked before confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-disable-current-"));
  try {
    const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
    const modelsText = JSON.stringify({ providers: { target: { models: [] } } });
    const configText = JSON.stringify({ version: 1, providers: { target: { enabled: true, authMode: "reuse-pi", managedChatIds: [], models: [] } } });
    writeFileSync(modelsPath, modelsText); writeFileSync(configPath, configText);
    await withAgentDir(dir, async () => {
      const command = await loadCommand(); const notices = notifications(); let visits = 0;
      const ui = { ...notices, select: async () => undefined, input: async () => undefined, custom: async (factory: any) => new Promise((resolve, reject) => {
        const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } }; const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
        Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => { if (visits++ === 0) component.handleInput("\x18"); else component.handleInput("\x1b"); }, reject);
      }) };
      await command.handler("", context(ui, { provider: "target", id: "active" }));
      assert.equal(readFileSync(configPath, "utf8"), configText);
      assert.ok(notices.rows.some((row) => row.message.includes("当前会话正在使用")));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("overview enable/disable executes directly without a confirmation panel", async () => {
  for (const enabled of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), `pi-model-config-toggle-${enabled}-`));
    try {
      const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
      const modelsText = JSON.stringify({ providers: { target: { models: [] } } });
      const configText = JSON.stringify({ version: 1, providers: { target: { enabled, authMode: "reuse-pi", managedChatIds: [], models: [] } } });
      writeFileSync(modelsPath, modelsText); writeFileSync(configPath, configText);
      await withAgentDir(dir, async () => {
        const command = await loadCommand(); let visits = 0;
        const ui = { ...notifications(), select: async () => undefined, input: async () => undefined, custom: async (factory: any) => new Promise((resolve, reject) => {
          const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } }; const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
          Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => {
            if (visits++ === 0) component.handleInput("\x18");
            else component.handleInput("\x1b");
          }, reject);
        }) };
        await command.handler("", context(ui));
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        assert.equal(config.providers.target.enabled, !enabled);
        assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")), JSON.parse(modelsText));
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("models.json-only custom provider can toggle and delete, while config-only third party remains blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-models-only-boundary-"));
  try {
    const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
    const modelsText = JSON.stringify({ providers: { models_only: { models: [] } } });
    writeFileSync(modelsPath, modelsText); writeFileSync(configPath, JSON.stringify({ version: 1, providers: {} }));
    await withAgentDir(dir, async () => {
      const command = await loadCommand(); let visits = 0;
      const ui = { ...notifications(), select: async () => undefined, input: async () => undefined, custom: async (factory: any) => new Promise((resolve, reject) => {
        const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } }; const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
        Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => component.handleInput(visits++ === 0 ? "\x18" : "\x1b"), reject);
      }) };
      await command.handler("", context(ui));
    });
    assert.equal(readFileSync(modelsPath, "utf8"), modelsText);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).providers.models_only.enabled, false);

    writeFileSync(configPath, JSON.stringify({ version: 1, providers: {} }));
    await withAgentDir(dir, async () => { await runDeleteOverview(dir, "models_only", true); });
    assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers.models_only, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("custom provider saves after preview confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-save-"));
  try {
    await withAgentDir(dir, async () => {
      const command = await loadCommand(); let visits = 0;
      const ui = {
        ...notifications(),
        select: async (title: string, options: string[]) => title === "添加服务商" ? options.find((option) => option.includes("添加自定义服务商")) : undefined,
        input: async (title: string) => title === "新服务商 ID" ? "fixture-provider" : undefined,
        custom: async (factory: any) => new Promise((resolve, reject) => {
          const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } }; const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
          Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => {
            switch (visits++) {
              case 0: component.handleInput("\x0e"); break;
              case 1: component.handleInput("\x0d"); break;
              case 2: component.handleInput("\x13"); break;
              case 3: component.handleInput("\x13"); break;
              case 4: component.handleInput("\x1b"); break;
              default: component.handleInput("\x1b");
            }
          }, reject);
        }),
      };
      await command.handler("", context(ui));
      const config = JSON.parse(readFileSync(join(dir, "model-config.json"), "utf8"));
      assert.equal(config.providers["fixture-provider"].enabled, true);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("managed parameter edit stays dirty through selector reopen and preview confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-edit-chain-"));
  try {
    const modelsPath = join(dir, "models.json");
    const configPath = join(dir, "model-config.json");
    const model = { id: "chat", name: "Original", api: "openai-responses", reasoning: true, thinkingLevelMap: { medium: "medium" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 };
    writeFileSync(modelsPath, JSON.stringify({ providers: { target: { api: "openai-responses", models: [model] } } }));
    writeFileSync(configPath, JSON.stringify({ version: 1, providers: { target: { authMode: "reuse-pi", managedChatIds: ["chat"], modelMetadata: [{ type: "chat", id: "chat", thinkingSource: "existing" }] } } }));
    writeFileSync(join(dir, "model-config-ui.json"), JSON.stringify({ version: 1, language: "en" }));
    await withAgentDir(dir, async () => {
      const command = await loadCommand();
      let preview = "";
      let draftApplied = false;
      let saveConfirmed = false;
      const ui = {
        ...notifications(),
        select: async () => undefined,
        input: async () => undefined,
        custom: async (factory: any) => new Promise((resolve, reject) => {
          const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } }; const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
          Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => {
            const rendered = component.render(100).join("\n");
            if (rendered.includes("Models and Providers")) component.handleInput(saveConfirmed ? "\x1b" : "\r");
            else if (rendered.includes("Provider connection settings")) { component.handleInput("\t"); component.handleInput("\t"); component.handleInput("\x1b[C"); component.handleInput("\r"); }
            else if (rendered.includes("Configure Models")) component.handleInput(draftApplied ? "\x13" : "\x05");
            else if (rendered.includes("Edit model parameters")) { component.handleInput("\r"); for (let index = 0; index < 32; index++) component.handleInput("\x7f"); component.handleInput("Edited"); component.handleInput("\r"); component.handleInput("\x13"); }
            else if (rendered.includes("Apply model parameters to the draft?")) { draftApplied = true; component.handleInput("\x13"); }
            else if (rendered.includes("Preview Changes")) { component.handleInput("\x1b[B"); preview = component.render(100).join("\n"); saveConfirmed = true; component.handleInput("\x13"); }
            else component.handleInput("\x1b");
          }, reject);
        }),
      };
      await command.handler("", context(ui));
      const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
      assert.equal(saved.providers.target.models[0].name, "Edited");
      assert.match(preview, /Modify models: Chat\/chat/u);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("preview save keeps legacy metadata and compatibility defaults without model requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-legacy-save-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected network request during save"); };
  try {
    const modelsPath = join(dir, "models.json");
    const configPath = join(dir, "model-config.json");
    const legacy = { type: "chat", id: "legacy", contextSource: "probed", maxTokensSource: "probed", thinkingSource: "probed", verifiedAt: "2026-10-01T00:00:00.000Z", probeLower: 64000, probeUpper: 128000, probeEstimated: true };
    writeFileSync(modelsPath, JSON.stringify({ providers: { target: { baseUrl: "https://example.test/v1", models: [{ id: "legacy", contextWindow: 64000, maxTokens: 4096 }, { id: "compat" }] } } }));
    writeFileSync(configPath, JSON.stringify({ version: 1, providers: { target: { owned: true, enabled: true, authMode: "anonymous", managedChatIds: ["legacy", "compat"], modelMetadata: [legacy] } } }));
    writeFileSync(join(dir, "model-config-ui.json"), JSON.stringify({ version: 1, language: "en" }));
    await withAgentDir(dir, async () => {
      const command = await loadCommand();
      const notices = notifications();
      let visits = 0;
      const ui = { ...notices, custom: async (factory: any) => new Promise((resolve, reject) => {
        const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } };
        const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
        Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => {
          const rendered = component.render(100).join("\n");
          assert.ok(visits < 4, `save flow stalled: ${rendered}`);
          component.handleInput(["\r", "\x13", "\x13", "\x1b"][visits++]!);
        }).catch(reject);
      }) };
      await command.handler("", context(ui));
      assert.equal(visits, 4);
      assert.ok(notices.rows.some((row) => row.message.includes("written transactionally")));
    });
    const savedConfig = parseModelConfig(snapshot(configPath));
    assert.deepEqual(savedConfig.providers.target.modelMetadata?.find((entry) => entry.id === "legacy"), legacy);
    const savedCompat = JSON.parse(readFileSync(modelsPath, "utf8")).providers.target.models.find((model: any) => model.id === "compat");
    assert.equal(savedCompat.contextWindow, 128000);
    assert.equal(savedCompat.maxTokens, 16384);
    assert.equal(requests, 0);
    const schema = JSON.parse(readFileSync(new URL("../model-config.schema.json", import.meta.url), "utf8"));
    const properties = schema.$defs.modelMetadata.properties;
    for (const key of ["contextSource", "maxTokensSource", "thinkingSource"]) {
      assert.ok(properties[key].enum.includes("probed"));
      assert.match(properties[key].description, /deprecated/iu);
    }
    for (const key of ["probeLower", "probeUpper", "probeEstimated"]) {
      assert.equal(properties[key].deprecated, true);
      assert.match(properties[key].description, /deprecated/iu);
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin source contains no ctx.ui.confirm calls", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = ["command.ts", "panel.ts"];
  for (const file of files) assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /ctx\.ui\.confirm\s*\(/u);
});

// Drive the registered command and its real TUI components against isolated transaction files.
for (const scenario of ["network-failure", "cancel", "complete-save", "undo", "fetch-complete-all", "external-edit"] as const) {
  test(`directory command round-trip: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-model-config-directory-"));
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const model = { ...(scenario === "external-edit" ? { contextWindow: 500000, maxTokens: 77777 } : {}), id: "gpt-5.1", name: "Configured name", api: "openai-completions", reasoning: false, thinkingLevelMap: { minimal: "minimal", high: "custom-high" }, input: ["text"], cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
    const metadata = { type: "chat", id: model.id, contextSource: "compat", maxTokensSource: "compat", thinkingSource: "existing", verifiedAt: "legacy-date", probeLower: 64000 };
    try {
      const modelsPath = join(dir, "models.json"), configPath = join(dir, "model-config.json");
      writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [model] } } }));
      writeFileSync(configPath, JSON.stringify({ version: 1, providers: { openai: { owned: true, authMode: "anonymous", managedChatIds: [model.id], modelMetadata: [metadata], discoveryUrl: "https://api.openai.com/v1/models" } } }));
      writeFileSync(join(dir, "model-config-ui.json"), JSON.stringify({ version: 1, language: "en" }));
      const beforeModels = readFileSync(modelsPath, "utf8"), beforeConfig = readFileSync(configPath, "utf8");
      globalThis.fetch = (async (url: any, init: any) => {
        requests++;
        if (scenario === "network-failure") throw new Error("offline");
        if (scenario === "cancel") return new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); });
        assert.equal(init?.headers?.authorization, undefined);
        if (String(url) === "https://models.dev/api.json") return new Response(readFileSync(new URL("./fixtures/models-directory.json", import.meta.url), "utf8"));
        assert.equal(String(url), "https://api.openai.com/v1/models");
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.1" }, { id: "gpt-5.1-chat-latest" }, { id: "no-catalog-match" }] }));
      }) as typeof fetch;
      await withAgentDir(dir, async () => {
        const command = await loadCommand(), notices = notifications();
        let entered = false, completed = false, selectorVisits = 0, connectionVisits = 0, saved = false, views = 0;
        let preview = "";
        const ui = {
          ...notices,
          custom: (factory: any) => new Promise((resolve, reject) => {
            let component: any;
            const done = (value: any) => { component?.dispose?.(); resolve(value); };
            const tui = { requestRender() {}, terminal: { rows: 30, columns: 120 } }, theme = { fg: (_c: string, value: string) => value, bold: (value: string) => value };
            try {
              component = factory(tui, theme, {}, done);
              const rendered = component.render(120).join("\n");
              assert.ok(++views < 22, `stalled: ${rendered}`);
              if (rendered.includes("Models and Providers")) { if (!entered) { entered = true; component.handleInput("\r"); } else component.handleInput("\x1b"); }
              else if (rendered.includes("Provider connection settings")) {
                connectionVisits++;
                if (scenario === "fetch-complete-all" && connectionVisits <= 2) component.handleInput(connectionVisits === 1 ? "\x12" : "\x10");
                else if ((scenario === "network-failure" || scenario === "cancel")) component.handleInput(completed ? "\x1b" : "\x10");
                else { component.handleInput("\t"); component.handleInput("\t"); component.handleInput("\x1b[C"); component.handleInput("\r"); }
                if (scenario === "network-failure" || scenario === "cancel") completed = true;
              } else if (rendered.includes("Fetching Models.dev") || rendered.includes("Fetching models")) {
                if (scenario === "cancel") component.handleInput("\x1b");
                // Other loader instances resolve from the mocked response.
              } else if (rendered.includes("Configure Models")) {
                selectorVisits++;
                if (scenario === "fetch-complete-all") {
                  assert.match(rendered, /directory\(exact\)/);
                  assert.match(rendered, /⌀/);
                  assert.match(rendered, /Selected 1/);
                  component.handleInput("\x13");
                } else if (selectorVisits === 1 || scenario === "undo" && selectorVisits === 2) component.handleInput("\x0b");
                else { assert.match(rendered, scenario === "undo" ? /Undid this model/ : scenario === "external-edit" ? /conflict/i : /directory\(exact\)/); component.handleInput("\x13"); }
              } else if (rendered.includes("Preview Changes")) {
                component.handleInput("\x1b[B"); preview = component.render(120).join("\n");
                if (scenario !== "undo" && scenario !== "external-edit") assert.match(preview, /gpt-5.1 · directory/);
                saved = true; component.handleInput("\x13");
              } else if (rendered.includes("Fetching")) {
                // Discovery loader.
              } else throw new Error(`Unexpected screen: ${rendered}`);
            } catch (error) { component?.dispose?.(); reject(error); }
          }),
        };
        await command.handler("", context(ui));
        if (scenario === "network-failure" || scenario === "cancel") {
          assert.equal(saved, false);
          if (scenario === "network-failure") assert.ok(notices.rows.some((row) => /network\/proxy/.test(row.message)));
          assert.equal(readFileSync(modelsPath, "utf8"), beforeModels);
          assert.equal(readFileSync(configPath, "utf8"), beforeConfig);
        } else {
          assert.equal(saved, true, JSON.stringify(notices.rows));
          const savedModel = JSON.parse(readFileSync(modelsPath, "utf8")).providers.openai.models[0];
          const savedMetadata = JSON.parse(readFileSync(configPath, "utf8")).providers.openai.modelMetadata.find((entry: any) => entry.id === model.id);
          assert.equal(savedModel.contextWindow, scenario === "external-edit" ? 500000 : scenario === "undo" ? 128000 : 400000);
          assert.equal(savedModel.maxTokens, scenario === "external-edit" ? 77777 : scenario === "undo" ? 16384 : 128000);
          assert.equal(savedModel.name, model.name);
          assert.deepEqual(savedModel.cost, model.cost);
          assert.deepEqual(savedModel.thinkingLevelMap, model.thinkingLevelMap);
          assert.equal(savedMetadata.contextSource, scenario === "undo" || scenario === "external-edit" ? "compat" : "directory");
          assert.equal(savedMetadata.verifiedAt, "legacy-date");
          assert.equal(savedMetadata.probeLower, 64000);
          assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers.openai.models.length, 1);
        }
      });
      if (scenario === "network-failure") assert.equal(requests, 1);
    } finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); }
  });
}

test("directory command undo stays isolated across providers and after save/reentry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-directory-isolation-"));
  const originalFetch = globalThis.fetch;
  const base = { id: "gpt-5.1", name: "Configured name", api: "openai-completions", reasoning: false, input: ["text"] };
  const compat = { type: "chat", id: base.id, contextSource: "compat", maxTokensSource: "compat" };
  const completed = { ...compat, contextSource: "directory", maxTokensSource: "directory", directoryFields: ["contextWindow", "maxTokens"], directoryMatchMethod: "variant" };
  try {
    const modelsPath = join(dir, "models.json"), configPath = join(dir, "model-config.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: {
      alpha: { baseUrl: "https://alpha.example.test/v1", models: [base] },
      beta: { baseUrl: "https://beta.example.test/v1", models: [{ ...base, contextWindow: 400000, maxTokens: 128000 }] },
    } }));
    writeFileSync(configPath, JSON.stringify({ version: 1, providers: Object.fromEntries(["alpha", "beta"].map((id) => [id, {
      owned: true, authMode: "anonymous", managedChatIds: [base.id], modelMetadata: [id === "alpha" ? compat : completed],
    }])) }));
    writeFileSync(join(dir, "model-config-ui.json"), JSON.stringify({ version: 1, language: "en" }));
    globalThis.fetch = (async () => new Response(readFileSync(new URL("./fixtures/models-directory.json", import.meta.url), "utf8"))) as typeof fetch;
    await withAgentDir(dir, async () => {
      const command = await loadCommand(), notices = notifications();
      let overviewVisits = 0, selectorVisits = 0, saves = 0, views = 0;
      const ui = { ...notices, custom: (factory: any) => new Promise((resolve, reject) => {
        let component: any;
        const done = (value: any) => { component?.dispose?.(); resolve(value); };
        try {
          component = factory({ requestRender() {}, terminal: { rows: 30, columns: 120 } }, { fg: (_c: string, v: string) => v, bold: (v: string) => v }, {}, done);
          const rendered = component.render(120).join("\n");
          assert.ok(++views < 30, rendered);
          if (rendered.includes("Models and Providers")) {
            overviewVisits++; selectorVisits = 0;
            if (overviewVisits === 4) component.handleInput("\x1b");
            else {
              if (overviewVisits === 2) component.handleInput("\x1b[B");
              if (overviewVisits === 3) component.handleInput("\x1b[A");
              component.handleInput("\r");
            }
          } else if (rendered.includes("Provider connection settings")) {
            assert.match(rendered, new RegExp(overviewVisits === 2 ? "beta" : "alpha"));
            component.handleInput("\t"); component.handleInput("\t"); component.handleInput("\x1b[C"); component.handleInput("\r");
          } else if (rendered.includes("Configure Models")) {
            if (++selectorVisits === 1) component.handleInput("\x0b");
            else {
              assert.doesNotMatch(rendered, /Undid this model/);
              assert.match(rendered, /directory\(variant\)/);
              component.handleInput("\x13");
            }
          } else if (rendered.includes("Preview Changes")) { saves++; component.handleInput("\x13"); }
          else if (!rendered.includes("Fetching Models.dev")) throw new Error(rendered);
        } catch (error) { component?.dispose?.(); reject(error); }
      }) };
      await command.handler("", context(ui));
      assert.equal(saves, 3, JSON.stringify(notices.rows));
      assert.equal(overviewVisits, 4);
      assert.ok(notices.rows.every((notice) => !/Undid this model/.test(notice.message)));
    });
    const savedModels = JSON.parse(readFileSync(modelsPath, "utf8"));
    const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    for (const id of ["alpha", "beta"]) {
      assert.equal(savedModels.providers[id].models[0].contextWindow, 400000);
      assert.equal(savedModels.providers[id].models[0].maxTokens, 128000);
      assert.equal(savedConfig.providers[id].modelMetadata[0].contextSource, "directory");
    }
  } finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); }
});
