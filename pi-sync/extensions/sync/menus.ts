import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enhancedSelect } from "../_shared/enhanced-select";
import {
  archiveTimestamp,
  createAgentSkillsZip,
  createCortexkitZip,
  createPiAgentZip,
  listArchiveEntries,
  platformTag,
  validateArchiveEntries,
} from "./archive";
import { loadConfig, normalizePiExcludePaths, saveConfig, type SyncConfig } from "./config";
import { t, type SyncLanguage } from "./i18n";
import { extractAgentSkillsZip, extractCortexkitZip, extractPiAgentZip, getRestorePlan } from "./restore";
import {
  downloadFromWebdavDir,
  listWebdavDir,
  pruneOldBackupsInDir,
  uploadToWebdavDir,
  WEBDAV_AGENT_SKILLS_DIR,
  WEBDAV_CORTEXKIT_DIR,
  WEBDAV_PI_BACKUP_DIR,
} from "./webdav";

export type SelectItem<T extends string> = { id: T; label: string };
type BackupKind = "pi" | "skills" | "cortexkit";
/** 重新绑定当前会话模型：pi.setModel（ExtensionAPI）。恢复 Pi 备份后用于刷新过期模型引用。 */
export type SetModelFn = (model: Model<any>) => Promise<boolean>;
export type MainAction =
  | "upload-all" | "restore-all"
  | "upload-pi" | "upload-skills" | "upload-cortexkit"
  | "restore-pi" | "restore-skills" | "restore-cortexkit"
  | "configure" | "language" | "cancel";

export interface BulkResult {
  kind: BackupKind;
  success: boolean;
  error?: string;
}

export interface BackupAllOperations {
  uploadPi(): Promise<boolean>;
  uploadSkills(): Promise<boolean>;
  uploadCortexkit(): Promise<boolean>;
}

export interface RestoreAllOperations {
  restorePi(): Promise<boolean>;
  restoreSkills(): Promise<boolean>;
  restoreCortexkit(): Promise<boolean>;
}

async function selectAction<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem<T>[],
  initialIndex = 0,
): Promise<T | undefined> {
  const selected = await enhancedSelect(ctx, title, items.map((item) => item.label), { initialIndex });
  return items.find((item) => item.label === selected)?.id;
}

function cloneConfig(config: SyncConfig): SyncConfig {
  return { ...config, piExcludePaths: [...config.piExcludePaths] };
}

function onOff(language: SyncLanguage, value: boolean): string {
  return t(language, value ? "on" : "off");
}

function kindLabel(language: SyncLanguage, kind: BackupKind): string {
  return t(language, kind === "pi" ? "piKind" : kind === "skills" ? "skillsKind" : "cortexkitKind");
}

export function buildMainMenuItems(language: SyncLanguage): SelectItem<MainAction>[] {
  return [
    { id: "upload-all", label: t(language, "uploadAllBackups") },
    { id: "restore-all", label: t(language, "restoreAllBackups") },
    { id: "upload-pi", label: t(language, "uploadPiBackup") },
    { id: "upload-skills", label: t(language, "uploadSkillsBackup") },
    { id: "upload-cortexkit", label: t(language, "uploadCortexkitBackup") },
    { id: "restore-pi", label: t(language, "restorePiBackup") },
    { id: "restore-skills", label: t(language, "restoreSkillsBackup") },
    { id: "restore-cortexkit", label: t(language, "restoreCortexkitBackup") },
    { id: "configure", label: t(language, "configureSettings") },
    { id: "language", label: t(language, "switchLanguage") },
    { id: "cancel", label: t(language, "cancel") },
  ];
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
  let cursor = 0;
  while (true) {
    const language = config.language;
    const items: SelectItem<string>[] = [
      { id: "url", label: t(language, "webdavUrl", { value: config.webdavUrl || t(language, "notSet") }) },
      { id: "user", label: t(language, "webdavUsername", { value: config.webdavUser || t(language, "notSet") }) },
      { id: "password", label: t(language, "webdavPassword", { value: config.webdavPass ? t(language, "passwordSet") : t(language, "notSet") }) },
      { id: "pi", label: t(language, "piBackup", { value: onOff(language, config.backupProviders) }) },
      { id: "skills", label: t(language, "skillsBackup", { value: onOff(language, config.backupAgentSkills) }) },
      { id: "cortexkit", label: t(language, "cortexkitBackup", { value: onOff(language, config.backupCortexkit) }) },
      { id: "exit", label: t(language, "backupOnExit", { value: onOff(language, config.backupOnExit) }) },
      { id: "exclude", label: t(language, "piExcludePaths", { value: config.piExcludePaths.join(", ") || t(language, "none") }) },
      { id: "max", label: t(language, "maxCloudBackups", { value: config.maxBackups === 0 ? t(language, "keepAll") : config.maxBackups }) },
      { id: "save", label: t(language, "save") },
      { id: "back", label: t(language, "back") },
    ];
    const action = await selectAction(ctx, t(language, "configureTitle"), items, cursor);
    if (!action || action === "back") return;
    cursor = Math.max(0, items.findIndex((item) => item.id === action));
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
    } else if (action === "cortexkit") {
      config.backupCortexkit = !config.backupCortexkit;
    } else if (action === "exit") {
      config.backupOnExit = !config.backupOnExit;
    } else if (action === "exclude") {
      const value = await ctx.ui.input(t(language, "promptExcludePaths"), config.piExcludePaths.join(", "));
      if (value !== undefined) config.piExcludePaths = normalizePiExcludePaths(value.split(/[\n,]/));
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
    : kind === "skills"
      ? { filename: `agent_skills_${timestamp}.tar.xz`, dir: WEBDAV_AGENT_SKILLS_DIR, prefix: "agent_skills_" }
      : { filename: `cortexkit_${timestamp}.tar.xz`, dir: WEBDAV_CORTEXKIT_DIR, prefix: "cortexkit_" };
}

export async function uploadBackupPackage(
  ctx: ExtensionCommandContext,
  kind: BackupKind,
  config = loadConfig(),
  notify = true,
): Promise<boolean> {
  const language = config.language;
  const label = kindLabel(language, kind);
  const enabled = kind === "pi"
    ? config.backupProviders
    : kind === "skills"
      ? config.backupAgentSkills
      : config.backupCortexkit;
  if (!enabled) {
    if (notify) ctx.ui.notify(t(language, "backupDisabled", { kind: label }), "warning");
    return false;
  }
  const meta = packageMeta(kind);
  const archive = path.join(os.tmpdir(), meta.filename);
  try {
    const contents = kind === "pi"
      ? await createPiAgentZip(config, archive)
      : kind === "skills"
        ? await createAgentSkillsZip(archive)
        : await createCortexkitZip(archive);
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

async function showRestorePackage(
  ctx: ExtensionCommandContext,
  kind: BackupKind,
  autoLatest = false,
  reloadAfter = true,
  setModel?: SetModelFn,
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
    if ((kind === "skills" || kind === "cortexkit") && !await ctx.ui.confirm(
      t(language, kind === "skills" ? "replaceSharedSkillsTitle" : "replaceCortexkitTitle"),
      t(language, kind === "skills" ? "replaceSharedSkillsBody" : "replaceCortexkitBody"),
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
      const restored = kind === "pi"
        ? await extractPiAgentZip(local)
        : kind === "skills"
          ? await extractAgentSkillsZip(local)
          : await extractCortexkitZip(local);
      if (kind === "pi") {
        try {
          const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false });
          if (refresh.errors.size > 0) console.warn(`[pi-sync] Model catalog refresh completed with ${refresh.errors.size} error(s)`);
        } catch (error) {
          console.warn(`[pi-sync] Failed to refresh restored model catalog: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (setModel) {
          const current = ctx.model;
          if (current) {
            const fresh = ctx.modelRegistry.find(current.provider, current.id);
            if (fresh && fresh !== current) {
              const bound = await setModel(fresh);
              if (!bound) console.warn(`[pi-sync] Failed to rebind current model ${current.provider}/${current.id}; auth may be unconfigured.`);
            } else if (!fresh) {
              console.warn(`[pi-sync] Current model ${current.provider}/${current.id} is absent from the restored catalog; select a model manually.`);
            }
          }
        }
      }
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

export async function executeBackupAll(config: SyncConfig, operations: BackupAllOperations): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  if (config.backupProviders) results.push({ kind: "pi", success: await operations.uploadPi() });
  if (config.backupAgentSkills) results.push({ kind: "skills", success: await operations.uploadSkills() });
  if (config.backupCortexkit) results.push({ kind: "cortexkit", success: await operations.uploadCortexkit() });
  return results;
}

export async function executeRestoreAll(config: SyncConfig, operations: RestoreAllOperations): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  if (config.backupProviders) results.push({ kind: "pi", success: await operations.restorePi() });
  if (config.backupAgentSkills) results.push({ kind: "skills", success: await operations.restoreSkills() });
  if (config.backupCortexkit) results.push({ kind: "cortexkit", success: await operations.restoreCortexkit() });
  return results;
}

function formatBulkResults(language: SyncLanguage, results: BulkResult[]): string {
  return results.map((result) => `${result.success ? "✅" : "❌"} ${kindLabel(language, result.kind)}${result.error ? `: ${result.error}` : ""}`).join("\n");
}

export async function uploadEnabledBackups(ctx: ExtensionCommandContext, config = loadConfig(), notify = true): Promise<boolean> {
  const results = await executeBackupAll(config, {
    uploadPi: () => uploadBackupPackage(ctx, "pi", config, notify),
    uploadSkills: () => uploadBackupPackage(ctx, "skills", config, notify),
    uploadCortexkit: () => uploadBackupPackage(ctx, "cortexkit", config, notify),
  });
  return results.length > 0 && results.every((result) => result.success);
}

async function showUploadAll(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  const language = config.language;
  const results = await executeBackupAll(config, {
    uploadPi: () => uploadBackupPackage(ctx, "pi", config, false),
    uploadSkills: () => uploadBackupPackage(ctx, "skills", config, false),
    uploadCortexkit: () => uploadBackupPackage(ctx, "cortexkit", config, false),
  });
  ctx.ui.notify(t(language, "allBackupCompleted", { results: formatBulkResults(language, results) || t(language, "none") }), "info");
}

async function showRestoreAll(ctx: ExtensionCommandContext, setModel?: SetModelFn): Promise<void> {
  const config = loadConfig();
  const language = config.language;
  if (!await ctx.ui.confirm(t(language, "confirmRestoreAllTitle"), t(language, "confirmRestoreAllBody"))) return;
  const results = await executeRestoreAll(config, {
    restorePi: () => showRestorePackage(ctx, "pi", true, false, setModel),
    restoreSkills: () => showRestorePackage(ctx, "skills", true, false),
    restoreCortexkit: () => showRestorePackage(ctx, "cortexkit", true, false),
  });
  ctx.ui.notify(t(language, "allRestoreCompleted", { results: formatBulkResults(language, results) || t(language, "none") }), "info");
  if (results.some((result) => result.success)
    && await ctx.ui.confirm(t(language, "reloadRuntimeTitle"), t(language, "reloadRuntimeBody"))) {
    await ctx.reload();
  }
}

export async function handleSyncCommand(ctx: ExtensionCommandContext, setModel?: SetModelFn): Promise<void> {
  let config = loadConfig();
  if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) {
    if (!await showSetupWizard(ctx)) return;
  }
  while (true) {
    config = loadConfig();
    const language = config.language;
    const action = await selectAction(ctx, t(language, "menuTitle"), buildMainMenuItems(language));
    if (!action || action === "cancel") return;
    if (action === "upload-all") await showUploadAll(ctx);
    else if (action === "restore-all") await showRestoreAll(ctx, setModel);
    else if (action === "upload-pi") await uploadBackupPackage(ctx, "pi");
    else if (action === "upload-skills") await uploadBackupPackage(ctx, "skills");
    else if (action === "upload-cortexkit") await uploadBackupPackage(ctx, "cortexkit");
    else if (action === "restore-pi") await showRestorePackage(ctx, "pi", false, true, setModel);
    else if (action === "restore-skills") await showRestorePackage(ctx, "skills");
    else if (action === "restore-cortexkit") await showRestorePackage(ctx, "cortexkit");
    else if (action === "configure") await showConfigureSettings(ctx);
    else if (action === "language") saveConfig({ ...config, language: language === "zh" ? "en" : "zh" }, ctx);
  }
}

export function registerSyncCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sync", {
    description: "Back up and restore Pi data via WebDAV",
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => handleSyncCommand(ctx, (model) => pi.setModel(model)),
  });
}
