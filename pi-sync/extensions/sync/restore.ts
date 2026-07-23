import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { timestampForBackup } from "../_shared/json-io";
import { copyRecursiveSync, listArchiveEntries, runTar, validateArchiveEntries, validateArchiveEntryTypes } from "./archive";
import { resolveCustomRestoreTarget, type CustomPathArchiveEntry, validateCustomPathSet } from "./custom-paths";
import {
  AGENT_DIR,
  AGENT_ROOT_MARKDOWN_FILES,
  AGENT_SKILLS_DIR,
  SESSIONS_DIR,
  ensureDir,
  type SyncConfig,
} from "./config";

async function extractToTemp(archivePath: string, prefix: string): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `${prefix}_${Date.now()}`);
  ensureDir(tempDir);
  validateArchiveEntries(await listArchiveEntries(archivePath));
  await validateArchiveEntryTypes(archivePath);
  await runTar(["-x", "--no-same-owner", "--no-same-permissions", "-f", archivePath, "-C", tempDir]);
  return tempDir;
}

function backupAndCopyFile(src: string, dest: string): void {
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest) && fs.statSync(dest).isFile()) fs.copyFileSync(dest, `${dest}.bak-${timestampForBackup()}`);
  fs.copyFileSync(src, dest);
}

export function getRestorePlan(entries: string[], config: SyncConfig): string[] {
  const has = (name: string) => entries.some((entry) => entry === name || entry.startsWith(`${name}/`));
  const plan: string[] = [];
  if (has("config")) plan.push(config.backupProviders ? "Config files will be overwritten after timestamped .bak copies are created." : "Config files are present but skipped by current settings.");
  if (has("skills")) plan.push(config.backupSkills ? "Pi skills will be replaced after a timestamped directory backup." : "Pi skills are present but skipped by current settings.");
  if (has("extensions")) plan.push(config.backupExtensions ? "Extensions will be merged after a timestamped directory backup." : "Extensions are present but skipped by current settings.");
  if (has("sessions")) plan.push(config.backupSessions ? "Sessions will be merged into ~/.pi/agent/sessions/." : "Sessions are present but skipped by current settings.");
  if (has("custom")) plan.push("Custom Pi paths will overwrite their original ~/.pi/agent locations after confirmation and timestamped backups.");
  if (has("agent-skills")) plan.push(config.backupAgentSkills ? "~/.agents/skills will be replaced after moving the current directory to a backup." : "Shared skills are present but skipped by current settings.");
  return plan.length ? plan : ["No restorable content was found in this archive."];
}

export async function extractConfigZip(archivePath: string, config: SyncConfig): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_config_extract");
  const restored: string[] = [];
  try {
    const root = path.join(tempDir, "config", "root");
    if (config.backupProviders && fs.existsSync(root)) {
      const allowedMd = new Set<string>(AGENT_ROOT_MARKDOWN_FILES);
      for (const name of fs.readdirSync(root)) {
        const src = path.join(root, name);
        if (!fs.statSync(src).isFile() || (!name.endsWith(".json") && !allowedMd.has(name))) continue;
        backupAndCopyFile(src, path.join(AGENT_DIR, name));
        restored.push(`Config: ${name}`);
      }
    }
    const sub = path.join(tempDir, "config", "sub");
    if (config.backupProviders && fs.existsSync(sub)) {
      const dest = path.join(AGENT_DIR, "config");
      if (fs.existsSync(dest)) copyRecursiveSync(dest, path.join(AGENT_DIR, `config-backup-${timestampForBackup()}`));
      copyRecursiveSync(sub, dest);
      restored.push("Config directory");
    }
    const extensions = path.join(tempDir, "extensions");
    if (config.backupExtensions && fs.existsSync(extensions)) {
      const dest = path.join(AGENT_DIR, "extensions");
      if (fs.existsSync(dest)) copyRecursiveSync(dest, path.join(AGENT_DIR, `extensions-backup-${timestampForBackup()}`));
      copyRecursiveSync(extensions, dest);
      restored.push("Extensions");
    }
    return restored;
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

function readCustomPathManifest(tempDir: string): CustomPathArchiveEntry[] {
  const manifestPath = path.join(tempDir, "manifest.json");
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { throw new Error("Custom path archive is missing a valid manifest.json"); }
  if (!manifest || typeof manifest !== "object" || !Array.isArray((manifest as { customPaths?: unknown }).customPaths)) {
    throw new Error("Archive does not contain custom Pi path metadata.");
  }
  const customPaths = (manifest as { customPaths: CustomPathArchiveEntry[] }).customPaths;
  // Archive metadata is untrusted. Reject overlapping targets before any
  // restore begins so a later entry cannot overwrite an earlier backup.
  validateCustomPathSet(customPaths.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.relativePath !== "string") {
      throw new Error("Invalid custom path manifest entry");
    }
    return entry.relativePath;
  }));
  return customPaths;
}

export async function inspectCustomPathsZip(archivePath: string): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_custom_paths_inspect");
  try {
    return readCustomPathManifest(tempDir).map((entry) => {
      const target = resolveCustomRestoreTarget(entry);
      return `~/.pi/agent/${target.relativePath}`;
    });
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

export async function extractCustomPathsZip(archivePath: string): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_custom_paths_extract");
  const restored: string[] = [];
  try {
    for (const entry of readCustomPathManifest(tempDir)) {
      const target = resolveCustomRestoreTarget(entry);
      const source = path.join(tempDir, target.archiveRoot);
      const sourceStats = fs.existsSync(source) ? fs.lstatSync(source) : undefined;
      if (!sourceStats || sourceStats.isSymbolicLink() || (target.type === "file" ? !sourceStats.isFile() : !sourceStats.isDirectory())) {
        throw new Error(`Custom archive payload is missing or invalid: ${target.relativePath}`);
      }
      if (fs.existsSync(target.destination)) {
        const backup = `${target.destination}.bak-${timestampForBackup()}`;
        ensureDir(path.dirname(backup));
        fs.renameSync(target.destination, backup);
      }
      copyRecursiveSync(source, target.destination);
      restored.push(`Custom: ~/.pi/agent/${target.relativePath}`);
    }
    return restored;
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

export async function extractAgentSkillsZip(archivePath: string): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_agent_skills_extract");
  try {
    const source = path.join(tempDir, "agent-skills");
    if (!fs.existsSync(source)) throw new Error("Archive does not contain agent-skills/.");
    const backup = path.join(os.homedir(), ".agents", `skills-backup-${timestampForBackup()}`);
    if (fs.existsSync(AGENT_SKILLS_DIR)) fs.renameSync(AGENT_SKILLS_DIR, backup);
    copyRecursiveSync(source, AGENT_SKILLS_DIR);
    return [`Shared skills; previous directory moved to ${backup}`];
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

export async function extractSessionsArchiveZip(archivePath: string): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_sessions_extract");
  try {
    const source = path.join(tempDir, "sessions");
    if (!fs.existsSync(source)) throw new Error("Archive does not contain sessions/.");
    copyRecursiveSync(source, SESSIONS_DIR);
    return ["Session archive merged"];
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

export async function extractLegacyZip(archivePath: string, config: SyncConfig): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_sync_extract");
  const restored: string[] = [];
  try {
    const configDir = path.join(tempDir, "config");
    if (config.backupProviders && fs.existsSync(configDir)) {
      for (const name of fs.readdirSync(configDir)) {
        const src = path.join(configDir, name);
        if (fs.statSync(src).isFile()) { backupAndCopyFile(src, path.join(AGENT_DIR, name)); restored.push(`Config: ${name}`); }
      }
    }
    const skills = path.join(tempDir, "skills");
    if (config.backupSkills && fs.existsSync(skills)) {
      const dest = path.join(AGENT_DIR, "skills"), backup = path.join(AGENT_DIR, `skills-backup-${timestampForBackup()}`);
      if (fs.existsSync(dest)) fs.renameSync(dest, backup);
      copyRecursiveSync(skills, dest);
      restored.push("Skills");
    }
    const extensions = path.join(tempDir, "extensions");
    if (config.backupExtensions && fs.existsSync(extensions)) {
      const dest = path.join(AGENT_DIR, "extensions");
      if (fs.existsSync(dest)) copyRecursiveSync(dest, path.join(AGENT_DIR, `extensions-backup-${timestampForBackup()}`));
      copyRecursiveSync(extensions, dest);
      restored.push("Extensions");
    }
    const sessions = path.join(tempDir, "sessions");
    if (config.backupSessions && fs.existsSync(sessions)) { copyRecursiveSync(sessions, SESSIONS_DIR); restored.push("Sessions"); }
    return restored;
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}
