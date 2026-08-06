import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createPiAgentZip, listArchiveEntries, validateArchiveEntries, validateArchiveEntryTypes } from "./archive.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-archive-"));
}

test("archive entry path validation accepts plugin files and rejects path escapes", () => {
  validateArchiveEntries(["settings.json", "config/sync.json", "extensions/plugin/config.json", "manifest.json"]);
  for (const unsafe of ["../escape", "/etc/passwd", "config//settings.json", "C:/outside", "config/./settings.json"]) {
    assert.throws(() => validateArchiveEntries([unsafe]), /Unsafe archive path/);
  }
});

test("Pi agent archive excludes configured trees without staging a copy", async (t) => {
  const root = tempDir();
  const source = path.join(root, "agent");
  const archive = path.join(root, "backup.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.mkdirSync(path.join(source, "npm", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(source, "sessions", "project"), { recursive: true });
  fs.writeFileSync(path.join(source, "settings.json"), "{}");
  fs.writeFileSync(path.join(source, "config", "sync.json"), "{}");
  fs.writeFileSync(path.join(source, "npm", "pkg", "index.js"), "installed");
  fs.writeFileSync(path.join(source, "sessions", "project", "session.jsonl"), "session");

  await createPiAgentZip({ piExcludePaths: ["npm", "sessions"] }, archive, source);
  const entries = await listArchiveEntries(archive);
  assert.ok(entries.includes("settings.json"));
  assert.ok(entries.includes("config/sync.json"));
  assert.ok(!entries.some((entry) => entry === "npm" || entry.startsWith("npm/")));
  assert.ok(!entries.some((entry) => entry === "sessions" || entry.startsWith("sessions/")));
});

test("Pi agent archive skips unsafe entries within an excluded runtime tree", async (t) => {
  const root = tempDir();
  const source = path.join(root, "agent");
  const archive = path.join(root, "backup.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "tmp"), { recursive: true });
  fs.writeFileSync(path.join(source, "settings.json"), "{}");
  fs.symlinkSync("/etc/passwd", path.join(source, "tmp", "runtime-link"));

  await createPiAgentZip({ piExcludePaths: ["tmp"] }, archive, source);

  const entries = await listArchiveEntries(archive);
  assert.ok(entries.includes("settings.json"));
  assert.ok(!entries.some((entry) => entry === "tmp" || entry.startsWith("tmp/")));
});

test("Pi agent archive refuses symbolic links before invoking tar", async (t) => {
  const root = tempDir();
  const source = path.join(root, "agent");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "settings.json"), "{}");
  fs.symlinkSync("/etc/passwd", path.join(source, "unsafe-link"));
  await assert.rejects(
    () => createPiAgentZip({ piExcludePaths: [] }, path.join(root, "backup.tar.xz"), source),
    /Refusing unsafe filesystem entry/,
  );
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
