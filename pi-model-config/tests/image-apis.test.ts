import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateImages as openai } from "../src/image-apis/openai.ts";
import { generateImages as gemini } from "../src/image-apis/gemini.ts";
import { generateImages as xai } from "../src/image-apis/xai.ts";
import { generateImages as dashscope } from "../src/image-apis/dashscope.ts";
import { IMAGE_API_DEFAULT_BASE_URLS, downloadImageUrl, resolveImageBaseUrl, validatePublicImageUrl } from "../src/image-apis/common.ts";
import { registerConfiguredProviders } from "../src/runtime.ts";
import { applyProviderTransport, IMAGE_APIS } from "../src/transport.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const context: any = { input: [{ type: "text", text: "draw a red dot" }] };
const model = (api: string, id = "model", baseUrl?: string) => ({ type: "image", provider: "fixture", id, name: id, api, ...(baseUrl ? { baseUrl } : {}), input: ["text"], output: ["image"], cost }) as any;
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

test("OpenAI image adapter injects supplied fetch, normalizes v1, and returns a PNG data URL", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await openai(model("openai-images", "gpt-image-1", "https://gateway.example/"), context, {
    apiKey: "openai-key",
    headers: { "x-extra": "yes" },
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return json({ data: [{ b64_json: "YWJj" }] }); },
  } as any);
  assert.equal(calls[0]!.url, "https://gateway.example/v1/images/generations");
  assert.equal((calls[0]!.init.headers as any).authorization, "Bearer openai-key");
  assert.equal((calls[0]!.init.headers as any)["x-extra"], "yes");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { model: "gpt-image-1", prompt: "draw a red dot", n: 1, output_format: "png" });
  assert.deepEqual(result.output[0], { type: "image", data: "data:image/png;base64,YWJj", mimeType: "image/png" });
  assert.equal(result.usage, undefined);
  let dallEBody: any;
  await openai(model("openai-images", "dall-e-3"), context, {
    apiKey: "openai-key",
    fetch: async (_url: RequestInfo | URL, init?: RequestInit) => { dallEBody = JSON.parse(String(init!.body)); return json({ data: [{ b64_json: "YWJj" }] }); },
  } as any);
  assert.deepEqual(dallEBody, { model: "dall-e-3", prompt: "draw a red dot", n: 1, response_format: "b64_json" });
});

test("OpenAI accepts b64_json:null URL responses and downloads a JPEG without credentials", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await openai(model("openai-images", "seedream-4"), context, {
    apiKey: "openai-key",
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      if (calls.length === 1) return json({ data: [{ b64_json: null, url: "https://tos-cn.volces.com/signed-image.jpg" }] });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
    },
  } as any);
  assert.equal(calls[1]!.url, "https://tos-cn.volces.com/signed-image.jpg");
  assert.equal(calls[1]!.init.headers, undefined);
  assert.deepEqual(result.output, [{ type: "image", mimeType: "image/jpeg", data: "data:image/jpeg;base64,/9j/AA==" }]);
});

test("OpenAI URL output rejects private images, limits size and reports missing output", async () => {
  const ssrf = await openai(model("openai-images"), context, {
    apiKey: "openai-key", fetch: async () => json({ data: [{ b64_json: null, url: "http://127.0.0.1/image" }] }),
  } as any);
  assert.equal(ssrf.stopReason, "error");
  assert.match(ssrf.errorMessage!, /private network/u);
  const missing = await openai(model("openai-images"), context, {
    apiKey: "openai-key", fetch: async () => json({ data: [{ b64_json: null }] }),
  } as any);
  assert.equal(missing.stopReason, "error");
  assert.match(missing.errorMessage!, /no usable/u);
  await assert.rejects(() => downloadImageUrl("https://images.example/large", {
    fetch: async () => new Response(new Uint8Array(11)), sizeLimit: 10,
  }), /byte limit/u);
});

test("Gemini URL encodes model IDs and parses inline_data",  async () => {
  let call: { url: string; init: RequestInit } | undefined;
  const result = await gemini(model("gemini-images", "gemini/image"), context, {
    apiKey: "google-key",
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => { call = { url: String(url), init: init! }; return json({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/webp", data: "Z2Vu" } }] } }] }); },
  } as any);
  assert.equal(call!.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini%2Fimage:generateContent");
  assert.equal((call!.init.headers as any)["x-goog-api-key"], "google-key");
  assert.deepEqual(JSON.parse(String(call!.init.body)).generationConfig, { responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K" } });
  assert.deepEqual(result.output[0], { type: "image", data: "data:image/webp;base64,Z2Vu", mimeType: "image/webp" });
});

test("xAI uses the minimal b64 payload and retains JPEG MIME pending live verification", async () => {
  let body: any;
  const result = await xai(model("xai-images", "grok-imagine-image"), context, {
    apiKey: "xai-key",
    fetch: async (_url: RequestInfo | URL, init?: RequestInit) => { body = JSON.parse(String(init!.body)); return json({ data: [{ b64_json: "anBlZw==" }] }); },
  } as any);
  assert.deepEqual(body, { model: "grok-imagine-image", prompt: "draw a red dot", n: 1, response_format: "b64_json" });
  assert.deepEqual(result.output[0], { type: "image", data: "data:image/jpeg;base64,anBlZw==", mimeType: "image/jpeg" });
});

test("DashScope uses synchronous results and safely downloads a public image through injected fetch", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await dashscope(model("dashscope-images", "qwen-image"), context, {
    apiKey: "dash-key",
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      if (calls.length === 1) return json({ output: { choices: [{ message: { content: [
        { image: "https://images.example/result.png" },
        { image: { url: "https://images.example/result-2.png" } },
      ] } }] } });
      return new Response(new Uint8Array(calls.length === 2 ? [1, 2, 3] : [4, 5, 6]), { headers: { "content-type": "image/png" } });
    },
  } as any);
  assert.equal(calls[0]!.url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
  assert.equal((calls[0]!.init.headers as any)["x-dashscope-async"], undefined);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { model: "qwen-image", input: { messages: [{ role: "user", content: [{ text: "draw a red dot" }] }] } });
  assert.equal(calls[1]!.url, "https://images.example/result.png");
  assert.equal(calls[2]!.url, "https://images.example/result-2.png");
  assert.equal(calls[1]!.init.headers, undefined);
  assert.deepEqual(result.output, [
    { type: "image", mimeType: "image/png", data: "data:image/png;base64,AQID" },
    { type: "image", mimeType: "image/png", data: "data:image/png;base64,BAUG" },
  ]);
});

test("DashScope image download rejects private/CGNAT/mapped IPv6 SSRF, redirect overflow, and an over-limit body", async () => {
  for (const privateUrl of ["http://127.0.0.1/private.png", "http://[::]/private.png", "http://[::1]/private.png", "http://[fe80::1]/private.png", "http://[febf::1]/private.png", "http://[::ffff:127.0.0.1]/private.png", "http://[::ffff:10.1.2.3]/private.png", "http://100.64.0.1/private.png"]) {
    await assert.rejects(() => downloadImageUrl(privateUrl), /private network/u);
  }
  assert.equal(validatePublicImageUrl("https://images.example/public.png").origin, "https://images.example");
  let redirects = 0;
  await assert.rejects(() => downloadImageUrl("https://images.example/a", { fetch: async () => {
    redirects++;
    return new Response(null, { status: 302, headers: { location: "https://images.example/a" } });
  } }), /redirect limit/u);
  assert.equal(redirects, 6);
  await assert.rejects(() => downloadImageUrl("https://images.example/large", { fetch: async () =>
    new Response(new Uint8Array(10 * 1024 * 1024 + 1)) }), /byte limit/u);
  await assert.rejects(() => downloadImageUrl("https://images.example/timeout", {
    timeoutMs: 1,
    fetch: async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })),
  }), /timed out/u);
});

test("image failures are redacted and protocol default URLs do not require a provider URL", async () => {
  const result = await openai(model("openai-images"), context, {
    apiKey: "super-secret-key",
    metadata: { secrets: ["also-secret"] },
    fetch: async () => json({ error: `visible-detail super-secret-key also-secret ${"x".repeat(400)}` }, 401),
  } as any);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /HTTP 401/u);
  assert.match(result.errorMessage!, /visible-detail/u);
  assert.match(result.errorMessage!, /\[REDACTED\]/u);
  assert.doesNotMatch(result.errorMessage!, /secret-key|also-secret/u);
  assert.equal(resolveImageBaseUrl("openai-images"), IMAGE_API_DEFAULT_BASE_URLS["openai-images"]);
  assert.equal(resolveImageBaseUrl("openai-images", "https://model.example/v1", "https://provider.example/v1"), "https://model.example/v1");
  assert.equal(resolveImageBaseUrl("openai-images", undefined, "https://provider.example/v1"), "https://provider.example/v1");
  assert.equal(resolveImageBaseUrl("openrouter-images"), undefined);
});

test("runtime registers image defaults, schema lists all protocols, and anonymous transport clears Google auth", () => {
  const registrations: any[] = [];
  const pi = { registerProvider: (...args: any[]) => registrations.push(args) } as any;
  const issues = registerConfiguredProviders(pi, { version: 1, providers: {
    fixture: { owned: true, authMode: "reuse-pi", models: [{ type: "image", id: "default", name: "Default", api: "openai-images", input: ["text"], output: ["image"], cost }] },
  } }, { providers: { fixture: { models: [] } } }, "en");
  assert.deepEqual(issues, []);
  const provider = registrations[0]![0];
  assert.equal(((provider.getAllModels?.() ?? provider.getModels())[0] as any).baseUrl, "https://api.openai.com/v1");
  assert.deepEqual([...IMAGE_APIS], ["openrouter-images", "openai-images", "gemini-images", "xai-images", "dashscope-images"]);
  const schema = JSON.parse(readFileSync(new URL("../model-config.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.$defs.provider.properties.imageApi.enum, [...IMAGE_APIS]);
  const anonymous = applyProviderTransport({ headers: { "x-goog-api-key": "key", authorization: "Bearer key" } } as any, { anonymous: true, api: "gemini-images" });
  assert.equal((anonymous.headers as any)["x-goog-api-key"], null);
  assert.equal((anonymous.headers as any).authorization, null);
  const anonymousIssues = registerConfiguredProviders({ registerProvider() { throw new Error("must not register"); } } as any, { version: 1, providers: {
    forbidden: { owned: true, authMode: "anonymous", models: [{ type: "image", id: "self", name: "Self", api: "openai-images", input: ["text"], output: ["image"], cost }] },
  } }, { providers: { forbidden: { models: [] } } }, "en");
  assert.equal((anonymousIssues[0]?.error as any).code, "MCFG_E_ANONYMOUS_UNSUPPORTED");
});
