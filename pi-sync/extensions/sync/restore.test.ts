import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createPiAgentZip } from "./archive.ts";
import { extractAgentSkillsZip, extractPiAgentZip } from "./restore.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-restore-"));
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
  fs.symlinkSync(outside, path.join(target, "config"));

  await createPiAgentZip({ piExcludePaths: [] }, archive, source);
  await assert.rejects(() => extractPiAgentZip(archive, target), /Unsafe restore destination rejected/);
  assert.ok(!fs.existsSync(path.join(outside, "sync.json")));
});
