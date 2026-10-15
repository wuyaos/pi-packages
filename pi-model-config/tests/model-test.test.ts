import assert from "node:assert/strict";
import test from "node:test";
import { runModelAvailabilityTests, showModelTestFlow } from "../src/model-test.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const chat = (id: string) => ({ type: "chat", provider: "fixture", id, name: id, api: "openai-completions", input: ["text"], cost, reasoning: false, contextWindow: 1024, maxTokens: 16 }) as any;
const classifier = (id: string) => ({ type: "classifier", provider: "fixture", id, name: id, api: "typesafe-system-one", input: ["text"], cost, contextWindow: 1024 }) as any;
const image = (id: string) => ({ type: "image", provider: "fixture", id, name: id, api: "openrouter-images", input: ["text"], output: ["image"], cost }) as any;

async function* doneStream(delayMs: number, hooks?: { start(): void; end(): void }) {
  hooks?.start();
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  hooks?.end();
  yield { type: "done", message: { usage: { totalTokens: 1 } } };
}

test("model test worker queue never exceeds configured concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const registry = {
    streamSimple: () => doneStream(15, { start: () => { active++; maxActive = Math.max(maxActive, active); }, end: () => { active--; } }),
  };
  const results = await runModelAvailabilityTests([chat("a"), chat("b"), chat("c"), chat("d")], registry, new AbortController().signal, 2, { chat: 1000, classifier: 1000, image: 1000 });
  assert.equal(maxActive, 2);
  assert.ok(results.every((result) => result.status === "success"));
});

test("model test timeout and global abort are typed without deleting models", async () => {
  const registry = {
    streamSimple: (_model: any, _context: any, options: any) => (async function* () {
      await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    })(),
  };
  const keepAlive = setTimeout(() => {}, 50);
  const timeout = await runModelAvailabilityTests([chat("timeout")], registry, new AbortController().signal, 1, { chat: 5, classifier: 5, image: 5 });
  clearTimeout(keepAlive);
  assert.equal(timeout[0]?.status, "timeout");
  const controller = new AbortController();
  controller.abort(new DOMException("Cancelled", "AbortError"));
  const aborted = await runModelAvailabilityTests([chat("a"), chat("b")], registry, controller.signal, 2, { chat: 100, classifier: 100, image: 100 });
  assert.deepEqual(aborted.map((result) => result.status), ["aborted", "aborted"]);
});

function flowContext(confirm: (title: string) => Promise<boolean>, registry: any, drive: (visit: number, component: any) => void): any {
  let visit = 0;
  return {
    modelRegistry: registry,
    ui: {
      confirm,
      custom: async (factory: any) => new Promise((resolve, reject) => {
        const tui = { requestRender() {}, terminal: { rows: 24, columns: 100 } };
        const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
        let component: any;
        const done = (value: any) => { queueMicrotask(() => component?.dispose?.()); resolve(value); };
        Promise.resolve(factory(tui, theme, {}, done)).then((created) => { component = created; drive(visit++, component); }, reject);
      }),
    },
  };
}

test("global abort cancels all active model tests", async () => {
  const registry = { streamSimple: (_m: any, _c: any, options: any) => (async function* () { await new Promise((_r, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })); })() };
  const controller = new AbortController(); const keepAlive = setTimeout(() => controller.abort(new DOMException("Cancelled", "AbortError")), 5);
  const results = await runModelAvailabilityTests([chat("a"), chat("b")], registry, controller.signal, 2, { chat: 1000, classifier: 1000, image: 1000 });
  clearTimeout(keepAlive); assert.deepEqual(results.map((result) => result.status), ["aborted", "aborted"]);
});

test("chat/classifier default selected, image default skipped, and execution requires cost confirmation", async () => {
  let imageCalls = 0;
  const registry = {
    streamSimple: () => doneStream(0),
    classify: async () => ({ stopReason: "stop", answers: {}, usage: { totalTokens: 1 } }),
    generateImages: async () => { imageCalls++; return { stopReason: "stop", output: [] }; },
  };
  const confirms: string[] = [];
  const ctx = flowContext(async (title) => { confirms.push(title); return true; }, registry, (visit, component) => {
    if (visit === 0) component.handleInput("");
    else if (visit === 1) component.handleInput("");
    else if (visit === 3) component.handleInput("");
  });
  await showModelTestFlow(ctx, "en", [chat("chat"), classifier("classifier"), image("image")]);
  assert.equal(imageCalls, 0);
  assert.deepEqual(confirms, []);
});

test("selecting an image model requires a separate confirmation", async () => {
  let calls = 0;
  const registry = { generateImages: async () => { calls++; return { stopReason: "stop", output: [] }; } };
  const confirms: string[] = [];
  const ctx = flowContext(async (title) => { confirms.push(title); return false; }, registry, (visit, component) => {
    if (visit === 0) { component.handleInput(" "); component.handleInput("\x13"); }
    else component.handleInput("\x1b");
  });
  await showModelTestFlow(ctx, "en", [image("image")]);
  assert.equal(calls, 0);
  assert.deepEqual(confirms, []);
});

test("results use the shared horizontal ActionBar and Enter retries failures", async () => {
  let calls = 0;
  const registry = { streamSimple: () => ++calls === 1 ? (async function* () { yield { type: "error", error: { errorMessage: "fixture failure" } }; })() : doneStream(0) };
  let failedPanel = "";
  let successPanel = "";
  const ctx = flowContext(async () => false, registry, (visit, component) => {
    if (visit === 0) component.handleInput("\x13");
    else if (visit === 1 || visit === 4) { component.handleInput("\x1b[C"); component.handleInput("\r"); }
    else if (visit === 3) {
      failedPanel = component.render(100).join("\n");
      component.handleInput("\x1b[B");
      component.handleInput("\x1b[C");
      component.handleInput("\r");
    } else if (visit === 6) {
      successPanel = component.render(100).join("\n");
      component.handleInput("\x12"); // legacy Ctrl+R no longer activates the panel
      component.handleInput("\x1b");
    }
  });
  await showModelTestFlow(ctx, "en", [chat("retry")]);
  assert.equal(calls, 2);
  assert.match(failedPanel, /→ \[Esc\] Back.*Retry failures/u);
  assert.match(failedPanel, /←\/→ switch actions · Enter activate/u);
  assert.doesNotMatch(failedPanel + successPanel, /Ctrl\+R/u);
});

test("chat SDK errorMessage is classified and active secrets are redacted", async () => {
  const authRegistry = { streamSimple: () => (async function* () { yield { type: "error", error: { errorMessage: "401 bad literal-secret", stopReason: "error" } }; })() };
  const auth = await runModelAvailabilityTests([chat("auth")], authRegistry, new AbortController().signal, 1, { chat: 1000, classifier: 1000, image: 1000 }, ["literal-secret"]);
  assert.equal(auth[0]?.status, "auth");
  assert.doesNotMatch(auth[0]?.error ?? "", /literal-secret/u);
  const rateRegistry = { streamSimple: () => (async function* () { yield { type: "error", error: { errorMessage: "429 rate limit", stopReason: "error" } }; })() };
  const rate = await runModelAvailabilityTests([chat("rate")], rateRegistry, new AbortController().signal, 1, { chat: 1000, classifier: 1000, image: 1000 });
  assert.equal(rate[0]?.status, "rate-limit");
});
