import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { buildDiscoveryCandidates, discoverModels, discoverModelsFromCandidates } from "../src/discovery.ts";
import type { ProviderDraft } from "../src/types.ts";

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not expose a TCP port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function draft(discoveryUrl: string, overrides: Partial<ProviderDraft> = {}): ProviderDraft {
  return {
    id: "fixture",
    name: "Fixture",
    owned: true,
    discoveryUrl,
    authMode: "anonymous",
    authHeader: "none",
    chatApi: "openai-completions",
    classifierApi: "typesafe-system-one",
    imageApi: "openrouter-images",
    defaultType: "chat",
    ...overrides,
    enabled: overrides.enabled ?? true,
  };
}

test("本地 HTTP Discovery 规范化多类型、应用默认值并按 identity 去重", async () => {
  const fixture = await listen((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [
      { id: "chat-a", name: "Chat A", context_window: 12_345, max_output_tokens: 678 },
      { id: "classify-a", task: "classification" },
      { id: "image-a", type: "text-to-image" },
      { id: "chat-a", name: "duplicate" },
      { id: "bad\u0000id" },
    ] }));
  });
  try {
    const rows = await discoverModels(draft(`${fixture.origin}/models`), undefined, new AbortController().signal, 2_000);
    assert.deepEqual(rows.map((row) => [row.type, row.id]), [
      ["chat", "chat-a"],
      ["classifier", "classify-a"],
      ["image", "image-a"],
    ]);
    assert.equal((rows[0] as any).contextWindow, 12_345);
    assert.equal((rows[0] as any).maxTokens, 678);
    assert.equal((rows[0] as any).contextSource, "remote");
    assert.equal((rows[0] as any).maxTokensSource, "remote");
    assert.equal((rows[0] as any).reasoning, true);
    assert.deepEqual((rows[0] as any).thinkingLevelMap, { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null });
    assert.equal((rows[0] as any).thinkingSource, "protocol");
    assert.equal((rows[1] as any).contextWindow, 128_000);
    assert.equal((rows[1] as any).contextSource, "compat");
  } finally {
    await close(fixture.server);
  }
});

test("检测到 body 或 Link 的分页指示时整体拒绝第一页", async (t) => {
  for (const fixtureCase of [
    { name: "has_more", body: { data: [{ id: "partial" }], has_more: true }, link: undefined },
    { name: "Link rel=next", body: { data: [{ id: "partial" }] }, link: `<next>; rel=\"next\"` },
  ]) {
    await t.test(fixtureCase.name, async () => {
      const fixture = await listen((_request, response) => {
        response.setHeader("content-type", "application/json");
        if (fixtureCase.link) response.setHeader("link", fixtureCase.link);
        response.end(JSON.stringify(fixtureCase.body));
      });
      try {
        await assert.rejects(
          discoverModels(draft(`${fixture.origin}/models`), undefined, new AbortController().signal, 2_000),
          (error: any) => error?.code === "MCFG_E_PAGINATION",
        );
      } finally {
        await close(fixture.server);
      }
    });
  }
});

test("调用方取消会中止挂起的本地 Discovery", async () => {
  let markRequest!: () => void;
  const requested = new Promise<void>((resolve) => { markRequest = resolve; });
  const fixture = await listen((_request, _response) => markRequest());
  const controller = new AbortController();
  try {
    const pending = discoverModels(draft(`${fixture.origin}/slow`), undefined, controller.signal, 10_000);
    await requested;
    controller.abort(new DOMException("fixture cancelled", "AbortError"));
    await assert.rejects(pending, (error: any) => error?.name === "AbortError");
  } finally {
    await close(fixture.server);
  }
});

test("跨 origin 重定向在发送目标请求前拒绝，认证头不泄漏", async () => {
  let targetRequests = 0;
  let sourceAuthorization: string | undefined;
  const target = await listen((_request, response) => {
    targetRequests++;
    response.end("unexpected");
  });
  const source = await listen((request, response) => {
    sourceAuthorization = request.headers.authorization;
    response.statusCode = 302;
    response.setHeader("location", `${target.origin}/stolen`);
    response.end();
  });
  try {
    await assert.rejects(
      discoverModels(
        draft(`${source.origin}/models`, { authMode: "temporary", authHeader: "bearer", temporaryKey: "fixture-secret" }),
        undefined,
        new AbortController().signal,
        2_000,
      ),
      (error: any) => error?.code === "MCFG_E_REDIRECT_ORIGIN",
    );
    assert.equal(sourceAuthorization, "Bearer fixture-secret");
    assert.equal(targetRequests, 0);
  } finally {
    await close(source.server);
    await close(target.server);
  }
});

test("Discovery profiles produce conservative ordered same-origin candidates", () => {
  const candidates = (chatApi: string, baseUrl: string, proxyUrl?: string) => buildDiscoveryCandidates({ chatApi, baseUrl, proxyUrl });
  assert.deepEqual(candidates("openai-completions", "https://api.example.com/"), [
    "https://api.example.com/v1/models",
    "https://api.example.com/models",
  ]);
  assert.deepEqual(candidates("openai-responses", "https://api.example.com/v1"), [
    "https://api.example.com/v1/models",
    "https://api.example.com/models",
  ]);
  assert.deepEqual(candidates("openai-codex-responses", "https://api.example.com/backend-api"), [
    "https://api.example.com/backend-api/codex/models",
    "https://api.example.com/v1/models",
  ]);
  assert.equal(candidates("openai-codex-responses", "https://api.example.com/codex/responses")[0], "https://api.example.com/codex/models");
  assert.deepEqual(candidates("openai-codex-responses", "https://api.example.com/unrecognized/path"), []);
  assert.deepEqual(candidates("anthropic-messages", "https://api.example.com"), ["https://api.example.com/v1/models"]);
  assert.deepEqual(candidates("google-generative-ai", "https://generativelanguage.googleapis.com"), ["https://generativelanguage.googleapis.com/v1beta/models"]);
  assert.deepEqual(candidates("google-generative-ai", "https://generativelanguage.googleapis.com", "http://127.0.0.1:7890"), []);
  assert.deepEqual(candidates("mistral-conversations", "https://api.example.com"), ["https://api.example.com/v1/models"]);
  for (const api of ["azure-openai-responses", "bedrock-converse-stream", "google-vertex", "pi-messages"]) {
    assert.deepEqual(candidates(api, "https://api.example.com"), []);
  }
  const explicit = buildDiscoveryCandidates({ chatApi: "azure-openai-responses", baseUrl: "https://api.example.com", discoveryUrl: "https://catalog.example.com/models" });
  assert.deepEqual(explicit, ["https://catalog.example.com/models"]);
  assert.equal(candidates("openai-completions", "https://api.example.com").some((url) => url.includes("client_version")), false);
});

test("candidate fallback occurs only for 404/405", async () => {
  const requests: string[] = [];
  const fixture = await listen((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/first") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "missing" }));
    } else response.end(JSON.stringify({ data: ["fallback-model"] }));
  });
  try {
    const result = await discoverModelsFromCandidates(
      draft(`${fixture.origin}/first`),
      [`${fixture.origin}/first`, `${fixture.origin}/second`],
      undefined,
      new AbortController().signal,
      2_000,
    );
    assert.equal(result.url, `${fixture.origin}/second`);
    assert.deepEqual(result.models.map((model) => model.id), ["fallback-model"]);
    assert.deepEqual(requests, ["/first", "/second"]);
  } finally {
    await close(fixture.server);
  }
});

test("401 never falls back to another candidate", async () => {
  const requests: string[] = [];
  const fixture = await listen((request, response) => {
    requests.push(request.url ?? "");
    response.statusCode = request.url === "/first" ? 401 : 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/first" ? { error: "unauthorized" } : { data: ["must-not-load"] }));
  });
  try {
    await assert.rejects(
      discoverModelsFromCandidates(draft(`${fixture.origin}/first`), [`${fixture.origin}/first`, `${fixture.origin}/second`], undefined, new AbortController().signal, 2_000),
      (error: any) => error?.code === "MCFG_E_DISCOVERY_HTTP" && error?.params?.status === 401,
    );
    assert.deepEqual(requests, ["/first"]);
  } finally {
    await close(fixture.server);
  }
});

test("Discovery accepts array/data/models/list/result shapes, strings, and Codex slug fields", async () => {
  const fixtures: Record<string, unknown> = {
    "/array": ["string-model"],
    "/data": { data: [{ id: "data-model" }] },
    "/models": { models: [{ slug: "codex-model", display_name: "Codex Display" }] },
    "/list": { list: [{ model_id: "list-model" }] },
    "/result": { result: [{ model: "result-model" }] },
  };
  const fixture = await listen((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(fixtures[request.url ?? ""]));
  });
  try {
    for (const [path, expected] of [["/array", "string-model"], ["/data", "data-model"], ["/models", "codex-model"], ["/list", "list-model"], ["/result", "result-model"]] as const) {
      const rows = await discoverModels(draft(`${fixture.origin}${path}`), undefined, new AbortController().signal, 2_000);
      assert.equal(rows[0]?.id, expected);
      if (path === "/models") assert.equal(rows[0]?.name, "Codex Display");
    }
  } finally {
    await close(fixture.server);
  }
});

test("Discovery validates IDs, sanitizes names, parses explicit metadata, and clamps max tokens", async () => {
  const fixture = await listen((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [
      { id: "  valid-id  ", name: "\u001b[31m Visible\u0007 Name ", context_length: 100, max_tokens: 200, input_modalities: ["text", "image"], capabilities: { reasoning: true }, cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
      { id: "bad\u001bid" },
      { id: "x".repeat(257) },
      { id: "classifier", model_type: "classification", context_window: 50 },
    ] }));
  });
  try {
    const rows = await discoverModels(draft(`${fixture.origin}/models`), undefined, new AbortController().signal, 2_000);
    assert.deepEqual(rows.map((row) => row.id), ["valid-id", "classifier"]);
    const chat = rows[0] as any;
    assert.equal(chat.name, "Visible Name");
    assert.equal(chat.contextWindow, 100);
    assert.equal(chat.maxTokens, 100);
    assert.equal(chat.reasoning, true);
    assert.deepEqual(chat.input, ["text", "image"]);
    assert.deepEqual(chat.cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    assert.equal(rows[1]?.type, "classifier");
  } finally {
    await close(fixture.server);
  }
});

test("remote chat defaults thinking on known protocols while preserving explicit remote values", async () => {
  const fixture = await listen((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [
      { id: "defaulted" },
      { id: "explicit", reasoning: false, thinkingLevelMap: { high: "remote-high", max: null } },
    ] }));
  });
  try {
    const rows = await discoverModels(draft(`${fixture.origin}/models`, { chatApi: "openai-responses" }), undefined, new AbortController().signal, 2_000) as any[];
    assert.equal(rows[0].reasoning, true);
    assert.equal(rows[0].thinkingSource, "protocol");
    assert.equal(rows[0].thinkingLevelMap.off, null);
    assert.equal(rows[1].reasoning, false);
    assert.equal(rows[1].thinkingSource, "remote");
    assert.deepEqual(rows[1].thinkingLevelMap, { high: "remote-high", max: null });
  } finally {
    await close(fixture.server);
  }
});

test("auto auth sends protocol-specific headers", async (t) => {
  for (const fixtureCase of [
    { api: "openai-completions", expected: { authorization: "Bearer fixture-key" } },
    { api: "anthropic-messages", expected: { "x-api-key": "fixture-key", "anthropic-version": "2023-06-01" } },
    { api: "google-generative-ai", expected: { "x-goog-api-key": "fixture-key" } },
    { api: "azure-openai-responses", expected: { "api-key": "fixture-key" } },
  ]) {
    await t.test(fixtureCase.api, async () => {
      let headers: IncomingMessage["headers"] = {};
      const fixture = await listen((request, response) => {
        headers = request.headers;
        response.setHeader("content-type", "application/json");
        response.end("[]");
      });
      try {
        await discoverModels(draft(`${fixture.origin}/models`, { baseUrl: fixture.origin, chatApi: fixtureCase.api, authMode: "temporary", authHeader: "auto", temporaryKey: "fixture-key" }), undefined, new AbortController().signal, 2_000);
        for (const [name, value] of Object.entries(fixtureCase.expected)) assert.equal(headers[name], value);
      } finally {
        await close(fixture.server);
      }
    });
  }
});

test("cross-origin reuse-pi credentials are rejected before request", async () => {
  let requests = 0;
  const model = await listen((_request, response) => response.end("[]"));
  const discovery = await listen((_request, response) => { requests++; response.end("[]"); });
  try {
    await assert.rejects(
      discoverModels(
        draft(`${discovery.origin}/models`, { baseUrl: model.origin, authMode: "reuse-pi", authHeader: "auto" }),
        { auth: { apiKey: "fixture-key" } } as any,
        new AbortController().signal,
        2_000,
      ),
      (error: any) => error?.code === "MCFG_E_DISCOVERY_AUTH_ORIGIN",
    );
    assert.equal(requests, 0);
    await assert.rejects(
      discoverModels(
        draft(`${discovery.origin}/models`, { baseUrl: model.origin, authMode: "reuse-pi", authHeader: "auto" }),
        { auth: { headers: { authorization: "Bearer oauth-token" } } } as any,
        new AbortController().signal,
        2_000,
      ),
      (error: any) => error?.code === "MCFG_E_DISCOVERY_AUTH_ORIGIN",
    );
    assert.equal(requests, 0);
  } finally {
    await close(model.server);
    await close(discovery.server);
  }
});

test("pagination zero and empty markers do not reject", async () => {
  const fixture = await listen((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: ["model"], has_more: false, next: "", next_page: 0, next_cursor: null }));
  });
  try {
    const rows = await discoverModels(draft(`${fixture.origin}/models`), undefined, new AbortController().signal, 2_000);
    assert.deepEqual(rows.map((row) => row.id), ["model"]);
  } finally {
    await close(fixture.server);
  }
});

test("Discovery enforces 1 MiB body limit and redacts HTTP error details", async (t) => {
  await t.test("body limit", async () => {
    const fixture = await listen((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.setHeader("content-length", String(1024 * 1024 + 1));
      response.end("[]");
    });
    try {
      await assert.rejects(
        discoverModels(draft(`${fixture.origin}/models`), undefined, new AbortController().signal, 2_000),
        (error: any) => error?.code === "MCFG_E_DISCOVERY_BODY_LIMIT",
      );
    } finally {
      await close(fixture.server);
    }
  });
  await t.test("error redaction", async () => {
    const fixture = await listen((_request, response) => {
      response.statusCode = 400;
      response.end("authorization: super-secret\u001b[31m bad\u0007detail");
    });
    try {
      await assert.rejects(
        discoverModels(draft(`${fixture.origin}/models`), undefined, new AbortController().signal, 2_000),
        (error: any) => error?.code === "MCFG_E_DISCOVERY_HTTP"
          && !String(error?.params?.detail).includes("super-secret")
          && !/[\u0000-\u001f\u007f-\u009f]/u.test(String(error?.params?.detail)),
      );
    } finally {
      await close(fixture.server);
    }
  });
});

test("successful HTTP with invalid JSON does not fall back", async () => {
  const requests: string[] = [];
  const fixture = await listen((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/first" ? "not-json" : JSON.stringify({ data: ["must-not-load"] }));
  });
  try {
    await assert.rejects(
      discoverModelsFromCandidates(draft(`${fixture.origin}/first`), [`${fixture.origin}/first`, `${fixture.origin}/second`], undefined, new AbortController().signal, 2_000),
      (error: any) => error?.code === "MCFG_E_DISCOVERY_JSON",
    );
    assert.deepEqual(requests, ["/first"]);
  } finally {
    await close(fixture.server);
  }
});

test("streamed Discovery body without Content-Length is limited to 1 MiB", async () => {
  const fixture = await listen((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    for (let index = 0; index < 17; index++) response.write("x".repeat(64 * 1024));
    response.end();
  });
  try {
    await assert.rejects(
      discoverModels(draft(`${fixture.origin}/models`), undefined, new AbortController().signal, 2_000),
      (error: any) => error?.code === "MCFG_E_DISCOVERY_BODY_LIMIT",
    );
  } finally {
    await close(fixture.server);
  }
});

test("reuse-pi Discovery fails closed without a trusted model origin", async () => {
  let requests = 0;
  const discovery = await listen((_request, response) => { requests++; response.end("[]"); });
  try {
    await assert.rejects(
      discoverModels(
        draft(`${discovery.origin}/models`, { baseUrl: undefined, authMode: "reuse-pi", authHeader: "auto" }),
        { auth: { apiKey: "fixture-key" } } as any,
        new AbortController().signal,
        2_000,
      ),
      (error: any) => error?.code === "MCFG_E_DISCOVERY_AUTH_ORIGIN",
    );
    assert.equal(requests, 0);
  } finally {
    await close(discovery.server);
  }
});

test("reuse-pi uses auth.baseUrl as trusted origin when draft Base URL is absent", async () => {
  let requests = 0;
  const discovery = await listen((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end("[]");
  });
  try {
    const rows = await discoverModels(
      draft(`${discovery.origin}/models`, { baseUrl: undefined, authMode: "reuse-pi", authHeader: "auto" }),
      { auth: { apiKey: "fixture-key", baseUrl: `${discovery.origin}/v1` } } as any,
      new AbortController().signal,
      2_000,
    );
    assert.deepEqual(rows, []);
    assert.equal(requests, 1);
  } finally {
    await close(discovery.server);
  }
});

test("reuse-pi rejects mismatched auth.baseUrl before request", async () => {
  let requests = 0;
  const trusted = await listen((_request, response) => response.end("[]"));
  const discovery = await listen((_request, response) => { requests++; response.end("[]"); });
  try {
    await assert.rejects(
      discoverModels(
        draft(`${discovery.origin}/models`, { baseUrl: undefined, authMode: "reuse-pi", authHeader: "auto" }),
        { auth: { apiKey: "fixture-key", baseUrl: trusted.origin } } as any,
        new AbortController().signal,
        2_000,
      ),
      (error: any) => error?.code === "MCFG_E_DISCOVERY_AUTH_ORIGIN",
    );
    assert.equal(requests, 0);
  } finally {
    await close(trusted.server);
    await close(discovery.server);
  }
});
