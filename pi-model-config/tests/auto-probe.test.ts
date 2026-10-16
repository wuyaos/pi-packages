import assert from "node:assert/strict";
import test from "node:test";
import { protocolThinkingMap } from "../src/thinking-defaults.ts";
import { parseModelConfig, snapshot } from "../src/config.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_PROBE_MAX_TOKENS_REQUEST,
  inferAutoProbeParams,
  probeChatParams,
  probeTargetsFor,
  resolveProbeApiKey,
  runProbeQueue,
} from "../src/auto-probe.ts";

const model = { id: "probe-model", api: "openai-completions" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function completionBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
    ...overrides,
  };
}

function mockFetch(body: () => unknown, captures: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: any, init: any) => {
    captures.push({ url: String(url), init });
    return jsonResponse(body());
  }) as typeof fetch;
}

test("probe request shape: minimal chat-completions POST with 100000 max_tokens and bearer key", async () => {
  const captures: Array<{ url: string; init: RequestInit }> = [];
  const result = await probeChatParams(model, {
    fetch: mockFetch(() => completionBody(), captures),
    apiKey: "sk-secret",
    baseUrl: "https://api.example.com/v1/",
    signal: AbortSignal.timeout(5_000),
  });
  assert.ok(result);
  assert.equal(captures.length, 1);
  assert.equal(captures[0]!.url, "https://api.example.com/v1/chat/completions");
  const init = captures[0]!.init as any;
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer sk-secret");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "probe-model");
  assert.deepEqual(body.messages, [{ role: "user", content: "用中文写一段约300字的描写" }]);
  assert.equal(body.max_tokens, AUTO_PROBE_MAX_TOKENS_REQUEST);
  assert.equal(AUTO_PROBE_MAX_TOKENS_REQUEST, 100_000);
  assert.equal(result.maxTokens, 32_768);
  assert.equal(result.reasoning, false);
});

test("finish_reason=length with reasoning tokens infers 2x reasoning budget", () => {
  const result = inferAutoProbeParams({ finishReason: "length", reasoningTokens: 12_000, completionTokens: 12_000 }, model.api);
  assert.equal(result?.maxTokens, 24_000);
  assert.equal(result?.reasoning, true);
  assert.deepEqual(result?.thinkingLevelMap, protocolThinkingMap("openai-completions"));
});

test("finish_reason=length with small reasoning tokens still uses the 16384 floor", () => {
  const result = inferAutoProbeParams({ finishReason: "length", reasoningTokens: 500 }, model.api);
  assert.equal(result?.maxTokens, 16_384);
  assert.equal(result?.reasoning, true);
});

test("finish_reason=length without reasoning keeps the truncation point with a 16384 floor", () => {
  const result = inferAutoProbeParams({ finishReason: "length", completionTokens: 100_000 }, model.api);
  assert.equal(result?.maxTokens, 100_000);
  assert.equal(result?.reasoning, false);
  assert.equal(result?.thinkingLevelMap, undefined);
  const small = inferAutoProbeParams({ finishReason: "length", completionTokens: 300 }, model.api);
  assert.equal(small?.maxTokens, 16_384);
});

test("finish_reason=stop infers the 32768 default", () => {
  const result = inferAutoProbeParams({ finishReason: "stop", completionTokens: 300 }, model.api);
  assert.equal(result?.maxTokens, 32_768);
});

test("reasoning_content alone marks reasoning=true even without token accounting", () => {
  const result = inferAutoProbeParams({ finishReason: "stop", reasoningContent: "thinking..." }, model.api);
  assert.equal(result?.reasoning, true);
  assert.equal(result?.maxTokens, 32_768);
});

test("unknown finish reasons and untrusted payloads return null for compatibility defaults", () => {
  assert.equal(inferAutoProbeParams({ finishReason: "tool_calls" }, model.api), null);
  assert.equal(inferAutoProbeParams({ finishReason: "content_filter" }, model.api), null);
  assert.equal(inferAutoProbeParams({}, model.api), null);
});

test("HTTP errors, invalid JSON, bad shapes, and aborts all fall back to null", async () => {
  const failing: Array<typeof fetch> = [
    (async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch,
    (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    (async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    (async () => jsonResponse({ choices: "nope" })) as unknown as typeof fetch,
    (async () => jsonResponse({ choices: [] })) as unknown as typeof fetch,
  ];
  for (const fetchImpl of failing) {
    const result = await probeChatParams(model, { fetch: fetchImpl, baseUrl: "https://api.example.com/v1", signal: AbortSignal.timeout(5_000) });
    assert.equal(result, null);
  }
  const controller = new AbortController();
  controller.abort();
  const aborted = await probeChatParams(model, {
    fetch: mockFetch(() => { throw new Error("should not be called"); }),
    baseUrl: "https://api.example.com/v1",
    signal: controller.signal,
  });
  assert.equal(aborted, null);
});

test("probe URLs reject non-HTTP schemes, embedded credentials, and secret queries like discovery", async () => {
  for (const baseUrl of ["ftp://api.example.com/v1", "https://user:pass@api.example.com/v1", "https://api.example.com/v1?token=secret"]) {
    const result = await probeChatParams(model, {
      fetch: mockFetch(() => completionBody()),
      baseUrl,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(result, null, baseUrl);
  }
});

test("resolveProbeApiKey resolves env and $$ literals, and never forwards reuse-pi keys across origins", () => {
  process.env.AUTO_PROBE_TEST_KEY = "env-key-value";
  try {
    assert.equal(resolveProbeApiKey({ authMode: "models-json", apiKeyRaw: "$AUTO_PROBE_TEST_KEY" }, undefined, "https://a.example.com/v1"), "env-key-value");
    assert.equal(resolveProbeApiKey({ authMode: "models-json", apiKeyRaw: "$$literal-key" }, undefined, "https://a.example.com/v1"), "$literal-key");
    assert.equal(resolveProbeApiKey({ authMode: "models-json", apiKeyRaw: "plain-key" }, undefined, "https://a.example.com/v1"), "plain-key");
    assert.equal(resolveProbeApiKey({ authMode: "temporary", temporaryKey: "temp" }, undefined, "https://a.example.com/v1"), "temp");
    assert.equal(resolveProbeApiKey({ authMode: "anonymous" }, undefined, "https://a.example.com/v1"), undefined);
    const piAuth = { auth: { apiKey: "pi-key", baseUrl: "https://pi.example.com/v1" } };
    assert.equal(resolveProbeApiKey({ authMode: "reuse-pi" }, piAuth, "https://pi.example.com/v1"), "pi-key");
    assert.equal(resolveProbeApiKey({ authMode: "reuse-pi" }, piAuth, "https://other.example.com/v1"), undefined);
    assert.equal(resolveProbeApiKey({ authMode: "reuse-pi" }, piAuth, "not-a-url"), undefined);
    assert.equal(resolveProbeApiKey({ authMode: "reuse-pi" }, { auth: { apiKey: "pi-key" } }, "https://pi.example.com/v1"), undefined);
  } finally {
    delete process.env.AUTO_PROBE_TEST_KEY;
  }
});

test("probeTargetsFor selects only chat models whose context/maxTokens are unverified compat defaults", () => {
  const models = [
    { type: "chat", id: "compat" },
    { type: "chat", id: "existing" },
    { type: "classifier", id: "compat-classifier" },
    { type: "chat", id: "missing-entry" },
  ];
  const metadata = [
    { type: "chat", id: "compat", contextSource: "compat", maxTokensSource: "compat" },
    { type: "chat", id: "existing", contextSource: "remote", maxTokensSource: "remote" },
    { type: "classifier", id: "compat-classifier", contextSource: "compat" },
  ];
  assert.deepEqual(probeTargetsFor(models, metadata).map((model) => model.id), ["compat", "missing-entry"]);
});

test("autoProbeOnSave config gate: boolean validated, defaults to enabled when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-auto-probe-config-"));
  try {
    const path = join(dir, "model-config.json");
    writeFileSync(path, JSON.stringify({ version: 1, autoProbeOnSave: false, providers: {} }));
    const disabled = parseModelConfig(snapshot(path));
    assert.equal(disabled.autoProbeOnSave, false);
    writeFileSync(path, JSON.stringify({ version: 1, autoProbeOnSave: "yes", providers: {} }));
    assert.throws(() => parseModelConfig(snapshot(path)), (error: any) => error?.code === "MCFG_E_CONFIG_SHAPE");
    writeFileSync(path, JSON.stringify({ version: 1, providers: {} }));
    // Missing key means enabled: the save flow probes unless autoProbeOnSave === false.
    assert.notEqual(parseModelConfig(snapshot(path)).autoProbeOnSave, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProbeQueue runs serially, reports progress, and Esc cancels only the remaining entries", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const entries = ["a", "b", "c", "d"].map((label) => ({
    label,
    run: async (signal: AbortSignal) => {
      events.push(`start:${label}`);
      if (label === "b") controller.abort();
      assert.equal(signal.aborted, label === "b");
      events.push(`done:${label}`);
      return { maxTokens: 1, reasoning: false };
    },
  }));
  const progress: Array<[number, number, string]> = [];
  const outcomes = await runProbeQueue(entries, controller.signal, (done, total, current) => progress.push([done, total, current]));
  // Aborted queue skips the remaining run functions entirely; completed results are kept.
  assert.deepEqual(events, ["start:a", "done:a", "start:b", "done:b"]);
  assert.deepEqual(progress, [[0, 4, "a"], [1, 4, "a"], [1, 4, "b"], [2, 4, "b"]]);
  assert.equal(outcomes[0]!.cancelled, false);
  assert.ok(outcomes[0]!.result);
  assert.equal(outcomes[2]!.cancelled, true);
  assert.equal(outcomes[2]!.result, null);
  assert.equal(outcomes[3]!.cancelled, true);
});
