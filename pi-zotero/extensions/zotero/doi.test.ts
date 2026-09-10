import assert from "node:assert/strict";
import { test } from "node:test";

import { cslToZoteroFields, mergeDoiFields, normalizeDoiInput } from "./doi.ts";

test("normalizeDoiInput accepts prefixes and rejects non-DOI strings", () => {
  assert.equal(normalizeDoiInput("10.1038/s41586-025-08628-5"), "10.1038/s41586-025-08628-5");
  assert.equal(normalizeDoiInput("doi:10.1002/adfm.202106725."), "10.1002/adfm.202106725");
  assert.equal(normalizeDoiInput("https://doi.org/10.1093/nar/gkr900 "), "10.1093/nar/gkr900");
  assert.throws(() => normalizeDoiInput("not-a-doi"), /无效 DOI/);
  assert.throws(() => normalizeDoiInput("https://example.com/10.1000/x"), /无效 DOI/);
});

test("cslToZoteroFields maps a journal article with authors and editors", () => {
  const result = cslToZoteroFields({
    type: "journal-article",
    title: "Self-Driving Platform",
    DOI: "10.1002/adfm.202106725",
    author: [
      { given: "Yongjie", family: "Tao" },
      { literal: "Test Institute" },
    ],
    editor: [{ given: "Ed", family: "Itor" }],
    "container-title": ["Advanced Functional Materials"],
    volume: "31",
    issue: "45",
    page: "2106725",
    publisher: "Wiley",
    ISSN: "1616-3028",
    issued: { "date-parts": [[2021, 12]] },
  });

  assert.equal(result.itemType, "journalArticle");
  assert.deepEqual(result.fields.creators, [
    { creatorType: "author", firstName: "Yongjie", lastName: "Tao" },
    { creatorType: "author", name: "Test Institute" },
    { creatorType: "editor", firstName: "Ed", lastName: "Itor" },
  ]);
  assert.equal(result.fields.publicationTitle, "Advanced Functional Materials");
  assert.equal(result.fields.volume, "31");
  assert.equal(result.fields.issue, "45");
  assert.equal(result.fields.pages, "2106725");
  assert.equal(result.fields.publisher, "Wiley");
  assert.equal(result.fields.ISSN, "1616-3028");
  assert.equal(result.fields.date, "2021-12");
});

test("cslToZoteroFields maps conference DOI and unknown types conservatively", () => {
  const conference = cslToZoteroFields({
    type: "paper-conference",
    title: "Attention Is All You Need",
    "container-title": ["NeurIPS"],
    ISBN: ["978-1-4503-0000-0"],
  });
  assert.equal(conference.itemType, "conferencePaper");
  assert.equal(conference.fields.proceedingsTitle, "NeurIPS");
  assert.equal(conference.fields.ISBN, "978-1-4503-0000-0");

  assert.equal(cslToZoteroFields({ type: "weird-type", title: "X" }).itemType, "document");
});

test("mergeDoiFields fills only empty fields unless overwrite is set", () => {
  const existing = {
    title: "Existing Title",
    creators: [{ creatorType: "author", lastName: "Existing" }],
    pages: "",
    volume: undefined,
    DOI: "10.1000/existing",
    issue: "9",
  };
  const incoming = { title: "Fetched Title", creators: [{ creatorType: "author", lastName: "Fetched" }], pages: "1-2", volume: "7", DOI: "10.1000/fetched", itemType: "journalArticle" };

  const fill = mergeDoiFields(existing, incoming);
  assert.equal(fill.title, undefined);
  assert.equal(fill.creators, undefined);
  assert.deepEqual(fill.pages, "1-2");
  assert.deepEqual(fill.volume, "7");
  assert.equal(fill.DOI, undefined);
  assert.equal(fill.itemType, undefined);

  const overwrite = mergeDoiFields(existing, incoming, true);
  assert.equal(overwrite.title, "Fetched Title");
  assert.deepEqual(overwrite.creators, incoming.creators);
  assert.equal(overwrite.DOI, "10.1000/fetched");
  assert.equal(overwrite.itemType, undefined);

  const emptyItem = mergeDoiFields({}, incoming);
  assert.deepEqual(emptyItem.creators, incoming.creators);
  assert.equal(emptyItem.DOI, "10.1000/fetched");
});
