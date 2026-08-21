import assert from "node:assert/strict";
import { test } from "node:test";

import { extractReferenceEvidence, matchReferenceDetailed, matchTitleDetailed } from "./build_map.ts";

test("title matching returns ambiguous instead of silently picking the first duplicate", () => {
  const result = matchTitleDetailed(["Attention Is All You Need"], [
    { key: "PREPRINT", title: "Attention Is All You Need" },
    { key: "CONF0001", title: "Attention Is All You Need" },
  ]);

  assert.equal(result.key, null);
  assert.deepEqual(result.ambiguous.map((entry) => entry.key), ["PREPRINT", "CONF0001"]);
});

test("DOI matching has priority over a mismatched title", () => {
  const evidence = extractReferenceEvidence("[1] Smith et al. Wrong Display Title. *Journal*. doi:10.1000/ABC.1");
  const result = matchReferenceDetailed(evidence, [
    { key: "TARGET01", title: "Canonical Title", doi: "https://doi.org/10.1000/abc.1", year: "2024" },
  ]);

  assert.equal(result.key, "TARGET01");
  assert.equal(result.matchMethod, "doi");
  assert.equal(result.confidence, 1);
});

test("year and author evidence resolve duplicate exact titles without silently picking", () => {
  const byYear = matchReferenceDetailed(
    extractReferenceEvidence("[2] Smith et al. Shared Title. *Journal* 2021."),
    [
      { key: "OLDER001", title: "Shared Title", year: "2019", creators: "Smith et al." },
      { key: "TARGET02", title: "Shared Title", year: "2021", creators: "Smith et al." },
    ],
  );
  assert.equal(byYear.key, "TARGET02");
  assert.equal(byYear.matchMethod, "title-year");

  const byAuthor = matchReferenceDetailed(
    extractReferenceEvidence("[3] Jones et al. Shared Title. *Journal*."),
    [
      { key: "SMITH001", title: "Shared Title", creators: "Smith et al." },
      { key: "JONES001", title: "Shared Title", creators: "Jones et al." },
    ],
  );
  assert.equal(byAuthor.key, "JONES001");
  assert.equal(byAuthor.matchMethod, "title-author");
});

test("a conflicting DOI blocks automatic title matching", () => {
  const result = matchReferenceDetailed(
    extractReferenceEvidence("[4] Smith et al. Shared Title. *Journal*. doi:10.1000/expected"),
    [{ key: "WRONG001", title: "Shared Title", doi: "10.1000/different", creators: "Smith et al." }],
  );

  assert.equal(result.key, null);
  assert.deepEqual(result.ambiguous.map((entry) => entry.key), ["WRONG001"]);
});

test("a Zotero ShortDOI is treated as unknown rather than a conflicting full DOI", () => {
  const result = matchReferenceDetailed(
    extractReferenceEvidence("[5] Smith et al. Shared Title. *Journal*. doi:10.1000/expected"),
    [{ key: "SHORT001", title: "Shared Title", doi: "10/abc123", creators: "Smith et al." }],
  );

  assert.equal(result.key, "SHORT001");
  assert.equal(result.matchMethod, "title-exact");
  assert.equal(result.confidence, 0.93);
});

test("a unique title-contains candidate remains an explicit low-confidence suggestion", () => {
  const result = matchReferenceDetailed(
    extractReferenceEvidence("[6] Committee. Materials Genome Initiative for Global Competitiveness. 2011."),
    [{ key: "REPORT01", title: "Materials Genome Initiative for Global Competitiveness" }],
  );

  assert.equal(result.key, null);
  assert.equal(result.matchMethod, "title-contains");
  assert.equal(result.confidence, 0.8);
  assert.deepEqual(result.ambiguous.map((entry) => entry.key), ["REPORT01"]);
});

test("title matching selects a unique exact title", () => {
  const result = matchTitleDetailed(["Self-Driving Platform for Metal Nanoparticle Synthesis"], [
    { key: "TARGET01", title: "Self-Driving Platform for Metal Nanoparticle Synthesis" },
    { key: "OTHER001", title: "A Different Paper" },
  ]);

  assert.equal(result.key, "TARGET01");
  assert.deepEqual(result.ambiguous, []);
});
