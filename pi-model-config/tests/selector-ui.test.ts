import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyChanges } from "../src/command.ts";
import { candidateFromExternal, candidateFromInstalled, candidateFromManaged, mergeCandidates, selectModels, type ModelPanelState } from "../src/selector.ts";
import { secretInput } from "../src/ui.ts";
import type { CandidateModel, ManagedChatModel, ProviderDraft, SelectionResult } from "../src/types.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};
const tui = { requestRender() {} };
const keybindings = {};

function chat(id: string, name = id): ManagedChatModel {
  return {
    type: "chat",
    id,
    name,
    api: "openai-completions",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
}

function remoteChat(id: string, name = id): CandidateModel {
  return { ...chat(id, name), source: "remote", mutableType: true };
}

const draft: ProviderDraft = {
  id: "fixture",
  name: "Fixture",
  owned: true,
  enabled: true,
  authMode: "anonymous",
  authHeader: "none",
  chatApi: "openai-completions",
  classifierApi: "typesafe-system-one",
  imageApi: "openrouter-images",
  defaultType: "chat",
};

function customContext<T>(drive: (component: any) => void | Promise<void>, rows = 24, columns = 100, onOptions?: (options: any) => void): any {
  return {
    ui: {
      custom: async (factory: any, options?: any): Promise<T> => new Promise<T>(async (resolve, reject) => {
        try {
          onOptions?.(options);
          const component = await factory({ ...tui, terminal: { rows, columns } }, theme, keybindings, resolve);
          await drive(component);
        } catch (error) {
          reject(error);
        }
      }),
    },
  };
}

test("catalog thinking metadata is preserved without protocol replacement", () => {
  const catalog = candidateFromInstalled({ ...chat("catalog"), reasoning: false, thinkingLevelMap: { high: "catalog-high", max: null } } as any) as ManagedChatModel & CandidateModel;
  assert.equal(catalog.reasoning, false);
  assert.deepEqual(catalog.thinkingLevelMap, { high: "catalog-high", max: null });
  assert.equal(catalog.thinkingSource, "catalog");
});

test("候选 merge 以 managed/external/installed 元数据优先，远程只补新增 identity", () => {
  const managed = candidateFromManaged({ ...chat("same", "managed-name"), contextWindow: 111 });
  const installed = { ...candidateFromManaged({ ...chat("same", "installed-name"), contextWindow: 222 }), source: "installed" as const };
  const remote = remoteChat("same", "remote-name");
  const remoteOnly = remoteChat("model-10", "remote-only");

  const merged = mergeCandidates("fixture", [installed], [managed], [remote, remoteOnly]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((row) => row.id === "same")?.name, "managed-name");
  assert.equal((merged.find((row) => row.id === "same") as ManagedChatModel).contextWindow, 111);
  assert.equal(merged.find((row) => row.id === "model-10")?.source, "remote");
});

test("远程获取后取消再勾选仍保留 managed 模型字段、元数据并按原值保存", async () => {
  const managed: ManagedChatModel = {
    ...chat("preserve-after-fetch", "Configured model"),
    baseUrl: "https://provider.example/v1",
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.25, cacheWrite: 0.5 },
    reasoning: true,
    thinkingLevelMap: { off: null, medium: "configured-medium", high: "configured-high", max: null },
    contextWindow: 200_000,
    maxTokens: 16_000,
    headers: { "x-model-header": "configured" },
  };
  const metadata = { type: "chat" as const, id: managed.id, contextSource: "user" as const, maxTokensSource: "user" as const, thinkingSource: "user" as const };
  const remote = {
    ...remoteChat(managed.id, "Remote replacement"),
    contextWindow: 128_000,
    maxTokens: 4_096,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const rows = mergeCandidates("fixture", [], [candidateFromManaged(managed, metadata)], [remote]);
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as ManagedChatModel).contextWindow, 200_000);

  const result = await selectModels(customContext<SelectionResult>((component) => {
    component.handleInput("\r"); // cancel the managed selection
    component.handleInput("\r"); // select it again
    component.handleInput("\x13"); // Ctrl+S
  }), "en", "fixture", draft, rows, [managed], undefined, [metadata]);

  assert.deepEqual(result.selected, [managed]);
  assert.deepEqual(result.metadata, [metadata]);
  const { type: _type, ...persisted } = managed;
  const saved = applyChanges({
    models: { providers: { fixture: { models: [persisted] } } },
    config: { version: 1, providers: { fixture: { owned: true, authMode: "anonymous", managedChatIds: [managed.id] } } },
  }, "fixture", draft, result.selected, new Set(), result.metadata);
  assert.deepEqual(saved.models.providers.fixture!.models, [persisted]);
  assert.equal((saved.models.providers.fixture!.models![0] as any).contextWindow, 200_000);
  assert.notEqual((saved.models.providers.fixture!.models![0] as any).contextWindow, 128_000);
});

test("会话内编辑后的模型在远程获取并重进 selector 后取消再勾选仍按编辑值保存", async () => {
  const persisted: ManagedChatModel = {
    ...chat("session-edited", "Persisted model"),
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    reasoning: true,
    thinkingLevelMap: { high: "persisted-high" },
    contextWindow: 200_000,
    maxTokens: 16_000,
  };
  const sessionEdited: ManagedChatModel = { ...persisted, contextWindow: 240_000, thinkingLevelMap: { high: "session-high", max: null } };
  const metadata = { type: "chat" as const, id: persisted.id, contextSource: "user" as const, maxTokensSource: "user" as const, thinkingSource: "user" as const };
  const remote = { ...remoteChat(persisted.id, "Remote stale value"), contextWindow: 128_000, maxTokens: 1_024, reasoning: false };
  // `rows` models the catalog assembled after fetch; `sessionEdited` is the unsaved draft passed when reopening.
  const rows = mergeCandidates("fixture", [], [candidateFromManaged(persisted, metadata)], [remote]);
  const result = await selectModels(customContext<SelectionResult>((component) => {
    component.handleInput("\r");
    component.handleInput("\r");
    component.handleInput("\x13");
  }), "en", "fixture", draft, rows, [sessionEdited], undefined, [metadata]);

  assert.deepEqual(result.selected, [sessionEdited]);
  assert.deepEqual(result.metadata, [metadata]);
  const { type: _persistedType, ...persistedJson } = persisted;
  const saved = applyChanges({
    models: { providers: { fixture: { models: [persistedJson] } } },
    config: { version: 1, providers: { fixture: { owned: true, authMode: "anonymous", managedChatIds: [persisted.id] } } },
  }, "fixture", draft, result.selected, new Set(), result.metadata);
  assert.equal((saved.models.providers.fixture!.models![0] as any).contextWindow, 240_000);
  assert.notEqual((saved.models.providers.fixture!.models![0] as any).contextWindow, 128_000);
  assert.deepEqual((saved.models.providers.fixture!.models![0] as any).thinkingLevelMap, { high: "session-high", max: null });
});

test("搜索只缩小当前集合，Ctrl+A 选择过滤结果且保留已有 managed selection", async () => {
  const managed = candidateFromManaged(chat("kept", "existing"));
  const remote = remoteChat("remote-only", "Needle Model");
  let rendered = "";
  const ctx = customContext<SelectionResult>((component) => {
    component.handleInput("/");
    component.handleInput("needle");
    rendered = component.render(100).join("\n");
    component.handleInput("\x01"); // Ctrl+A
    component.handleInput("\x13"); // Ctrl+S
  });

  const result = await selectModels(ctx, "en", "fixture", draft, [managed, remote]);
  assert.equal(result.cancelled, false);
  assert.match(rendered, /remote-only/u);
  assert.doesNotMatch(rendered, /kept/u);
  assert.deepEqual(result.selected.map((model) => model.id).sort(), ["kept", "remote-only"]);
});

test("space remains search input while Enter toggles model selection", async () => {
  const remote = remoteChat("space-search", "Needle Model");
  let rendered = "";
  const ctx = customContext<SelectionResult>((component) => {
    component.handleInput("/");
    component.handleInput("/");
    component.handleInput("needle");
    component.handleInput(" ");
    component.handleInput("model");
    rendered = component.render(80).join("\n");
    component.handleInput("\x13");
  });
  const result = await selectModels(ctx, "en", "fixture", draft, [remote]);
  assert.match(rendered, /space-search/u);
  assert.deepEqual(result.selected, []);
});

test("类型切换遇到同 identity 冲突时拒绝，remote selection key 不被破坏", async () => {
  const classifier: CandidateModel = {
    type: "classifier",
    id: "duplicate",
    name: "Existing classifier",
    api: "typesafe-system-one",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4_096,
    source: "remote",
    mutableType: true,
  };
  const chatRow = remoteChat("duplicate", "Remote chat");
  let rendered = "";
  const ctx = customContext<SelectionResult>((component) => {
    component.handleInput("\x14"); // Ctrl+T
    rendered = component.render(100).join("\n");
    component.handleInput("\x13");
  });

  const result = await selectModels(ctx, "en", "fixture", draft, [chatRow, classifier]);
  assert.match(rendered, /Cannot change to Classification: Classification\/duplicate already exists/u);
  assert.equal(chatRow.type, "chat");
  assert.deepEqual(result.selected, []);
});

test("model panel uses overlay sizing and responsive 80/48 column layouts", async () => {
  const row = remoteChat("responsive", "Responsive model");
  let overlayOptions: any;
  let wide: string[] = [];
  const wideCtx = customContext<SelectionResult>((component) => {
    wide = component.render(76); // 96% overlay width on an 80-column terminal
    component.handleInput("\x1b");
  }, 18, 80, (options) => { overlayOptions = options; });
  await selectModels(wideCtx, "en", "fixture", draft, [row]);
  assert.equal(overlayOptions.overlay, true);
  assert.equal(overlayOptions.overlayOptions.width, "96%");
  assert.ok(wide.some((line) => line.includes("Model name")));
  assert.ok(wide.some((line) => line.includes("[Ctrl+R] Fetch remote model list")));
  assert.match(wide.join("\n"), /→ \[ \] \[Chat\]/u);
  assert.ok(wide.every((line) => visibleWidth(line) <= 76));

  let narrow: string[] = [];
  const narrowCtx = customContext<SelectionResult>((component) => {
    component.handleInput("\t"); // list -> details
    narrow = component.render(48);
    component.handleInput("\x1b");
  }, 20, 48);
  await selectModels(narrowCtx, "en", "fixture", draft, [row]);
  assert.ok(narrow.some((line) => line.includes("Model name")));
  assert.ok(narrow.some((line) => line.includes("[Ctrl+R] Fetch remote model list")));
  assert.ok(narrow.every((line) => visibleWidth(line) <= 48));
  assert.ok(narrow.length <= Math.max(4, Math.floor(20 * 0.9)));
});

test("model search focus handles CSI, SS3, and Kitty arrows with clamp and filtered details", async () => {
  const rows = [0, 1, 2, 3].map((index) => remoteChat(`model-${index}`, `Model ${index}`));
  const state: ModelPanelState = { search: "", focus: "search", actionIndex: 0, detailScroll: 0 };
  let middle = "";
  let filtered = "";
  const ctx = customContext<SelectionResult>((component) => {
    component.focused = true;
    component.handleInput("\x1b[B");
    component.handleInput("\x1bOB");
    component.handleInput("\x1b[1;1B");
    component.handleInput("\x1b[1;1B"); // clamp bottom
    assert.equal(state.selectedId, "model-3");
    component.handleInput("\x1b[1;1A");
    middle = component.render(76).join("\n");
    component.handleInput("model-1");
    filtered = component.render(76).join("\n");
    component.handleInput("\x1b[A"); // clamp filtered top
    component.handleInput("\x1b");
  });
  await selectModels(ctx, "en", "fixture", draft, rows, undefined, state);
  assert.equal(state.focus, "search");
  assert.match(middle, /Model name: Model 2/u);
  assert.match(filtered, /Model name: Model 1/u);
  assert.doesNotMatch(filtered, /Model name: Model 2/u);
  assert.equal(state.selectedId, "model-1");
});

test("model defaults to list and slash explicitly focuses search", async () => {
  const state: ModelPanelState = { search: "", focus: "list", actionIndex: 0, detailScroll: 0 };
  const ctx = customContext<SelectionResult>((component) => { component.handleInput("/"); assert.equal(state.focus, "search"); component.handleInput(""); });
  await selectModels(ctx, "en", "fixture", draft, [remoteChat("slash")], undefined, state);
});

test("model footer shortcuts are global and fetch preserves current selection", async () => {
  const remote = remoteChat("fetch-selected", "Fetch selected");
  const state: ModelPanelState = { search: "fetch", selectedId: "fetch-selected", focus: "details", actionIndex: 0, detailScroll: 0 };
  const ctx = customContext<SelectionResult>((component) => component.handleInput("\x12")); // Ctrl+R
  const result = await selectModels(ctx, "en", "fixture", draft, [remote], [chat("fetch-selected", "Fetch selected")], state);
  assert.equal(result.action, "fetch");
  assert.deepEqual(result.selected.map((model) => model.id), ["fetch-selected"]);
  assert.equal(state.focus, "details");
});

test("model footer remote action is focusable and Enter executes fetch", async () => {
  const remote = remoteChat("footer-fetch", "Footer fetch");
  const state: ModelPanelState = { search: "", focus: "actions", actionIndex: 7, detailScroll: 0 };
  let rendered = "";
  const ctx = customContext<SelectionResult>((component) => {
    rendered = component.render(76).join("\n");
    component.handleInput("\r");
  });
  const result = await selectModels(ctx, "en", "fixture", draft, [remote], undefined, state);
  assert.equal(result.action, "fetch");
  assert.match(rendered, /→ \[Ctrl\+R\] Fetch remote model list/u);
});

test("new chat created by type cycling defaults reasoning and the protocol map", async () => {
  const row: CandidateModel = {
    type: "classifier", id: "new-chat", name: "New chat", api: "typesafe-system-one", input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_192, source: "remote", mutableType: true,
  };
  const ctx = customContext<SelectionResult>((component) => {
    component.handleInput("\x14"); // classifier -> image
    component.handleInput("\x14"); // image -> chat
    component.handleInput("\r");
    component.handleInput("\x13");
  });
  const result = await selectModels(ctx, "en", "fixture", { ...draft, chatApi: "openai-responses" }, [row]);
  const model = result.selected[0] as ManagedChatModel;
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap?.off, null);
  assert.equal(result.metadata[0]?.thinkingSource, "protocol");
});

test("reopening the selector preserves user thinking provenance from parameter editing", async () => {
  const row = { ...remoteChat("edited"), reasoning: true, thinkingLevelMap: { high: "user-high", max: null }, thinkingSource: "protocol" as const };
  const selected = [{ ...row, type: "chat" as const }].map(({ source: _source, mutableType: _mutable, thinkingSource: _sourceMeta, ...model }) => model as ManagedChatModel);
  const ctx = customContext<SelectionResult>((component) => component.handleInput("\x13"));
  const result = await selectModels(ctx, "en", "fixture", draft, [row], selected, undefined, [{ type: "chat", id: "edited", thinkingSource: "user" }]);
  assert.equal(result.metadata[0]?.thinkingSource, "user");
  assert.deepEqual((result.selected[0] as ManagedChatModel).thinkingLevelMap, { high: "user-high", max: null });
});

test("type cycling preserves known remote chat metadata across classifier and image", async () => {
  const row = remoteChat("metadata", "Metadata model") as CandidateModel & ManagedChatModel;
  row.contextWindow = 99_999;
  row.maxTokens = 7_777;
  row.reasoning = true;
  const rows: CandidateModel[] = [row];
  const ctx = customContext<SelectionResult>((component) => {
    component.handleInput("\x14"); // chat -> classifier
    component.handleInput("\x14"); // classifier -> image
    component.handleInput("\x14"); // image -> chat
    component.handleInput("\x13");
  });
  await selectModels(ctx, "en", "fixture", draft, rows);
  assert.equal(rows[0]!.type, "chat");
  if (rows[0]!.type !== "chat") throw new Error("expected chat model");
  assert.equal(rows[0]!.contextWindow, 99_999);
  assert.equal(rows[0]!.maxTokens, 7_777);
  assert.equal(rows[0]!.reasoning, true);
});

test("models.json 外部模型默认选中且可直接取消勾选，不再需要接管", async () => {
  const external = candidateFromExternal(chat("external", "External model"));
  assert.equal(external.readOnly, undefined);
  let rendered = "";
  const ctx = customContext<SelectionResult>((component) => {
    rendered = component.render(100).join("\n");
    component.handleInput("\r"); // uncheck the external row directly
    component.handleInput("\x04"); // Ctrl+D
    component.handleInput("\x13");
  });

  const result = await selectModels(ctx, "en", "fixture", draft, [external]);
  assert.doesNotMatch(rendered, /read-only/u);
  assert.match(rendered, /→ \[✓\]/u);
  assert.deepEqual(result.selected, []);
});

test("runtime catalog rows stay read-only and cannot be unchecked", async () => {
  const installed = candidateFromInstalled(chat("catalog", "Catalog model") as any);
  let rendered = "";
  const ctx = customContext<SelectionResult>((component) => {
    component.handleInput("\r"); // read-only rows ignore toggling
    rendered = component.render(100).join("\n");
    component.handleInput("\x13");
  });
  const result = await selectModels(ctx, "en", "fixture", draft, [installed]);
  assert.equal(installed.readOnly, true);
  assert.equal(installed.readOnlyReason, "runtime-catalog");
  assert.match(rendered, /read-only/u);
  assert.match(rendered, /→ \[ \]/u);
  assert.doesNotMatch(rendered, /→ \[✓\]/u);
  assert.deepEqual(result.selected, []);
});

test("edit action identifies external models as directly editable", async () => {
  const external = candidateFromExternal(chat("external-edit", "External edit"));
  const result = await selectModels(customContext<SelectionResult>((component) => component.handleInput("\x05")), "en", "fixture", draft, [external]);
  assert.equal(result.action, "edit");
  assert.deepEqual(result.target, { id: "external-edit", type: "chat", source: "external", readOnlyReason: undefined });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0]!.id, "external-edit");
});

test("model details show thinking default/source plus input, image output, and cost", async () => {
  const reasoning = { ...remoteChat("thinking-detail"), reasoning: true, thinkingLevelMap: { medium: "medium" }, thinkingSource: "remote" as const };
  let chatDetails = "";
  await selectModels(customContext<SelectionResult>((component) => { component.handleInput("\t"); chatDetails = component.render(100).join("\n"); component.handleInput("\x1b"); }), "en", "fixture", draft, [reasoning]);
  assert.match(chatDetails, /Default thinking level: medium[\s\S]*remote catalog/u);
  assert.match(chatDetails, /Input modalities: text/u);
  assert.match(chatDetails, /Cost: input 0[\s\S]*cache[\s\S]*write 0/u);

  const image: CandidateModel = { type: "image", id: "image-detail", name: "Image", api: "openrouter-images", input: ["text", "image"], output: ["image", "text"], cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, source: "remote", mutableType: true };
  let imageDetails = "";
  await selectModels(customContext<SelectionResult>((component) => { component.handleInput("\t"); imageDetails = component.render(100).join("\n"); component.handleInput("\x1b"); }), "en", "fixture", draft, [image]);
  assert.match(imageDetails, /Output modalities: image, text/u);
});

test("F2 is ignored outside overview and model state remains intact", async () => {
  const remote = remoteChat("selected", "Selected model");
  const state: ModelPanelState = { search: "selected", selectedId: "selected", focus: "details", actionIndex: 0, detailScroll: 0 };
  const ctx = customContext<SelectionResult>((component) => { component.handleInput("\x1bOQ"); component.handleInput("\x1b"); });
  const result = await selectModels(ctx, "en", "fixture", draft, [remote], [chat("selected", "Selected model")], state);
  assert.equal(result.action, "back");
  assert.deepEqual(state, { search: "selected", selectedId: "selected", focus: "details", actionIndex: 0, detailScroll: 0 });
});

test("masked key 支持跨 chunk bracketed paste，过滤终端控制序列且从不渲染明文", async () => {
  let rendered = "";
  const ctx = customContext<string | undefined>((component) => {
    component.focused = true;
    component.handleInput("\x1b[20");
    component.handleInput("0~abc\x1b[31mDEF");
    component.handleInput("\x1b]0;window-title\x07ghi\x1b[20");
    component.handleInput("1~");
    rendered = component.render(16).join("\n");
    component.handleInput("\r");
  });

  const value = await secretInput(ctx, "en", "Fixture key");
  assert.equal(value, "abcDEFghi");
  assert.doesNotMatch(rendered, /abc|DEF|ghi|window-title/u);
  assert.match(rendered, /•/u);
  assert.ok(rendered.split("\n").every((line) => visibleWidth(line) <= 16));
});

test("model action focus uses left/right while up/down do not change action", async () => {
  const state: ModelPanelState = { search: "", focus: "actions", actionIndex: 4, detailScroll: 0 };
  const ctx = customContext<SelectionResult>((component) => {
    component.handleInput("\x1b[A"); assert.equal(state.actionIndex, 4);
    component.handleInput("\x1b[C"); assert.equal(state.actionIndex, 5);
    component.handleInput("\x1b[D"); assert.equal(state.actionIndex, 4);
    component.handleInput("\x1b");
  });
  await selectModels(ctx, "en", "fixture", draft, [remoteChat("nav")], undefined, state);
});
