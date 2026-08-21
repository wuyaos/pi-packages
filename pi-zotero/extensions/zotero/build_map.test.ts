import assert from "node:assert/strict";
import { test } from "node:test";

import { matchTitleDetailed } from "./build_map.ts";

test("title matching returns ambiguous instead of silently picking the first duplicate", () => {
  const result = matchTitleDetailed(["Attention Is All You Need"], [
    { key: "PREPRINT", title: "Attention Is All You Need" },
    { key: "CONF0001", title: "Attention Is All You Need" },
  ]);

  assert.equal(result.key, null);
  assert.deepEqual(result.ambiguous.map((entry) => entry.key), ["PREPRINT", "CONF0001"]);
});

test("title matching selects a unique exact title", () => {
  const result = matchTitleDetailed(["Self-Driving Platform for Metal Nanoparticle Synthesis"], [
    { key: "TARGET01", title: "Self-Driving Platform for Metal Nanoparticle Synthesis" },
    { key: "OTHER001", title: "A Different Paper" },
  ]);

  assert.equal(result.key, "TARGET01");
  assert.deepEqual(result.ambiguous, []);
});
