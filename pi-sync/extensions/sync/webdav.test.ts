import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { webdavGetFile, webdavPutFile } from "./webdav.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-webdav-"));
}

async function startServer(): Promise<{ url: string; close: () => Promise<void>; uploads: Buffer[] }> {
  const uploads: Buffer[] = [];
  const server = http.createServer((request, response) => {
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => { uploads.push(Buffer.concat(chunks)); response.writeHead(201).end(); });
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end("downloaded payload");
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind WebDAV test server");
  return {
    url: `http://127.0.0.1:${address.port}/archive`,
    uploads,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const ctx = { signal: new AbortController().signal } as any;

test("WebDAV PUT and GET stream data and GET replaces the destination atomically", async () => {
  const root = tempDir();
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "destination.txt");
  fs.writeFileSync(source, "uploaded payload");
  fs.writeFileSync(destination, "old content");
  const server = await startServer();
  try {
    await webdavPutFile(source, server.url, "Basic test", ctx);
    await webdavGetFile(server.url, destination, "Basic test", ctx);
    assert.deepEqual(server.uploads.map(String), ["uploaded payload"]);
    assert.equal(fs.readFileSync(destination, "utf8"), "downloaded payload");
    assert.equal(fs.readdirSync(root).some((name) => name.includes(".part-")), false);
  } finally {
    await server.close();
  }
});
