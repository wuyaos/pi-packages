import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fetchModelsDirectory, matchModelsDirectory, normalizeDirectoryVariant, DIRECTORY_TTL_MS } from "../src/models-directory.ts";
const offline = JSON.parse(readFileSync(new URL("./fixtures/models-directory.json", import.meta.url), "utf8"));
const model = (reasoning?: boolean) => ({ name: "Claude Fable 5", limit: { context: 200000, output: 64000 }, modalities: { input: ["text", "image"] }, reasoning, cost: { input: 99, output: 999 } });

test("directory offline L1 is case insensitive; effort hints never create maps/prices", () => {
  const result = matchModelsDirectory(offline, "GPT-5.1", { providerId: "OPENAI" });
  assert.equal(result.matchMethod, "exact");
  assert.equal(result.fields.contextWindow, 400000);
  assert.equal(result.fields.maxTokens, 128000);
  assert.deepEqual(result.effortHint?.values, ["none", "low", "medium", "high"]);
  assert.equal("cost" in result.fields, false);
  assert.equal("thinkingLevelMap" in result.fields, false);
  assert.equal("reasoningEfforts" in result.fields, false);
  assert.equal(JSON.stringify(result).includes('"cost"'), false);
  assert.equal(result.sources.contextWindow?.[0]?.provider, "openai");
});
test("directory offline canonical_model_id follows provider/canonicalId", () => {
  const alias = Object.entries<any>(offline.hetzner.models).find(([, m]) => m.canonical_model_id === "alibaba/qwen3.6-35b-a3b");
  assert.ok(alias);
  const result = matchModelsDirectory(offline, alias[0], { providerId: "hetzner" });
  assert.equal(result.matchMethod, "canonical");
  assert.equal(result.sources.contextWindow?.[0]?.provider, "alibaba");
});
const fullDumpUrl = new URL("../../.ralph/modelsdev.json", import.meta.url);
for (const [id, providerId, method] of [["GPT-5.1", "OPENAI", "exact"], ["AWS-Claude-Fable-5", "custom", "variant"]] as const) {
  test(`directory optional real dump: ${id}`, { skip: !existsSync(fullDumpUrl) }, () => {
    const dump = JSON.parse(readFileSync(fullDumpUrl, "utf8"));
    const result = matchModelsDirectory(dump, id, { providerId });
    const expected = matchModelsDirectory(offline, id, { providerId });
    assert.equal(result.matchMethod, method);
    assert.deepEqual(result.fields, expected.fields);
    assert.deepEqual(result.effortHint, expected.effortHint);
  });
}
test("directory provider scoped variant strips AWS region/vendor/date/version affixes only on unique match", () => {
  const catalog = { "amazon-bedrock": { name: "Amazon Bedrock", models: { "anthropic.claude-fable-5": model(true) } }, anthropic: { models: { "claude-fable-5": model(true) } } };
  const result = matchModelsDirectory(catalog, "us.anthropic.claude-fable-5-20261023-v1:0", { providerId: "amazon-bedrock" });
  assert.equal(result.matchMethod, "variant");
  assert.equal(result.fields.contextWindow, 200000);
  assert.equal(result.sources.contextWindow?.[0]?.provider, "amazon-bedrock");
  const unrouted = matchModelsDirectory(catalog, "claude-fable-5-preview", { providerId: "unknown-gateway" });
  assert.equal(unrouted.matchMethod, "variant");
  assert.equal(unrouted.sources.contextWindow?.[0]?.provider, "anthropic");
  (catalog["amazon-bedrock"].models as any)["anthropic.claude-fable-5-latest"] = model(true);
  const ambiguous = matchModelsDirectory(structuredClone(catalog), "claude-fable-5-preview", { providerId: "amazon-bedrock" });
  assert.equal(ambiguous.matchMethod, "variant");
  assert.equal(ambiguous.sources.contextWindow?.[0]?.provider, "anthropic");
});
test("directory routing by display name/baseUrl keeps exact hits and uses global fallback for contradictory evidence", () => {
  const catalog = { anthropic: { name: "Anthropic", api: "https://api.anthropic.com", models: { "claude-fable-5": model(true) } }, openai: { api: "https://api.openai.com", models: { "gpt-test": model(false) } } };
  assert.equal(matchModelsDirectory(catalog, "claude-fable-5", { providerId: "custom", baseUrl: "https://api.anthropic.com/v1" }).matchMethod, "exact");
  const contradictory = matchModelsDirectory(catalog, "claude-fable-5", { providerId: "openai", baseUrl: "https://api.anthropic.com/v1" });
  assert.equal(contradictory.matchMethod, "variant");
  assert.equal(contradictory.sources.contextWindow?.[0]?.provider, "anthropic");
});
test("directory offline custom gateway resolves AWS-Claude-Fable-5 to official metadata", () => {
  const result = matchModelsDirectory(offline, "AWS-Claude-Fable-5", { providerId: "pa-completions" });
  assert.equal(result.matchMethod, "variant");
  assert.equal(result.fields.contextWindow, offline.anthropic.models["claude-fable-5"].limit.context);
  assert.equal(result.fields.maxTokens, offline.anthropic.models["claude-fable-5"].limit.output);
  for (const field of ["name", "contextWindow", "maxTokens", "input"] as const) {
    assert.deepEqual(result.sources[field], [{ provider: "anthropic", id: "claude-fable-5", matchMethod: "variant" }]);
  }
  assert.equal(result.reasoning, true);
  assert.equal(result.effortHint?.provider, "anthropic");
  assert.deepEqual(result.effortHint?.values, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(JSON.stringify(result).includes('"cost"'), false);
});
test("directory offline unknown models and fuzzy prefixes remain unmatched", () => {
  for (const id of ["my-fake-model-0718", "AWS-Claude-Fable", "pa-claude-fable-5"]) {
    assert.deepEqual(matchModelsDirectory(offline, id, { providerId: "pa-completions" }), { matchMethod: "none", fields: {}, sources: {} });
  }
});
test("directory normalization strips known cloud prefixes after vendor dots only", () => {
  for (const vendor of ["aws", "azure", "bedrock", "gcp", "vertex"]) {
    for (const separator of ["-", "."]) {
      assert.equal(normalizeDirectoryVariant(`${vendor}${separator}Claude-Fable-5`), "claude-fable-5");
    }
  }
  assert.equal(normalizeDirectoryVariant("US.anthropic.AWS-Claude-Fable-5-20261023-v1:0"), "claude-fable-5");
  assert.equal(normalizeDirectoryVariant("custom-claude-fable-5"), "custom-claude-fable-5");
});
test("directory routed exact, canonical and unique variant take priority over global official entries", () => {
  const catalog = {
    gateway: { models: { "claude-fable-5": { ...model(false), limit: { context: 123000, output: 12000 } } } },
    alias: { models: { alias: { canonical_model_id: "gateway/claude-fable-5" } } },
    anthropic: { models: { "claude-fable-5": model(true) } },
  };
  for (const [id, providerId, method] of [["claude-fable-5", "gateway", "exact"], ["alias", "alias", "canonical"], ["AWS-Claude-Fable-5-preview", "gateway", "variant"]] as const) {
    const result = matchModelsDirectory(catalog, id, { providerId });
    assert.equal(result.matchMethod, method);
    assert.equal(result.fields.contextWindow, 123000);
    assert.equal(result.sources.contextWindow?.[0]?.provider, "gateway");
  }
});
test("directory global fallback runs after a routed provider has no matching model", () => {
  const catalog = { gateway: { models: { unrelated: model(false) } }, anthropic: { models: { "claude-fable-5": model(true) } } };
  const result = matchModelsDirectory(catalog, "AWS-Claude-Fable-5", { providerId: "gateway" });
  assert.equal(result.matchMethod, "variant");
  assert.equal(result.sources.contextWindow?.[0]?.provider, "anthropic");
});
for (const provider of ["anthropic", "reseller"]) {
  test(`directory fallback excludes ambiguous ${provider} variants independent of JSON order`, () => {
    const variants = [
      ["claude-test-20261020", { ...model(true), name: "First", limit: { context: 200000, output: 32000 }, reasoning_options: [{ type: "effort", values: ["high"] }] }],
      ["claude-test-preview", { ...model(false), name: "Last", limit: { context: 100000, output: 16000 } }],
    ];
    const match = (reverse: boolean, peers = {}) => matchModelsDirectory({
      [provider]: { models: Object.fromEntries(reverse ? [...variants].reverse() : variants) }, ...peers,
    }, "aws-claude-test", { providerId: provider });
    assert.deepEqual(match(false), { matchMethod: "none", fields: {}, sources: {} });
    assert.deepEqual(match(true), match(false));
    // Ambiguous official data must not supply limits, reasoning, effort, or even one vote.
    const peers = { a: { models: { "claude-test": model(false) } }, b: { models: { "claude-test-latest": model(false) } } };
    const result = match(false, peers);
    assert.deepEqual(match(true, peers), result);
    assert.deepEqual(result.fields, { name: "Claude Fable 5", contextWindow: 200000, maxTokens: 64000, input: ["text", "image"], reasoning: false });
    for (const sources of Object.values(result.sources)) assert.deepEqual(sources?.map((s) => s.provider), ["a", "b"]);
    assert.equal(result.effortHint, undefined);
  });
}
test("directory fallback keeps all fields and provenance on the same unambiguous official entry", () => {
  const catalog = {
    anthropic: { models: { "claude-test-latest": { ...model(true), limit: { context: 300000, output: 50000 } } } },
    reseller: { models: {
      "claude-test-preview": { ...model(false), limit: { context: 100000, output: 10000 } },
      "claude-test-20261020": { ...model(false), limit: { context: 90000, output: 9000 } },
    } },
  };
  const result = matchModelsDirectory(catalog, "aws-claude-test", { providerId: "custom" });
  assert.equal(result.fields.contextWindow, 300000);
  assert.equal(result.fields.maxTokens, 50000);
  assert.equal(result.reasoning, true);
  for (const sources of Object.values(result.sources)) assert.deepEqual(sources, [{ provider: "anthropic", id: "claude-test-latest", matchMethod: "variant" }]);
});
test("directory global fallback without an official family uses field consensus at 60 percent", () => {
  const catalog = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`reseller${i}`, { models: { "my-model": {
    ...model(i < 3), name: i < 3 ? "Majority" : "Minority",
    limit: { context: i < 3 ? 200000 : 100000, output: i < 3 ? 64000 : 32000 },
    modalities: { input: i === 1 ? ["image", "text"] : i < 3 ? ["text", "image"] : ["text"] },
  } } }]));
  const result = matchModelsDirectory(catalog, "AWS-my-model-preview", { providerId: "custom" });
  assert.equal(result.matchMethod, "variant");
  assert.deepEqual(result.fields, { name: "Majority", contextWindow: 200000, maxTokens: 64000, input: ["text", "image"], reasoning: true });
  for (const field of ["name", "contextWindow", "maxTokens", "input", "reasoning"] as const) {
    assert.deepEqual(result.sources[field]?.map((s) => s.provider), ["reseller0", "reseller1", "reseller2"]);
    assert.ok(result.sources[field]?.every((s) => s.matchMethod === "variant"));
  }
  assert.equal(result.effortHint, undefined);
  assert.equal(JSON.stringify(result).includes('"cost"'), false);
});
test("directory global consensus abstains on tied fields and counts missing values in the threshold", () => {
  const tied = {
    a: { models: { "my-model": model(true) } },
    b: { models: { "my-model-latest": { ...model(false), limit: { context: 100000, output: 32000 } } } },
  };
  const result = matchModelsDirectory(tied, "my-model-preview", { providerId: "custom" });
  assert.equal(result.matchMethod, "variant");
  assert.equal(result.fields.contextWindow, undefined);
  assert.equal(result.fields.maxTokens, undefined);
  assert.equal(result.sources.contextWindow, undefined);
  assert.equal(result.reasoning, undefined);
  assert.equal(result.fields.name, "Claude Fable 5");
  const missing = { ...tied, c: { models: { "my-model": {} } }, d: { models: { "my-model": {} } } };
  const abstained = matchModelsDirectory(missing, "my-model-preview", { providerId: "custom" });
  assert.deepEqual(abstained.fields, {});
  assert.deepEqual(abstained.sources, {});
});
test("directory global fallback uses a single nonofficial entry without inventing an official provider", () => {
  const catalog = { reseller: { models: { "gpt-xxx": model(true) } }, anthropic: { models: { "claude-fable-5": model(true) } } };
  const result = matchModelsDirectory(catalog, "aws-gpt-xxx", { providerId: "custom" });
  assert.equal(result.matchMethod, "variant");
  assert.equal(result.fields.contextWindow, 200000);
  assert.equal(result.sources.contextWindow?.[0]?.provider, "reseller");
  assert.equal(result.effortHint, undefined);
});
test("directory global fallback missing the official family provider uses consensus, not another family", () => {
  const catalog = {
    a: { models: { "gpt-xxx": model(true) } },
    b: { models: { "gpt-xxx-preview": model(true) } },
    c: { models: { "gpt-xxx": { ...model(false), limit: { context: 100000, output: 32000 } } } },
    anthropic: { models: { "claude-fable-5": model(true) } },
  };
  const result = matchModelsDirectory(catalog, "aws-gpt-xxx", { providerId: "custom" });
  assert.equal(result.fields.contextWindow, 200000);
  assert.deepEqual(result.sources.contextWindow?.map((s) => s.provider), ["a", "b"]);
  assert.equal(result.reasoning, true);
  assert.equal(result.effortHint, undefined);
});
test("directory reasoning consensus: official weight 5, threshold 60%, ties/unknown abstain", () => {
  const catalog: any = { anthropic: { models: { "claude-fable-5": model(true) } } };
  for (let i = 0; i < 3; i++) catalog[`reseller${i}`] = { models: { "claude-fable-5": model(false) } };
  assert.equal(matchModelsDirectory(structuredClone(catalog), "claude-fable-5", { providerId: "anthropic" }).reasoning, true); // 5/8
  catalog.reseller3 = { models: { "claude-fable-5": model(false) } };
  assert.equal(matchModelsDirectory(structuredClone(catalog), "claude-fable-5", { providerId: "anthropic" }).reasoning, undefined); // 5/9
  catalog.reseller4 = { models: { "claude-fable-5": model(false) } };
  assert.equal(matchModelsDirectory(structuredClone(catalog), "claude-fable-5", { providerId: "anthropic" }).reasoning, undefined); // tie
  const unknown = { a: { models: { custom: model(true) } }, b: { models: { custom: model() } } };
  assert.equal(matchModelsDirectory(unknown, "custom", { providerId: "a" }).reasoning, undefined);
});
test("directory truncates long names, validates limits/modalities, never reads prices", () => {
  const result = matchModelsDirectory({ x: { models: { x: { ...model(), name: "🙂".repeat(400), limit: { context: -1, output: Infinity }, modalities: { input: ["audio", "image", "image"] } } } } }, "x", { providerId: "x" });
  assert.equal(Array.from(result.fields.name!).length, 256);
  assert.equal(result.fields.contextWindow, undefined);
  assert.equal(result.fields.maxTokens, undefined);
  assert.deepEqual(result.fields.input, ["image"]);
  assert.equal("cost" in result, false);
});
test("directory fetch caches for one hour, sends no credentials, and failures are actionable", async () => {
  const now = Date.now;
  let clock = 1, calls = 0;
  Date.now = () => clock;
  const fetcher = (async (input: any, init: any) => {
    calls++;
    assert.equal(input, "https://models.dev/api.json");
    assert.equal(init.headers, undefined);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    return new Response(JSON.stringify({ fixture: { models: { test: model() } } }));
  }) as typeof fetch;
  try {
    const [first, concurrent] = await Promise.all([fetchModelsDirectory(fetcher), fetchModelsDirectory(fetcher)]);
    assert.equal(first, concurrent);
    await fetchModelsDirectory(fetcher);
    assert.equal(calls, 1);
    clock += DIRECTORY_TTL_MS;
    await fetchModelsDirectory(fetcher);
    assert.equal(calls, 2);
    clock += DIRECTORY_TTL_MS;
    await assert.rejects(fetchModelsDirectory((async () => { throw new Error("secret"); }) as typeof fetch), /network\/proxy/);
    await assert.rejects(fetchModelsDirectory((async () => new Response("{}")) as typeof fetch), /网络\/代理/);
  } finally { Date.now = now; }
});
test("directory refresh failure clears shared pending and allows concurrent retry", async () => {
  const now = Date.now;
  Date.now = () => 10 * DIRECTORY_TTL_MS;
  let calls = 0;
  let fail!: (error: Error) => void;
  const failedFetcher = (() => { calls++; return new Promise((_resolve, reject) => { fail = reject; }); }) as typeof fetch;
  try {
    const failed = [fetchModelsDirectory(failedFetcher), fetchModelsDirectory(failedFetcher)];
    const settled = Promise.allSettled(failed);
    assert.equal(calls, 1);
    fail(new Error("refresh failed"));
    for (const result of await settled) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.match(result.reason.message, /network\/proxy/);
    }
    const refreshed = { refreshed: { models: { test: model(false) } } };
    const retry = (async () => { calls++; return new Response(JSON.stringify(refreshed)); }) as typeof fetch;
    const [first, concurrent] = await Promise.all([fetchModelsDirectory(retry), fetchModelsDirectory(retry)]);
    assert.equal(calls, 2);
    assert.equal(first, concurrent);
    assert.deepEqual(first, refreshed);
    assert.equal(await fetchModelsDirectory(retry), first);
    assert.equal(calls, 2);
  } finally { Date.now = now; }
});
