import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { writeFileAtomic, writeJsonAtomic } from "./atomic.ts";

test("atomic writes replace existing content without leaving temporary files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zotero-atomic-"));
  try {
    const filePath = path.join(directory, "nested", "state.json");
    writeFileAtomic(filePath, "old");
    writeJsonAtomic(filePath, { version: 2 }, { mode: 0o600 });

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf-8")), { version: 2 });
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ["state.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
