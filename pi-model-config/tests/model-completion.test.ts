import assert from "node:assert/strict";
import test from "node:test";
import { completeDirectoryModel, planDirectoryCompletion, type CompletionSession } from "../src/model-completion.ts";
import { matchModelsDirectory } from "../src/models-directory.ts";
import { candidateFromManaged, selectModels } from "../src/selector.ts";
import { editModelParameters } from "../src/model-editor.ts";
import type { CandidateModel, ManagedChatModel, ModelMetadataEntry, ProviderDraft } from "../src/types.ts";
const directory = { openai: { models: { "gpt-test": { name: "GPT Test", reasoning: true, limit: { context: 200000, output: 32000 }, modalities: { input: ["text", "image"] }, reasoning_options: [{ type: "effort", values: ["low", "high"] }], cost: { input: 999 } } } } };
const hint = { providerId: "openai" };
const chat = (): ManagedChatModel => ({ type: "chat", id: "gpt-test", name: "custom name", api: "openai-completions", contextWindow: 128000, maxTokens: 16384, reasoning: false, thinkingLevelMap: { minimal: "minimal", max: null }, input: ["text"], cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
function context(drive?: (component: any, index: number) => void | Promise<void>): any {
  let index = 0;
  return { ui: { custom: (factory: any) => new Promise(async (resolve, reject) => { try { const component = factory({ requestRender() {}, terminal: { rows: 30, columns: 120 } }, theme, {}, resolve); if (drive) await drive(component, index++); else component.handleInput("\x13"); } catch (e) { reject(e); } }) } };
}
test("completion preserves concrete fields, maps/prices, fills compat only then undo then explicit compare", async () => {
  const model = chat(), before = structuredClone(model);
  const metadata: ModelMetadataEntry = { type: "chat", id: model.id, contextSource: "compat", maxTokensSource: "compat" };
  const originalMetadata = structuredClone(metadata), session: CompletionSession = new Map();
  const first = await completeDirectoryModel(context(), "en", directory, hint, model, metadata, session, true);
  assert.equal(first.conflicts, true);
  assert.equal(model.contextWindow, 200000);
  assert.equal(model.maxTokens, 32000);
  assert.equal(model.name, "custom name");
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.input, ["text"]);
  assert.deepEqual(model.thinkingLevelMap, before.thinkingLevelMap);
  assert.deepEqual(model.cost, before.cost);
  assert.equal(metadata.contextSource, "directory");
  const undone = await completeDirectoryModel(context(), "en", directory, hint, model, metadata, session, true);
  assert.equal(undone.undone, true);
  assert.deepEqual(model, before);
  assert.deepEqual(metadata, originalMetadata);
  const seen: string[] = [];
  await completeDirectoryModel(context((component) => { seen.push(component.render(120).join("\n")); component.handleInput("\x13"); }), "en", directory, hint, model, metadata, session, true);
  assert.equal(seen.length, 3); // name / input / reasoning; compat fields need no confirmation
  assert.equal(model.name, "GPT Test");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, before.thinkingLevelMap);
  assert.deepEqual(model.cost, before.cost);
});
test("batch completion never overrides conflicts even after repeated batches; keep defaults to no", async () => {
  const model = chat(), metadata: ModelMetadataEntry = { type: "chat", id: model.id };
  const session: CompletionSession = new Map(), before = structuredClone(model);
  await completeDirectoryModel(context(), "en", directory, hint, model, metadata, session, false);
  await completeDirectoryModel(context(), "en", directory, hint, model, metadata, session, false);
  assert.deepEqual(model, before);
  let comparisons = 0;
  await completeDirectoryModel(context((component) => { comparisons++; component.handleInput("\x1b"); }), "en", directory, hint, model, metadata, session, true);
  assert.equal(comparisons, 5);
  assert.deepEqual(model, before);
});
test("completion treats external token edits with stale compat provenance as conflicts", async () => {
  const model = { ...chat(), contextWindow: 500000, maxTokens: 77777 };
  const metadata: ModelMetadataEntry = { type: "chat", id: model.id, contextSource: "compat", maxTokensSource: "compat" };
  const plan = planDirectoryCompletion(model, metadata, matchModelsDirectory(directory, model.id, hint));
  assert.deepEqual(plan.changes, []);
  assert.ok(plan.conflicts.includes("contextWindow"));
  assert.ok(plan.conflicts.includes("maxTokens"));
  const before = structuredClone(model), session: CompletionSession = new Map();
  for (let i = 0; i < 2; i++) {
    const result = await completeDirectoryModel(context(), "en", directory, hint, model, metadata, session, false);
    assert.equal(result.conflicts, true);
    assert.deepEqual(model, before);
  }
  const compared: string[] = [];
  await completeDirectoryModel(context((component) => { compared.push(component.render(120).join("\n")); component.handleInput("\x1b"); }), "en", directory, hint, model, metadata, session, true);
  assert.ok(compared.some((view) => view.includes("500000") && view.includes("200000")));
  assert.ok(compared.some((view) => view.includes("77777") && view.includes("32000")));
  assert.deepEqual(model, before);
});
test("completion only treats compat token placeholders as missing, independently per field", () => {
  const model = chat(), result = matchModelsDirectory(directory, model.id, hint);
  const metadata: ModelMetadataEntry = { type: "chat", id: model.id, contextSource: "compat", maxTokensSource: "compat" };
  for (const [contextWindow, maxTokens, changes] of [[500000, 16384, ["maxTokens"]], [128000, 77777, ["contextWindow"]]] as const) {
    const plan = planDirectoryCompletion({ ...model, contextWindow, maxTokens }, metadata, result);
    assert.deepEqual(plan.changes, changes);
  }
});
test("completion does not overwrite subsequent manual edits on undo, and rejects inconsistent token pairs", async () => {
  const model = chat(), metadata: ModelMetadataEntry = { type: "chat", id: model.id, contextSource: "compat", maxTokensSource: "compat" }, session: CompletionSession = new Map();
  await completeDirectoryModel(context(), "en", directory, hint, model, metadata, session, true);
  model.name = "user changed after completion";
  await completeDirectoryModel(context((component) => component.handleInput("\x1b")), "en", directory, hint, model, metadata, session, true);
  assert.equal(model.name, "user changed after completion");
  const tiny = { openai: { models: { "gpt-test": { limit: { context: 100, output: 200 } } } } };
  const other = chat(), otherMetadata: ModelMetadataEntry = { type: "chat", id: other.id, contextSource: "compat", maxTokensSource: "compat" };
  const result = await completeDirectoryModel(context(), "en", tiny, hint, other, otherMetadata, new Map(), false);
  assert.equal(result.invalidLimits, true);
  assert.equal(other.contextWindow, 128000);
  assert.equal(other.maxTokens, 16384);
});
test("selector completion targets filtered editable chats only, Ctrl+R removed, and completed values survive cycle", async () => {
  const completed = chat(); completed.contextWindow = 200000; completed.maxTokens = 32000;
  const row: CandidateModel = { ...candidateFromManaged(completed, { type: "chat", id: completed.id, contextSource: "directory", maxTokensSource: "directory", directoryFields: ["contextWindow", "maxTokens"], directoryMatchMethod: "variant" }), mutableType: true };
  const readOnly = { ...candidateFromManaged({ ...chat(), id: "runtime" }), readOnly: true };
  const draft: ProviderDraft = { id: "openai", name: "OpenAI", owned: true, enabled: true, authMode: "anonymous", authHeader: "none", chatApi: "openai-completions", classifierApi: "typesafe-system-one", imageApi: "openai-images", defaultType: "chat" };
  const result = await selectModels(context((component) => {
    const render = component.render(120).join("\n");
    assert.match(render, /directory\(variant\)/);
    component.handleInput("\x12"); // no longer returns fetch
    component.handleInput("\x14"); component.handleInput("\x14"); component.handleInput("\x14");
    component.handleInput("\x0c");
  }), "en", "openai", draft, [row, readOnly], [completed]);
  assert.equal(result.action, "completeBatch");
  assert.equal(result.completionTargets?.length, 1);
  assert.equal((result.completionTargets?.[0] as ManagedChatModel).contextWindow, 200000);
  assert.equal(result.completionTargets?.[0]?.contextSource, "directory");
});
test("editor Ctrl+K closes before async completion, displays sources, retains apply confirmation", async () => {
  const model = chat(), metadata: ModelMetadataEntry = { type: "chat", id: model.id };
  const result = await editModelParameters(context((component, index) => {
    if (index === 0) component.handleInput("\x0b");
    else { if (index === 1) assert.match(component.render(120).join("\n"), /field provenance/); component.handleInput("\x13"); }
  }), "en", model, metadata, async (current, entry) => { if (current.type === "chat") current.contextWindow = 200000; entry.contextSource = "directory"; return ["field provenance"]; });
  assert.equal((result?.model as ManagedChatModel).contextWindow, 200000);
  assert.equal(result?.metadata.contextSource, "directory");
  assert.equal(model.contextWindow, 128000);
});
test("completion planning only fills absent values, not concrete false or text-only input", () => {
  const model = chat(), metadata: ModelMetadataEntry = { type: "chat", id: model.id };
  const plan = planDirectoryCompletion(model, metadata, matchModelsDirectory(directory, model.id, hint));
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.conflicts.length, 5);
});
