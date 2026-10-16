import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createCortexkitZip, createPiAgentZip, listArchiveEntries, validateArchiveEntries, validateArchiveEntryTypes } from "./archive.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-archive-"));
}

function createSymlinkOrSkip(t: { skip(message?: string): void }, target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symbolic link creation requires Windows developer mode or elevated privileges");
      return false;
    }
    throw error;
  }
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
  fs.writeFileSync(path.join(source, "settings.json"), "{}");
  fs.writeFileSync(path.join(source, "config", "sync.json"), "{}");
  fs.writeFileSync(path.join(source, "npm", "pkg", "index.js"), "installed");

  await createPiAgentZip({ piExcludePaths: ["npm"] }, archive, source);
  const entries = await listArchiveEntries(archive);
  assert.ok(entries.includes("settings.json"));
  assert.ok(entries.includes("config/sync.json"));
  assert.ok(!entries.some((entry) => entry === "npm" || entry.startsWith("npm/")));
});

test("Pi agent archive skips unsafe entries within an excluded runtime tree", async (t) => {
  const root = tempDir();
  const source = path.join(root, "agent");
  const archive = path.join(root, "backup.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "tmp"), { recursive: true });
  fs.writeFileSync(path.join(source, "settings.json"), "{}");
  if (!createSymlinkOrSkip(t, "/etc/passwd", path.join(source, "tmp", "runtime-link"))) return;

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
  if (!createSymlinkOrSkip(t, "/etc/passwd", path.join(source, "unsafe-link"))) return;
  await assert.rejects(
    () => createPiAgentZip({ piExcludePaths: [] }, path.join(root, "backup.tar.xz"), source),
    /Refusing unsafe filesystem entry/,
  );
});

test("archive type validation rejects symbolic links before extraction", async (t) => {
  const root = tempDir();
  const payload = path.join(root, "payload");
  const archive = path.join(root, "unsafe.tar");
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, "safe.txt"), "safe");
  if (!createSymlinkOrSkip(t, "/etc/passwd", path.join(payload, "escape-link"))) return;
  execFileSync("tar", ["-c", "-f", archive, "-C", payload, "."]);
  await assert.rejects(() => validateArchiveEntryTypes(archive), /Unsafe archive entry type rejected: l/);
});

test("cortexkit archive packs config files and excludes log files", async (t) => {
  const root = tempDir();
  const source = path.join(root, "cortexkit");
  const archive = path.join(root, "cortexkit.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(source, "magic-context.jsonc"), "{}\n");
  fs.writeFileSync(path.join(source, "debug.log"), "noise");
  fs.writeFileSync(path.join(source, "sessions", "compaction.md"), "memory");

  await createCortexkitZip(archive, source);

  const entries = await listArchiveEntries(archive);
  assert.ok(entries.includes("cortexkit/magic-context.jsonc"));
  assert.ok(entries.includes("cortexkit/sessions/compaction.md"));
  assert.ok(!entries.some((entry) => entry.endsWith(".log")));
});

test("cortexkit archive rejects a missing config directory", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    () => createCortexkitZip(path.join(root, "cortexkit.tar.xz"), path.join(root, "missing")),
    /does not exist/,
  );
});
