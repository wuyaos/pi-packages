import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createCortexkitZip, createPiAgentZip } from "./archive.ts";
import { extractAgentSkillsZip, extractCortexkitZip, extractPiAgentZip } from "./restore.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-restore-"));
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

test("Pi restore merges archived files and preserves excluded directories", async (t) => {
  const root = tempDir();
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const archive = path.join(root, "backup.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.mkdirSync(path.join(source, "npm"), { recursive: true });
  fs.writeFileSync(path.join(source, "settings.json"), "new");
  fs.writeFileSync(path.join(source, "config", "sync.json"), "config");
  fs.writeFileSync(path.join(source, "npm", "ignored.txt"), "ignored");

  fs.mkdirSync(path.join(target, "npm"), { recursive: true });
  fs.writeFileSync(path.join(target, "settings.json"), "old");
  fs.writeFileSync(path.join(target, "npm", "keep.txt"), "keep");

  await createPiAgentZip({ piExcludePaths: ["npm"] }, archive, source);
  await extractPiAgentZip(archive, target);

  assert.equal(fs.readFileSync(path.join(target, "settings.json"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(target, "config", "sync.json"), "utf8"), "config");
  assert.equal(fs.readFileSync(path.join(target, "npm", "keep.txt"), "utf8"), "keep");
  assert.ok(!fs.existsSync(path.join(target, "npm", "ignored.txt")));
});

test("Skills restore stages a complete copy before atomically replacing the current directory", async (t) => {
  const root = tempDir();
  const payload = path.join(root, "payload");
  const target = path.join(root, "skills");
  const archive = path.join(root, "skills.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(payload, "agent-skills"), { recursive: true });
  fs.writeFileSync(path.join(payload, "agent-skills", "new.md"), "new");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "old.md"), "old");
  execFileSync("tar", ["-J", "-c", "-f", archive, "-C", payload, "."]);

  await extractAgentSkillsZip(archive, target);

  assert.equal(fs.readFileSync(path.join(target, "new.md"), "utf8"), "new");
  const backups = fs.readdirSync(root).filter((name) => name.startsWith("skills-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, backups[0]!, "old.md"), "utf8"), "old");
  assert.ok(!fs.readdirSync(root).some((name) => name.startsWith(".skills-restore-")));
});

test("Cortexkit restore extracts to the target directory and keeps a timestamped backup", async (t) => {
  const root = tempDir();
  const payload = path.join(root, "payload");
  const target = path.join(root, "cortexkit");
  const archive = path.join(root, "cortexkit.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, "new-config"), { recursive: true });
  fs.writeFileSync(path.join(root, "new-config", "magic-context.jsonc"), "{}\n");
  await createCortexkitZip(archive, path.join(root, "new-config"));

  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "old.jsonc"), "old");
  await extractCortexkitZip(archive, target);

  assert.equal(fs.readFileSync(path.join(target, "magic-context.jsonc"), "utf8"), "{}\n");
  const backups = fs.readdirSync(root).filter((name) => name.startsWith("cortexkit-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, backups[0]!, "old.jsonc"), "utf8"), "old");
  assert.ok(!fs.readdirSync(root).some((name) => name.startsWith(".cortexkit-restore-")));
});

test("Cortexkit restore rejects an archive without a cortexkit/ directory", async (t) => {
  const root = tempDir();
  const payload = path.join(root, "payload");
  const archive = path.join(root, "bad.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, "stray.txt"), "x");
  execFileSync("tar", ["-J", "-c", "-f", archive, "-C", payload, "."]);
  await assert.rejects(() => extractCortexkitZip(archive, path.join(root, "target")), /does not contain cortexkit\//);
});

test("Pi restore rejects a symlink in the destination path", async (t) => {
  const root = tempDir();
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const outside = path.join(root, "outside");
  const archive = path.join(root, "backup.tar.xz");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.writeFileSync(path.join(source, "config", "sync.json"), "config");
  fs.mkdirSync(target);
  fs.mkdirSync(outside);
  if (!createSymlinkOrSkip(t, outside, path.join(target, "config"))) return;

  await createPiAgentZip({ piExcludePaths: [] }, archive, source);
  await assert.rejects(() => extractPiAgentZip(archive, target), /Unsafe restore destination rejected/);
  assert.ok(!fs.existsSync(path.join(outside, "sync.json")));
});

