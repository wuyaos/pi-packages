import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import type { ZoteroClient } from "./client.ts";
import { writeZoteroDocxFields } from "./docx_fields.ts";

const csl = (key: string, title: string): Record<string, unknown> => ({
  id: `http://zotero.org/users/123/items/${key}`,
  type: "article-journal",
  title,
  issued: { "date-parts": [[2026]] },
});

const csls: Record<string, Record<string, unknown>> = {
  AAAAAAAA: csl("AAAAAAAA", "One"),
  BBBBBBBB: csl("BBBBBBBB", "Two"),
  CCCCCCCC: csl("CCCCCCCC", "Three"),
};

const mockClient = {
  ensureServerMeta: async () => ({ serverId: "server-test", version: "10.0" }),
  getCSLBatch: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, csls[key]])),
} as unknown as ZoteroClient;

function paragraph(inner: string): string {
  return `<w:p>${inner}</w:p>`;
}

function run(text: string, attributes = ""): string {
  return `<w:r${attributes}><w:t>${text}</w:t></w:r>`;
}

function documentXml(paragraphs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    paragraphs.join("") + `<w:sectPr/></w:body></w:document>`;
}

function writeDocx(filePath: string, xml: string): void {
  fs.writeFileSync(filePath, zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(xml),
  }));
}

function readDocumentXml(filePath: string): string {
  return strFromU8(unzipSync(new Uint8Array(fs.readFileSync(filePath)))["word/document.xml"]);
}

function writeMap(filePath: string, markers: { marker: string; keys: string[] }[], extra: object = {}): void {
  fs.writeFileSync(filePath, JSON.stringify({ serverId: "server-test", markers, ...extra }));
}

test("DOCX conversion preserves surrounding text, repeated markers and same-container cross-run markers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zotero-docx-"));
  try {
    const src = path.join(dir, "input.docx");
    const out = path.join(dir, "output.docx");
    const map = path.join(dir, "map.json");
    writeDocx(src, documentXml([
      paragraph(run("正文[1]中间[1]结尾", ` w:rsidR="001"`)),
      paragraph(run("跨run[2-") + run("3]保留")),
      paragraph(run("标题（此处由 Zotero 插入参考文献表）尾部")),
    ]));
    writeMap(map, [
      { marker: "[1]", keys: ["AAAAAAAA"] },
      { marker: "[1]", keys: ["AAAAAAAA"] },
      { marker: "[2-3]", keys: ["BBBBBBBB", "CCCCCCCC"] },
    ]);
    const inputHash = createHash("sha256").update(fs.readFileSync(src)).digest("hex");

    const result = await writeZoteroDocxFields(mockClient, { src, out, mapPath: map });
    const xml = readDocumentXml(out);

    for (const expected of ["正文", "中间", "结尾", "跨run", "保留", "标题", "尾部"]) {
      assert.ok(xml.includes(expected), `正文片段丢失: ${expected}`);
    }
    assert.equal((xml.match(/ZOTERO_ITEM/g) ?? []).length, 3);
    assert.equal((xml.match(/ZOTERO_BIBL/g) ?? []).length, 1);
    assert.equal(result.markersReplaced, 3);
    assert.equal(result.bibliography, "placeholder");
    assert.equal(createHash("sha256").update(fs.readFileSync(src)).digest("hex"), inputHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DOCX conversion refuses partial marker maps and does not overwrite an existing output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zotero-docx-"));
  try {
    const src = path.join(dir, "input.docx");
    const out = path.join(dir, "output.docx");
    const map = path.join(dir, "map.json");
    writeDocx(src, documentXml([paragraph(run("正文[1][2]"))]));
    writeMap(map, [{ marker: "[1]", keys: ["AAAAAAAA"] }], { bibl_placeholder: "" });
    fs.writeFileSync(out, "sentinel");

    await assert.rejects(
      () => writeZoteroDocxFields(mockClient, { src, out, mapPath: map }),
      /未映射引用标记/,
    );
    assert.equal(fs.readFileSync(out, "utf-8"), "sentinel");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
