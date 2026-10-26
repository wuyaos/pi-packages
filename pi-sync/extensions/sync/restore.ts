import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { timestampForBackup } from "../_shared/json-io";
import {
  copyRecursiveSync,
  listArchiveEntries,
  readManifestSourceMeta,
  runTar,
  validateArchiveEntries,
  validateArchiveEntryTypes,
  type ManifestSourceMeta,
} from "./archive";
import { AGENT_DIR, AGENT_SKILLS_DIR, ensureDir } from "./config";

/**
 * 恢复结果：detail 行数组，附加 sourceMeta（manifest 来源信息；旧归档或
 * Pi 直打归档无 manifest 时为 undefined）。向后代兼容：数组形态不变。
 */
export type RestoreResult = string[] & { sourceMeta?: ManifestSourceMeta };

/** 把来源 meta 附着到 detail 行数组上（无 meta 时保持 undefined）。 */
function withSourceMeta(lines: string[], tempDir: string): RestoreResult {
  const result = lines as RestoreResult;
  result.sourceMeta = readManifestSourceMeta(tempDir);
  return result;
}

async function extractToTemp(archivePath: string, prefix: string): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `${prefix}_${Date.now()}`);
  ensureDir(tempDir);
  validateArchiveEntries(await listArchiveEntries(archivePath));
  await validateArchiveEntryTypes(archivePath);
  await runTar(["-x", "--no-same-owner", "--no-same-permissions", "-f", archivePath, "-C", tempDir]);
  return tempDir;
}

function assertSafeRestoreParent(root: string, destination: string): void {
  // destination 就是 root 本身时是安全的：
  // 此时 dirname(destination) 在 root 之外，会被下面的检查误判为路径逃逸。
  if (path.resolve(destination) === path.resolve(root)) return;
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

function typeConflictWarning(destination: string, root: string): string {
  const relative = path.relative(root, destination) || destination;
  return `Type conflict, skipped: ${relative} (archive and local disagree between file and directory; resolve manually if needed)`;
}

function copyExtractedTree(source: string, destination: string, root: string, warnings: string[]): number {
  const sourceStats = fs.lstatSync(source);
  if (sourceStats.isSymbolicLink() || (!sourceStats.isFile() && !sourceStats.isDirectory())) {
    throw new Error(`Unsafe extracted entry rejected: ${source}`);
  }
  assertSafeRestoreParent(root, destination);
  if (sourceStats.isDirectory()) {
    if (fs.existsSync(destination)) {
      const destinationStats = fs.lstatSync(destination);
      if (destinationStats.isSymbolicLink()) {
        throw new Error(`Unsafe restore destination rejected: ${destination}`);
      }
      if (!destinationStats.isDirectory()) {
        // 归档目录 vs 本地普通文件：类型冲突不阻断整体恢复，跳过并记录
        warnings.push(typeConflictWarning(destination, root));
        return 0;
      }
    } else {
      fs.mkdirSync(destination, { recursive: true });
    }
    let copied = 0;
    for (const child of fs.readdirSync(source)) {
      copied += copyExtractedTree(path.join(source, child), path.join(destination, child), root, warnings);
    }
    return copied;
  }
  if (fs.existsSync(destination)) {
    const destinationStats = fs.lstatSync(destination);
    if (destinationStats.isSymbolicLink()) {
      throw new Error(`Unsafe restore destination rejected: ${destination}`);
    }
    if (!destinationStats.isFile()) {
      // 归档文件 vs 本地普通目录：类型冲突不阻断整体恢复，跳过并记录
      warnings.push(typeConflictWarning(destination, root));
      return 0;
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
    const warnings: string[] = [];
    for (const name of fs.readdirSync(tempDir)) {
      fileCount += copyExtractedTree(path.join(tempDir, name), path.join(target, name), target, warnings);
    }
    if (fileCount === 0 && warnings.length === 0) throw new Error("Pi backup archive contained no files.");
    return withSourceMeta([`Pi agent: ${fileCount} file(s) merged`, ...warnings], tempDir);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

export function getRestorePlan(entries: string[]): string[] {
  if (entries.some((entry) => entry === "settings.json" || entry === "models.json" || entry === "AGENTS.md")) {
    return ["Pi agent files will be merged; excluded install and runtime directories remain untouched."];
  }
  if (entries.some((entry) => entry === "agent-skills" || entry.startsWith("agent-skills/"))) {
    return ["Shared skills will replace ~/.agents/skills after the current directory is moved to a timestamped backup."];
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
    return withSourceMeta(previousMoved
      ? [`Shared skills restored; previous directory moved to ${backup}`]
      : ["Shared skills restored"], tempDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}


