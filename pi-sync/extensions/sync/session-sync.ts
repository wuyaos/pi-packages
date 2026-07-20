import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enhancedSelect } from "../_shared/enhanced-select";
import { readJsonSafe } from "../_shared/json-io";
import { extractSessionTs } from "./archive";
import { SESSIONS_DIR, ensureDir, isProjectAllowed, loadConfig, saveConfig, type SyncConfig } from "./config";
import { ensureWebdavDirectory, sessionsWebdavBase, WEBDAV_SESSIONS_DIR, webdavAuth, webdavGetFile, webdavList, webdavPutFile } from "./webdav";

export interface SessionSyncState {
  currentSessionFile?: string;
  currentProjectDir?: string;
  liveBackupTimer?: ReturnType<typeof setTimeout>;
  turnCounter: number;
}

const state: SessionSyncState = { turnCounter: 0 };

export function setSessionContext(file?: string, dir?: string): void {
  state.currentSessionFile = file;
  state.currentProjectDir = dir ? path.basename(dir) : undefined;
  state.turnCounter = 0;
}

export function refreshSessionFile(file?: string): void {
  state.currentSessionFile = file ?? state.currentSessionFile;
}

export function getCurrentSessionFile(): string | undefined {
  return state.currentSessionFile;
}

export function incrementTurnAndShouldSync(interval: number): boolean {
  if (interval <= 0) return false;
  state.turnCounter++;
  return state.turnCounter % interval === 0;
}

export function currentProjectIsAllowed(config: SyncConfig): boolean {
  return isProjectAllowed(state.currentProjectDir, config);
}

export function listSessionProjects(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("--") && entry.name.endsWith("--"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

export function sessionDirToPath(dirName: string): string {
  let value = dirName;
  if (value.startsWith("--")) value = value.slice(2);
  if (value.endsWith("--")) value = value.slice(0, -2);
  return value ? `/${value.replace(/-/g, "/")}` : dirName;
}

export function projectDirFromCwd(cwd: string): string {
  return `--${cwd.replace(/\//g, "-")}--`;
}

export function describeSessionSelection(config: SyncConfig): string {
  const count = config.sessionProjects.length;
  return count === 0 ? `ALL projects (${config.sessionProjectMode}, empty list)` : `${config.sessionProjectMode}: ${count} project${count === 1 ? "" : "s"}`;
}

export async function updateLatestMarker(ctx: ExtensionContext, config: SyncConfig, projectDir: string, sessionFile: string): Promise<void> {
  const filename = path.basename(sessionFile), sessionTs = extractSessionTs(filename);
  if (!sessionTs) return;
  const markerUrl = sessionsWebdavBase(config) + encodeURIComponent(projectDir) + "/_latest.json";
  const temp = path.join(os.tmpdir(), `pi_latest_${process.pid}_${Date.now()}.json`);
  let remoteTs: string | undefined;
  try {
    try { await webdavGetFile(markerUrl, temp, webdavAuth(config), ctx); remoteTs = readJsonSafe<{ sessionTs?: string }>(temp, {}).sessionTs; }
    catch (error) { if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error; }
    if (remoteTs && remoteTs >= sessionTs) return;
    fs.writeFileSync(temp, JSON.stringify({ file: filename, sessionTs, machine: os.hostname(), uploadedAt: new Date().toISOString() }, null, 2));
    await webdavPutFile(temp, markerUrl, webdavAuth(config), ctx);
  } finally { fs.rmSync(temp, { force: true }); }
}

export async function uploadCurrentSession(ctx: ExtensionContext, silent = false): Promise<boolean> {
  const config = loadConfig();
  if (!state.currentSessionFile || !state.currentProjectDir) {
    if (!silent) ctx.ui.notify("No active session file to upload.", "warning");
    return false;
  }
  if (!isProjectAllowed(state.currentProjectDir, config)) return false;
  if (!fs.existsSync(state.currentSessionFile)) {
    if (!silent) ctx.ui.notify(`Session file missing: ${state.currentSessionFile}`, "warning");
    return false;
  }
  try {
    await ensureWebdavDirectory(`${WEBDAV_SESSIONS_DIR}${state.currentProjectDir}/`, config, ctx);
    const remote = sessionsWebdavBase(config) + encodeURIComponent(state.currentProjectDir) + "/" + encodeURIComponent(path.basename(state.currentSessionFile));
    await webdavPutFile(state.currentSessionFile, remote, webdavAuth(config), ctx);
    await updateLatestMarker(ctx, config, state.currentProjectDir, state.currentSessionFile);
    if (!silent) ctx.ui.notify(`☁️  Session uploaded: ${path.basename(state.currentSessionFile)}`, "info");
    return true;
  } catch (error) {
    if (!silent) ctx.ui.notify(`❌ Session upload failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  }
}

export function scheduleLiveBackup(ctx: ExtensionContext): void {
  const config = loadConfig();
  if (!config.liveSessionBackup || !currentProjectIsAllowed(config)) return;
  clearLiveBackupTimer();
  state.liveBackupTimer = setTimeout(() => {
    state.liveBackupTimer = undefined;
    uploadCurrentSession(ctx, true).catch(() => { /* silent */ });
  }, config.liveBackupDebounceMs);
}

export function clearLiveBackupTimer(): void {
  if (state.liveBackupTimer) clearTimeout(state.liveBackupTimer);
  state.liveBackupTimer = undefined;
}

async function listRemoteProjects(config: SyncConfig, ctx: ExtensionContext): Promise<string[]> {
  try { return await webdavList(sessionsWebdavBase(config), webdavAuth(config), ctx, (name) => name.startsWith("--") && name.endsWith("--")); }
  catch (error) { if (error instanceof Error && /HTTP 404/.test(error.message)) return []; throw error; }
}

export async function showRestoreLatest(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  try {
    const projects = await listRemoteProjects(config, ctx);
    if (!projects.length) { ctx.ui.notify("No remote session projects found.", "warning"); return; }
    const project = await enhancedSelect(ctx, "Restore latest: select project", [...projects, "❌ Cancel"], { fuzzy: true });
    if (!project || project.includes("Cancel")) return;
    const markerPath = path.join(os.tmpdir(), `pi_latest_${Date.now()}.json`);
    try {
      const base = sessionsWebdavBase(config) + encodeURIComponent(project) + "/";
      await webdavGetFile(base + "_latest.json", markerPath, webdavAuth(config), ctx);
      const marker = readJsonSafe<{ file?: string }>(markerPath, {});
      if (!marker.file || !marker.file.endsWith(".jsonl") || path.basename(marker.file) !== marker.file) throw new Error("Remote _latest.json has no safe session filename.");
      const localDir = path.join(SESSIONS_DIR, project); ensureDir(localDir);
      const localPath = path.join(localDir, marker.file);
      await webdavGetFile(base + encodeURIComponent(marker.file), localPath, webdavAuth(config), ctx);
      ctx.ui.notify(`🎉 Restored latest session into ${localPath}\nUse /resume to continue.`, "info");
    } finally { fs.rmSync(markerPath, { force: true }); }
  } catch (error) { ctx.ui.notify(`❌ Restore latest failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
}

export async function showRestoreSessions(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  try {
    const projects = await listRemoteProjects(config, ctx);
    if (!projects.length) { ctx.ui.notify("No remote session projects found.", "warning"); return; }
    const project = await enhancedSelect(ctx, "Select remote project to restore", [...projects, "❌ Cancel"], { fuzzy: true });
    if (!project || project.includes("Cancel")) return;
    const base = sessionsWebdavBase(config) + encodeURIComponent(project) + "/";
    const files = await webdavList(base, webdavAuth(config), ctx, (name) => name.endsWith(".jsonl"));
    if (!files.length) { ctx.ui.notify(`No .jsonl files in ${project}.`, "warning"); return; }
    const choice = await enhancedSelect(ctx, `Restore from ${project}`, [...files, "a Restore ALL", "❌ Cancel"], { fuzzy: true });
    if (!choice || choice.includes("Cancel")) return;
    const targets = choice === "a Restore ALL" ? files : [choice];
    const localDir = path.join(SESSIONS_DIR, project); ensureDir(localDir);
    for (const file of targets) await webdavGetFile(base + encodeURIComponent(file), path.join(localDir, file), webdavAuth(config), ctx);
    ctx.ui.notify(`🎉 Restored ${targets.length} session(s) into ${localDir}`, "info");
  } catch (error) { ctx.ui.notify(`❌ Restore failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
}

export async function showForkSession(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();
  try {
    const projects = await listRemoteProjects(config, ctx);
    if (!projects.length) { ctx.ui.notify("No remote session projects found.", "warning"); return; }
    const project = await enhancedSelect(ctx, "Fork: select source project", [...projects, "❌ Cancel"], { fuzzy: true });
    if (!project || project.includes("Cancel")) return;
    const base = sessionsWebdavBase(config) + encodeURIComponent(project) + "/";
    const files = await webdavList(base, webdavAuth(config), ctx, (name) => name.endsWith(".jsonl"));
    const file = await enhancedSelect(ctx, "Fork: select session", [...files, "❌ Cancel"], { fuzzy: true });
    if (!file || file.includes("Cancel")) return;
    const temp = path.join(os.tmpdir(), `pi_fork_${Date.now()}.jsonl`);
    try {
      await webdavGetFile(base + encodeURIComponent(file), temp, webdavAuth(config), ctx);
      const manager = SessionManager.forkFrom(temp, process.cwd());
      ctx.ui.notify(`🎉 Forked into: ${manager.getSessionFile() ?? "(unknown)"}`, "info");
    } finally { fs.rmSync(temp, { force: true }); }
  } catch (error) { ctx.ui.notify(`❌ Fork failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
}

export async function showSessionProjectSelect(ctx: ExtensionCommandContext, config: SyncConfig): Promise<void> {
  while (true) {
    const projects = listSessionProjects();
    if (!projects.length) { ctx.ui.notify("No local session projects found.", "warning"); return; }
    const selected = new Set(config.sessionProjects);
    const items = projects.map((dir) => `${selected.has(dir) ? "[x]" : "[ ]"} ${sessionDirToPath(dir)}`);
    items.push("───────────────", `m Switch to ${config.sessionProjectMode === "whitelist" ? "blacklist" : "whitelist"} mode`, "a Select All", "r Reset list (empty = all)", "x Back");
    const label = config.sessionProjectMode === "whitelist" ? "白名单模式" : "黑名单模式";
    const choice = await enhancedSelect(ctx, `Select Session Projects [${label}]`, items, { fuzzy: true });
    if (!choice || choice === "x Back") { saveConfig(config, ctx); return; }
    if (choice.startsWith("m Switch")) { config.sessionProjectMode = config.sessionProjectMode === "whitelist" ? "blacklist" : "whitelist"; saveConfig(config, ctx); continue; }
    if (choice === "a Select All") { config.sessionProjects = [...projects]; saveConfig(config, ctx); continue; }
    if (choice.startsWith("r Reset")) { config.sessionProjects = []; saveConfig(config, ctx); continue; }
    const match = choice.match(/^\[[ x]\]\s+(.*)$/); if (!match) continue;
    const dir = projects.find((candidate) => sessionDirToPath(candidate) === match[1]); if (!dir) continue;
    config.sessionProjects = selected.has(dir) ? config.sessionProjects.filter((item) => item !== dir) : [...config.sessionProjects, dir];
    saveConfig(config, ctx);
  }
}

export async function showSessionSyncMenu(ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const config = loadConfig();
    const current = state.currentSessionFile ? path.basename(state.currentSessionFile) : "(none)";
    const choice = await enhancedSelect(ctx, "Session Sync", [
      `⚡ Live Backup: ${config.liveSessionBackup ? "ON" : "OFF"}`,
      `  ↳ Debounce: ${config.liveBackupDebounceMs}ms`,
      `🔄 Sync Interval: ${config.syncIntervalTurns === 0 ? "OFF" : `every ${config.syncIntervalTurns} turns`}`,
      `📤 Sync On Exit: ${config.syncSessionOnExit ? "ON" : "OFF"}`,
      `☁️  Upload Current Session Now  (cur: ${current})`,
      "📥 Restore Latest Session", "📥 Restore Sessions", "🌿 Fork Remote Session", "x Back",
    ]);
    if (!choice || choice === "x Back") return;
    if (choice.startsWith("⚡")) { config.liveSessionBackup = !config.liveSessionBackup; saveConfig(config, ctx); continue; }
    if (choice.startsWith("  ↳")) { const value = await ctx.ui.input("Debounce ms:", String(config.liveBackupDebounceMs)); const n = value ? parseInt(value, 10) : NaN; if (n > 0) { config.liveBackupDebounceMs = n; saveConfig(config, ctx); } continue; }
    if (choice.startsWith("🔄")) { const value = await ctx.ui.input("Upload every N turns (0 = off):", String(config.syncIntervalTurns)); const n = value ? parseInt(value, 10) : NaN; if (n >= 0) { config.syncIntervalTurns = n; saveConfig(config, ctx); } continue; }
    if (choice.startsWith("📤")) { config.syncSessionOnExit = !config.syncSessionOnExit; saveConfig(config, ctx); continue; }
    if (choice.startsWith("☁️")) { await uploadCurrentSession(ctx); continue; }
    if (choice.startsWith("📥 Restore Latest")) { await showRestoreLatest(ctx); continue; }
    if (choice.startsWith("📥 Restore Sessions")) { await showRestoreSessions(ctx); continue; }
    if (choice.startsWith("🌿")) { await showForkSession(ctx); continue; }
  }
}
