import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fetchModelsDirectory, matchModelsDirectory, DIRECTORY_TTL_MS } from "../src/models-directory.ts";
const offline = JSON.parse(readFileSync(new URL("../../.ralph/modelsdev.json", import.meta.url), "utf8"));
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
test("directory provider scoped variant strips AWS region/vendor/date/version affixes only on unique match", () => {
  const catalog = { "amazon-bedrock": { name: "Amazon Bedrock", models: { "anthropic.claude-fable-5": model(true) } }, anthropic: { models: { "claude-fable-5": model(true) } } };
  const result = matchModelsDirectory(catalog, "us.anthropic.claude-fable-5-20261023-v1:0", { providerId: "amazon-bedrock" });
  assert.equal(result.matchMethod, "variant");
  assert.equal(result.fields.contextWindow, 200000);
  assert.equal(result.sources.contextWindow?.[0]?.provider, "amazon-bedrock");
  assert.equal(matchModelsDirectory(catalog, "claude-fable-5-preview", { providerId: "unknown-gateway" }).matchMethod, "none");
  (catalog["amazon-bedrock"].models as any)["anthropic.claude-fable-5-latest"] = model(true);
  assert.equal(matchModelsDirectory(structuredClone(catalog), "claude-fable-5-preview", { providerId: "amazon-bedrock" }).matchMethod, "none");
});
test("directory routing by display name/baseUrl does not cross contradictory evidence", () => {
  const catalog = { anthropic: { name: "Anthropic", api: "https://api.anthropic.com", models: { "claude-fable-5": model(true) } }, openai: { api: "https://api.openai.com", models: { "gpt-test": model(false) } } };
  assert.equal(matchModelsDirectory(catalog, "claude-fable-5", { providerId: "custom", baseUrl: "https://api.anthropic.com/v1" }).matchMethod, "exact");
  assert.equal(matchModelsDirectory(catalog, "claude-fable-5", { providerId: "openai", baseUrl: "https://api.anthropic.com/v1" }).matchMethod, "none");
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
