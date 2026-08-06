import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../_shared/spawn";
import {
  AGENT_DIR,
  AGENT_SKILLS_DIR,
  SESSIONS_DIR,
  ensureDir,
  normalizePiExcludePaths,
  type ManifestFile,
  type SyncConfig,
} from "./config";

const TAR_TIMEOUT_MS = 300_000;

export function platformTag(): string {
  const platform = os.platform();
  if (platform === "win32") {
    const build = parseInt(os.release().split(".")[2] ?? "0", 10);
    return build >= 22000 ? "windows11" : "windows10";
  }
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return platform;
}

export function archiveTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function runTar(args: string[], options: { capture?: boolean; timeoutMs?: number } = {}): Promise<string> {
  const result = await runCommand("tar", args, { timeoutMs: options.timeoutMs ?? TAR_TIMEOUT_MS });
  if (!result.ok) throw new Error(result.stderr || `tar ${args[0]} failed with status ${result.status}`);
  return options.capture ? result.stdout : "";
}

function lstatRegularOrDirectory(src: string): fs.Stats {
  const stats = fs.lstatSync(src);
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw new Error(`Refusing unsafe filesystem entry: ${src}`);
  }
  return stats;
}

export function copyRecursiveSync(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  const stats = lstatRegularOrDirectory(src);
  if (stats.isDirectory()) {
    ensureDir(dest);
    for (const child of fs.readdirSync(src)) copyRecursiveSync(path.join(src, child), path.join(dest, child));
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

export function copyRecursiveSyncFiltered(src: string, dest: string, include: (name: string, isDirectory: boolean) => boolean): void {
  if (!fs.existsSync(src)) return;
  const stats = lstatRegularOrDirectory(src);
  if (!include(path.basename(src), stats.isDirectory())) return;
  if (stats.isDirectory()) {
    ensureDir(dest);
    for (const child of fs.readdirSync(src)) copyRecursiveSyncFiltered(path.join(src, child), path.join(dest, child), include);
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

export function collectManifest(dir: string, archivePrefix: string, sourcePrefix: string, files: ManifestFile[]): void {
  if (!fs.existsSync(dir)) return;
  const stats = lstatRegularOrDirectory(dir);
  if (stats.isFile()) {
    files.push({ archive: archivePrefix, source: sourcePrefix });
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const archivePath = `${archivePrefix}/${entry.name}`;
    const sourcePath = sourcePrefix ? `${sourcePrefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectManifest(full, archivePath, sourcePath, files);
    else if (entry.isFile()) files.push({ archive: archivePath, source: sourcePath });
    else throw new Error(`Refusing unsafe filesystem entry: ${full}`);
  }
}

export function writeManifest(tempDir: string, agentDir: string, files: ManifestFile[]): void {
  fs.writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    agentDir,
    fileCount: files.length,
    files,
  }, null, 2), "utf8");
}

export function extractSessionTs(filename: string): string | null {
  return filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_/)?.[1] ?? null;
}

export async function listArchiveEntries(archivePath: string): Promise<string[]> {
  return (await runTar(["-t", "-f", archivePath], { capture: true }))
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((entry) => entry && entry !== ".");
}

/**
 * `tar -t` only prints names, so it cannot distinguish regular files from
 * links or device nodes. Ask tar for the entry type before extraction.
 * The POSIX tar permission field starts with `-` (file) or `d` (directory);
 * every other type is rejected.
 */
export async function validateArchiveEntryTypes(archivePath: string): Promise<void> {
  const lines = (await runTar(["-t", "-v", "-f", archivePath], { capture: true }))
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length === 0) throw new Error("Backup archive is empty or unreadable");
  for (const line of lines) {
    const entryType = line[0];
    if (entryType !== "-" && entryType !== "d") {
      throw new Error(`Unsafe archive entry type rejected: ${entryType ?? "unknown"}`);
    }
  }
}

export function validateArchiveEntries(entries: string[]): void {
  if (entries.length === 0) throw new Error("Backup archive is empty or unreadable");
  for (const entry of entries) {
    const parts = entry.split("/");
    if (
      entry.startsWith("/")
      || /^[a-zA-Z]:\//.test(entry)
      || parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe archive path rejected: ${entry}`);
    }
  }
}

export async function packTemporaryArchive(tempDir: string, archivePath: string): Promise<void> {
  await yieldToUI();
  await runTar(["-J", "-c", "-f", archivePath, "-C", tempDir, "."]);
}

function isExcluded(relativePath: string, exclusions: readonly string[]): boolean {
  return exclusions.some((excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`));
}

function validatePiAgentTree(sourceDir: string, exclusions: readonly string[]): number {
  const root = lstatRegularOrDirectory(sourceDir);
  if (!root.isDirectory()) throw new Error(`Pi agent path is not a directory: ${sourceDir}`);
  let fileCount = 0;
  const visit = (dir: string, relativeDir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      if (isExcluded(relativePath, exclusions)) continue;
      const fullPath = path.join(dir, name);
      const stats = lstatRegularOrDirectory(fullPath);
      if (stats.isDirectory()) visit(fullPath, relativePath);
      else fileCount += 1;
    }
  };
  visit(sourceDir, "");
  return fileCount;
}

/**
 * Pack ~/.pi/agent directly without first copying it to a staging directory.
 * A lightweight filesystem scan rejects links/special nodes before tar runs;
 * excluded install/state trees are skipped during both scan and compression.
 */
export async function createPiAgentZip(
  config: Pick<SyncConfig, "piExcludePaths">,
  archivePath: string,
  sourceDir = AGENT_DIR,
): Promise<string[]> {
  const source = path.resolve(sourceDir);
  const output = path.resolve(archivePath);
  if (output === source || output.startsWith(`${source}${path.sep}`)) {
    throw new Error("Pi backup archive must be written outside ~/.pi/agent.");
  }
  const exclusions = normalizePiExcludePaths(config.piExcludePaths);
  const fileCount = validatePiAgentTree(source, exclusions);
  if (fileCount === 0) throw new Error("No Pi agent files found to back up.");
  const excludeArgs = exclusions.map((relativePath) => `--exclude=./${relativePath}`);
  await yieldToUI();
  await runTar(["-J", "-c", "-f", output, ...excludeArgs, "-C", source, "."]);
  return [
    `Pi agent: ${fileCount} file(s)`,
    `Excluded: ${exclusions.length ? exclusions.join(", ") : "none"}`,
  ];
}

export async function createAgentSkillsZip(archivePath: string): Promise<string[]> {
  if (!fs.existsSync(AGENT_SKILLS_DIR)) throw new Error("~/.agents/skills does not exist.");
  const tempDir = path.join(os.tmpdir(), `pi_agent_skills_temp_${Date.now()}`);
  const destDir = path.join(tempDir, "agent-skills");
  const manifest: ManifestFile[] = [];
  try {
    copyRecursiveSyncFiltered(AGENT_SKILLS_DIR, destDir, (name, isDirectory) => isDirectory ? name !== "__pycache__" : !name.endsWith(".pyc"));
    collectManifest(destDir, "agent-skills", ".agents/skills", manifest);
    if (manifest.length === 0) throw new Error("No shared agent skill files found.");
    writeManifest(tempDir, os.homedir(), manifest);
    await packTemporaryArchive(tempDir, archivePath);
    return [`Shared agent skills: ${manifest.length} file(s)`];
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

export async function createSessionsArchiveZip(projectDir: string, archivePath: string): Promise<string[]> {
  const sourceDir = path.join(SESSIONS_DIR, projectDir);
  if (!fs.existsSync(sourceDir)) throw new Error(`Session project not found: ${projectDir}`);
  const tempDir = path.join(os.tmpdir(), `pi_sessions_temp_${Date.now()}`);
  const destDir = path.join(tempDir, "sessions", projectDir);
  const manifest: ManifestFile[] = [];
  try {
    copyRecursiveSync(sourceDir, destDir);
    collectManifest(destDir, `sessions/${projectDir}`, `sessions/${projectDir}`, manifest);
    if (manifest.length === 0) throw new Error(`No session files found for ${projectDir}.`);
    writeManifest(tempDir, AGENT_DIR, manifest);
    await packTemporaryArchive(tempDir, archivePath);
    return [`Sessions: ${projectDir} (${manifest.length} file(s))`];
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}
