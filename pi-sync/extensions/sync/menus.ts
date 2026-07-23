import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enhancedSelect } from "../_shared/enhanced-select";
import {
  archiveTimestamp,
  createAgentSkillsZip,
  createConfigZip,
  createCustomPathsZip,
  createLegacyZip,
  createSessionsArchiveZip,
  listArchiveEntries,
  platformTag,
  validateArchiveEntries,
  yieldToUI,
} from "./archive";
import { loadConfig, saveConfig, isProjectAllowed, type SyncConfig } from "./config";
import { customPathDisplay, parseCustomPathList } from "./custom-paths";
import {
  extractAgentSkillsZip,
  extractConfigZip,
  extractCustomPathsZip,
  extractLegacyZip,
  inspectCustomPathsZip,
  extractSessionsArchiveZip,
  getRestorePlan,
} from "./restore";
import {
  describeSessionSelection,
  listSessionProjects,
  sessionDirToPath,
  showSessionProjectSelect,
  showSessionSyncMenu,
} from "./session-sync";
import {
  downloadFromWebdavDir,
  listWebdavDir,
  pruneOldBackupsInDir,
  sessionsWebdavBase,
  uploadToWebdavDir,
  WEBDAV_AGENT_SKILLS_DIR,
  WEBDAV_CONFIG_DIR,
  WEBDAV_SESSIONS_DIR,
  webdavAuth,
  webdavGetFile,
  webdavList,
} from "./webdav";

export async function showSetupWizard(ctx: ExtensionCommandContext): Promise<boolean> {
  const config = loadConfig();
  ctx.ui.notify("WebDAV is not configured. Please set it up now.", "warning");
  const url = await ctx.ui.input("WebDAV URL:", config.webdavUrl); if (!url) return false;
  const user = await ctx.ui.input("WebDAV username:", config.webdavUser); if (!user) return false;
  const pass = await ctx.ui.input("WebDAV token (or $ENV_VAR):", config.webdavPass); if (!pass) return false;
  const merged = { ...config, webdavUrl: url.trim(), webdavUser: user.trim(), webdavPass: pass.trim() };
  saveConfig(merged, ctx);
  return true;
}

export async function showConfigureSettings(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  while (true) {
    const choice = await enhancedSelect(ctx, "Configure Sync Settings", [
      `WebDAV URL: ${config.webdavUrl || "(not set)"}`,
      `WebDAV Username: ${config.webdavUser || "(not set)"}`,
      `WebDAV Password/Token: ${config.webdavPass ? "(set)" : "(not set)"}`,
      `Backup Providers & Config: ${config.backupProviders ? "ON" : "OFF"}`,
      `Backup Skills: ${config.backupSkills ? "ON" : "OFF"}`,
      `Backup Extensions: ${config.backupExtensions ? "ON" : "OFF"}`,
      `Custom Pi Paths: ${config.customPaths.length ? config.customPaths.map(customPathDisplay).join(", ") : "(none)"}`,
      `Backup Shared Agent Skills: ${config.backupAgentSkills ? "ON" : "OFF"}`,
      `Backup Sessions: ${config.backupSessions ? "ON" : "OFF"}`,
      `  ↳ Session Projects: ${describeSessionSelection(config)}`,
      `Session Project Mode: ${config.sessionProjectMode}`,
      `Sync Every N Turns: ${config.syncIntervalTurns || "OFF"}`,
      `Sync Session On Exit: ${config.syncSessionOnExit ? "ON" : "OFF"}`,
      `Max Cloud Backups: ${config.maxBackups === 0 ? "keep all" : config.maxBackups}`,
      "s Save", "x Back",
    ]);
    if (!choice || choice === "x Back") return;
    if (choice === "s Save") { saveConfig(config, ctx); ctx.ui.notify("Sync configuration updated.", "info"); return; }
    if (choice.startsWith("WebDAV URL:")) { const value = await ctx.ui.input("WebDAV URL:", config.webdavUrl); if (value) config.webdavUrl = value.trim(); continue; }
    if (choice.startsWith("WebDAV Username:")) { const value = await ctx.ui.input("WebDAV username:", config.webdavUser); if (value) config.webdavUser = value.trim(); continue; }
    if (choice.startsWith("WebDAV Password")) { const value = await ctx.ui.input("WebDAV token (or $ENV_VAR):", config.webdavPass); if (value) config.webdavPass = value.trim(); continue; }
    if (choice.startsWith("Backup Providers")) { config.backupProviders = !config.backupProviders; continue; }
    if (choice.startsWith("Backup Skills:")) { config.backupSkills = !config.backupSkills; continue; }
    if (choice.startsWith("Backup Extensions")) { config.backupExtensions = !config.backupExtensions; continue; }
    if (choice.startsWith("Custom Pi Paths:")) {
      const current = config.customPaths.map(customPathDisplay).join(", ");
      const value = await ctx.ui.input("Custom paths under ~/.pi/agent (comma or newline separated; blank clears):", current);
      if (value !== undefined) {
        try { config.customPaths = parseCustomPathList(value); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
      }
      continue;
    }
    if (choice.startsWith("Backup Shared")) { config.backupAgentSkills = !config.backupAgentSkills; continue; }
    if (choice.startsWith("Backup Sessions")) { config.backupSessions = !config.backupSessions; continue; }
    if (choice.startsWith("  ↳")) { await showSessionProjectSelect(ctx, config); continue; }
    if (choice.startsWith("Session Project Mode")) { config.sessionProjectMode = config.sessionProjectMode === "whitelist" ? "blacklist" : "whitelist"; continue; }
    if (choice.startsWith("Sync Every")) { const value = await ctx.ui.input("Every N turns (0 = off):", String(config.syncIntervalTurns)); const n = value ? parseInt(value, 10) : NaN; if (n >= 0) config.syncIntervalTurns = n; continue; }
    if (choice.startsWith("Sync Session On Exit")) { config.syncSessionOnExit = !config.syncSessionOnExit; continue; }
    if (choice.startsWith("Max Cloud")) { const value = await ctx.ui.input("Maximum backups (0 = all):", String(config.maxBackups)); const n = value ? parseInt(value, 10) : NaN; if (n >= 0) config.maxBackups = n; continue; }
  }
}

type BackupKind = "config" | "custom" | "agent-skills";

async function showUploadPackage(ctx: ExtensionCommandContext, kind: BackupKind): Promise<boolean> {
  const config = loadConfig();
  if (kind === "custom" && config.customPaths.length === 0) { ctx.ui.notify("No custom Pi paths are configured.", "warning"); return false; }
  if (kind === "agent-skills" && !config.backupAgentSkills) { ctx.ui.notify("Shared skills backup is disabled.", "warning"); return false; }
  const timestamp = archiveTimestamp();
  const meta = kind === "config"
    ? { filename: `pi_config_${platformTag()}_${timestamp}.tar.xz`, dir: WEBDAV_CONFIG_DIR, prefix: "pi_config_" }
    : kind === "custom"
      ? { filename: `pi_custom_${platformTag()}_${timestamp}.tar.xz`, dir: "custom/", prefix: "pi_custom_" }
      : { filename: `agent_skills_${timestamp}.tar.xz`, dir: WEBDAV_AGENT_SKILLS_DIR, prefix: "agent_skills_" };
  const archive = path.join(os.tmpdir(), meta.filename);
  try {
    const contents = kind === "config" ? await createConfigZip(config, archive) : kind === "custom" ? await createCustomPathsZip(config, archive) : await createAgentSkillsZip(archive);
    if (contents.length === 0) {
      ctx.ui.notify(`No ${kind} content is available to back up.`, "warning");
      return false;
    }
    await uploadToWebdavDir(archive, meta.dir, meta.filename, config, ctx);
    const deleted = await pruneOldBackupsInDir(config, ctx, meta.dir, meta.prefix);
    ctx.ui.notify(`🎉 Uploaded ${meta.filename}\n${contents.join("\n")}${deleted.length ? `\nPruned: ${deleted.length}` : ""}`, "info");
    return true;
  } catch (error) {
    ctx.ui.notify(`❌ ${kind} backup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  } finally { fs.rmSync(archive, { force: true }); }
}

async function showUploadSessionsArchive(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  const projects = listSessionProjects().filter((project) => isProjectAllowed(project, config));
  if (!projects.length) { ctx.ui.notify("No allowed local session projects found.", "warning"); return; }
  const project = await enhancedSelect(ctx, "Archive session project", [...projects, "❌ Cancel"], { fuzzy: true });
  if (!project || project.includes("Cancel")) return;
  const filename = `sessions_${platformTag()}_${archiveTimestamp()}.tar.xz`;
  const archive = path.join(os.tmpdir(), filename), remoteDir = `${WEBDAV_SESSIONS_DIR}${project}/archive/`;
  try {
    const contents = await createSessionsArchiveZip(project, archive);
    await uploadToWebdavDir(archive, remoteDir, filename, config, ctx);
    await pruneOldBackupsInDir(config, ctx, remoteDir, "sessions_");
    ctx.ui.notify(`🎉 Uploaded ${filename}\n${contents.join("\n")}`, "info");
  } catch (error) { ctx.ui.notify(`❌ Session archive failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  finally { fs.rmSync(archive, { force: true }); }
}

async function showRestorePackage(ctx: ExtensionCommandContext, kind: BackupKind, autoLatest = false): Promise<boolean> {
  const config = loadConfig();
  const meta = kind === "config" ? { dir: WEBDAV_CONFIG_DIR, prefix: "pi_config_" } : kind === "custom" ? { dir: "custom/", prefix: "pi_custom_" } : { dir: WEBDAV_AGENT_SKILLS_DIR, prefix: "agent_skills_" };
  try {
    const files = (await listWebdavDir(meta.dir, config, ctx)).filter((name) => name.startsWith(meta.prefix) && name.endsWith(".tar.xz")).sort().reverse();
    if (!files.length) { ctx.ui.notify(`No ${kind} archives found.`, "warning"); return false; }
    let selected: string | undefined;
    if (autoLatest) selected = files[0];
    else { selected = await enhancedSelect(ctx, `Restore ${kind} archive`, [...files, "❌ Cancel"], { fuzzy: true }); if (!selected || selected.includes("Cancel")) return false; }
    if (kind === "agent-skills" && !await ctx.ui.confirm("Replace shared skills?", "The current ~/.agents/skills will be moved to a timestamped backup.")) return false;
    const local = path.join(os.tmpdir(), path.basename(selected));
    try {
      await downloadFromWebdavDir(selected, meta.dir, local, config, ctx);
      if (kind === "custom") {
        const paths = await inspectCustomPathsZip(local);
        if (!await ctx.ui.confirm("Restore custom Pi paths?", `The following ~/.pi/agent paths will be replaced with timestamped backups:\n${paths.join("\n")}`)) return false;
      }
      const restored = kind === "config" ? await extractConfigZip(local, config) : kind === "custom" ? await extractCustomPathsZip(local) : await extractAgentSkillsZip(local);
      ctx.ui.notify(`🎉 Restored ${kind}:\n${restored.join("\n")}`, "info");
      return true;
    } finally { fs.rmSync(local, { force: true }); }
  } catch (error) { ctx.ui.notify(`❌ ${kind} restore failed: ${error instanceof Error ? error.message : String(error)}`, "error"); return false; }
}

async function showUploadAll(ctx: ExtensionCommandContext): Promise<void> {
  const results: string[] = [];
  for (const kind of ["config", "custom", "agent-skills"] as BackupKind[]) {
    const config = loadConfig();
    if (kind === "config" && !config.backupProviders) { results.push(`⏭️  config (disabled)`); continue; }
    if (kind === "custom" && config.customPaths.length === 0) { results.push(`⏭️  custom (none configured)`); continue; }
    if (kind === "agent-skills" && !config.backupAgentSkills) { results.push(`⏭️  agent-skills (disabled)`); continue; }
    results.push((await showUploadPackage(ctx, kind)) ? `✅ ${kind}` : `❌ ${kind}`);
  }
  ctx.ui.notify(`Upload All complete:\n${results.join("\n")}\n\n💡 Sessions: use 🗂️ Upload Sessions Archive or 🔄 Session Sync.`, "info");
}

async function showRestoreAll(ctx: ExtensionCommandContext): Promise<void> {
  const results: string[] = [];
  for (const kind of ["config", "custom", "agent-skills"] as BackupKind[]) {
    const ok = await showRestorePackage(ctx, kind, true);
    results.push(ok ? `✅ ${kind}` : `⏭️  ${kind} (skipped)`);
  }
  ctx.ui.notify(`Restore All complete:\n${results.join("\n")}`, "info");
  if (results.some((r) => r.startsWith("✅")) && await ctx.ui.confirm("Reload Runtime?", "Reload Pi to apply the restored data?")) await ctx.reload();
}

async function showRestoreSessionsArchive(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  try {
    const projects = await webdavList(sessionsWebdavBase(config), webdavAuth(config), ctx, (name) => name.startsWith("--") && name.endsWith("--"));
    const project = await enhancedSelect(ctx, "Restore session archive: project", [...projects, "❌ Cancel"], { fuzzy: true }); if (!project || project.includes("Cancel")) return;
    const remoteDir = `${WEBDAV_SESSIONS_DIR}${project}/archive/`;
    const files = (await listWebdavDir(remoteDir, config, ctx)).filter((name) => name.startsWith("sessions_") && name.endsWith(".tar.xz")).sort().reverse();
    const selected = await enhancedSelect(ctx, "Select session archive", [...files, "❌ Cancel"], { fuzzy: true }); if (!selected || selected.includes("Cancel")) return;
    const local = path.join(os.tmpdir(), path.basename(selected));
    try { await downloadFromWebdavDir(selected, remoteDir, local, config, ctx); ctx.ui.notify(`🎉 ${(await extractSessionsArchiveZip(local)).join("\n")}`, "info"); }
    finally { fs.rmSync(local, { force: true }); }
  } catch (error) { ctx.ui.notify(`❌ Session restore failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
}

async function listLegacyBackups(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
  return (await listWebdavDir("", config, ctx)).filter((name) => name.startsWith("pi_sync_backup_") && (name.endsWith(".tar.xz") || name.endsWith(".zip"))).sort().reverse();
}

async function showUploadLegacy(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig(), filename = `pi_sync_backup_${archiveTimestamp()}_${platformTag()}.tar.xz`, local = path.join(os.tmpdir(), filename);
  try { const contents = await createLegacyZip(config, local); await uploadToWebdavDir(local, "", filename, config, ctx); await pruneOldBackupsInDir(config, ctx, "", "pi_sync_backup_"); ctx.ui.notify(`🎉 Legacy backup uploaded\n${contents.join("\n")}`, "info"); }
  catch (error) { ctx.ui.notify(`❌ Legacy backup failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  finally { fs.rmSync(local, { force: true }); }
}

async function showRestoreLegacy(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  try {
    const files = await listLegacyBackups(config, ctx); if (!files.length) { ctx.ui.notify("No legacy backups found.", "warning"); return; }
    const selected = await enhancedSelect(ctx, "Select legacy backup", [...files, "❌ Cancel"], { fuzzy: true }); if (!selected || selected.includes("Cancel")) return;
    const local = path.join(os.tmpdir(), path.basename(selected));
    try {
      await downloadFromWebdavDir(selected, "", local, config, ctx);
      const entries = await listArchiveEntries(local); validateArchiveEntries(entries);
      if (!await ctx.ui.confirm("Confirm restore?", [`Entries: ${entries.length}`, ...getRestorePlan(entries, config)].join("\n"))) return;
      await yieldToUI();
      const restored = await extractLegacyZip(local, config); ctx.ui.notify(`🎉 Restored:\n${restored.join("\n")}`, "info");
      if (await ctx.ui.confirm("Reload Runtime?", "Reload Pi now?")) await ctx.reload();
    } finally { fs.rmSync(local, { force: true }); }
  } catch (error) { ctx.ui.notify(`❌ Legacy restore failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
}

export async function handleSyncCommand(ctx: ExtensionCommandContext): Promise<void> {
  let config = loadConfig();
  if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) { if (!await showSetupWizard(ctx)) return; config = loadConfig(); }
  const choice = await enhancedSelect(ctx, "Pi WebDAV Synchronization", [
    "⬆️  Upload All (config + custom + skills)", "⬇️  Restore All (latest)",
    "☁️  Upload Config Backup", "📁 Upload Custom Pi Paths", "📦 Upload Skills Snapshot", "🗂️  Upload Sessions Archive",
    "📥 Restore Config Backup", "📥 Restore Custom Pi Paths", "📥 Restore Skills Snapshot", "📥 Restore Sessions Archive",
    "🔄 Session Sync", "🧰 Legacy Monolithic Backup/Restore", "⚙️  Configure Sync Settings", "❌  Cancel",
  ]);
  if (!choice || choice.includes("Cancel")) return;
  if (choice.startsWith("⬆️  Upload All")) return showUploadAll(ctx);
  if (choice.startsWith("⬇️  Restore All")) return showRestoreAll(ctx);
  if (choice.includes("Configure")) return showConfigureSettings(ctx);
  if (choice === "☁️  Upload Config Backup") { await showUploadPackage(ctx, "config"); return; }
  if (choice === "📁 Upload Custom Pi Paths") { await showUploadPackage(ctx, "custom"); return; }
  if (choice === "📦 Upload Skills Snapshot") { await showUploadPackage(ctx, "agent-skills"); return; }
  if (choice === "🗂️  Upload Sessions Archive") return showUploadSessionsArchive(ctx);
  if (choice === "📥 Restore Config Backup") { await showRestorePackage(ctx, "config"); return; }
  if (choice === "📥 Restore Custom Pi Paths") { await showRestorePackage(ctx, "custom"); return; }
  if (choice === "📥 Restore Skills Snapshot") { await showRestorePackage(ctx, "agent-skills"); return; }
  if (choice === "📥 Restore Sessions Archive") return showRestoreSessionsArchive(ctx);
  if (choice.startsWith("🔄")) return showSessionSyncMenu(ctx);
  if (choice.startsWith("🧰")) {
    const action = await enhancedSelect(ctx, "Legacy backup", ["Upload legacy backup", "Restore legacy backup", "❌ Cancel"]);
    if (action?.startsWith("Upload")) return showUploadLegacy(ctx);
    if (action?.startsWith("Restore")) return showRestoreLegacy(ctx);
  }
}

export function registerSyncCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sync", {
    description: "Sync configurations, skills, extensions, and sessions via WebDAV",
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => handleSyncCommand(ctx),
  });
}
