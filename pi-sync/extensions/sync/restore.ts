import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { timestampForBackup } from "../_shared/json-io";
import { copyRecursiveSync, listArchiveEntries, runTar, validateArchiveEntries, validateArchiveEntryTypes } from "./archive";
import { AGENT_DIR, AGENT_SKILLS_DIR, SESSIONS_DIR, ensureDir } from "./config";

async function extractToTemp(archivePath: string, prefix: string): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `${prefix}_${Date.now()}`);
  ensureDir(tempDir);
  validateArchiveEntries(await listArchiveEntries(archivePath));
  await validateArchiveEntryTypes(archivePath);
  await runTar(["-x", "--no-same-owner", "--no-same-permissions", "-f", archivePath, "-C", tempDir]);
  return tempDir;
}

function assertSafeRestoreParent(root: string, destination: string): void {
  const relative = path.relative(root, path.dirname(destination));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Restore destination escapes root: ${destination}`);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Unsafe restore parent rejected: ${current}`);
    }
  }
}

function copyExtractedTree(source: string, destination: string, root: string): number {
  const sourceStats = fs.lstatSync(source);
  if (sourceStats.isSymbolicLink() || (!sourceStats.isFile() && !sourceStats.isDirectory())) {
    throw new Error(`Unsafe extracted entry rejected: ${source}`);
  }
  assertSafeRestoreParent(root, destination);
  if (sourceStats.isDirectory()) {
    if (fs.existsSync(destination)) {
      const destinationStats = fs.lstatSync(destination);
      if (destinationStats.isSymbolicLink() || !destinationStats.isDirectory()) {
        throw new Error(`Unsafe restore destination rejected: ${destination}`);
      }
    } else {
      fs.mkdirSync(destination, { recursive: true });
    }
    let copied = 0;
    for (const child of fs.readdirSync(source)) {
      copied += copyExtractedTree(path.join(source, child), path.join(destination, child), root);
    }
    return copied;
  }
  if (fs.existsSync(destination)) {
    const destinationStats = fs.lstatSync(destination);
    if (destinationStats.isSymbolicLink() || !destinationStats.isFile()) {
      throw new Error(`Unsafe restore destination rejected: ${destination}`);
    }
  }
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  return 1;
}

/** Merge an archive created by createPiAgentZip into ~/.pi/agent. */
export async function extractPiAgentZip(archivePath: string, targetDir = AGENT_DIR): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_agent_extract");
  const target = path.resolve(targetDir);
  try {
    fs.mkdirSync(target, { recursive: true });
    const targetStats = fs.lstatSync(target);
    if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
      throw new Error(`Pi agent restore target is not a safe directory: ${target}`);
    }
    let fileCount = 0;
    for (const name of fs.readdirSync(tempDir)) {
      fileCount += copyExtractedTree(path.join(tempDir, name), path.join(target, name), target);
    }
    if (fileCount === 0) throw new Error("Pi backup archive contained no files.");
    return [`Pi agent: ${fileCount} file(s) merged`];
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

export function getRestorePlan(entries: string[]): string[] {
  if (entries.some((entry) => entry === "settings.json" || entry === "models.json" || entry === "AGENTS.md")) {
    return ["Pi agent files will be merged; excluded install/session/state directories remain untouched."];
  }
  if (entries.some((entry) => entry === "agent-skills" || entry.startsWith("agent-skills/"))) {
    return ["Shared skills will replace ~/.agents/skills after the current directory is moved to a timestamped backup."];
  }
  if (entries.some((entry) => entry === "sessions" || entry.startsWith("sessions/"))) {
    return ["Session files will be merged into ~/.pi/agent/sessions/."];
  }
  return ["Archive files will be merged into their destination."];
}

export async function extractAgentSkillsZip(archivePath: string, targetDir = AGENT_SKILLS_DIR): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_agent_skills_extract");
  const target = path.resolve(targetDir);
  const parent = path.dirname(target);
  const name = path.basename(target);
  const staging = path.join(parent, `.${name}-restore-${process.pid}-${Date.now()}`);
  const backup = path.join(parent, `${name}-backup-${timestampForBackup()}`);
  let previousMoved = false;
  try {
    const source = path.join(tempDir, "agent-skills");
    if (!fs.existsSync(source)) throw new Error("Archive does not contain agent-skills/.");
    ensureDir(parent);
    // Complete the potentially fallible recursive copy before touching the
    // current skills directory. Staging shares the target filesystem so the
    // final rename is atomic.
    copyRecursiveSync(source, staging);
    if (fs.existsSync(target)) {
      if (fs.existsSync(backup)) throw new Error(`Skills backup destination already exists: ${backup}`);
      fs.renameSync(target, backup);
      previousMoved = true;
    }
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (previousMoved && !fs.existsSync(target) && fs.existsSync(backup)) {
        try {
          fs.renameSync(backup, target);
        } catch (rollbackError) {
          console.error(`[pi-sync] Failed to roll back shared skills restore: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      throw error;
    }
    return previousMoved
      ? [`Shared skills restored; previous directory moved to ${backup}`]
      : ["Shared skills restored"];
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function extractSessionsArchiveZip(archivePath: string): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_sessions_extract");
  try {
    const source = path.join(tempDir, "sessions");
    if (!fs.existsSync(source)) throw new Error("Archive does not contain sessions/.");
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const fileCount = copyExtractedTree(source, SESSIONS_DIR, SESSIONS_DIR);
    return [`Session archive merged: ${fileCount} file(s)`];
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}
