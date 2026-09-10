import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { ZoteroApiError, ZoteroClient, type ZoteroItem } from "./client.ts";

function item(key: string, data: ZoteroItem["data"], version = 1): ZoteroItem {
  return { key, version, data };
}

function clientWithoutConstructor(overrides: Record<string, unknown> = {}): ZoteroClient {
  return Object.assign(Object.create(ZoteroClient.prototype), {
    apiBase: "http://example.invalid/api",
    timeoutMs: 1000,
    userAgent: "pi-zotero-test",
    maxItems: 5000,
    ...overrides,
  }) as ZoteroClient;
}

test("listWithMeta reports Total-Results and intentional truncation", async () => {
  const starts: string[] = [];
  const client = clientWithoutConstructor({
    rawFetchResult: async (_base: string, _path: string, init: { params: Record<string, string> }) => {
      starts.push(init.params.start);
      const count = init.params.start === "0" ? 100 : 20;
      return {
        data: Array.from({ length: count }, (_, index) => ({ index })),
        headers: new Headers({ "Total-Results": "250" }),
      };
    },
  });

  const result = await client.listWithMeta<{ index: number }>("/items", { limit: 120 });
  assert.equal(result.items.length, 120);
  assert.equal(result.total, 250);
  assert.equal(result.truncated, true);
  assert.deepEqual(starts, ["0", "100"]);
});

test("getCollectionItems excludes deleted items and filters direct top-level membership", async () => {
  const collectionKey = "COLL1234";
  const client = clientWithoutConstructor({
    listWithMeta: async () => ({
      items: [
        item("ACTIVE01", { title: "active", collections: [collectionKey] }),
        item("DELETED1", { title: "deleted", collections: [collectionKey], deleted: true }),
        item("CHILD001", { title: "attachment", parentItem: "ACTIVE01", collections: [] }),
      ],
      total: 3,
      truncated: false,
    }),
  });

  const topLevel = await client.getCollectionItemsWithMeta(collectionKey);
  assert.deepEqual(topLevel.items.map((value) => value.key), ["ACTIVE01"]);
  assert.equal(topLevel.total, 1);
  assert.equal(topLevel.sourceTotal, 3);
  assert.deepEqual(
    (await client.getCollectionItems(collectionKey, { topLevelOnly: false })).map((value) => value.key),
    ["ACTIVE01", "CHILD001"],
  );
});

test("getCollectionTrashItems reports deleted entries that retain a collection relation", async () => {
  const collectionKey = "COLL1234";
  const client = clientWithoutConstructor({
    getTrashItemsWithMeta: async () => ({
      items: [
        item("TRASH001", { deleted: true, collections: [collectionKey] }),
        item("TRASH002", { deleted: true, collections: ["OTHER123"] }),
      ],
      total: 2,
      truncated: false,
    }),
  });

  assert.deepEqual((await client.getCollectionTrashItems(collectionKey)).map((value) => value.key), ["TRASH001"]);
});

test("restoreItem writes deleted=false and retries once after a 412 with a fresh version", async () => {
  const patches: { key: string; data: Record<string, unknown>; version: number }[] = [];
  let readCount = 0;
  const client = clientWithoutConstructor({
    getItem: async (key: string) => item(key, { deleted: true }, ++readCount),
    updateItem: async (key: string, data: Record<string, unknown>, version: number) => {
      patches.push({ key, data, version });
      if (patches.length === 1) throw new ZoteroApiError("conflict", 412);
    },
  });

  assert.equal(await client.restoreItem("ITEM1234"), true);
  assert.deepEqual(patches, [
    { key: "ITEM1234", data: { deleted: false }, version: 1 },
    { key: "ITEM1234", data: { deleted: false }, version: 2 },
  ]);
});

test("restoreItem avoids a write when the item is already active", async () => {
  let writes = 0;
  const client = clientWithoutConstructor({
    getItem: async (key: string) => item(key, { deleted: false }, 3),
    updateItem: async () => { writes += 1; },
  });

  assert.equal(await client.restoreItem("ITEM1234"), false);
  assert.equal(writes, 0);
});

test("getCSLBatch falls back to per-key fetch when CSL ids are citation keys", async () => {
  const fetched: string[] = [];
  const client = clientWithoutConstructor({
    rawFetch: async (_base: string, path: string, init: { params: Record<string, string> }) => {
      if (path === "/items" && init.params.format === "csljson") {
        // 引用管理插件会把 id 改写为 citation key，且混入子附件
        return [{ id: "tao2021Adv.Funct.Mater." }, { id: "http://zotero.org/users/0/items/CHILD001" }];
      }
      const match = path.match(/^\/items\/([A-Z0-9]{8})$/);
      if (match && init.params.format === "csljson") {
        fetched.push(match[1]);
        return [{ id: "citation-key-style", title: "for " + match[1] }];
      }
      throw new Error("unexpected path " + path);
    },
  });

  const result = await client.getCSLBatch(["TARGET01", "TARGET02"]);
  assert.deepEqual(fetched.sort(), ["TARGET01", "TARGET02"]);
  assert.equal(result["TARGET01"]?.title, "for TARGET01");
  assert.equal(result["TARGET02"]?.title, "for TARGET02");
});

test("getCSLSingle accepts object-shaped CSL responses and rejects empty ones", async () => {
  const objectClient = clientWithoutConstructor({
    rawFetch: async () => ({ id: "http://zotero.org/users/0/items/TARGET01", title: "object form" }),
  });
  assert.equal((await objectClient.getCSLSingle("TARGET01"))["title"], "object form");

  const emptyClient = clientWithoutConstructor({ rawFetch: async () => [] });
  await assert.rejects(() => emptyClient.getCSLSingle("TARGET01"), /响应为空/);
});

test("getItemVersions falls back to per-key lookup when the batch page is truncated", async () => {
  const client = clientWithoutConstructor({
    rawFetch: async (_base: string, path: string, init: { params: Record<string, string> }) => {
      if (path === "/items" && init.params.format === "versions") {
        return { FOUND001: 7 }; // FOUND002 被子附件挤断
      }
      throw new Error("unexpected " + path);
    },
    getItem: async (key: string) => item(key, { title: "x" }, key === "FOUND002" ? 9 : 0),
  });

  const result = await client.getItemVersions(["FOUND001", "FOUND002"]);
  assert.deepEqual(result, { FOUND001: 7, FOUND002: 9 });
});

test("searchMany isolates per-query failures and preserves every query result", async () => {
  const client = clientWithoutConstructor({
    searchWithMeta: async (query: string) => {
      if (query === "bad query") throw new ZoteroApiError("boom", 500);
      return { items: [item("HIT00001", { title: query })], total: 1, truncated: false };
    },
  });

  const results = await client.searchMany(["alpha", "bad query", "alpha"], { limit: 5 });
  assert.equal(results.length, 2); // 重复查询去重
  const alpha = results.find((entry) => entry.query === "alpha");
  assert.equal(alpha?.result?.items[0]?.key, "HIT00001");
  const bad = results.find((entry) => entry.query === "bad query");
  assert.match(bad?.error ?? "", /boom/);
});

test("updateItemVerified retries 412 and reports per-field persistence", async () => {
  let readCount = 0;
  let writeCount = 0;
  const client = clientWithoutConstructor({
    getItem: async (key: string) => {
      readCount += 1;
      // 第 1 次读：旧值；写后读：已持久化
      return item(key, readCount === 1 ? { title: "old" } : { title: "new", pages: "7-9" }, readCount + 10);
    },
    updateItem: async (key: string, data: Record<string, unknown>, version: number) => {
      writeCount += 1;
      if (writeCount === 1) throw new ZoteroApiError("conflict", 412);
      // 412 后重写前会重读最新 version（read3 → v13）
      assert.equal(version, 13);
    },
  });

  const result = await client.updateItemVerified("ITEM1234", { title: "new", pages: "7-9" }, { settleMs: 100 });
  assert.equal(writeCount, 2);
  assert.deepEqual(result.persisted, ["title", "pages"]);
  assert.deepEqual(result.missing, []);
});

test("updateItemVerified treats reordered object keys as persisted", async () => {
  let readCount = 0;
  const client = clientWithoutConstructor({
    getItem: async (key: string) => {
      readCount += 1;
      // Zotero 返回的 creators 键序与发送时不同
      return readCount === 1
        ? item(key, { creators: [] }, 30)
        : item(key, { creators: [{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }] }, 31);
    },
    updateItem: async () => {},
  });

  const result = await client.updateItemVerified(
    "ITEM1234",
    { creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }] },
    { settleMs: 100 },
  );
  assert.deepEqual(result.persisted, ["creators"]);
  assert.deepEqual(result.missing, []);
});

test("updateItemVerified reports fields clobbered by background plugins", async () => {
  const client = clientWithoutConstructor({
    getItem: async (key: string) => item(key, { title: "old", pages: null }, 20), // 永远读到旧值
    updateItem: async () => {}, // 204 成功
  });

  const result = await client.updateItemVerified("ITEM1234", { title: "new", pages: "7-9" }, { settleMs: 300 });
  assert.deepEqual(result.persisted, []);
  assert.deepEqual(result.missing, ["title", "pages"]);
});

test("fetchDoiCsl negotiates CSL via doi.org and rejects unregistered DOIs", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const headers: { url: string; accept: string | undefined }[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      headers.push({ url: String(input), accept: init?.headers ? (init.headers as Record<string, string>).Accept : undefined });
      if (String(input).includes("10.1000/gone")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ type: "journal-article", title: "Fetched" }), { status: 200 });
    }) as typeof fetch;

    const client = clientWithoutConstructor();
    const csl = await client.fetchDoiCsl("https://doi.org/10.1000/valid");
    assert.equal(csl.title, "Fetched");
    assert.equal(headers[0].url, "https://doi.org/10.1000/valid");
    assert.equal(headers[0].accept, "application/vnd.citationstyles.csl+json");

    await assert.rejects(() => client.fetchDoiCsl("10.1000/gone"), /DOI 未注册/);
    await assert.rejects(() => client.fetchDoiCsl("not-a-doi"), /无效 DOI/);
    assert.equal(headers.length, 2); // 无效 DOI 未出网
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createItems preserves successful keys when Zotero reports a partial failure", async () => {
  const client = clientWithoutConstructor({
    writeRequest: async () => ({
      successful: { "0": { key: "CREATED1", version: 7 } },
      failed: { "1": { index: 1, message: "invalid item" } },
    }),
  });

  const result = await client.createItems([{ title: "valid" }, { title: "invalid" }]);
  assert.deepEqual(result.successful, [{ key: "CREATED1", version: 7 }]);
  assert.deepEqual(result.failed, [{ index: 1, message: "invalid item" }]);
});

test("collection and saved-search creation accept index-keyed Local API responses", async () => {
  let call = 0;
  const client = clientWithoutConstructor({
    writeRequest: async () => {
      call += 1;
      return { successful: { "0": { key: call === 1 ? "COLL0001" : "SEARCH01", version: call } }, failed: {} };
    },
  });

  assert.deepEqual(await client.createCollection("Collection"), { key: "COLL0001", version: 1 });
  assert.deepEqual(await client.createSearch("Search", []), { key: "SEARCH01", version: 2 });
});

test("uploadFile streams content after a streaming MD5 pass", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zotero-upload-"));
  const filePath = path.join(directory, "attachment.pdf");
  const content = Buffer.from("streamed attachment content");
  fs.writeFileSync(filePath, content);
  const originalFetch = globalThis.fetch;
  let metadata: Record<string, unknown> | null = null;
  let registerBody: Record<string, unknown> | null = null;
  let uploaded = Buffer.alloc(0);
  let authorizedCalls = 0;
  const client = clientWithoutConstructor({
    authorizedWriteFetch: async (_url: string, init: { body: string }) => {
      authorizedCalls += 1;
      if (authorizedCalls === 1) {
        metadata = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(JSON.stringify({ url: "http://upload.invalid/content", uploadKey: "UPLOAD01" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      registerBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    },
  });
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.body && !(init.body instanceof Uint8Array), "upload body should be a stream");
    const chunks: Buffer[] = [];
    for await (const chunk of init.body as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    uploaded = Buffer.concat(chunks);
    assert.equal((init as RequestInit & { duplex?: string }).duplex, "half");
    return new Response(null, { status: 201 });
  };

  try {
    assert.deepEqual(await client.uploadFile("ATTACH01", filePath), { exists: false });
    const metadataValue = metadata as Record<string, unknown> | null;
    assert.equal(metadataValue?.md5, createHash("md5").update(content).digest("hex"));
    assert.equal(metadataValue?.filesize, content.length);
    assert.deepEqual(uploaded, content);
    assert.deepEqual(registerBody, { upload: "UPLOAD01" });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("searchCollection keeps paging until it has the requested filtered top-level items", async () => {
  const collectionKey = "COLL1234";
  const starts: string[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => item(`CH${String(index).padStart(6, "0")}`, {
    parentItem: "PARENT01",
    collections: [],
    title: "child",
  }));
  const secondPage = [
    item("ACTIVE01", { collections: [collectionKey], title: "first" }),
    item("DELETED1", { collections: [collectionKey], deleted: true, title: "deleted" }),
    item("ACTIVE02", { collections: [collectionKey], title: "second" }),
  ];
  const client = clientWithoutConstructor({
    rawFetchResult: async (_base: string, _path: string, init: { params: Record<string, string> }) => {
      starts.push(init.params.start);
      assert.equal(init.params.q, "needle");
      return {
        data: init.params.start === "0" ? firstPage : secondPage,
        headers: new Headers({ "Total-Results": "103" }),
      };
    },
  });

  const result = await client.searchCollectionWithMeta(collectionKey, "needle", { limit: 2 });
  assert.deepEqual(result.items.map((value) => value.key), ["ACTIVE01", "ACTIVE02"]);
  assert.equal(result.sourceTotal, 103);
  assert.equal(result.truncated, false);
  assert.deepEqual(starts, ["0", "100"]);
});

test("searchCollection reports truncation when the filtered limit stops inside a page", async () => {
  const collectionKey = "COLL1234";
  const client = clientWithoutConstructor({
    rawFetchResult: async () => ({
      data: [
        item("ACTIVE01", { collections: [collectionKey] }),
        item("ACTIVE02", { collections: [collectionKey] }),
        item("ACTIVE03", { collections: [collectionKey] }),
      ],
      headers: new Headers({ "Total-Results": "3" }),
    }),
  });

  const result = await client.searchCollectionWithMeta(collectionKey, "needle", { limit: 2 });
  assert.deepEqual(result.items.map((value) => value.key), ["ACTIVE01", "ACTIVE02"]);
  assert.equal(result.total, 2);
  assert.equal(result.sourceTotal, 3);
  assert.equal(result.truncated, true);
});
