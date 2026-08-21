import assert from "node:assert/strict";
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

test("getCollectionItems excludes deleted items and filters direct top-level membership", async () => {
  const collectionKey = "COLL1234";
  const client = clientWithoutConstructor({
    list: async () => [
      item("ACTIVE01", { title: "active", collections: [collectionKey] }),
      item("DELETED1", { title: "deleted", collections: [collectionKey], deleted: true }),
      item("CHILD001", { title: "attachment", parentItem: "ACTIVE01", collections: [] }),
    ],
  });

  assert.deepEqual((await client.getCollectionItems(collectionKey)).map((value) => value.key), ["ACTIVE01"]);
  assert.deepEqual(
    (await client.getCollectionItems(collectionKey, { topLevelOnly: false })).map((value) => value.key),
    ["ACTIVE01", "CHILD001"],
  );
});

test("getCollectionTrashItems reports deleted entries that retain a collection relation", async () => {
  const collectionKey = "COLL1234";
  const client = clientWithoutConstructor({
    getTrashItems: async () => [
      item("TRASH001", { deleted: true, collections: [collectionKey] }),
      item("TRASH002", { deleted: true, collections: ["OTHER123"] }),
    ],
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
    rawFetch: async (_base: string, _path: string, init: { params: Record<string, string> }) => {
      starts.push(init.params.start);
      assert.equal(init.params.q, "needle");
      return init.params.start === "0" ? firstPage : secondPage;
    },
  });

  const result = await client.searchCollection(collectionKey, "needle", { limit: 2 });
  assert.deepEqual(result.map((value) => value.key), ["ACTIVE01", "ACTIVE02"]);
  assert.deepEqual(starts, ["0", "100"]);
});
