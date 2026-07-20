import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../_shared/spawn";
import {
  AGENT_DIR,
  AGENT_ROOT_MARKDOWN_FILES,
  AGENT_SKILLS_DIR,
  MEMORY_MARKDOWN_FILES,
  SESSIONS_DIR,
  ensureDir,
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

export function copyRecursiveSync(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  const stats = fs.statSync(src);
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
  const stats = fs.statSync(src);
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
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const archivePath = `${archivePrefix}/${entry.name}`;
    const sourcePath = sourcePrefix ? `${sourcePrefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectManifest(full, archivePath, sourcePath, files);
    else files.push({ archive: archivePath, source: sourcePath });
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

export function validateArchiveEntries(entries: string[]): void {
  const allowed = new Set(["config", "skills", "extensions", "sessions", "memory", "agent-skills", "manifest.json"]);
  const legacyConfigFiles = new Set(["models.json", "settings.json", "auth.json"]);
  const rootMarkdownFiles = new Set<string>(AGENT_ROOT_MARKDOWN_FILES);
  if (entries.length === 0) throw new Error("Backup archive is empty or unreadable");
  for (const entry of entries) {
    const parts = entry.split("/");
    if (entry.startsWith("/") || /^[a-zA-Z]:\//.test(entry) || parts.includes("..") || !allowed.has(parts[0]!)) {
      throw new Error(`Unsafe archive path rejected: ${entry}`);
    }
    if (parts[0] !== "config" || !parts[1]) continue;
    if (parts[1] === "root") {
      if (!parts[2]) continue;
      if (parts.length !== 3 || (!parts[2].endsWith(".json") && !rootMarkdownFiles.has(parts[2]))) {
        throw new Error(`Unexpected root config file rejected: ${entry}`);
      }
    } else if (parts[1] === "sub") {
      continue;
    } else if (parts.length !== 2 || !legacyConfigFiles.has(parts[1])) {
      throw new Error(`Unexpected config file rejected: ${entry}`);
    }
  }
}

export async function packTemporaryArchive(tempDir: string, archivePath: string): Promise<void> {
  await yieldToUI();
  await runTar(["-J", "-c", "-f", archivePath, "-C", tempDir, "."]);
}

export async function createConfigZip(config: SyncConfig, archivePath: string): Promise<string[]> {
  const tempDir = path.join(os.tmpdir(), `pi_config_temp_${Date.now()}`);
  const rootDir = path.join(tempDir, "config", "root");
  const subDir = path.join(tempDir, "config", "sub");
  const manifest: ManifestFile[] = [];
  const contents: string[] = [];
  ensureDir(rootDir);
  ensureDir(subDir);
  try {
    if (config.backupProviders) {
      const rootNames = fs.readdirSync(AGENT_DIR).filter((name) => name.endsWith(".json"));
      for (const name of AGENT_ROOT_MARKDOWN_FILES) if (!rootNames.includes(name)) rootNames.push(name);
      for (const name of rootNames) {
        const src = path.join(AGENT_DIR, name);
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
        fs.copyFileSync(src, path.join(rootDir, name));
        manifest.push({ archive: `config/root/${name}`, source: name });
        contents.push(`Config: ${name}`);
      }
      const configDir = path.join(AGENT_DIR, "config");
      if (fs.existsSync(configDir)) {
        copyRecursiveSync(configDir, subDir);
        collectManifest(subDir, "config/sub", "config", manifest);
        contents.push("Config directory");
      }
    }
    if (config.backupExtensions) {
      const source = path.join(AGENT_DIR, "extensions");
      const dest = path.join(tempDir, "extensions");
      if (fs.existsSync(source)) {
        copyRecursiveSync(source, dest);
        fs.rmSync(path.join(dest, "sync"), { recursive: true, force: true });
        collectManifest(dest, "extensions", "extensions", manifest);
        contents.push("Extensions directory");
      }
    }
    if (manifest.length === 0) throw new Error("No config or extension files found to back up.");
    writeManifest(tempDir, AGENT_DIR, manifest);
    await packTemporaryArchive(tempDir, archivePath);
    return contents;
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

export async function createMemoryZip(archivePath: string): Promise<string[]> {
  const sourceDir = path.join(AGENT_DIR, "pi-hermes-memory");
  const tempDir = path.join(os.tmpdir(), `pi_memory_temp_${Date.now()}`);
  const destDir = path.join(tempDir, "memory");
  const manifest: ManifestFile[] = [];
  ensureDir(destDir);
  try {
    for (const name of MEMORY_MARKDOWN_FILES) {
      const src = path.join(sourceDir, name);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(destDir, name));
      manifest.push({ archive: `memory/${name}`, source: `pi-hermes-memory/${name}` });
    }
    if (manifest.length === 0) throw new Error("No durable pi-hermes-memory markdown files found.");
    writeManifest(tempDir, AGENT_DIR, manifest);
    await packTemporaryArchive(tempDir, archivePath);
    return manifest.map((item) => `Memory: ${path.basename(item.source)}`);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
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

export async function createLegacyZip(config: SyncConfig, archivePath: string): Promise<string[]> {
  const tempDir = path.join(os.tmpdir(), `pi_sync_temp_${Date.now()}`);
  const manifest: ManifestFile[] = [];
  const contents: string[] = [];
  ensureDir(tempDir);
  try {
    if (config.backupProviders) {
      const configDir = path.join(tempDir, "config");
      ensureDir(configDir);
      for (const name of ["models.json", "settings.json", "auth.json"]) {
        const src = path.join(AGENT_DIR, name);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(configDir, name));
        manifest.push({ archive: `config/${name}`, source: name });
        contents.push(`Config: ${name}`);
      }
    }
    if (config.backupSkills) {
      const src = path.join(AGENT_DIR, "skills"), dest = path.join(tempDir, "skills");
      if (fs.existsSync(src)) { copyRecursiveSync(src, dest); collectManifest(dest, "skills", "skills", manifest); contents.push("Skills Directory"); }
    }
    if (config.backupExtensions) {
      const src = path.join(AGENT_DIR, "extensions"), dest = path.join(tempDir, "extensions");
      if (fs.existsSync(src)) { copyRecursiveSync(src, dest); fs.rmSync(path.join(dest, "sync"), { recursive: true, force: true }); collectManifest(dest, "extensions", "extensions", manifest); contents.push("Extensions Directory"); }
    }
    if (config.backupSessions) {
      for (const entry of fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }) : []) {
        if (!entry.isDirectory()) continue;
        const listed = config.sessionProjects.includes(entry.name);
        if (config.sessionProjects.length && (config.sessionProjectMode === "whitelist" ? !listed : listed)) continue;
        const dest = path.join(tempDir, "sessions", entry.name);
        copyRecursiveSync(path.join(SESSIONS_DIR, entry.name), dest);
      }
      const sessionsDest = path.join(tempDir, "sessions");
      if (fs.existsSync(sessionsDest)) { collectManifest(sessionsDest, "sessions", "sessions", manifest); contents.push("Sessions"); }
    }
    if (manifest.length === 0) throw new Error("No components selected or found to backup.");
    writeManifest(tempDir, AGENT_DIR, manifest);
    await packTemporaryArchive(tempDir, archivePath);
    return contents;
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}
