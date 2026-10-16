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
  type KindBackupResult,
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
import { showProgressPanel } from "./progress-panel";
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
  /** 归档 manifest meta 的源家目录；供跨设备恢复后的 home 映射修复。 */
  sourceHome?: string;
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
  // 同一批备份共用一个时间戳，保证恢复列表聚类为一行（同一设备+平台+相同 ts）。
  const batchTs = new Date();
  // 后台执行：命令立即返回、编辑器解锁，进度用 Widget 通知条展示，完成后汇总通知。
  const panel = showProgressPanel(ctx, t(language, "backupRunningTitle"));
  const total = kinds.length;
  const doneResults: KindBackupResult[] = [];
  const updatePanel = (): void => {
    panel.update({
      status: t(language, "progressCompleted", { completed: doneResults.length, total }),
      current: t(language, "progressCurrent", {
        value: doneResults.length < total ? kindLabel(language, kinds[doneResults.length]!) : "",
      }),
      rows: doneResults.map((entry) => ({
        ok: entry.ok,
        text: entry.ok ? entry.file ?? "" : errorText(language, entry.error),
      })),
    });
  };
  updatePanel();
  void runBackupKinds(ctx, config, kinds, {
    batchTs,
    onProgress: (event) => {
      doneResults.push(event.result);
      updatePanel();
    },
  })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(t(language, "commandError", { error: message }), "error");
    })
    .finally(async () => {
      await panel.finish();
      if (doneResults.length === 0) return;
      const rows = doneResults.map((entry) => ({
        kind: entry.kind,
        ok: entry.ok,
        text: entry.file,
        error: entry.error,
      }));
      ctx.ui.notify(
        t(language, "backupSummary", { results: formatResultRows(language, rows) }),
        doneResults.every((entry) => entry.ok) ? "info" : "warning",
      );
    });
}

// ── 恢复二级 ────────────────────────────────────────────────────────────

function platformFriendlyName(language: SyncLanguage, platform: "win" | "mac" | "linux"): string {
  return t(language, platform === "win" ? "platformWin" : platform === "mac" ? "platformMac" : "platformLinux");
}

function formatRestoreTime(ts: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
}

/** 恢复列表行文案：只含 设备名/平台友好名/时间/本机徽标，类别交给第二步勾选。 */
export function formatRestoreRow(language: SyncLanguage, row: RestoreRow, localDevice: string): string {
  const parts = [
    row.device,
    platformFriendlyName(language, row.platform),
    formatRestoreTime(row.ts),
    // 行内显示备份内容（类别标签），让旧的单类别归档可分辨。
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
    return { kind, ok: true, detail: restored, sourceHome: restored.sourceMeta?.sourceHome };
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

/**
 * 恢复二级（两步）：扫描合并行 → 设备筛选 → 单选行 → 多选该行的类别
 * （默认全选；跨平台/非本机警示作为置灰提示行）→ 逐类别恢复 → 汇总。
 */
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

  // 跨平台/跨设备合并为一行简短提示（置灰不可选，仅提示）。
  const warnings: string[] = [];
  if (row.platform !== platformCode() || row.device !== localDevice) {
    warnings.push(t(language, "restoreSourceBrief", {
      device: row.device,
      platform: platformFriendlyName(language, row.platform),
    }));
  }
  // 第二步：复用盒式多选勾选要恢复的类别（默认全选），Esc 取消、Ctrl+S 执行。
  const items: MultiSelectItem[] = [
    ...warnings.map((warning, index) => ({ id: `warn:${index}`, label: warning, checked: false, disabled: true })),
    ...RESTORE_TAG_ORDER
      .filter((tag) => row.files[tag] !== undefined)
      .map((tag) => ({ id: tag, label: kindLabel(language, tag), checked: true })),
  ];
  const picked = await multiSelect(ctx, t(language, "restorePickTitle"), items, t(language, "runRestoreAction"));
  if (!picked || picked.checked.length === 0) return;

  const pending = RESTORE_TAG_ORDER
    .filter((tag) => picked.checked.includes(tag))
    .map((tag) => ({ kind: tag as BackupKind, file: row.files[tag]! }));
  // 进度面板：逐类别恢复期间展示 X/Y、当前类别与已完成归档。
  const panel = showProgressPanel(ctx, t(language, "restoreRunningTitle"));
  const updatePanel = (done: RestoreKindResult[]): void => {
    panel.update({
      status: t(language, "progressCompleted", { completed: done.length, total: pending.length }),
      current: t(language, "progressCurrent", {
        value: done.length < pending.length ? kindLabel(language, pending[done.length]!.kind) : "",
      }),
      rows: done.map((entry) => ({
        ok: entry.ok,
        text: t(language, entry.ok ? "resultRowOk" : "resultRowFail", {
          status: entry.ok ? "✅" : "❌",
          kind: kindLabel(language, entry.kind),
          text: entry.ok ? entry.detail?.join("; ") ?? "" : entry.error ?? "",
        }),
      })),
    });
  };
  updatePanel([]);
  const results: RestoreKindResult[] = [];
  try {
    for (const entry of pending) {
      const result = await restoreKindArchive(ctx, config, entry.kind, entry.file, setModel);
      results.push(result);
      updatePanel(results);
      if (!result.ok) break;
    }
  } finally {
    await panel.finish();
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
  // 带 manifest meta 的归档恢复成功后，提供按源 home 映射的修复面板
  // （Pi 直打归档无 manifest，修复命令里走保守模式识别）。
  const sourceHome = results.find((result) => result.ok && result.sourceHome)?.sourceHome;
  if (sourceHome && sourceHome !== os.homedir()
    && await ctx.ui.confirm(t(language, "repairTitle"), t(language, "repairAfterRestore"))) {
    await runRepair(ctx, language, AGENT_DIR, sourceHome);
  }
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
    handler: async (_args, ctx) => {
      try {
        await handleSyncCommand(ctx, (model) => pi.setModel(model));
      } catch (error) {
        // 不静默：错误写入 console（含堆栈，便于定位），并尽力通知 UI（TUI 可能已重建）。
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack ?? "" : "";
        console.error(`[pi-sync] /sync command failed: ${message}\n${stack}`);
        try {
          const stackLines = (error instanceof Error ? error.stack ?? "" : "").split("\n").slice(1, 4).join("\n").trim();
          ctx.ui.notify(t(loadConfig().language, "commandError", { error: stackLines ? `${message}\n${stackLines}` : message }), "error");
        } catch {
          // UI 不可用时仅保留 console 错误。
        }
      }
    },
  });
}
