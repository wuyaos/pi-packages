import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { validateArchiveEntries, validateArchiveEntryTypes } from "./archive.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-archive-"));
}

test("archive entry path validation rejects traversal, absolute paths, and malformed custom entries", () => {
  validateArchiveEntries(["config", "config/root", "config/root/settings.json", "custom", "custom/0", "custom/0/data", "custom/0/data/file.txt", "manifest.json"]);
  for (const unsafe of ["../escape", "/etc/passwd", "config//settings.json", "custom/nope/data/file", "custom/0/not-data/file"]) {
    assert.throws(() => validateArchiveEntries([unsafe]), /Unsafe archive path|Unexpected custom archive entry/);
  }
});

test("archive type validation rejects symbolic links before extraction", async () => {
  const root = tempDir();
  const payload = path.join(root, "payload");
  const archive = path.join(root, "unsafe.tar");
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, "safe.txt"), "safe");
  fs.symlinkSync("/etc/passwd", path.join(payload, "escape-link"));
  execFileSync("tar", ["-c", "-f", archive, "-C", payload, "."]);
  await assert.rejects(() => validateArchiveEntryTypes(archive), /Unsafe archive entry type rejected: l/);
});
