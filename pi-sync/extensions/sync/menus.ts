import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enhancedSelect } from "../_shared/enhanced-select";
import { platformCode, sanitizeDeviceName } from "./archive-name";
import {
  LOCK_BUSY_ERROR,
  runBackupKinds,
} from "./backup";
import {
  AGENT_DIR,
  AGENT_SKILLS_DIR,
  CORTEXKIT_CONFIG_DIR,
  loadConfig,
  normalizePiExcludePaths,
  saveConfig,
  validateRemoteBaseDirInput,
  webdavDir,
  type BackupKind,
  type SyncConfig,
} from "./config";
import { invalidateSyncState } from "./fingerprint";
import { t, type SyncLanguage } from "./i18n";
import { multiSelect, type MultiSelectItem } from "./multi-select";
import { extractAgentSkillsZip, extractCortexkitZip, extractPiAgentZip } from "./restore";
import { runRepair } from "./repair";
import { buildRestoreRows, RESTORE_TAG_ORDER, type RestoreRow } from "./restore-rows";
import { selectRestoreRow } from "./restore-panel";
import { downloadFromWebdavDir, listWebdavDir } from "./webdav";

export type SelectItem<T extends string> = { id: T; label: string };
/** 重新绑定当前会话模型：pi.setModel（ExtensionAPI）。恢复 Pi 备份后用于刷新过期模型引用。 */
export type SetModelFn = (model: Model<any>) => Promise<boolean>;
export type MainAction =
  | "backup" | "restore" | "repair" | "settings" | "quit";

const BACKUP_KINDS: readonly BackupKind[] = ["pi", "skills", "cortexkit"];

export interface KindResultRow {
  kind: BackupKind;
  ok: boolean;
  /** 成功时的说明文字（远端文件名或恢复详情）。 */
  text?: string;
  error?: string;
}

export interface RestoreKindResult {
  kind: BackupKind;
  ok: boolean;
  detail?: string[];
  error?: string;
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

function onOff(language: SyncLanguage, value: boolean): string {
  return t(language, value ? "on" : "off");
}

function kindLabel(language: SyncLanguage, kind: BackupKind): string {
  return t(language, kind === "pi" ? "piKind" : kind === "skills" ? "skillsKind" : "cortexkitKind");
}

export function buildMainMenuItems(language: SyncLanguage): SelectItem<MainAction>[] {
  return [
    { id: "backup", label: t(language, "menuBackup") },
    { id: "restore", label: t(language, "menuRestore") },
    { id: "repair", label: t(language, "menuRepair") },
    { id: "settings", label: t(language, "menuSettings") },
    { id: "quit", label: t(language, "menuQuit") },
  ];
}

export async function showSetupWizard(ctx: ExtensionCommandContext): Promise<boolean> {
  const config = loadConfig();
  const language = config.language;
  ctx.ui.notify(t(language, "setupRequired"), "warning");
  const url = await ctx.ui.input(t(language, "promptWebdavUrl"), config.webdavUrl); if (!url) return false;
  const user = await ctx.ui.input(t(language, "promptWebdavUsername"), config.webdavUser); if (!user) return false;
  const pass = await ctx.ui.input(t(language, "promptWebdavPassword"), config.webdavPass); if (!pass) return false;
  saveConfig({ ...config, webdavUrl: url.trim(), webdavUser: user.trim(), webdavPass: pass.trim() }, ctx);
  return true;
}

// ── 汇总行渲染 ──────────────────────────────────────────────────────────

/** 失败行错误文案：锁冲突标记映射为本地化提示，其余原样。 */
function errorText(language: SyncLanguage, error: string | undefined): string {
  return error === LOCK_BUSY_ERROR ? t(language, "lockBusy") : error ?? "";
}

function formatResultRows(
  language: SyncLanguage,
  rows: readonly { kind: BackupKind; ok: boolean; text?: string; error?: string }[],
): string {
  return rows.map((row) => {
    const kind = kindLabel(language, row.kind);
    return row.ok
      ? t(language, "resultRowOk", { status: "✅", kind, text: row.text ?? "" })
      : t(language, "resultRowFail", { status: "❌", kind, text: errorText(language, row.error) });
  }).join("\n");
}

// ── 备份二级 ────────────────────────────────────────────────────────────

function kindAvailable(kind: BackupKind): boolean {
  return fs.existsSync(kind === "pi" ? AGENT_DIR : kind === "skills" ? AGENT_SKILLS_DIR : CORTEXKIT_CONFIG_DIR);
}

/** 备份二级：多选类别（目录缺失置灰）→ Ctrl+S 串行执行 → 汇总通知。 */
export async function showBackupMenu(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  const language = config.language;
  const items: MultiSelectItem[] = BACKUP_KINDS.map((kind) => {
    const available = kindAvailable(kind);
    return {
      id: kind,
      label: available ? kindLabel(language, kind) : t(language, "categoryMissingDir", { kind: kindLabel(language, kind) }),
      checked: available,
      disabled: !available,
    };
  });
  const result = await multiSelect(ctx, t(language, "backupSelectTitle"), items, t(language, "runBackupAction"));
  if (!result || result.checked.length === 0) return;
  const kinds = result.checked as BackupKind[];
  const results = await runBackupKinds(ctx, config, kinds);
  const rows = results.map((entry) => ({
    kind: entry.kind,
    ok: entry.ok,
    text: entry.file,
    error: entry.error,
  }));
  ctx.ui.notify(
    t(language, "backupSummary", { results: formatResultRows(language, rows) }),
    results.every((entry) => entry.ok) ? "info" : "warning",
  );
}

// ── 恢复二级 ────────────────────────────────────────────────────────────

function platformFriendlyName(language: SyncLanguage, platform: "win" | "mac" | "linux"): string {
  return t(language, platform === "win" ? "platformWin" : platform === "mac" ? "platformMac" : "platformLinux");
}

function formatRestoreTime(ts: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
}

function formatRestoreRow(language: SyncLanguage, row: RestoreRow, localDevice: string): string {
  const parts = [
    row.device,
    platformFriendlyName(language, row.platform),
    formatRestoreTime(row.ts),
    row.tags.map((tag) => kindLabel(language, tag)).join("+"),
  ];
  if (row.device === localDevice) parts.push(t(language, "localBadge"));
  return parts.join("  ");
}

async function scanRestoreArchives(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
  const names: string[] = [];
  for (const kind of BACKUP_KINDS) {
    try {
      names.push(...await listWebdavDir(webdavDir(kind, config), config, ctx));
    } catch (error) {
      console.warn(`[pi-sync] Failed to list ${webdavDir(kind, config)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return names;
}

async function restoreKindArchive(
  ctx: ExtensionCommandContext,
  config: SyncConfig,
  kind: BackupKind,
  file: string,
  setModel?: SetModelFn,
): Promise<RestoreKindResult> {
  const local = path.join(os.tmpdir(), path.basename(file));
  try {
    await downloadFromWebdavDir(file, webdavDir(kind, config), local, config, ctx);
    const restored = kind === "pi"
      ? await extractPiAgentZip(local)
      : kind === "skills"
        ? await extractAgentSkillsZip(local)
        : await extractCortexkitZip(local);
    if (kind === "pi") await refreshModelCatalog(ctx, setModel);
    return { kind, ok: true, detail: restored };
  } catch (error) {
    return { kind, ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(local, { force: true });
  }
}

/** 恢复 Pi 备份后刷新模型目录并尝试重绑当前模型；失败只警告，不中断恢复流程。 */
async function refreshModelCatalog(ctx: ExtensionCommandContext, setModel?: SetModelFn): Promise<void> {
  try {
    const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false });
    if (refresh.errors.size > 0) console.warn(`[pi-sync] Model catalog refresh completed with ${refresh.errors.size} error(s)`);
  } catch (error) {
    console.warn(`[pi-sync] Failed to refresh restored model catalog: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!setModel) return;
  const current = ctx.model;
  if (!current) return;
  const fresh = ctx.modelRegistry.find(current.provider, current.id);
  if (fresh && fresh !== current) {
    const bound = await setModel(fresh);
    if (!bound) console.warn(`[pi-sync] Failed to rebind current model ${current.provider}/${current.id}; auth may be unconfigured.`);
  } else if (!fresh) {
    console.warn(`[pi-sync] Current model ${current.provider}/${current.id} is absent from the restored catalog; select a model manually.`);
  }
}

/** 恢复二级：扫描合并行 → 设备筛选 → 单选 → 覆盖确认 → 逐类别恢复 → 汇总。 */
export async function showRestoreMenu(ctx: ExtensionCommandContext, setModel?: SetModelFn): Promise<void> {
  const config = loadConfig();
  const language = config.language;
  const localDevice = config.deviceName;
  const rows = buildRestoreRows(await scanRestoreArchives(config, ctx));
  if (rows.length === 0) {
    ctx.ui.notify(t(language, "restoreNoArchives"), "warning");
    return;
  }
  const row = await selectRestoreRow(ctx, {
    title: t(language, "restoreSelectTitle"),
    rows,
    texts: {
      filterLabel: t(language, "deviceFilterLabel"),
      allDevices: t(language, "deviceFilterAll"),
    },
    formatRow: (entry) => formatRestoreRow(language, entry, localDevice),
  });
  if (!row) return;

  const warnings: string[] = [];
  if (row.platform !== platformCode()) {
    warnings.push(t(language, "restoreCrossPlatformWarn", { platform: platformFriendlyName(language, row.platform) }));
  }
  if (row.device !== localDevice) {
    warnings.push(t(language, "restoreOtherDeviceWarn", { device: row.device }));
  }
  const fileList = RESTORE_TAG_ORDER
    .map((tag) => row.files[tag])
    .filter((file): file is string => Boolean(file))
    .join("\n");
  if (!await ctx.ui.confirm(
    t(language, "restoreConfirmTitle"),
    t(language, "restoreConfirmBody", { files: fileList, warning: warnings.join("\n") }),
  )) return;

  const results: RestoreKindResult[] = [];
  for (const kind of RESTORE_TAG_ORDER) {
    const file = row.files[kind];
    if (!file) continue;
    const result = await restoreKindArchive(ctx, config, kind, file, setModel);
    results.push(result);
    if (!result.ok) break;
  }
  if (results.some((result) => result.ok)) invalidateSyncState();
  const summaryRows: KindResultRow[] = results.map((result) => ({
    kind: result.kind,
    ok: result.ok,
    text: result.detail?.join("; "),
    error: result.error,
  }));
  const summary = formatResultRows(language, summaryRows);
  const failed = results.some((result) => !result.ok);
  ctx.ui.notify(
    t(language, "restoreSummary", { results: failed ? `${summary}\n${t(language, "restoreInterrupted")}` : summary }),
    failed ? "warning" : "info",
  );
}

// ── 设置子菜单 ──────────────────────────────────────────────────────────

/** WebDAV 三项连续编辑；任一步取消（Esc）则整体不保存。 */
async function editWebdavSettings(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  const language = config.language;
  const url = await ctx.ui.input(t(language, "promptWebdavUrl"), config.webdavUrl);
  if (url === undefined) return;
  const user = await ctx.ui.input(t(language, "promptWebdavUsername"), config.webdavUser);
  if (user === undefined) return;
  const pass = await ctx.ui.input(t(language, "promptWebdavPassword"), config.webdavPass);
  if (pass === undefined) return;
  saveConfig({
    ...config,
    webdavUrl: url.trim() || config.webdavUrl,
    webdavUser: user.trim() || config.webdavUser,
    webdavPass: pass.trim() || config.webdavPass,
  }, ctx);
  ctx.ui.notify(t(language, "configSaved"), "info");
}

async function editExitBackupScope(ctx: ExtensionCommandContext, config: SyncConfig): Promise<void> {
  const language = config.language;
  const items: MultiSelectItem[] = BACKUP_KINDS.map((kind) => ({
    id: kind,
    label: kindLabel(language, kind),
    checked: config.exitBackupScope.includes(kind),
  }));
  const result = await multiSelect(ctx, t(language, "settingsExitScope", { value: "" }), items);
  if (!result) return;
  saveConfig({ ...config, exitBackupScope: result.checked as BackupKind[] }, ctx);
}

/** 设置子菜单：9 项，修改即时保存（每个编辑项自带取消）。 */
export async function showConfigureSettings(ctx: ExtensionCommandContext): Promise<void> {
  let cursor = 0;
  while (true) {
    const config = loadConfig();
    const language = config.language;
    const items: SelectItem<string>[] = [
      { id: "webdav", label: t(language, "settingsWebdav", { value: config.webdavUrl || t(language, "notSet") }) },
      { id: "exitBackup", label: t(language, "settingsExitBackup", { value: onOff(language, config.backupOnExit) }) },
      { id: "max", label: t(language, "maxCloudBackups", { value: config.maxBackups === 0 ? t(language, "keepAll") : config.maxBackups }) },
      { id: "exitScope", label: t(language, "settingsExitScope", { value: config.exitBackupScope.map((kind) => kindLabel(language, kind)).join(", ") || t(language, "none") }) },
      { id: "device", label: t(language, "settingsDeviceName", { value: config.deviceName }) },
      { id: "baseDir", label: t(language, "settingsRemoteBaseDir", { value: config.remoteBaseDir }) },
      { id: "exclude", label: t(language, "piExcludePaths", { value: config.piExcludePaths.join(", ") || t(language, "none") }) },
      { id: "language", label: t(language, "switchLanguage") },
      { id: "back", label: t(language, "back") },
    ];
    const action = await selectAction(ctx, t(language, "settingsTitle"), items, cursor);
    if (!action || action === "back") return;
    cursor = Math.max(0, items.findIndex((item) => item.id === action));
    if (action === "webdav") {
      await editWebdavSettings(ctx);
    } else if (action === "exitBackup") {
      saveConfig({ ...config, backupOnExit: !config.backupOnExit }, ctx);
    } else if (action === "max") {
      const value = await ctx.ui.input(t(language, "promptMaxBackups"), String(config.maxBackups));
      if (value === undefined) continue;
      const count = Number.parseInt(value, 10);
      if (count >= 0) saveConfig({ ...config, maxBackups: count }, ctx);
    } else if (action === "exitScope") {
      await editExitBackupScope(ctx, config);
    } else if (action === "device") {
      const value = await ctx.ui.input(t(language, "promptDeviceName"), config.deviceName);
      if (value === undefined || !value.trim()) continue;
      saveConfig({ ...config, deviceName: sanitizeDeviceName(value) }, ctx);
    } else if (action === "baseDir") {
      const value = await ctx.ui.input(t(language, "promptRemoteBaseDir"), config.remoteBaseDir);
      if (value === undefined || !value.trim()) continue;
      const normalized = validateRemoteBaseDirInput(value);
      if (normalized) saveConfig({ ...config, remoteBaseDir: normalized }, ctx);
      else ctx.ui.notify(t(language, "remoteBaseDirInvalid"), "warning");
    } else if (action === "exclude") {
      const value = await ctx.ui.input(t(language, "promptExcludePaths"), config.piExcludePaths.join(", "));
      if (value === undefined) continue;
      saveConfig({ ...config, piExcludePaths: normalizePiExcludePaths(value.split(/[\n,]/)) }, ctx);
    } else if (action === "language") {
      saveConfig({ ...config, language: language === "zh" ? "en" : "zh" }, ctx);
    }
  }
}

// ── 主菜单 ──────────────────────────────────────────────────────────────

export async function handleSyncCommand(ctx: ExtensionCommandContext, setModel?: SetModelFn): Promise<void> {
  if (!loadConfig().webdavUrl || !loadConfig().webdavUser || !loadConfig().webdavPass) {
    if (!await showSetupWizard(ctx)) return;
  }
  while (true) {
    const config = loadConfig();
    const language = config.language;
    const action = await selectAction(ctx, t(language, "menuTitle"), buildMainMenuItems(language));
    if (!action || action === "quit") return;
    if (action === "backup") await showBackupMenu(ctx);
    else if (action === "restore") await showRestoreMenu(ctx, setModel);
    else if (action === "repair") await runRepair(ctx, loadConfig().language);
    else if (action === "settings") await showConfigureSettings(ctx);
  }
}

export function registerSyncCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sync", {
    description: "Back up and restore Pi data via WebDAV",
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => handleSyncCommand(ctx, (model) => pi.setModel(model)),
  });
}
