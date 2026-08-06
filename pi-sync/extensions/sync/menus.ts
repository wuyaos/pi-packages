import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enhancedSelect } from "../_shared/enhanced-select";
import {
  archiveTimestamp,
  createAgentSkillsZip,
  createPiAgentZip,
  createSessionsArchiveZip,
  listArchiveEntries,
  platformTag,
  validateArchiveEntries,
} from "./archive";
import {
  SESSIONS_DIR,
  isProjectAllowed,
  loadConfig,
  normalizePiExcludePaths,
  saveConfig,
  type SyncConfig,
} from "./config";
import { t, type SyncLanguage } from "./i18n";
import {
  extractAgentSkillsZip,
  extractPiAgentZip,
  extractSessionsArchiveZip,
  getRestorePlan,
} from "./restore";
import {
  downloadFromWebdavDir,
  listWebdavDir,
  pruneOldBackupsInDir,
  uploadToWebdavDir,
  webdavAuth,
  webdavDirBase,
  webdavList,
  WEBDAV_AGENT_SKILLS_DIR,
  WEBDAV_PI_BACKUP_DIR,
  WEBDAV_SESSIONS_ARCHIVE_DIR,
} from "./webdav";

export type SelectItem<T extends string> = { id: T; label: string };
type BackupKind = "pi" | "skills";
export type MainAction =
  | "upload-all" | "restore-all"
  | "upload-pi" | "upload-skills" | "upload-sessions"
  | "restore-pi" | "restore-skills" | "restore-sessions"
  | "configure" | "language" | "cancel";

export interface BulkResult {
  kind: "pi" | "skills" | "session";
  project?: string;
  success: boolean;
  error?: string;
}

export interface BackupAllOperations {
  uploadPi(): Promise<boolean>;
  uploadSkills(): Promise<boolean>;
  listProjects(): string[];
  uploadSession(project: string): Promise<boolean>;
}

export interface RestoreAllOperations {
  restorePi(): Promise<boolean>;
  restoreSkills(): Promise<boolean>;
  listProjects(): Promise<string[]>;
  restoreSession(project: string): Promise<boolean>;
}

async function selectAction<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem<T>[],
): Promise<T | undefined> {
  const selected = await enhancedSelect(ctx, title, items.map((item) => item.label));
  return items.find((item) => item.label === selected)?.id;
}

function cloneConfig(config: SyncConfig): SyncConfig {
  return {
    ...config,
    piExcludePaths: [...config.piExcludePaths],
    sessionProjects: [...config.sessionProjects],
  };
}

function onOff(language: SyncLanguage, value: boolean): string {
  return t(language, value ? "on" : "off");
}

function kindLabel(language: SyncLanguage, kind: BackupKind): string {
  return t(language, kind === "pi" ? "piKind" : "skillsKind");
}

export function buildMainMenuItems(language: SyncLanguage): SelectItem<MainAction>[] {
  return [
    { id: "upload-all", label: t(language, "uploadAllBackups") },
    { id: "restore-all", label: t(language, "restoreAllBackups") },
    { id: "upload-pi", label: t(language, "uploadPiBackup") },
    { id: "upload-skills", label: t(language, "uploadSkillsBackup") },
    { id: "upload-sessions", label: t(language, "uploadSessionsArchive") },
    { id: "restore-pi", label: t(language, "restorePiBackup") },
    { id: "restore-skills", label: t(language, "restoreSkillsBackup") },
    { id: "restore-sessions", label: t(language, "restoreSessionsArchive") },
    { id: "configure", label: t(language, "configureSettings") },
    { id: "language", label: t(language, "switchLanguage") },
    { id: "cancel", label: t(language, "cancel") },
  ];
}

function listSessionProjects(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("--") && entry.name.endsWith("--"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function sessionDirToPath(dirName: string): string {
  let value = dirName;
  if (value.startsWith("--")) value = value.slice(2);
  if (value.endsWith("--")) value = value.slice(0, -2);
  return value ? `/${value.replace(/-/g, "/")}` : dirName;
}

function sessionSelectionLabel(config: SyncConfig): string {
  const language = config.language;
  if (config.sessionProjects.length === 0) {
    return t(language, config.sessionProjectMode === "blacklist" ? "projectSelectionAll" : "projectSelectionWhitelist");
  }
  const mode = t(language, config.sessionProjectMode === "blacklist" ? "projectModeBlacklist" : "projectModeWhitelist");
  return `${mode}: ${config.sessionProjects.length}`;
}

async function showSessionProjectSelect(ctx: ExtensionCommandContext, config: SyncConfig): Promise<void> {
  while (true) {
    const language = config.language;
    const projects = listSessionProjects();
    const modeLabel = t(language, config.sessionProjectMode === "blacklist" ? "projectModeBlacklist" : "projectModeWhitelist");
    const items: SelectItem<string>[] = [
      { id: "mode", label: t(language, "switchProjectMode", { mode: modeLabel }) },
      { id: "all", label: t(language, "selectAllProjects") },
      { id: "reset", label: t(language, "resetProjects") },
      ...projects.map((project) => ({
        id: `project:${project}`,
        label: `[${config.sessionProjects.includes(project) ? "x" : " "}] ${sessionDirToPath(project)}`,
      })),
      { id: "back", label: t(language, "back") },
    ];
    const action = await selectAction(ctx, t(language, "selectSessionProjects", { mode: modeLabel }), items);
    if (!action || action === "back") return;
    if (action === "mode") {
      config.sessionProjectMode = config.sessionProjectMode === "whitelist" ? "blacklist" : "whitelist";
    } else if (action === "all") {
      config.sessionProjects = [...projects];
    } else if (action === "reset") {
      config.sessionProjects = [];
    } else if (action.startsWith("project:")) {
      const project = action.slice("project:".length);
      config.sessionProjects = config.sessionProjects.includes(project)
        ? config.sessionProjects.filter((item) => item !== project)
        : [...config.sessionProjects, project];
    }
  }
}

export async function showSetupWizard(ctx: ExtensionCommandContext): Promise<boolean> {
  const config = cloneConfig(loadConfig());
  const language = config.language;
  ctx.ui.notify(t(language, "setupRequired"), "warning");
  const url = await ctx.ui.input(t(language, "promptWebdavUrl"), config.webdavUrl); if (!url) return false;
  const user = await ctx.ui.input(t(language, "promptWebdavUsername"), config.webdavUser); if (!user) return false;
  const pass = await ctx.ui.input(t(language, "promptWebdavPassword"), config.webdavPass); if (!pass) return false;
  config.webdavUrl = url.trim();
  config.webdavUser = user.trim();
  config.webdavPass = pass.trim();
  saveConfig(config, ctx);
  return true;
}

export async function showConfigureSettings(ctx: ExtensionCommandContext): Promise<void> {
  const config = cloneConfig(loadConfig());
  while (true) {
    const language = config.language;
    const items: SelectItem<string>[] = [
      { id: "url", label: t(language, "webdavUrl", { value: config.webdavUrl || t(language, "notSet") }) },
      { id: "user", label: t(language, "webdavUsername", { value: config.webdavUser || t(language, "notSet") }) },
      { id: "password", label: t(language, "webdavPassword", { value: config.webdavPass ? t(language, "passwordSet") : t(language, "notSet") }) },
      { id: "pi", label: t(language, "piBackup", { value: onOff(language, config.backupProviders) }) },
      { id: "skills", label: t(language, "skillsBackup", { value: onOff(language, config.backupAgentSkills) }) },
      { id: "sessions", label: t(language, "sessionsBackup", { value: onOff(language, config.backupSessions) }) },
      { id: "exit", label: t(language, "backupOnExit", { value: onOff(language, config.backupOnExit) }) },
      { id: "exclude", label: t(language, "piExcludePaths", { value: config.piExcludePaths.join(", ") || t(language, "none") }) },
      { id: "projects", label: t(language, "sessionProjects", { value: sessionSelectionLabel(config) }) },
      { id: "mode", label: t(language, "sessionProjectMode", { value: t(language, config.sessionProjectMode === "blacklist" ? "projectModeBlacklist" : "projectModeWhitelist") }) },
      { id: "max", label: t(language, "maxCloudBackups", { value: config.maxBackups === 0 ? t(language, "keepAll") : config.maxBackups }) },
      { id: "save", label: t(language, "save") },
      { id: "back", label: t(language, "back") },
    ];
    const action = await selectAction(ctx, t(language, "configureTitle"), items);
    if (!action || action === "back") return;
    if (action === "save") {
      saveConfig(config, ctx);
      ctx.ui.notify(t(language, "configSaved"), "info");
      return;
    }
    if (action === "url") {
      const value = await ctx.ui.input(t(language, "promptWebdavUrl"), config.webdavUrl);
      if (value) config.webdavUrl = value.trim();
    } else if (action === "user") {
      const value = await ctx.ui.input(t(language, "promptWebdavUsername"), config.webdavUser);
      if (value) config.webdavUser = value.trim();
    } else if (action === "password") {
      const value = await ctx.ui.input(t(language, "promptWebdavPassword"), config.webdavPass);
      if (value) config.webdavPass = value.trim();
    } else if (action === "pi") {
      config.backupProviders = !config.backupProviders;
    } else if (action === "skills") {
      config.backupAgentSkills = !config.backupAgentSkills;
    } else if (action === "sessions") {
      config.backupSessions = !config.backupSessions;
    } else if (action === "exit") {
      config.backupOnExit = !config.backupOnExit;
    } else if (action === "exclude") {
      const value = await ctx.ui.input(t(language, "promptExcludePaths"), config.piExcludePaths.join(", "));
      if (value !== undefined) config.piExcludePaths = normalizePiExcludePaths(value.split(/[\n,]/));
    } else if (action === "projects") {
      await showSessionProjectSelect(ctx, config);
    } else if (action === "mode") {
      config.sessionProjectMode = config.sessionProjectMode === "whitelist" ? "blacklist" : "whitelist";
    } else if (action === "max") {
      const value = await ctx.ui.input(t(language, "promptMaxBackups"), String(config.maxBackups));
      const count = value ? Number.parseInt(value, 10) : Number.NaN;
      if (count >= 0) config.maxBackups = count;
    }
  }
}

function packageMeta(kind: BackupKind): { filename: string; dir: string; prefix: string } {
  const timestamp = archiveTimestamp();
  return kind === "pi"
    ? { filename: `pi_agent_${platformTag()}_${timestamp}.tar.xz`, dir: WEBDAV_PI_BACKUP_DIR, prefix: "pi_agent_" }
    : { filename: `agent_skills_${timestamp}.tar.xz`, dir: WEBDAV_AGENT_SKILLS_DIR, prefix: "agent_skills_" };
}

async function showUploadPackage(ctx: ExtensionCommandContext, kind: BackupKind, notify = true): Promise<boolean> {
  const config = loadConfig();
  const language = config.language;
  const label = kindLabel(language, kind);
  const enabled = kind === "pi" ? config.backupProviders : config.backupAgentSkills;
  if (!enabled) {
    if (notify) ctx.ui.notify(t(language, "backupDisabled", { kind: label }), "warning");
    return false;
  }
  const meta = packageMeta(kind);
  const archive = path.join(os.tmpdir(), meta.filename);
  try {
    const contents = kind === "pi"
      ? await createPiAgentZip(config, archive)
      : await createAgentSkillsZip(archive);
    await uploadToWebdavDir(archive, meta.dir, meta.filename, config, ctx);
    const deleted = await pruneOldBackupsInDir(config, ctx, meta.dir, meta.prefix);
    const pruned = deleted.length ? t(language, "prunedCount", { count: deleted.length }) : "";
    if (notify) ctx.ui.notify(t(language, "backupUploaded", { filename: meta.filename, contents: contents.join("\n"), pruned }), "info");
    return true;
  } catch (error) {
    if (notify) ctx.ui.notify(t(language, "backupFailed", { kind: label, error: error instanceof Error ? error.message : String(error) }), "error");
    return false;
  } finally { fs.rmSync(archive, { force: true }); }
}

export async function uploadSessionProjectArchive(
  ctx: ExtensionContext,
  config: SyncConfig,
  project: string,
  notify = true,
): Promise<boolean> {
  const language = config.language;
  const filename = `sessions_${platformTag()}_${archiveTimestamp()}.tar.xz`;
  const archive = path.join(os.tmpdir(), filename);
  const remoteDir = `${WEBDAV_SESSIONS_ARCHIVE_DIR}${project}/`;
  try {
    const contents = await createSessionsArchiveZip(project, archive);
    await uploadToWebdavDir(archive, remoteDir, filename, config, ctx);
    await pruneOldBackupsInDir(config, ctx, remoteDir, "sessions_");
    if (notify) ctx.ui.notify(t(language, "sessionArchiveUploaded", { filename, contents: contents.join("\n") }), "info");
    return true;
  } catch (error) {
    if (notify) ctx.ui.notify(t(language, "sessionArchiveFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
    return false;
  } finally { fs.rmSync(archive, { force: true }); }
}

async function showUploadSessionsArchive(ctx: ExtensionCommandContext): Promise<boolean> {
  const config = loadConfig();
  const language = config.language;
  if (!config.backupSessions) {
    ctx.ui.notify(t(language, "backupDisabled", { kind: t(language, "sessionsKind") }), "warning");
    return false;
  }
  const projects = listSessionProjects().filter((project) => isProjectAllowed(project, config));
  if (!projects.length) {
    ctx.ui.notify(t(language, "noAllowedSessionProjects"), "warning");
    return false;
  }
  const items: SelectItem<string>[] = [
    ...projects.map((project) => ({ id: project, label: sessionDirToPath(project) })),
    { id: "cancel", label: t(language, "cancel") },
  ];
  const project = await selectAction(ctx, t(language, "archiveSessionProject"), items);
  if (!project || project === "cancel") return false;
  return uploadSessionProjectArchive(ctx, config, project);
}

async function showRestorePackage(
  ctx: ExtensionCommandContext,
  kind: BackupKind,
  autoLatest = false,
  reloadAfter = true,
): Promise<boolean> {
  const config = loadConfig();
  const language = config.language;
  const label = kindLabel(language, kind);
  const meta = packageMeta(kind);
  try {
    const files = (await listWebdavDir(meta.dir, config, ctx))
      .filter((name) => name.startsWith(meta.prefix) && name.endsWith(".tar.xz"))
      .sort()
      .reverse();
    if (!files.length) {
      ctx.ui.notify(t(language, "noArchivesFound", { kind: label }), "warning");
      return false;
    }
    let selected: string | undefined;
    if (autoLatest) {
      selected = files[0];
    } else {
      const items: SelectItem<string>[] = [
        ...files.map((file) => ({ id: file, label: file })),
        { id: "cancel", label: t(language, "cancel") },
      ];
      selected = await selectAction(ctx, t(language, "restoreArchive", { kind: label }), items);
    }
    if (!selected || selected === "cancel") return false;
    if (kind === "skills" && !await ctx.ui.confirm(
      t(language, "replaceSharedSkillsTitle"),
      t(language, "replaceSharedSkillsBody"),
    )) return false;
    const local = path.join(os.tmpdir(), path.basename(selected));
    try {
      await downloadFromWebdavDir(selected, meta.dir, local, config, ctx);
      if (kind === "pi") {
        const entries = await listArchiveEntries(local);
        validateArchiveEntries(entries);
        const plan = getRestorePlan(entries).join("\n");
        if (!await ctx.ui.confirm(
          t(language, "confirmPiRestoreTitle"),
          t(language, "confirmPiRestoreBody", { count: entries.length, plan }),
        )) return false;
      }
      const restored = kind === "pi" ? await extractPiAgentZip(local) : await extractAgentSkillsZip(local);
      ctx.ui.notify(t(language, "restoreCompleted", { kind: label, contents: restored.join("\n") }), "info");
      if (kind === "pi" && reloadAfter && await ctx.ui.confirm(t(language, "reloadRuntimeTitle"), t(language, "reloadRuntimeBody"))) {
        await ctx.reload();
      }
      return true;
    } finally { fs.rmSync(local, { force: true }); }
  } catch (error) {
    ctx.ui.notify(t(language, "restoreFailed", { kind: label, error: error instanceof Error ? error.message : String(error) }), "error");
    return false;
  }
}

async function restoreSessionProjectArchive(
  ctx: ExtensionCommandContext,
  config: SyncConfig,
  project: string,
  autoLatest = false,
  notify = true,
): Promise<boolean> {
  const language = config.language;
  const remoteDir = `${WEBDAV_SESSIONS_ARCHIVE_DIR}${project}/`;
  try {
    const files = (await listWebdavDir(remoteDir, config, ctx))
      .filter((name) => name.startsWith("sessions_") && name.endsWith(".tar.xz"))
      .sort()
      .reverse();
    if (!files.length) {
      if (notify) ctx.ui.notify(t(language, "noArchivesFound", { kind: t(language, "sessionsKind") }), "warning");
      return false;
    }
    let selected: string | undefined;
    if (autoLatest) {
      selected = files[0];
    } else {
      const archiveItems: SelectItem<string>[] = [
        ...files.map((file) => ({ id: file, label: file })),
        { id: "cancel", label: t(language, "cancel") },
      ];
      selected = await selectAction(ctx, t(language, "selectSessionArchive"), archiveItems);
    }
    if (!selected || selected === "cancel") return false;
    const local = path.join(os.tmpdir(), path.basename(selected));
    try {
      await downloadFromWebdavDir(selected, remoteDir, local, config, ctx);
      const restored = await extractSessionsArchiveZip(local);
      if (notify) ctx.ui.notify(t(language, "sessionRestoreCompleted", { contents: restored.join("\n") }), "info");
      return true;
    } finally { fs.rmSync(local, { force: true }); }
  } catch (error) {
    if (notify) ctx.ui.notify(t(language, "sessionRestoreFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
    return false;
  }
}

async function listRemoteSessionProjects(ctx: ExtensionCommandContext, config: SyncConfig): Promise<string[]> {
  const base = webdavDirBase(config, WEBDAV_SESSIONS_ARCHIVE_DIR);
  return webdavList(base, webdavAuth(config), ctx, (name) => name.startsWith("--") && name.endsWith("--"));
}

async function showRestoreSessionsArchive(ctx: ExtensionCommandContext): Promise<boolean> {
  const config = loadConfig();
  const language = config.language;
  try {
    const projects = (await listRemoteSessionProjects(ctx, config)).filter((project) => isProjectAllowed(project, config));
    if (!projects.length) {
      ctx.ui.notify(t(language, "noRemoteSessionProjects"), "warning");
      return false;
    }
    const projectItems: SelectItem<string>[] = [
      ...projects.map((project) => ({ id: project, label: sessionDirToPath(project) })),
      { id: "cancel", label: t(language, "cancel") },
    ];
    const project = await selectAction(ctx, t(language, "restoreSessionProject"), projectItems);
    if (!project || project === "cancel") return false;
    return restoreSessionProjectArchive(ctx, config, project);
  } catch (error) {
    ctx.ui.notify(t(language, "sessionRestoreFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
    return false;
  }
}

export async function executeBackupAll(config: SyncConfig, operations: BackupAllOperations): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  if (config.backupProviders) {
    results.push({ kind: "pi", success: await operations.uploadPi() });
  }
  if (config.backupAgentSkills) {
    results.push({ kind: "skills", success: await operations.uploadSkills() });
  }
  if (config.backupSessions) {
    const projects = operations.listProjects().filter((project) => isProjectAllowed(project, config));
    for (const project of projects) {
      results.push({ kind: "session", project, success: await operations.uploadSession(project) });
    }
  }
  return results;
}

export async function executeRestoreAll(config: SyncConfig, operations: RestoreAllOperations): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  if (config.backupProviders) {
    results.push({ kind: "pi", success: await operations.restorePi() });
  }
  if (config.backupAgentSkills) {
    results.push({ kind: "skills", success: await operations.restoreSkills() });
  }
  if (config.backupSessions) {
    try {
      const projects = (await operations.listProjects()).filter((project) => isProjectAllowed(project, config));
      for (const project of projects) {
        results.push({ kind: "session", project, success: await operations.restoreSession(project) });
      }
    } catch (error) {
      results.push({ kind: "session", success: false, error: errorMessage(error) });
    }
  }
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBulkResults(language: SyncLanguage, results: BulkResult[]): string {
  return results.map((result) => {
    const label = result.kind === "pi"
      ? t(language, "piKind")
      : result.kind === "skills"
        ? t(language, "skillsKind")
        : result.project ? sessionDirToPath(result.project) : t(language, "sessionsKind");
    return `${result.success ? "✅" : "❌"} ${label}${result.error ? `: ${result.error}` : ""}`;
  }).join("\n");
}

async function showUploadAll(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  const language = config.language;
  const results = await executeBackupAll(config, {
    uploadPi: () => showUploadPackage(ctx, "pi", false),
    uploadSkills: () => showUploadPackage(ctx, "skills", false),
    listProjects: () => listSessionProjects(),
    uploadSession: (project) => uploadSessionProjectArchive(ctx, config, project, false),
  });
  ctx.ui.notify(t(language, "allBackupCompleted", { results: formatBulkResults(language, results) || t(language, "none") }), "info");
}

async function showRestoreAll(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  const language = config.language;
  if (!await ctx.ui.confirm(t(language, "confirmRestoreAllTitle"), t(language, "confirmRestoreAllBody"))) return;
  const results = await executeRestoreAll(config, {
    restorePi: () => showRestorePackage(ctx, "pi", true, false),
    restoreSkills: () => showRestorePackage(ctx, "skills", true, false),
    listProjects: () => listRemoteSessionProjects(ctx, config),
    restoreSession: (project) => restoreSessionProjectArchive(ctx, config, project, true, false),
  });
  ctx.ui.notify(t(language, "allRestoreCompleted", { results: formatBulkResults(language, results) || t(language, "none") }), "info");
  if (results.some((result) => result.success)
    && await ctx.ui.confirm(t(language, "reloadRuntimeTitle"), t(language, "reloadRuntimeBody"))) {
    await ctx.reload();
  }
}

export async function handleSyncCommand(ctx: ExtensionCommandContext): Promise<void> {
  let config = loadConfig();
  if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) {
    if (!await showSetupWizard(ctx)) return;
  }
  while (true) {
    config = loadConfig();
    const language = config.language;
    const items = buildMainMenuItems(language);
    const action = await selectAction(ctx, t(language, "menuTitle"), items);
    if (!action || action === "cancel") return;
    if (action === "upload-all") await showUploadAll(ctx);
    else if (action === "restore-all") await showRestoreAll(ctx);
    else if (action === "upload-pi") await showUploadPackage(ctx, "pi");
    else if (action === "upload-skills") await showUploadPackage(ctx, "skills");
    else if (action === "upload-sessions") await showUploadSessionsArchive(ctx);
    else if (action === "restore-pi") await showRestorePackage(ctx, "pi");
    else if (action === "restore-skills") await showRestorePackage(ctx, "skills");
    else if (action === "restore-sessions") await showRestoreSessionsArchive(ctx);
    else if (action === "configure") await showConfigureSettings(ctx);
    else if (action === "language") {
      saveConfig({ ...config, language: language === "zh" ? "en" : "zh" }, ctx);
    }
  }
}

export function registerSyncCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sync", {
    description: "Back up and restore Pi data via WebDAV",
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => handleSyncCommand(ctx),
  });
}
