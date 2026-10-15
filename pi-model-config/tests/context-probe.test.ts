import assert from "node:assert/strict";
import test from "node:test";
import { runContextProbe } from "../src/context-probe.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const chat = { type: "chat", provider: "fixture", id: "chat", name: "chat", api: "openai-completions", input: ["text"], cost, reasoning: false, contextWindow: 128000, maxTokens: 16384 } as any;
const image = { type: "image", provider: "fixture", id: "image", name: "image", api: "openrouter-images", input: ["text"], output: ["image"], cost } as any;

function streamEvent(event: any) { return (async function* () { yield event; })(); }

test("probe success uses provider input usage instead of claiming exact target", async () => {
  let payloadLength = 0;
  const registry = { streamSimple: (_m: any, context: any) => { payloadLength = context.messages[0].content[0].text.length; return streamEvent({ type: "done", message: { usage: { inputTokens: 31000 } } }); } };
  const result = await runContextProbe(chat, registry, 32000, new AbortController().signal);
  assert.equal(result.lower, 31000);
  assert.equal(result.estimated, false);
  assert.ok(payloadLength > 32000);
});

test("probe records only explicit context overflow as upper bound", async () => {
  let calls = 0;
  const registry = { streamSimple: () => ++calls === 1 ? streamEvent({ type: "done", message: { usage: { inputTokens: 30000 } } }) : streamEvent({ type: "error", error: { errorMessage: "context_length_exceeded" } }) };
  const result = await runContextProbe(chat, registry, 64000, new AbortController().signal);
  assert.equal(result.lower, 30000);
  assert.equal(result.upper, 64000);
  assert.deepEqual(result.steps.map((step) => step.status), ["success", "context-overflow"]);
});

test("probe auth error stops without upper bound and redacts secrets", async () => {
  const registry = { streamSimple: () => streamEvent({ type: "error", error: { errorMessage: "401 bad probe-secret" } }) };
  const result = await runContextProbe(chat, registry, 64000, new AbortController().signal, ["probe-secret"]);
  assert.equal(result.steps[0]?.status, "auth");
  assert.equal(result.upper, undefined);
  assert.doesNotMatch(result.steps[0]?.error ?? "", /probe-secret/u);
});

test("probe timeout, cancellation, and image unsupported are typed", async () => {
  const registry = { streamSimple: (_m: any, _c: any, options: any) => (async function* () { await new Promise((_r, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })); })() };
  const keepAlive = setTimeout(() => {}, 50);
  const timeout = await runContextProbe(chat, registry, 32000, new AbortController().signal, [], { timeoutMs: 5, steps: [32], payloadBuilder: () => "x" });
  clearTimeout(keepAlive);
  assert.equal(timeout.steps[0]?.status, "timeout");
  const controller = new AbortController(); controller.abort(new DOMException("Cancelled", "AbortError"));
  const aborted = await runContextProbe(chat, registry, 32000, controller.signal);
  assert.equal(aborted.steps[0]?.status, "aborted");
  const unsupported = await runContextProbe(image, {}, 32000, new AbortController().signal);
  assert.equal(unsupported.steps[0]?.status, "unsupported");
});
