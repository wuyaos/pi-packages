import assert from "node:assert/strict";
import test from "node:test";
import { defaultChatThinking } from "../src/thinking-defaults.ts";
import { t } from "../src/i18n.ts";
import {
  acceptedThinkingMap,
  protocolThinkingMap,
  resolveThinkingMap,
  runThinkingProbe,
  THINKING_PROBE_RUN_SHORTCUT,
} from "../src/thinking-probe.ts";

const model: any = {
  type: "chat",
  provider: "p",
  id: "m",
  name: "m",
  api: "openai-responses",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 16384,
  thinkingLevelMap: { high: "runtime-high", xhigh: "runtime-xhigh", max: "runtime-max" },
};

function stream(event: any) { return (async function* () { yield event; })(); }

test("thinking probe shortcut and its displayed labels consistently use Ctrl+L", () => {
  assert.equal(THINKING_PROBE_RUN_SHORTCUT, "ctrl+l");
  assert.match(t("zh-CN", "probeRun"), /\[Ctrl\+L\]/u);
  assert.match(t("en", "probeRun"), /\[Ctrl\+L\]/u);
  assert.match(t("zh-CN", "modelProbeThinking"), /\[Ctrl\+L\]/u);
  assert.match(t("en", "modelProbeThinking"), /\[Ctrl\+L\]/u);
  assert.match(t("en", "contextProbeRun"), /\[Ctrl\+K\]/u);
});

test("thinking metadata precedence preserves explicit remote/user maps and ignores empty runtime maps", () => {
  const remote = { high: "r" }, catalog = { high: "c" }, existing = { high: "e" };
  assert.equal(resolveThinkingMap(remote, catalog, existing, model.api).source, "remote");
  assert.equal(resolveThinkingMap(undefined, catalog, existing, model.api).source, "catalog");
  assert.equal(resolveThinkingMap(undefined, undefined, existing, model.api).source, "existing");
  assert.equal(resolveThinkingMap(undefined, undefined, undefined, model.api).source, "protocol");
  assert.equal(resolveThinkingMap(undefined, undefined, undefined, "unknown").map, undefined);

  assert.deepEqual(resolveThinkingMap({}, { high: "catalog" }, { high: "user" }, model.api), { map: {}, source: "remote" });
  assert.deepEqual(resolveThinkingMap(undefined, {}, undefined, "openai-completions"), {
    map: protocolThinkingMap("openai-completions"), source: "protocol",
  });
  assert.deepEqual(resolveThinkingMap(undefined, undefined, {}, "openai-completions"), { map: {}, source: "existing" });
});

test("protocol defaults are API-specific, including conservative openai-completions levels", () => {
  assert.deepEqual(protocolThinkingMap("anthropic-messages"), { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  assert.deepEqual(protocolThinkingMap("openai-completions"), { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null });
  assert.deepEqual(protocolThinkingMap("openai-responses"), { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  assert.deepEqual(protocolThinkingMap("openai-codex-responses"), { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  assert.deepEqual(protocolThinkingMap("azure-openai-responses"), protocolThinkingMap("openai-responses"));
  assert.deepEqual(protocolThinkingMap("pi-messages"), { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  assert.equal(protocolThinkingMap("unknown"), undefined);
});

test("empty existing maps fall back to protocol defaults while explicit remote maps remain authoritative", () => {
  const existing = defaultChatThinking("openai-completions", { thinkingLevelMap: {} }, "existing");
  assert.equal(existing.thinkingSource, "protocol");
  assert.deepEqual(existing.thinkingLevelMap, protocolThinkingMap("openai-completions"));

  const remote = defaultChatThinking("openai-completions", { thinkingLevelMap: {} }, "remote");
  assert.equal(remote.thinkingSource, "remote");
  assert.deepEqual(remote.thinkingLevelMap, {});
  const remotePartial = defaultChatThinking("openai-completions", { thinkingLevelMap: { high: "remote-high" } }, "remote");
  assert.deepEqual(remotePartial.thinkingLevelMap, { high: "remote-high" });
});

test("thinking probe uses only resolved wire mappings and marks null/missing levels unsupported without requests", async () => {
  const calls: Array<{ passedModel: any; options: any }> = [];
  const resolvedMap = { low: "probe-low", medium: null, high: "probe-high" } as const;
  const registry = {
    streamSimple: (passedModel: any, _context: any, options: any) => {
      calls.push({ passedModel, options });
      return stream({ type: "done" });
    },
  };
  const result = await runThinkingProbe(model, registry, resolvedMap, new AbortController().signal, [], 1_000);

  assert.deepEqual(calls.map(({ options }) => options.reasoning), ["low", "high"]);
  assert.equal(calls.length, 2, "null and missing mappings must not contact the provider");
  assert.ok(calls.every(({ passedModel }) => passedModel !== model));
  for (const { passedModel } of calls) assert.deepEqual(passedModel.thinkingLevelMap, resolvedMap);
  assert.equal(result.steps.find((step) => step.level === "medium")?.status, "unsupported");
  assert.equal(result.steps.find((step) => step.level === "xhigh")?.status, "unsupported");
  assert.equal(result.steps.find((step) => step.level === "max")?.status, "unsupported");
  assert.deepEqual(result.accepted, ["low", "high"]);
});

test("accepted probe writeback retains only accepted levels with concrete mappings", () => {
  assert.deepEqual(
    acceptedThinkingMap({ low: "wire-low", high: "wire-high", xhigh: null, max: "wire-max" }, ["low", "xhigh"]),
    { low: "wire-low" },
  );
});

test("thinking probe uses terminal events only and classifies rejection/auth", async () => {
  let calls = 0;
  const registry = { streamSimple: () => ++calls === 1 ? stream({ type: "start" }) : ++calls === 3 ? stream({ type: "error", error: { errorMessage: "unsupported reasoning effort" } }) : stream({ type: "done" }) };
  const result = await runThinkingProbe(model, registry, { low: "low", medium: "medium", high: "high" }, new AbortController().signal, [], 1_000);
  assert.equal(result.steps[2]?.status, "error"); // start without terminal done is never accepted
  assert.deepEqual(result.accepted, []);
  const auth = await runThinkingProbe(model, { streamSimple: () => stream({ type: "error", error: { errorMessage: "401 auth secret" } }) }, { high: "high" }, new AbortController().signal, ["secret"], 1_000);
  assert.equal(auth.steps.find((step) => step.level === "high")?.status, "auth");
  assert.doesNotMatch(auth.steps.find((step) => step.level === "high")?.error ?? "", /secret/u);
});
