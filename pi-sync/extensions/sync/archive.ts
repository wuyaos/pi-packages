import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../_shared/spawn";
import { platformCode, sanitizeDeviceName, type PlatformCode } from "./archive-name";
import {
  AGENT_DIR,
  AGENT_SKILLS_DIR,
  PI_EXCLUDE_GLOBS,
  ensureDir,
  matchExcludeGlob,
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

/**
 * 归档来源信息（manifest.json 顶层 meta 字段）。跨设备恢复后供修复
 * 面板按源 home 精确映射路径；旧归档无 meta 时为 undefined。
 */
export interface ManifestSourceMeta {
  /** 打包机器的家目录（os.homedir() 原样字符串）。 */
  sourceHome: string;
  /** 打包平台简码（win | mac | linux）。 */
  platform: PlatformCode;
  /** 打包设备名。 */
  device: string;
  /** meta 写入时间（ISO）。 */
  createdAt: string;
}

export function writeManifest(tempDir: string, agentDir: string, files: ManifestFile[], deviceName?: string): void {
  fs.writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    agentDir,
    fileCount: files.length,
    files,
    meta: {
      sourceHome: os.homedir(),
      platform: platformCode(),
      device: sanitizeDeviceName(deviceName ?? ""),
      createdAt: new Date().toISOString(),
    } satisfies ManifestSourceMeta,
  }, null, 2), "utf8");
}

/**
 * 从解包目录读取 manifest 顶层 meta；缺失或字段不完整（旧归档）返回
 * undefined。只信任字符串类型的 sourceHome，不校验路径存在性。
 */
export function readManifestSourceMeta(tempDir: string): ManifestSourceMeta | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(tempDir, "manifest.json"), "utf8"));
    const meta = (parsed as { meta?: unknown } | null)?.meta;
    if (!meta || typeof meta !== "object") return undefined;
    const sourceHome = (meta as { sourceHome?: unknown }).sourceHome;
    if (typeof sourceHome !== "string" || !sourceHome) return undefined;
    const platform = (meta as { platform?: unknown }).platform;
    const device = (meta as { device?: unknown }).device;
    const createdAt = (meta as { createdAt?: unknown }).createdAt;
    return {
      sourceHome,
      platform: platform === "win" || platform === "mac" || platform === "linux" ? platform : "linux",
      device: typeof device === "string" ? device : "",
      createdAt: typeof createdAt === "string" ? createdAt : "",
    };
  } catch {
    return undefined;
  }
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

function validatePiAgentTree(sourceDir: string, exclusions: readonly string[], globs: readonly string[]): number {
  const root = lstatRegularOrDirectory(sourceDir);
  if (!root.isDirectory()) throw new Error(`Pi agent path is not a directory: ${sourceDir}`);
  let fileCount = 0;
  const visit = (dir: string, relativeDir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      if (isExcluded(relativePath, exclusions) || matchExcludeGlob(name, globs)) continue;
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
 * excluded install/state trees and noise-name globs (*.log, *.bak, *.tmp,
 * *.swp, sync-state.json, *.bak-*) are skipped during both scan and
 * compression. Glob patterns stay unanchored (`--exclude=*.log`) so tar
 * matches them at any depth.
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
  const fileCount = validatePiAgentTree(source, exclusions, PI_EXCLUDE_GLOBS);
  if (fileCount === 0) throw new Error("No Pi agent files found to back up.");
  const excludeArgs = [
    ...exclusions.map((relativePath) => `--exclude=./${relativePath}`),
    // 不加 ./ 前缀：unanchored 模式在任意深度匹配文件名。
    ...PI_EXCLUDE_GLOBS.map((glob) => `--exclude=${glob}`),
  ];
  await yieldToUI();
  await runTar(["-J", "-c", "-f", output, ...excludeArgs, "-C", source, "."]);
  return [
    `Pi agent: ${fileCount} file(s)`,
    `Excluded: ${[...exclusions, ...PI_EXCLUDE_GLOBS].join(", ")}`,
  ];
}

export async function createAgentSkillsZip(archivePath: string, sourceDir = AGENT_SKILLS_DIR, deviceName?: string): Promise<string[]> {
  if (!fs.existsSync(sourceDir)) throw new Error("~/.agents/skills does not exist.");
  const tempDir = path.join(os.tmpdir(), `pi_agent_skills_temp_${Date.now()}`);
  const destDir = path.join(tempDir, "agent-skills");
  const manifest: ManifestFile[] = [];
  try {
    copyRecursiveSyncFiltered(
      sourceDir,
      destDir,
      // 与 Pi 归档共用通配排除：目录层拒 __pycache__，文件层拒 *.pyc 与噪声名。
      (name, isDirectory) => isDirectory ? name !== "__pycache__" : !name.endsWith(".pyc") && !matchExcludeGlob(name, PI_EXCLUDE_GLOBS),
    );
    collectManifest(destDir, "agent-skills", ".agents/skills", manifest);
    if (manifest.length === 0) throw new Error("No shared agent skill files found.");
    writeManifest(tempDir, os.homedir(), manifest, deviceName);
    await packTemporaryArchive(tempDir, archivePath);
    return [`Shared agent skills: ${manifest.length} file(s)`];
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

