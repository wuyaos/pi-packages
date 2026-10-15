import assert from "node:assert/strict";
import test from "node:test";
import { defaultThinkingLevel, describeThinking, editModelParameters, parsePositiveScaledInteger } from "../src/model-editor.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const chat: any = { type: "chat", id: "c", name: "Chat", api: "openai-responses", input: ["text"], cost: { ...cost }, reasoning: false, contextWindow: 128000, maxTokens: 16384 };

function context(driveEditor: (component: any) => void, renders: string[] = [], options: any[] = []): any {
  return { ui: {
    custom: async (factory: any, optionsArg?: any) => new Promise((resolve, reject) => {
      options.push(optionsArg);
      const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } };
      const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v };
      Promise.resolve(factory(tui, theme, {}, resolve)).then((component: any) => {
        renders.push(component.render(100).join("\n"));
        if (renders.at(-1)?.includes("Apply model parameters to the draft?")) component.handleInput("\x13");
        else driveEditor(component);
      }, reject);
    }),
  } };
}

function replaceInput(component: any, value: string): void {
  for (let index = 0; index < 32; index++) component.handleInput("\x7f");
  component.handleInput(value);
  component.handleInput("\r");
}

function down(component: any, count = 1): void { for (let index = 0; index < count; index++) component.handleInput("\x1b[B"); }

test("K/M positive integer parser is strict", () => {
  assert.equal(parsePositiveScaledInteger("64K"), 64000); assert.equal(parsePositiveScaledInteger("1.5K"), 1500); assert.equal(parsePositiveScaledInteger("1M"), 1000000); assert.equal(parsePositiveScaledInteger("0"), undefined); assert.equal(parsePositiveScaledInteger("bad"), undefined);
});

test("thinking default level and provenance are visible in the full-screen editor", async () => {
  const renders: string[] = [];
  const reasoning = { ...chat, reasoning: true, thinkingLevelMap: { medium: null, high: "high" } };
  assert.equal(defaultThinkingLevel(reasoning), "high");
  assert.match(describeThinking("en", reasoning, { thinkingSource: "protocol" }), /Default thinking level: high.*protocol default/u);
  await editModelParameters(context((component) => component.handleInput("\x1b"), renders), "en", reasoning, { type: "chat", id: "c", thinkingSource: "protocol" });
  assert.match(renders[0] ?? "", /Edit model parameters: c/u);
  assert.match(renders[0] ?? "", /→ Name/u);
  assert.match(renders[0] ?? "", /\[Enter\] Modify field.*\[Ctrl\+S\] Apply to draft.*\[Esc\] Back/u);
});

test("full-screen editor changes all managed chat fields in memory and marks user provenance", async () => {
  const options: any[] = [];
  const result = await editModelParameters(context((component) => {
    component.handleInput("\r"); replaceInput(component, "Edited"); // name
    down(component); component.handleInput("\r"); replaceInput(component, "64K"); // context
    down(component); component.handleInput("\r"); replaceInput(component, "2K"); // max
    down(component); component.handleInput("\r"); // reasoning toggle
    down(component, 4); component.handleInput("\r"); replaceInput(component, "medium-wire"); // thinking.medium
    down(component, 5); component.handleInput("\r"); // input.image
    down(component); component.handleInput("\r"); replaceInput(component, "1");
    down(component); component.handleInput("\r"); replaceInput(component, "2");
    down(component); component.handleInput("\r"); replaceInput(component, "3");
    down(component); component.handleInput("\r"); replaceInput(component, "4");
    component.handleInput("\x13");
  }, [], options), "en", chat, { type: "chat", id: "c", contextSource: "compat", maxTokensSource: "compat" });
  assert.equal(result?.model.name, "Edited");
  assert.equal((result?.model as any).contextWindow, 64000); assert.equal((result?.model as any).maxTokens, 2000);
  assert.equal((result?.model as any).reasoning, true); assert.deepEqual((result?.model as any).input.sort(), ["image", "text"]);
  assert.equal((result?.model as any).thinkingLevelMap.medium, "medium-wire");
  assert.deepEqual(result?.model.cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.equal(result?.metadata.contextSource, "user"); assert.equal(result?.metadata.maxTokensSource, "user"); assert.equal(result?.metadata.thinkingSource, "user");
  assert.equal(options[0]?.overlay, true);
});

test("editor validates K/M bounds and costs without mutating invalid values", async () => {
  const renders: string[] = [];
  const result = await editModelParameters(context((component) => {
    down(component, 2); component.handleInput("\r"); replaceInput(component, "256K");
    down(component, 11); component.handleInput("\r"); replaceInput(component, "-1");
    component.handleInput("\x13");
  }, renders), "en", chat, { type: "chat", id: "c" });
  assert.equal((result?.model as any).maxTokens, 16384);
  assert.equal(result?.model.cost.input, 0);
});

test("thinking map null, image output and Esc cancel follow the draft-only contract", async () => {
  const image: any = { type: "image", id: "i", name: "I", api: "openrouter-images", input: ["text"], output: ["image"], cost: { ...cost } };
  const edited = await editModelParameters(context((component) => {
    down(component, 3); component.handleInput("\r"); // output:text toggle
    component.handleInput("\x13");
  }), "en", image, { type: "image", id: "i" });
  assert.deepEqual((edited?.model as any).output.sort(), ["image", "text"]);

  const mapped = await editModelParameters(context((component) => {
    down(component, 4); component.handleInput("\r"); replaceInput(component, "-");
    component.handleInput("\x13");
  }), "en", { ...chat, reasoning: true }, { type: "chat", id: "c" });
  assert.equal((mapped?.model as any).thinkingLevelMap.off, null);
  assert.equal(mapped?.metadata.thinkingSource, "user");

  const original = structuredClone(chat);
  const cancelled = await editModelParameters(context((component) => { component.handleInput("\r"); replaceInput(component, "Lost"); component.handleInput("\x1b"); }), "en", original, { type: "chat", id: "c" });
  assert.equal(cancelled, undefined);
  assert.equal(original.name, "Chat");
});
