import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { timestampForBackup } from "../_shared/json-io";
import { copyRecursiveSync, listArchiveEntries, runTar, validateArchiveEntries } from "./archive";
import {
  AGENT_DIR,
  AGENT_ROOT_MARKDOWN_FILES,
  AGENT_SKILLS_DIR,
  MEMORY_MARKDOWN_FILES,
  SESSIONS_DIR,
  ensureDir,
  type SyncConfig,
} from "./config";

async function extractToTemp(archivePath: string, prefix: string): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `${prefix}_${Date.now()}`);
  ensureDir(tempDir);
  validateArchiveEntries(await listArchiveEntries(archivePath));
  await runTar(["-x", "-f", archivePath, "-C", tempDir]);
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
  if (has("memory")) plan.push(config.backupMemory ? "Durable memory markdown files will be restored after .bak copies." : "Memory files are present but skipped by current settings.");
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

export async function extractMemoryZip(archivePath: string): Promise<string[]> {
  const tempDir = await extractToTemp(archivePath, "pi_memory_extract");
  const destDir = path.join(AGENT_DIR, "pi-hermes-memory");
  const restored: string[] = [];
  try {
    for (const name of MEMORY_MARKDOWN_FILES) {
      const src = path.join(tempDir, "memory", name);
      if (!fs.existsSync(src)) continue;
      backupAndCopyFile(src, path.join(destDir, name));
      restored.push(name);
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
