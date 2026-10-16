import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createAgentSkillsZip, createCortexkitZip, createPiAgentZip, listArchiveEntries, readManifestSourceMeta, validateArchiveEntries, validateArchiveEntryTypes, writeManifest } from "./archive.ts";
import { platformCode } from "./archive-name.ts";
import { DEFAULT_PI_EXCLUDE_PATHS } from "./config.ts";

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

test("Pi agent archive excludes the install tree and noise-name globs", async (t) => {
  const root = tempDir();
  const source = path.join(root, "agent");
  const archive = path.join(root, "backup.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "install"), { recursive: true });
  fs.writeFileSync(path.join(source, "install", "x"), "installed");
  fs.writeFileSync(path.join(source, "settings.json"), "{}");
  fs.writeFileSync(path.join(source, "a.bak"), "noise");
  fs.writeFileSync(path.join(source, "a.tmp"), "noise");
  fs.writeFileSync(path.join(source, "a.log"), "noise");
  fs.writeFileSync(path.join(source, "a.swp"), "noise");
  fs.writeFileSync(path.join(source, "sync-state.json"), "state");
  fs.writeFileSync(path.join(source, "model-config.json.bak-123"), "txn backup");

  await createPiAgentZip({ piExcludePaths: [...DEFAULT_PI_EXCLUDE_PATHS] }, archive, source);
  const entries = await listArchiveEntries(archive);
  assert.ok(entries.includes("settings.json"));
  const noise = ["install", "a.bak", "a.tmp", "a.log", "a.swp", "sync-state.json", "model-config.json.bak-123"];
  for (const name of noise) {
    assert.ok(!entries.includes(name), `expected excluded: ${name}`);
  }
});

test("skills archive excludes __pycache__, *.pyc, and shared noise-name globs", async (t) => {
  const root = tempDir();
  const source = path.join(root, "skills");
  const archive = path.join(root, "skills.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "alpha", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(source, "alpha", "SKILL.md"), "keep");
  fs.writeFileSync(path.join(source, "alpha", "x.pyc"), "noise");
  fs.writeFileSync(path.join(source, "alpha", "__pycache__", "y.pyc"), "noise");
  fs.writeFileSync(path.join(source, "a.log"), "noise");
  fs.writeFileSync(path.join(source, "a.bak"), "noise");
  fs.writeFileSync(path.join(source, "a.tmp"), "noise");
  fs.writeFileSync(path.join(source, "a.swp"), "noise");
  fs.writeFileSync(path.join(source, "sync-state.json"), "noise");
  fs.writeFileSync(path.join(source, "SKILL.md.bak-123"), "noise");

  await createAgentSkillsZip(archive, source);
  const entries = await listArchiveEntries(archive);
  assert.ok(entries.includes("agent-skills/alpha/SKILL.md"));
  for (const entry of entries) {
    assert.ok(!entry.includes("__pycache__") && !entry.endsWith(".pyc") && !entry.includes(".log") && !entry.includes(".bak"), `unexpected entry: ${entry}`);
  }
});

test("cortexkit archive excludes shared noise-name globs beyond log files", async (t) => {
  const root = tempDir();
  const source = path.join(root, "cortexkit");
  const archive = path.join(root, "cortexkit.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "magic-context.jsonc"), "{}\n");
  fs.writeFileSync(path.join(source, "debug.log"), "noise");
  fs.writeFileSync(path.join(source, "magic-context.jsonc.bak"), "noise");
  fs.writeFileSync(path.join(source, "compaction.tmp"), "noise");
  fs.writeFileSync(path.join(source, "session.swp"), "noise");
  fs.writeFileSync(path.join(source, "magic-context.jsonc.bak-456"), "noise");

  await createCortexkitZip(archive, source);
  const entries = await listArchiveEntries(archive);
  assert.ok(entries.includes("cortexkit/magic-context.jsonc"));
  assert.deepEqual(
    entries.filter((entry) => !entry.endsWith("manifest.json")),
    ["cortexkit", "cortexkit/magic-context.jsonc"],
  );
});

test("cortexkit archive rejects a missing config directory", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    () => createCortexkitZip(path.join(root, "cortexkit.tar.xz"), path.join(root, "missing")),
    /does not exist/,
  );
});

test("writeManifest records source meta as an independent field without touching files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-manifest-"));
  try {
    writeManifest(tempDir, os.homedir(), [{ archive: "cortexkit/x.jsonc", source: ".config/cortexkit/x.jsonc" }], "devA");
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, "manifest.json"), "utf8"));
    // files 数组结构不变。
    assert.deepEqual(manifest.files, [{ archive: "cortexkit/x.jsonc", source: ".config/cortexkit/x.jsonc" }]);
    assert.equal(manifest.fileCount, 1);
    assert.equal(manifest.version, 1);
    // meta 为独立顶层字段。
    assert.equal(manifest.meta.sourceHome, os.homedir());
    assert.equal(manifest.meta.platform, platformCode());
    assert.equal(manifest.meta.device, "devA");
    assert.ok(manifest.meta.createdAt);
    // readManifestSourceMeta 读回一致。
    const meta = readManifestSourceMeta(tempDir);
    assert.deepEqual(meta, manifest.meta);
    // 缺失/损坏的 manifest 返回 undefined。
    assert.equal(readManifestSourceMeta(path.join(tempDir, "missing-dir")), undefined);
    fs.writeFileSync(path.join(tempDir, "manifest.json"), "{broken");
    assert.equal(readManifestSourceMeta(tempDir), undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
