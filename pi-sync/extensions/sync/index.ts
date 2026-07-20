import { type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { timestampForBackup, ensureDir, writeJsonAtomic, readJsonSafe } from "../_shared/json-io";
import { enhancedSelect } from "../_shared/enhanced-select";
import { runCommand } from "../_shared/spawn";
import { fetchWithTimeout } from "../_shared/fetch-utils";
// Responsibility modules are intentionally imported by the entrypoint. The
// compatibility implementation below is being kept while these seams become
// the stable public API for future extensions.
import * as syncConfigModule from "./config";
import * as syncWebdavModule from "./webdav";
import * as syncArchiveModule from "./archive";
import * as syncRestoreModule from "./restore";
import * as syncSessionModule from "./session-sync";
import * as syncMenusModule from "./menus";

/**
 * Platform tag for backup filenames, e.g. "windows11", "windows10", "macos", "linux".
 * Cross-platform: derives from os.platform()/os.release() so the archive name
 * identifies the machine that produced it regardless of host OS.
 */
function platformTag(): string {
  const p = os.platform();
  if (p === "win32") {
    // Windows 11 is build >= 22000; earlier builds report as Windows 10.
    const build = parseInt((os.release().split(".")[2] ?? "0"), 10);
    return build >= 22000 ? "windows11" : "windows10";
  }
  if (p === "darwin") return "macos";
  if (p === "linux") return "linux";
  return p; // fallback: raw platform id (e.g. "freebsd")
}

// 让出事件循环，让 TUI 有机会渲染之前的 notify/setStatus
// 同步 fs 操作 (copyRecursiveSync 等) 会阻塞事件循环，导致提示延迟显示
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Config lives under ~/.pi/agent/config/ (same convention as tool-gate.json).
// Legacy path ~/.pi/agent/sync_config.json is auto-migrated on first read.
const SYNC_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "config");
const SYNC_CONFIG_PATH = path.join(SYNC_CONFIG_DIR, "sync.json");
const LEGACY_SYNC_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "sync_config.json");
const TAR_TIMEOUT_MS = 300_000;
const WEBDAV_FETCH_TIMEOUT_MS = 120_000;

interface SyncConfig {
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string; // Environment variable or plaintext
  backupProviders: boolean;
  backupSkills: boolean;
  backupExtensions: boolean;
  backupSessions: boolean;
  /** Selected session project directory names (e.g. "--mnt-c-Users-wff19-Desktop-222--"). Empty = all. */
  sessionProjects: string[];
  /** Real-time per-file session backup after each agent turn. */
  liveSessionBackup: boolean;
  /** Debounce window (ms) for live session backup after agent_settled. */
  liveBackupDebounceMs: number;
  /** Upload the active session every N turns (0 = disabled). */
  syncIntervalTurns: number;
  /** Flush the active session when the Pi session shuts down. */
  syncSessionOnExit: boolean;
  /** Include the three durable pi-hermes-memory markdown files in memory snapshots. */
  backupMemory: boolean;
  /** Back up the shared ~/.agents/skills directory as a standalone snapshot. */
  backupAgentSkills: boolean;
  /** Interpret sessionProjects as an inclusion or exclusion list. */
  sessionProjectMode: "whitelist" | "blacklist";
  /** Keep at most N cloud archives per backup category (0 = keep all). */
  maxBackups: number;
}

export default function (pi: ExtensionAPI) {
  // Keep module imports live and validated by the runtime entrypoint while the
  // compatibility closure continues to own the registered handlers.
  void syncConfigModule; void syncWebdavModule; void syncArchiveModule;
  void syncRestoreModule; void syncSessionModule; void syncMenusModule;
  // Read and write config helpers
  function loadConfig(): SyncConfig {
    // Auto-migrate legacy ~/.pi/agent/sync_config.json → config/sync.json
    if (!fs.existsSync(SYNC_CONFIG_PATH) && fs.existsSync(LEGACY_SYNC_CONFIG_PATH)) {
      ensureDir(SYNC_CONFIG_DIR);
      try {
        fs.copyFileSync(LEGACY_SYNC_CONFIG_PATH, SYNC_CONFIG_PATH);
      } catch { /* best-effort migration */ }
    }
    const data = readJsonSafe<Partial<SyncConfig>>(SYNC_CONFIG_PATH, {});
    const normalizeList = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
    return {
      webdavUrl: data.webdavUrl || "",
      webdavUser: data.webdavUser || "",
      webdavPass: data.webdavPass || "",
      backupProviders: data.backupProviders !== false,
      backupSkills: data.backupSkills !== false,
      backupExtensions: data.backupExtensions !== false,
      backupSessions: data.backupSessions === true,
      sessionProjects: normalizeList(data.sessionProjects),
      liveSessionBackup: data.liveSessionBackup === true,
      liveBackupDebounceMs: typeof data.liveBackupDebounceMs === "number" && data.liveBackupDebounceMs > 0 ? data.liveBackupDebounceMs : 3000,
      syncIntervalTurns: typeof data.syncIntervalTurns === "number" && data.syncIntervalTurns >= 0 ? Math.floor(data.syncIntervalTurns) : 0,
      syncSessionOnExit: data.syncSessionOnExit !== false,
      backupMemory: data.backupMemory !== false,
      backupAgentSkills: data.backupAgentSkills !== false,
      sessionProjectMode: data.sessionProjectMode === "blacklist" ? "blacklist" : "whitelist",
      maxBackups: typeof data.maxBackups === "number" && data.maxBackups >= 0 ? data.maxBackups : 10,
    };
  }

  function saveConfig(config: SyncConfig) {
    ensureDir(path.dirname(SYNC_CONFIG_PATH));
    writeJsonAtomic(SYNC_CONFIG_PATH, config, { backup: true });
  }

  // Resolve password / token (supports environment variables starting with $)
  function resolvePassword(pass: string): string {
    if (pass.startsWith("$")) {
      const envVar = pass.slice(1);
      return process.env[envVar] ?? pass;
    }
    return pass;
  }

  // Thin wrapper: run tar via shared runCommand, preserving throw-on-error semantics
  async function runTar(args: string[], options: { capture?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const r = await runCommand("tar", args, { timeoutMs: options.timeoutMs ?? TAR_TIMEOUT_MS });
    if (!r.ok) throw new Error(r.stderr || `tar ${args[0]} failed with status ${r.status}`);
    return options.capture ? r.stdout : "";
  }

  function normalizeArchiveEntry(entry: string): string {
    return entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  }

  // ── Session project helpers ────────────────────────────────────────
  // Sessions live under ~/.pi/agent/sessions/<projectDir>/<timestamp-uuid>.jsonl
  // where <projectDir> encodes the project cwd as "--<path-with-slashes-as-dashes>--".

  const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

  /** List existing session project directory names on this machine. */
  function listSessionProjects(): string[] {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    return fs
      .readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name.startsWith("--") && name.endsWith("--"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }

  /** Best-effort conversion of a session dir name to a readable cwd path. */
  function sessionDirToPath(dirName: string): string {
    let s = dirName;
    if (s.startsWith("--")) s = s.slice(2);
    if (s.endsWith("--")) s = s.slice(0, -2);
    if (!s) return dirName;
    return "/" + s.replace(/-/g, "/");
  }

  async function listArchiveEntries(zipPath: string): Promise<string[]> {
    return (await runTar(["-t", "-f", zipPath], { capture: true }))
      .split(/\r?\n/)
      .map((line) => normalizeArchiveEntry(line.trim()))
      .filter((entry) => entry && entry !== ".");
  }

  function validateArchiveEntries(entries: string[]): void {
    const allowedTopLevel = new Set(["config", "skills", "extensions", "sessions", "memory", "agent-skills", "manifest.json"]);
    const legacyConfigFiles = new Set(["models.json", "settings.json", "auth.json"]);

    if (entries.length === 0) throw new Error("Backup archive is empty or unreadable");

    for (const entry of entries) {
      const pathParts = entry.split("/");
      if (entry.startsWith("/") || /^[a-zA-Z]:\//.test(entry) || pathParts.includes("..")) {
        throw new Error(`Unsafe archive path rejected: ${entry}`);
      }
      const [topLevel, secondPart, ...rest] = pathParts;
      if (!topLevel || !allowedTopLevel.has(topLevel)) {
        throw new Error(`Unexpected top-level archive entry rejected: ${entry}`);
      }
      if (topLevel !== "config" || !secondPart) continue;

      // New archives use config/root/*.json and config/sub/**. Legacy archives
      // used config/{models,settings,auth}.json directly.
      const rootMarkdownFiles = new Set(["SYSTEM.md", "AGENTS.md", "APPEND_SYSTEM.md"]);
      if (secondPart === "root") {
        const filename = rest.join("/");
        if (filename && (rest.length !== 1 || (!filename.endsWith(".json") && !rootMarkdownFiles.has(filename)))) {
          throw new Error(`Unexpected root config file rejected: ${entry}`);
        }
      } else if (secondPart === "sub") {
        // Traversal has already been rejected above. Nested config files are allowed.
        continue;
      } else if (!legacyConfigFiles.has(secondPart) || rest.length > 0) {
        throw new Error(`Unexpected config file rejected: ${entry}`);
      }
    }
  }

  function getRestorePlan(entries: string[], config: SyncConfig): string[] {
    const hasConfig = entries.some((entry) => entry === "config" || entry.startsWith("config/"));
    const hasSkills = entries.some((entry) => entry === "skills" || entry.startsWith("skills/"));
    const hasExtensions = entries.some((entry) => entry === "extensions" || entry.startsWith("extensions/"));
    const hasSessions = entries.some((entry) => entry === "sessions" || entry.startsWith("sessions/"));
    const hasMemory = entries.some((entry) => entry === "memory" || entry.startsWith("memory/"));
    const hasAgentSkills = entries.some((entry) => entry === "agent-skills" || entry.startsWith("agent-skills/"));
    const plan: string[] = [];

    if (hasConfig) {
      plan.push(config.backupProviders ? "Config files will be overwritten; current files get timestamped .bak copies." : "Config files are present but skipped by current settings.");
    }
    if (hasSkills) {
      plan.push(config.backupSkills ? "Skills directory will be replaced; current skills get a timestamped backup folder." : "Skills are present but skipped by current settings.");
    }
    if (hasExtensions) {
      plan.push(config.backupExtensions ? "Extensions will be merged/overwritten; current extensions get a timestamped backup folder." : "Extensions are present but skipped by current settings.");
    }
    if (hasSessions) {
      plan.push(config.backupSessions ? "Session projects will be merged into ~/.pi/agent/sessions/ (unique file names, no local data lost)." : "Sessions are present but skipped by current settings.");
    }
    if (hasMemory) {
      plan.push(config.backupMemory ? "Durable memory markdown files will be overwritten after timestamped backups are created." : "Memory files are present but skipped by current settings.");
    }
    if (hasAgentSkills) {
      plan.push(config.backupAgentSkills ? "~/.agents/skills will be replaced after the existing directory is moved to a timestamped backup." : "Shared agent skills are present but skipped by current settings.");
    }

    if (plan.length === 0) {
      plan.push("No restorable config, skills, extensions, sessions, memory, or shared agent skills found in this archive.");
    }

    return plan;
  }

  // ── File I/O — delegated to _shared/json-io ─────────────────────────

  // Fetch list of files from WebDAV using propfind
  async function listCloudBackups(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
    const pass = resolvePassword(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");
    
    // Ensure URL ends with /
    let url = config.webdavUrl;
    if (!url.endsWith("/")) {
      url += "/";
    }

    try {
      const response = await fetchWithTimeout(url, {
        method: "PROPFIND",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Depth": "1",
          "Content-Type": "application/xml",
        },
      }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);

      if (!response.ok) {
        throw new Error(`WebDAV returns HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      
      // Super lightweight XML parsing for file names containing "pi_sync_backup_"
      // Accept both new .tar.xz and legacy .zip backups.
      const isBackupName = (n: string) =>
        n.startsWith("pi_sync_backup_") && (n.endsWith(".tar.xz") || n.endsWith(".zip"));
      const backups: string[] = [];
      const regex = /<[a-zA-Z0-9:-]*displayname>([^<]+)<\/[a-zA-Z0-9:-]*displayname>/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const name = match[1].trim();
        if (isBackupName(name)) {
          backups.push(name);
        }
      }

      // Fallback: search URLs inside <d:href>
      if (backups.length === 0) {
        const hrefRegex = /<[a-zA-Z0-9:-]*href>([^<]+)<\/[a-zA-Z0-9:-]*href>/g;
        while ((match = hrefRegex.exec(text)) !== null) {
          const href = match[1].trim();
          const decodedHref = decodeURIComponent(href);
          const filename = path.basename(decodedHref);
          if (isBackupName(filename)) {
            if (!backups.includes(filename)) {
              backups.push(filename);
            }
          }
        }
      }

      return backups.sort().reverse(); // Show latest first
    } catch (e) {
      throw new Error(`Failed to query cloud backups: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Upload file to WebDAV
  async function uploadToWebdav(filePath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const filename = path.basename(filePath);
    const pass = resolvePassword(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");

    let url = config.webdavUrl;
    if (!url.endsWith("/")) {
      url += "/";
    }
    url += encodeURIComponent(filename);

    const fileBuffer = fs.readFileSync(filePath);

    const response = await fetchWithTimeout(url, {
      method: "PUT",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/octet-stream",
      },
      body: fileBuffer,
    }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV PUT returns HTTP ${response.status}: ${response.statusText}`);
    }
  }

  // Delete a file from WebDAV (used for backup retention / prune)
  async function deleteFromWebdav(filename: string, config: SyncConfig, ctx: ExtensionContext) {
    const pass = resolvePassword(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");
    let url = config.webdavUrl;
    if (!url.endsWith("/")) url += "/";
    url += encodeURIComponent(filename);
    const response = await fetchWithTimeout(url, {
      method: "DELETE",
      headers: { Authorization: auth },
    }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
    // 204 deleted, 404 already gone — both OK
    if (!response.ok && response.status !== 404) {
      throw new Error(`WebDAV DELETE HTTP ${response.status}: ${response.statusText}`);
    }
  }

  /** Prune old cloud backups, keeping only the newest maxBackups (0 = keep all). Returns deleted names. */
  async function pruneOldBackups(config: SyncConfig, ctx: ExtensionContext): Promise<string[]> {
    if (config.maxBackups <= 0) return [];
    const backups = await listCloudBackups(config, ctx as ExtensionCommandContext);
    // listCloudBackups returns newest-first (reverse sorted). Keep the first maxBackups, delete the rest.
    if (backups.length <= config.maxBackups) return [];
    const toDelete = backups.slice(config.maxBackups);
    for (const name of toDelete) {
      try { await deleteFromWebdav(name, config, ctx); } catch { /* best-effort, continue */ }
    }
    return toDelete;
  }

  const WEBDAV_CONFIG_DIR = "config/";
  const WEBDAV_MEMORY_DIR = "memory/";
  const WEBDAV_AGENT_SKILLS_DIR = "agent-skills/";
  const WEBDAV_SESSIONS_DIR = "sessions/";

  function webdavDirBase(config: SyncConfig, remoteDir: string): string {
    return ensureTrailingSlash(config.webdavUrl) + remoteDir.replace(/^\/+/, "");
  }

  async function ensureWebdavDirectory(remoteDir: string, config: SyncConfig, ctx: ExtensionContext): Promise<string> {
    const auth = webdavAuth(config);
    let current = ensureTrailingSlash(config.webdavUrl);
    const segments = remoteDir.split("/").filter(Boolean);
    for (const segment of segments) {
      current += `${encodeURIComponent(segment)}/`;
      await webdavMkcol(current, auth, ctx);
    }
    return current;
  }

  async function listWebdavDir(remoteDir: string, config: SyncConfig, ctx: ExtensionContext): Promise<string[]> {
    const base = webdavDirBase(config, remoteDir);
    try {
      return await webdavList(base, webdavAuth(config), ctx);
    } catch (error) {
      if (error instanceof Error && /HTTP 404/.test(error.message)) return [];
      throw error;
    }
  }

  async function uploadToWebdavDir(localPath: string, remoteDir: string, remoteName: string, config: SyncConfig, ctx: ExtensionContext): Promise<void> {
    const base = await ensureWebdavDirectory(remoteDir, config, ctx);
    await webdavPutFile(localPath, base + encodeURIComponent(remoteName), webdavAuth(config), ctx);
  }

  async function downloadFromWebdavDir(remoteName: string, remoteDir: string, destPath: string, config: SyncConfig, ctx: ExtensionContext): Promise<void> {
    await webdavGetFile(webdavDirBase(config, remoteDir) + encodeURIComponent(remoteName), destPath, webdavAuth(config), ctx);
  }

  async function deleteFromWebdavDir(remoteName: string, remoteDir: string, config: SyncConfig, ctx: ExtensionContext): Promise<void> {
    const response = await fetchWithTimeout(webdavDirBase(config, remoteDir) + encodeURIComponent(remoteName), {
      method: "DELETE",
      headers: { Authorization: webdavAuth(config) },
    }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
    if (!response.ok && response.status !== 404) {
      throw new Error(`WebDAV DELETE HTTP ${response.status}: ${response.statusText}`);
    }
  }

  async function pruneOldBackupsInDir(config: SyncConfig, ctx: ExtensionContext, remoteDir: string, prefix: string): Promise<string[]> {
    if (config.maxBackups <= 0) return [];
    const names = (await listWebdavDir(remoteDir, config, ctx))
      .filter((name) => name.startsWith(prefix) && (name.endsWith(".tar.xz") || name.endsWith(".zip")))
      .sort()
      .reverse();
    const toDelete = names.slice(config.maxBackups);
    for (const name of toDelete) {
      try { await deleteFromWebdavDir(name, remoteDir, config, ctx); } catch { /* best effort */ }
    }
    return toDelete;
  }

  // Download file from WebDAV
  async function downloadFromWebdav(filename: string, destPath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const pass = resolvePassword(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");

    let url = config.webdavUrl;
    if (!url.endsWith("/")) {
      url += "/";
    }
    url += encodeURIComponent(filename);

    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${auth}`,
      },
    }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV GET returns HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  }

  // Create tar.xz Archive
  async function createZip(config: SyncConfig, tempArchivePath: string): Promise<string[]> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const tempDir = path.join(os.tmpdir(), `pi_sync_temp_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const contents: string[] = [];
    // manifest records every archived file with its source path relative to
    // ~/.pi/agent/, so restores and audits can trace where each file came
    // from and the manifest stays portable across machines.
    const manifestFiles: Array<{ archive: string; source: string }> = [];

    /** Recursively collect files under `dir` into manifestFiles. */
    function collectManifest(dir: string, archivePrefix: string, sourcePrefix: string): void {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = archivePrefix ? `${archivePrefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          collectManifest(full, rel, `${sourcePrefix}/${entry.name}`);
        } else {
          manifestFiles.push({ archive: rel, source: `${sourcePrefix}/${entry.name}` });
        }
      }
    }

    try {
      // 1. Providers / Configuration (models.json, settings.json, auth.json)
      if (config.backupProviders) {
        const filesToBackup = ["models.json", "settings.json", "auth.json"];
        const confDir = path.join(tempDir, "config");
        fs.mkdirSync(confDir, { recursive: true });
        for (const file of filesToBackup) {
          const src = path.join(agentDir, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(confDir, file));
            manifestFiles.push({ archive: `config/${file}`, source: file });
            contents.push(`Config: ${file}`);
          }
        }
      }

      // 2. Skills (copy entire folder except backups if any)
      if (config.backupSkills) {
        const skillsSrc = path.join(agentDir, "skills");
        if (fs.existsSync(skillsSrc)) {
          const skillsDest = path.join(tempDir, "skills");
          fs.mkdirSync(skillsDest, { recursive: true });
          copyRecursiveSync(skillsSrc, skillsDest);
          await yieldToUI();
          collectManifest(skillsDest, "skills", "skills");
          contents.push(`Skills Directory`);
        }
      }

      // 3. Extensions (copy entire folder, ignoring specific ones if we want, but let's copy all user extensions except sync itself to prevent self-conflict)
      if (config.backupExtensions) {
        const extSrc = path.join(agentDir, "extensions");
        if (fs.existsSync(extSrc)) {
          const extDest = path.join(tempDir, "extensions");
          fs.mkdirSync(extDest, { recursive: true });
          copyRecursiveSync(extSrc, extDest);
          await yieldToUI();
          
          // Delete sync plugin from the backup directory to avoid overwriting current running files directly in nasty ways
          const syncInBackup = path.join(extDest, "sync");
          if (fs.existsSync(syncInBackup)) {
            fs.rmSync(syncInBackup, { recursive: true, force: true });
          }
          collectManifest(extDest, "extensions", "extensions");
          contents.push(`Extensions Directory`);
        }
      }

      // 4. Sessions
      //    sessionProjects empty  → back up ALL project directories (default: all)
      //    sessionProjects non-empty → back up only the listed project directories
      if (config.backupSessions) {
        const sessionsSrc = path.join(agentDir, "sessions");
        const wanted = new Set(config.sessionProjects);
        const selectAll = wanted.size === 0;
        if (fs.existsSync(sessionsSrc)) {
          let added = 0;
          for (const projDir of fs.readdirSync(sessionsSrc, { withFileTypes: true })) {
            if (!projDir.isDirectory()) continue;
            if (!selectAll && !wanted.has(projDir.name)) continue;
            const src = path.join(sessionsSrc, projDir.name);
            const dest = path.join(tempDir, "sessions", projDir.name);
            fs.mkdirSync(dest, { recursive: true });
            copyRecursiveSync(src, dest);
            added++;
          }
          if (added > 0) {
            await yieldToUI();
            collectManifest(path.join(tempDir, "sessions"), "sessions", "sessions");
            const scope = selectAll ? "all" : `${added} selected`;
            contents.push(`Sessions (${scope} project${added === 1 ? "" : "s"})`);
          }
        }
      }

      if (contents.length === 0) {
        throw new Error("No components selected or found to backup!");
      }

      // Write manifest.json at archive root: documents every file's archive path
      // and its original source path (relative to ~/.pi/agent/) on this machine.
      const manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        agentDir,
        fileCount: manifestFiles.length,
        files: manifestFiles,
      };
      fs.writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      contents.push(`Manifest: manifest.json (${manifestFiles.length} entries)`);

      // Pack the temp directory as tar.xz. xz gives ~20x compression on jsonl sessions
      // (vs tar's zip backend which stores uncompressed). tar auto-detects format on -x.
      // 'tar -Jcf archive.tar.xz -C <dir> .' — -J selects xz, universally available on
      // modern Linux/macOS/Windows(bsdtar).
      await yieldToUI();
      await runTar(["-J", "-c", "-f", tempArchivePath, "-C", tempDir, "."]);

      return contents;
    } finally {
      // Clean up temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // Extract Zip Archive and Overwrite
  async function extractZip(zipPath: string, config: SyncConfig): Promise<string[]> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const tempDir = path.join(os.tmpdir(), `pi_sync_extract_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const restored: string[] = [];

    try {
      // Inspect and safety-check before extracting to a temporary folder.
      const entries = await listArchiveEntries(zipPath);
      validateArchiveEntries(entries);
      await runTar(["-x", "-f", zipPath, "-C", tempDir]);

      // 1. Restore Config
      const configSrc = path.join(tempDir, "config");
      if (fs.existsSync(configSrc) && config.backupProviders) {
        const files = fs.readdirSync(configSrc);
        for (const file of files) {
          const srcFile = path.join(configSrc, file);
          const destFile = path.join(agentDir, file);
          
          // Backup existing local file before overwriting.
          if (fs.existsSync(destFile)) {
            fs.copyFileSync(destFile, `${destFile}.bak-${timestampForBackup()}`);
          }
          fs.copyFileSync(srcFile, destFile);
          restored.push(`Config: ${file} (restored, old file saved as timestamped .bak)`);
        }
      }

      // 2. Restore Skills
      const skillsSrc = path.join(tempDir, "skills");
      if (fs.existsSync(skillsSrc) && config.backupSkills) {
        const skillsDest = path.join(agentDir, "skills");
        
        // Safety: Backup existing skills directory without deleting previous backups.
        const skillsBackup = path.join(agentDir, `skills-backup-${timestampForBackup()}`);
        if (fs.existsSync(skillsDest)) {
          fs.renameSync(skillsDest, skillsBackup);
        }
        
        fs.mkdirSync(skillsDest, { recursive: true });
        copyRecursiveSync(skillsSrc, skillsDest);
        await yieldToUI();
        restored.push(`Skills (restored, old skills backed up to ${path.basename(skillsBackup)})`);
      }

      // 3. Restore Extensions
      const extSrc = path.join(tempDir, "extensions");
      if (fs.existsSync(extSrc) && config.backupExtensions) {
        const extDest = path.join(agentDir, "extensions");

        // Backup existing extensions folder without deleting previous backups.
        const extBackup = path.join(agentDir, `extensions-backup-${timestampForBackup()}`);
        if (fs.existsSync(extDest)) {
          // Instead of renaming the whole folder which would destroy the currently running sync plugin itself,
          // we merge/overwrite files but backup existing files.
          // Create a timestamped extensions-backup folder, copy existing to it, then overwrite.
          fs.mkdirSync(extBackup, { recursive: true });
          copyRecursiveSync(extDest, extBackup);
        }

        // Copy new extensions over.
        // We do recursive merge. The currently running sync plugin is NOT in the temp extracted folder because we filtered it during backup.
        // So the sync plugin itself is safe!
        copyRecursiveSync(extSrc, extDest);
        await yieldToUI();
        restored.push(`Extensions (restored, old extensions backed up to ${path.basename(extBackup)})`);
      }

      // 4. Restore Sessions (merge per project; session files have unique names)
      const sessionsSrc = path.join(tempDir, "sessions");
      if (fs.existsSync(sessionsSrc) && config.backupSessions) {
        const sessionsDest = path.join(agentDir, "sessions");
        fs.mkdirSync(sessionsDest, { recursive: true });
        let mergedProjects = 0;
        let mergedFiles = 0;
        for (const projEntry of fs.readdirSync(sessionsSrc, { withFileTypes: true })) {
          if (!projEntry.isDirectory()) continue;
          const srcProj = path.join(sessionsSrc, projEntry.name);
          const destProj = path.join(sessionsDest, projEntry.name);
          fs.mkdirSync(destProj, { recursive: true });
          // Merge: copy each file; unique timestamped names mean collisions are essentially impossible.
          for (const f of fs.readdirSync(srcProj, { withFileTypes: true })) {
            const srcFile = path.join(srcProj, f.name);
            const destFile = path.join(destProj, f.name);
            if (f.isDirectory()) {
              copyRecursiveSync(srcFile, destFile);
            } else {
              fs.copyFileSync(srcFile, destFile);
            }
            mergedFiles++;
          }
          mergedProjects++;
        }
        await yieldToUI();
        if (mergedProjects > 0) {
          restored.push(`Sessions: ${mergedProjects} project(s), ${mergedFiles} file(s) merged into ~/.pi/agent/sessions/`);
        }
      }

      return restored;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // Recursive copy helper
  function copyRecursiveSync(src: string, dest: string) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats && stats.isDirectory();
    if (isDirectory) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src).forEach((childItemName) => {
        copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
      });
    } else {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
    }
  }

  function copyRecursiveSyncFiltered(src: string, dest: string, include: (name: string, isDirectory: boolean) => boolean): void {
    if (!fs.existsSync(src)) return;
    const stats = fs.statSync(src);
    if (!include(path.basename(src), stats.isDirectory())) return;
    if (stats.isDirectory()) {
      ensureDir(dest);
      for (const name of fs.readdirSync(src)) {
        copyRecursiveSyncFiltered(path.join(src, name), path.join(dest, name), include);
      }
    } else {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
    }
  }

  type ManifestFile = { archive: string; source: string };

  function collectManifest(dir: string, archivePrefix: string, sourcePrefix: string, files: ManifestFile[]): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const archivePath = `${archivePrefix}/${entry.name}`;
      const sourcePath = sourcePrefix ? `${sourcePrefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectManifest(full, archivePath, sourcePath, files);
      else files.push({ archive: archivePath, source: sourcePath });
    }
  }

  function writeManifest(tempDir: string, agentDir: string, files: ManifestFile[]): void {
    fs.writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      agentDir,
      fileCount: files.length,
      files,
    }, null, 2), "utf8");
  }

  function archiveTimestamp(): string {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  async function packTemporaryArchive(tempDir: string, archivePath: string): Promise<void> {
    await yieldToUI();
    await runTar(["-J", "-c", "-f", archivePath, "-C", tempDir, "."]);
  }

  async function createConfigZip(config: SyncConfig, archivePath: string): Promise<string[]> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const tempDir = path.join(os.tmpdir(), `pi_config_temp_${Date.now()}`);
    const manifest: ManifestFile[] = [];
    const contents: string[] = [];
    ensureDir(path.join(tempDir, "config", "root"));
    ensureDir(path.join(tempDir, "config", "sub"));
    try {
      if (config.backupProviders) {
        for (const name of fs.readdirSync(agentDir)) {
          const src = path.join(agentDir, name);
          if (!name.endsWith(".json") || !fs.statSync(src).isFile()) continue;
          fs.copyFileSync(src, path.join(tempDir, "config", "root", name));
          manifest.push({ archive: `config/root/${name}`, source: name });
          contents.push(`Config: ${name}`);
        }
        // Agent-level markdown files (SYSTEM.md / AGENTS.md / APPEND_SYSTEM.md) if present
        for (const mdName of ["SYSTEM.md", "AGENTS.md", "APPEND_SYSTEM.md"]) {
          const mdSrc = path.join(agentDir, mdName);
          if (!fs.existsSync(mdSrc) || !fs.statSync(mdSrc).isFile()) continue;
          fs.copyFileSync(mdSrc, path.join(tempDir, "config", "root", mdName));
          manifest.push({ archive: `config/root/${mdName}`, source: mdName });
          contents.push(`Config: ${mdName}`);
        }
        const configDir = path.join(agentDir, "config");
        if (fs.existsSync(configDir)) {
          copyRecursiveSync(configDir, path.join(tempDir, "config", "sub"));
          collectManifest(path.join(tempDir, "config", "sub"), "config/sub", "config", manifest);
          contents.push("Config directory");
        }
      }
      if (config.backupExtensions) {
        const source = path.join(agentDir, "extensions");
        const dest = path.join(tempDir, "extensions");
        if (fs.existsSync(source)) {
          copyRecursiveSync(source, dest);
          fs.rmSync(path.join(dest, "sync"), { recursive: true, force: true });
          collectManifest(dest, "extensions", "extensions", manifest);
          contents.push("Extensions directory");
        }
      }
      if (manifest.length === 0) throw new Error("No config or extension files found to back up.");
      writeManifest(tempDir, agentDir, manifest);
      await packTemporaryArchive(tempDir, archivePath);
      return contents;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function createMemoryZip(archivePath: string): Promise<string[]> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const sourceDir = path.join(agentDir, "pi-hermes-memory");
    const tempDir = path.join(os.tmpdir(), `pi_memory_temp_${Date.now()}`);
    const destDir = path.join(tempDir, "memory");
    const manifest: ManifestFile[] = [];
    ensureDir(destDir);
    try {
      for (const name of ["USER.md", "MEMORY.md", "failures.md"]) {
        const src = path.join(sourceDir, name);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(destDir, name));
        manifest.push({ archive: `memory/${name}`, source: `pi-hermes-memory/${name}` });
      }
      if (manifest.length === 0) throw new Error("No durable pi-hermes-memory markdown files found.");
      writeManifest(tempDir, agentDir, manifest);
      await packTemporaryArchive(tempDir, archivePath);
      return manifest.map((item) => `Memory: ${path.basename(item.source)}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function createAgentSkillsZip(archivePath: string): Promise<string[]> {
    const sourceDir = path.join(os.homedir(), ".agents", "skills");
    if (!fs.existsSync(sourceDir)) throw new Error("~/.agents/skills does not exist.");
    const tempDir = path.join(os.tmpdir(), `pi_agent_skills_temp_${Date.now()}`);
    const destDir = path.join(tempDir, "agent-skills");
    const manifest: ManifestFile[] = [];
    try {
      copyRecursiveSyncFiltered(sourceDir, destDir, (name, isDirectory) => isDirectory ? name !== "__pycache__" : !name.endsWith(".pyc"));
      collectManifest(destDir, "agent-skills", ".agents/skills", manifest);
      if (manifest.length === 0) throw new Error("No shared agent skill files found.");
      writeManifest(tempDir, os.homedir(), manifest);
      await packTemporaryArchive(tempDir, archivePath);
      return [`Shared agent skills: ${manifest.length} file(s)`];
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function createSessionsArchiveZip(projectDir: string, archivePath: string): Promise<string[]> {
    const sourceDir = path.join(SESSIONS_DIR, projectDir);
    if (!fs.existsSync(sourceDir)) throw new Error(`Session project not found: ${projectDir}`);
    const tempDir = path.join(os.tmpdir(), `pi_sessions_temp_${Date.now()}`);
    const destDir = path.join(tempDir, "sessions", projectDir);
    const manifest: ManifestFile[] = [];
    try {
      copyRecursiveSync(sourceDir, destDir);
      collectManifest(destDir, `sessions/${projectDir}`, `sessions/${projectDir}`, manifest);
      if (manifest.length === 0) throw new Error(`No session files found for ${projectDir}.`);
      writeManifest(tempDir, path.join(os.homedir(), ".pi", "agent"), manifest);
      await packTemporaryArchive(tempDir, archivePath);
      return [`Sessions: ${sessionDirToPath(projectDir)} (${manifest.length} file(s))`];
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function extractConfigZip(archivePath: string, config: SyncConfig): Promise<string[]> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const tempDir = path.join(os.tmpdir(), `pi_config_extract_${Date.now()}`);
    const restored: string[] = [];
    ensureDir(tempDir);
    try {
      const entries = await listArchiveEntries(archivePath);
      validateArchiveEntries(entries);
      await runTar(["-x", "-f", archivePath, "-C", tempDir]);
      const rootDir = path.join(tempDir, "config", "root");
      if (config.backupProviders && fs.existsSync(rootDir)) {
        for (const name of fs.readdirSync(rootDir)) {
          const src = path.join(rootDir, name);
          if (!fs.statSync(src).isFile()) continue;
          const dest = path.join(agentDir, name);
          if (fs.existsSync(dest)) fs.copyFileSync(dest, `${dest}.bak-${timestampForBackup()}`);
          fs.copyFileSync(src, dest);
          restored.push(`Config: ${name}`);
        }
      }
      const subDir = path.join(tempDir, "config", "sub");
      if (config.backupProviders && fs.existsSync(subDir)) {
        const dest = path.join(agentDir, "config");
        const backup = path.join(agentDir, `config-backup-${timestampForBackup()}`);
        if (fs.existsSync(dest)) copyRecursiveSync(dest, backup);
        copyRecursiveSync(subDir, dest);
        restored.push("Config directory");
      }
      const extDir = path.join(tempDir, "extensions");
      if (config.backupExtensions && fs.existsSync(extDir)) {
        const dest = path.join(agentDir, "extensions");
        const backup = path.join(agentDir, `extensions-backup-${timestampForBackup()}`);
        if (fs.existsSync(dest)) copyRecursiveSync(dest, backup);
        copyRecursiveSync(extDir, dest);
        restored.push("Extensions");
      }
      return restored;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function extractMemoryZip(archivePath: string): Promise<string[]> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const tempDir = path.join(os.tmpdir(), `pi_memory_extract_${Date.now()}`);
    const restored: string[] = [];
    ensureDir(tempDir);
    try {
      const entries = await listArchiveEntries(archivePath);
      validateArchiveEntries(entries);
      await runTar(["-x", "-f", archivePath, "-C", tempDir]);
      const sourceDir = path.join(tempDir, "memory");
      const destDir = path.join(agentDir, "pi-hermes-memory");
      ensureDir(destDir);
      for (const name of ["USER.md", "MEMORY.md", "failures.md"]) {
        const src = path.join(sourceDir, name);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(destDir, name);
        if (fs.existsSync(dest)) fs.copyFileSync(dest, `${dest}.bak-${timestampForBackup()}`);
        fs.copyFileSync(src, dest);
        restored.push(`Memory: ${name}`);
      }
      return restored;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function extractAgentSkillsZip(archivePath: string): Promise<string[]> {
    const tempDir = path.join(os.tmpdir(), `pi_agent_skills_extract_${Date.now()}`);
    ensureDir(tempDir);
    try {
      const entries = await listArchiveEntries(archivePath);
      validateArchiveEntries(entries);
      await runTar(["-x", "-f", archivePath, "-C", tempDir]);
      const sourceDir = path.join(tempDir, "agent-skills");
      if (!fs.existsSync(sourceDir)) throw new Error("Archive does not contain agent-skills/.");
      const destDir = path.join(os.homedir(), ".agents", "skills");
      const backupDir = path.join(os.homedir(), ".agents", `skills-backup-${timestampForBackup()}`);
      if (fs.existsSync(destDir)) fs.renameSync(destDir, backupDir);
      ensureDir(destDir);
      copyRecursiveSync(sourceDir, destDir);
      return [`Shared agent skills (previous directory: ${path.basename(backupDir)})`];
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function extractSessionsArchiveZip(archivePath: string): Promise<string[]> {
    const tempDir = path.join(os.tmpdir(), `pi_sessions_extract_${Date.now()}`);
    ensureDir(tempDir);
    try {
      const entries = await listArchiveEntries(archivePath);
      validateArchiveEntries(entries);
      await runTar(["-x", "-f", archivePath, "-C", tempDir]);
      const source = path.join(tempDir, "sessions");
      if (!fs.existsSync(source)) throw new Error("Archive does not contain sessions/.");
      copyRecursiveSync(source, SESSIONS_DIR);
      return ["Session archive merged into ~/.pi/agent/sessions/"];
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // ── Session sync helpers (real-time backup / restore / fork) ───────────
  //
  // Remote layout mirrors local:
  //   <webdavUrl>/sessions/<projectDir>/<timestamp_uuid>.jsonl
  //
  // Real-time backup uploads a single .jsonl after each agent turn (debounced).
  // Restore merges remote files into the matching local project dir (unique names → no overwrite).
  // Fork downloads a remote session and uses SessionManager.forkFrom to bring it into the
  // *current* project (handles cross-path / cross-machine continuation).

  /** Current session file path + project dir, captured at session_start. */
  let currentSessionFile: string | undefined;
  let currentProjectDir: string | undefined;
  let liveBackupTimer: ReturnType<typeof setTimeout> | undefined;
  let turnCounter = 0;

  function isProjectAllowed(projectDir: string | undefined, config: SyncConfig): boolean {
    if (!projectDir) return false;
    if (config.sessionProjects.length === 0) return true;
    const listed = config.sessionProjects.includes(projectDir);
    return config.sessionProjectMode === "blacklist" ? !listed : listed;
  }

  function projectDirFromCwd(cwd: string): string {
    // pi encodes cwd as "--" + cwd.replace(/\//g, "-") + "--"
    return "--" + cwd.replace(/\//g, "-") + "--";
  }

  function ensureTrailingSlash(url: string): string {
    return url.endsWith("/") ? url : url + "/";
  }

  function configWebdavBase(config: SyncConfig): string {
    return webdavDirBase(config, WEBDAV_CONFIG_DIR);
  }

  function memoryWebdavBase(config: SyncConfig): string {
    return webdavDirBase(config, WEBDAV_MEMORY_DIR);
  }

  function agentSkillsWebdavBase(config: SyncConfig): string {
    return webdavDirBase(config, WEBDAV_AGENT_SKILLS_DIR);
  }

  function sessionsWebdavBase(config: SyncConfig): string {
    return webdavDirBase(config, WEBDAV_SESSIONS_DIR);
  }

  function webdavAuth(config: SyncConfig): string {
    const pass = resolvePassword(config.webdavPass);
    return "Basic " + Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");
  }

  /** PROPFIND a WebDAV collection, return child displayname or href-derived names. */
  async function webdavList(url: string, auth: string, ctx: ExtensionContext, filter?: (name: string) => boolean): Promise<string[]> {
    const response = await fetchWithTimeout(url, {
      method: "PROPFIND",
      headers: { Authorization: auth, Depth: "1", "Content-Type": "application/xml" },
    }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
    if (!response.ok) throw new Error(`WebDAV PROPFIND HTTP ${response.status}: ${response.statusText}`);
    const text = await response.text();
    const names = new Set<string>();
    let m: RegExpExecArray | null;
    const dn = /<[a-zA-Z0-9:-]*displayname>([^<]+)<\/[a-zA-Z0-9:-]*displayname>/g;
    while ((m = dn.exec(text)) !== null) {
      const n = m[1]!.trim();
      if (n && n !== "sessions") names.add(n);
    }
    if (names.size === 0) {
      const hr = /<[a-zA-Z0-9:-]*href>([^<]+)<\/[a-zA-Z0-9:-]*href>/g;
      while ((m = hr.exec(text)) !== null) {
        const name = path.basename(decodeURIComponent(m[1]!.trim()));
        if (name && name !== "sessions") names.add(name);
      }
    }
    let arr = [...names];
    if (filter) arr = arr.filter(filter);
    return arr.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }

  async function webdavPutFile(localPath: string, remoteUrl: string, auth: string, ctx: ExtensionContext) {
    const buf = fs.readFileSync(localPath);
    const response = await fetchWithTimeout(remoteUrl, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/octet-stream" },
      body: buf,
    }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
    if (!response.ok) throw new Error(`WebDAV PUT HTTP ${response.status}: ${response.statusText}`);
  }

  async function webdavGetFile(remoteUrl: string, destPath: string, auth: string, ctx: ExtensionContext) {
    const response = await fetchWithTimeout(remoteUrl, {
      method: "GET",
      headers: { Authorization: auth },
    }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
    if (!response.ok) throw new Error(`WebDAV GET HTTP ${response.status}: ${response.statusText}`);
    fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()));
  }

  /** Ensure a WebDAV collection exists (MKCOL, ignore 405/409 = already exists). */
  async function webdavMkcol(url: string, auth: string, ctx: ExtensionContext) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "MKCOL",
        headers: { Authorization: auth },
      }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
      // 201 created, 405 method not allowed (exists), 409 conflict (parent missing) — treat 405 as ok
      if (!response.ok && response.status !== 405) {
        throw new Error(`WebDAV MKCOL HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (e) {
      // Best-effort: ignore collection-exists errors
      if (e instanceof Error && !/405/.test(e.message)) throw e;
    }
  }

  function extractSessionTs(filename: string): string | null {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_/);
    return match?.[1] ?? null;
  }

  async function updateLatestMarker(ctx: ExtensionContext, config: SyncConfig, projectDir: string, sessionFile: string): Promise<void> {
    const filename = path.basename(sessionFile);
    const sessionTs = extractSessionTs(filename);
    if (!sessionTs) return;
    const base = sessionsWebdavBase(config) + encodeURIComponent(projectDir) + "/";
    const markerUrl = base + "_latest.json";
    const auth = webdavAuth(config);
    let remoteTs: string | undefined;
    const tempRead = path.join(os.tmpdir(), `pi_latest_read_${process.pid}_${Date.now()}.json`);
    try {
      await webdavGetFile(markerUrl, tempRead, auth, ctx);
      remoteTs = readJsonSafe<{ sessionTs?: string }>(tempRead, {}).sessionTs;
    } catch (error) {
      if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error;
    } finally {
      fs.rmSync(tempRead, { force: true });
    }
    if (remoteTs && remoteTs >= sessionTs) return;
    const tempWrite = path.join(os.tmpdir(), `pi_latest_write_${process.pid}_${Date.now()}.json`);
    try {
      fs.writeFileSync(tempWrite, JSON.stringify({
        file: filename,
        sessionTs,
        machine: os.hostname(),
        uploadedAt: new Date().toISOString(),
      }, null, 2));
      await webdavPutFile(tempWrite, markerUrl, auth, ctx);
    } finally {
      fs.rmSync(tempWrite, { force: true });
    }
  }

  /** Upload the current session file (single .jsonl) to the cloud. */
  async function uploadCurrentSession(ctx: ExtensionContext, silent = false): Promise<boolean> {
    const config = loadConfig();
    if (!currentSessionFile || !currentProjectDir) {
      if (!silent) ctx.ui.notify("No active session file to upload.", "warning");
      return false;
    }
    if (!isProjectAllowed(currentProjectDir, config)) return false;
    if (!fs.existsSync(currentSessionFile)) {
      if (!silent) ctx.ui.notify(`Session file missing: ${currentSessionFile}`, "warning");
      return false;
    }
    try {
      const base = sessionsWebdavBase(config);
      const auth = webdavAuth(config);
      await ensureWebdavDirectory(WEBDAV_SESSIONS_DIR, config, ctx);
      await ensureWebdavDirectory(`${WEBDAV_SESSIONS_DIR}${currentProjectDir}/`, config, ctx);
      const remote = base + encodeURIComponent(currentProjectDir) + "/" + encodeURIComponent(path.basename(currentSessionFile));
      await webdavPutFile(currentSessionFile, remote, auth, ctx);
      await updateLatestMarker(ctx, config, currentProjectDir, currentSessionFile);
      if (!silent) ctx.ui.notify(`☁️  Session uploaded: ${path.basename(currentSessionFile)}`, "info");
      return true;
    } catch (e) {
      if (!silent) ctx.ui.notify(`❌ Session upload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      return false;
    }
  }

  /** Debounced live backup, triggered by agent_settled. */
  function scheduleLiveBackup(ctx: ExtensionContext) {
    const config = loadConfig();
    if (!config.liveSessionBackup) return;
    if (liveBackupTimer) clearTimeout(liveBackupTimer);
    liveBackupTimer = setTimeout(() => {
      liveBackupTimer = undefined;
      // fire-and-forget; use a throwaway ctx-like signal-free call
      uploadCurrentSession(ctx, true).catch(() => { /* silent */ });
    }, config.liveBackupDebounceMs);
  }

  async function showRestoreLatest(ctx: ExtensionCommandContext): Promise<void> {
    const config = loadConfig();
    const base = sessionsWebdavBase(config);
    const auth = webdavAuth(config);
    try {
      const projectDirs = await webdavList(base, auth, ctx, (name) => name.startsWith("--") && name.endsWith("--"));
      if (projectDirs.length === 0) {
        ctx.ui.notify("No remote session projects found.", "warning");
        return;
      }
      const projectDir = await enhancedSelect(ctx, "Restore latest: select project", [...projectDirs, "❌ Cancel"], { fuzzy: true });
      if (!projectDir || projectDir.includes("Cancel")) return;
      const markerPath = path.join(os.tmpdir(), `pi_latest_${Date.now()}.json`);
      try {
        await webdavGetFile(base + encodeURIComponent(projectDir) + "/_latest.json", markerPath, auth, ctx);
        const marker = readJsonSafe<{ file?: string }>(markerPath, {});
        if (!marker.file || !marker.file.endsWith(".jsonl") || path.basename(marker.file) !== marker.file) {
          throw new Error("Remote _latest.json does not contain a safe session filename.");
        }
        const localDir = path.join(SESSIONS_DIR, projectDir);
        ensureDir(localDir);
        const localPath = path.join(localDir, marker.file);
        await webdavGetFile(base + encodeURIComponent(projectDir) + "/" + encodeURIComponent(marker.file), localPath, auth, ctx);
        ctx.ui.notify(`🎉 Restored latest session into ${localPath}\nUse /resume to continue.`, "info");
      } finally {
        fs.rmSync(markerPath, { force: true });
      }
    } catch (error) {
      ctx.ui.notify(`❌ Restore latest failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  /** Restore: merge remote session files into local ~/.pi/agent/sessions/<projectDir>/. */
  async function showRestoreSessions(ctx: ExtensionCommandContext): Promise<void> {
    const config = loadConfig();
    const base = sessionsWebdavBase(config);
    const auth = webdavAuth(config);
    ctx.ui.notify("Listing remote session projects...", "info");
    try {
      const projectDirs = await webdavList(base, auth, ctx, (n) => n.startsWith("--") && n.endsWith("--"));
      if (projectDirs.length === 0) {
        ctx.ui.notify("No remote session projects found under sessions/.", "warning");
        return;
      }
      const projChoice = await enhancedSelect(ctx, "Select remote project to restore", [...projectDirs, "❌ Cancel"], { fuzzy: true });
      if (!projChoice || projChoice.includes("Cancel")) return;

      ctx.ui.notify(`Listing sessions in ${projChoice}...`, "info");
      const files = await webdavList(base + projChoice + "/", auth, ctx, (n) => n.endsWith(".jsonl"));
      if (files.length === 0) {
        ctx.ui.notify(`No .jsonl files in ${projChoice}.`, "warning");
        return;
      }
      const fileChoice = await enhancedSelect(ctx, `Restore from ${projChoice} (${files.length} files)`, [...files, "═══════════════", "a Restore ALL into local project dir", "❌ Cancel"], { fuzzy: true });
      if (!fileChoice || fileChoice.includes("Cancel")) return;

      const targets = fileChoice.startsWith("a Restore ALL") ? files : [fileChoice];
      const localDir = path.join(SESSIONS_DIR, projChoice);
      fs.mkdirSync(localDir, { recursive: true });
      let done = 0;
      for (const f of targets) {
        const remote = base + projChoice + "/" + encodeURIComponent(f);
        const localPath = path.join(localDir, f);
        await webdavGetFile(remote, localPath, auth, ctx);
        done++;
      }
      ctx.ui.notify(`🎉 Restored ${done} session(s) into ${localDir}\nUse /resume in that project to continue.`, "info");
    } catch (e) {
      ctx.ui.notify(`❌ Restore failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  /** Fork: download a remote session and forkFrom into the *current* project. */
  async function showForkSession(ctx: ExtensionCommandContext): Promise<void> {
    const config = loadConfig();
    const base = sessionsWebdavBase(config);
    const auth = webdavAuth(config);
    ctx.ui.notify("Listing remote session projects...", "info");
    try {
      const projectDirs = await webdavList(base, auth, ctx, (n) => n.startsWith("--") && n.endsWith("--"));
      if (projectDirs.length === 0) {
        ctx.ui.notify("No remote session projects found under sessions/.", "warning");
        return;
      }
      const projChoice = await enhancedSelect(ctx, "Fork: select source project", [...projectDirs, "❌ Cancel"], { fuzzy: true });
      if (!projChoice || projChoice.includes("Cancel")) return;

      ctx.ui.notify(`Listing sessions in ${projChoice}...`, "info");
      const files = await webdavList(base + projChoice + "/", auth, ctx, (n) => n.endsWith(".jsonl"));
      if (files.length === 0) {
        ctx.ui.notify(`No .jsonl files in ${projChoice}.`, "warning");
        return;
      }
      const fileChoice = await enhancedSelect(ctx, `Fork: select session (${files.length})`, [...files, "❌ Cancel"], { fuzzy: true });
      if (!fileChoice || fileChoice.includes("Cancel")) return;

      const tmpPath = path.join(os.tmpdir(), `pi_fork_${Date.now()}.jsonl`);
      const remote = base + projChoice + "/" + encodeURIComponent(fileChoice);
      ctx.ui.notify(`Downloading ${fileChoice}...`, "info");
      await webdavGetFile(remote, tmpPath, auth, ctx);

      const targetCwd = process.cwd();
      ctx.ui.notify(`Forking into current project (${targetCwd})...`, "info");
      const mgr = SessionManager.forkFrom(tmpPath, targetCwd);
      const newFile = mgr.getSessionFile();
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      ctx.ui.notify(`🎉 Forked into: ${newFile ?? "(unknown)"}\nRun /resume to continue from this session.`, "info");
    } catch (e) {
      ctx.ui.notify(`❌ Fork failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  /** Session Sync submenu. */
  async function showSessionSyncMenu(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      const config = loadConfig();
      const cur = currentSessionFile ? path.basename(currentSessionFile) : "(none)";
      const sel = await enhancedSelect(ctx, "Session Sync", [
        `⚡ Live Backup: ${config.liveSessionBackup ? "ON" : "OFF"}`,
        `  ↳ Debounce: ${config.liveBackupDebounceMs}ms`,
        `🔄 Sync Interval: ${config.syncIntervalTurns === 0 ? "OFF" : `every ${config.syncIntervalTurns} turns`}`,
        `📤 Sync On Exit: ${config.syncSessionOnExit ? "ON" : "OFF"}`,
        `☁️  Upload Current Session Now  (cur: ${cur})`,
        `📥 Restore Latest Session`,
        `📥 Restore Sessions (merge into local project dir)`,
        `🌿 Fork Remote Session into Current Project`,
        "───────────────",
        "x Back",
      ]);
      if (!sel || sel === "x Back") return;
      if (sel.startsWith("⚡ Live Backup:")) { config.liveSessionBackup = !config.liveSessionBackup; saveConfig(config); continue; }
      if (sel.startsWith("  ↳ Debounce:")) {
        const v = await ctx.ui.input("Debounce ms (e.g. 3000):", String(config.liveBackupDebounceMs));
        const n = v ? parseInt(v.trim(), 10) : NaN;
        if (Number.isFinite(n) && n > 0) { config.liveBackupDebounceMs = n; saveConfig(config); }
        continue;
      }
      if (sel.startsWith("🔄 Sync Interval:")) {
        const value = await ctx.ui.input("Upload every N turns (0 = off):", String(config.syncIntervalTurns));
        const n = value ? parseInt(value.trim(), 10) : NaN;
        if (Number.isFinite(n) && n >= 0) { config.syncIntervalTurns = n; saveConfig(config); }
        continue;
      }
      if (sel.startsWith("📤 Sync On Exit:")) { config.syncSessionOnExit = !config.syncSessionOnExit; saveConfig(config); continue; }
      if (sel.startsWith("☁️  Upload Current")) { await uploadCurrentSession(ctx); continue; }
      if (sel.startsWith("📥 Restore Latest")) { await showRestoreLatest(ctx); continue; }
      if (sel.startsWith("📥 Restore Sessions")) { await showRestoreSessions(ctx); continue; }
      if (sel.startsWith("🌿 Fork Remote")) { await showForkSession(ctx); continue; }
    }
  }

  // ── Live backup event wiring ─────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    currentProjectDir = ctx.sessionManager.getSessionDir();
    turnCounter = 0;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    currentSessionFile = ctx.sessionManager.getSessionFile() ?? currentSessionFile;
    const config = loadConfig();
    if (config.liveSessionBackup && isProjectAllowed(currentProjectDir, config)) scheduleLiveBackup(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    const config = loadConfig();
    if (config.syncIntervalTurns <= 0 || !isProjectAllowed(currentProjectDir, config)) return;
    turnCounter++;
    if (turnCounter % config.syncIntervalTurns !== 0) return;
    currentSessionFile = ctx.sessionManager.getSessionFile() ?? currentSessionFile;
    await uploadCurrentSession(ctx, true).catch(() => { /* silent */ });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (liveBackupTimer) { clearTimeout(liveBackupTimer); liveBackupTimer = undefined; }
    const config = loadConfig();
    if ((config.syncSessionOnExit || config.liveSessionBackup) && currentSessionFile && isProjectAllowed(currentProjectDir, config)) {
      await uploadCurrentSession(ctx, true).catch(() => { /* silent */ });
    }
  });

  /** Run the initial WebDAV setup wizard (prompts for URL/user/pass). Returns true if config was saved. */
  async function showSetupWizard(ctx: ExtensionCommandContext): Promise<boolean> {
    const wizConfig = loadConfig();
    ctx.ui.notify("WebDAV is not configured! Please set it up now.", "warning");

    const url = await ctx.ui.input("Enter WebDAV server URL (e.g. https://dav.jianguoyun.com/dav/):", wizConfig.webdavUrl);
    if (!url) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const user = await ctx.ui.input("Enter WebDAV username/email:", wizConfig.webdavUser);
    if (!user) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const pass = await ctx.ui.input("Enter WebDAV password/application-token (recommended: store it in an environment variable and enter $ENV_VAR, e.g. $PI_WEBDAV_TOKEN):", wizConfig.webdavPass);
    if (!pass) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    wizConfig.webdavUrl = url.trim();
    wizConfig.webdavUser = user.trim();
    wizConfig.webdavPass = pass.trim();
    saveConfig(wizConfig);
    ctx.ui.notify("WebDAV configuration saved!", "info");
    return true;
  }

  /** Describe the current session-project selection for menu display. */
  function describeSessionSelection(config: SyncConfig): string {
    const n = config.sessionProjects.length;
    if (n === 0) return `ALL projects (${config.sessionProjectMode}, empty list)`;
    return `${config.sessionProjectMode}: ${n} project${n === 1 ? "" : "s"}`;
  }

  /** Submenu: pick which session project directories to sync. */
  async function showSessionProjectSelect(ctx: ExtensionCommandContext, config: SyncConfig): Promise<void> {
    while (true) {
      const projects = listSessionProjects();
      const selectedSet = new Set(config.sessionProjects);

      if (projects.length === 0) {
        await ctx.ui.confirm(
          "No session projects found",
          "No project directories were found under ~/.pi/agent/sessions/.\nRun Pi in some project first, then come back."
        );
        return;
      }

      const items: string[] = projects.map((dir) => {
        const mark = selectedSet.has(dir) ? "[x]" : "[ ]";
        return `${mark} ${sessionDirToPath(dir)}`;
      });
      items.push("───────────────");
      items.push(`m Switch to ${config.sessionProjectMode === "whitelist" ? "blacklist" : "whitelist"} mode`);
      items.push("a Select All");
      items.push("r Reset list (empty = sync everything)");
      items.push("x Back");

      const allSelected = selectedSet.size === projects.length;
      const mode = selectedSet.size === 0 ? "ALL (empty=default)" : `${selectedSet.size}/${projects.length} selected`;
      const label = config.sessionProjectMode === "whitelist" ? "白名单模式" : "黑名单模式";
      const choice = await enhancedSelect(ctx, `Select Session Projects [${label}] — ${mode}${allSelected ? " (all)" : ""}`, items, { fuzzy: true });
      if (!choice) return;
      if (choice === "x Back") { saveConfig(config); return; }
      if (choice.startsWith("m Switch to")) {
        config.sessionProjectMode = config.sessionProjectMode === "whitelist" ? "blacklist" : "whitelist";
        saveConfig(config);
        continue;
      }
      if (choice === "a Select All") {
        config.sessionProjects = [...projects];
        saveConfig(config);
        continue;
      }
      if (choice.startsWith("r Reset list")) {
        config.sessionProjects = [];
        saveConfig(config);
        continue;
      }
      // Toggle the project whose line was selected.
      // Line format: "[x] /path" or "[ ] /path"
      const m = choice.match(/^\[([ x])\]\s+(.*)$/);
      if (!m) continue;
      const displayPath = m[2]!;
      const dir = projects.find((d) => sessionDirToPath(d) === displayPath);
      if (!dir) continue;
      if (selectedSet.has(dir)) {
        config.sessionProjects = config.sessionProjects.filter((d) => d !== dir);
      } else {
        config.sessionProjects = [...config.sessionProjects, dir];
      }
      saveConfig(config);
    }
  }

  /** Interactive configure-settings menu (while-loop with Save/Back). */
  async function showConfigureSettings(ctx: ExtensionCommandContext): Promise<void> {
    const cfgConfig = loadConfig();
    while (true) {
      const selected = await enhancedSelect(ctx, "Configure Sync Settings", [
        `WebDAV URL: ${cfgConfig.webdavUrl || "(not set)"}`,
        `WebDAV Username: ${cfgConfig.webdavUser || "(not set)"}`,
        `WebDAV Password/Token: ${cfgConfig.webdavPass ? "(set)" : "(not set)"}`,
        `Backup Providers & Config: ${cfgConfig.backupProviders ? "ON" : "OFF"}`,
        `Backup Skills: ${cfgConfig.backupSkills ? "ON" : "OFF"}`,
        `Backup Extensions: ${cfgConfig.backupExtensions ? "ON" : "OFF"}`,
        `Backup Memory Markdown: ${cfgConfig.backupMemory ? "ON" : "OFF"}`,
        `Backup Shared Agent Skills: ${cfgConfig.backupAgentSkills ? "ON" : "OFF"}`,
        `Backup Sessions: ${cfgConfig.backupSessions ? "ON" : "OFF"}`,
        `  ↳ Session Projects: ${describeSessionSelection(cfgConfig)}`,
        `Session Project Mode: ${cfgConfig.sessionProjectMode}`,
        `Sync Every N Turns: ${cfgConfig.syncIntervalTurns === 0 ? "OFF" : cfgConfig.syncIntervalTurns}`,
        `Sync Session On Exit: ${cfgConfig.syncSessionOnExit ? "ON" : "OFF"}`,
        `Max Cloud Backups: ${cfgConfig.maxBackups === 0 ? "keep all" : cfgConfig.maxBackups}`,
        "───────────────",
        "s Save",
        "x Back",
      ]);
      if (!selected || selected === "x Back") return;
      if (selected === "s Save") {
        saveConfig(cfgConfig);
        ctx.ui.notify("Sync configuration updated successfully!", "info");
        return;
      }
      if (selected.startsWith("WebDAV URL:")) {
        const val = await ctx.ui.input("WebDAV URL:", cfgConfig.webdavUrl);
        if (val) cfgConfig.webdavUrl = val.trim();
        continue;
      }
      if (selected.startsWith("WebDAV Username:")) {
        const val = await ctx.ui.input("WebDAV Username:", cfgConfig.webdavUser);
        if (val) cfgConfig.webdavUser = val.trim();
        continue;
      }
      if (selected.startsWith("WebDAV Password/Token:")) {
        const val = await ctx.ui.input("WebDAV Password/Token (recommended: $ENV_VAR such as $PI_WEBDAV_TOKEN; plaintext is stored in config/sync.json):", cfgConfig.webdavPass);
        if (val) cfgConfig.webdavPass = val.trim();
        continue;
      }
      if (selected.startsWith("Backup Providers & Config:")) { cfgConfig.backupProviders = !cfgConfig.backupProviders; continue; }
      if (selected.startsWith("Backup Skills:")) { cfgConfig.backupSkills = !cfgConfig.backupSkills; continue; }
      if (selected.startsWith("Backup Extensions:")) { cfgConfig.backupExtensions = !cfgConfig.backupExtensions; continue; }
      if (selected.startsWith("Backup Memory Markdown:")) { cfgConfig.backupMemory = !cfgConfig.backupMemory; continue; }
      if (selected.startsWith("Backup Shared Agent Skills:")) { cfgConfig.backupAgentSkills = !cfgConfig.backupAgentSkills; continue; }
      if (selected.startsWith("Backup Sessions:")) { cfgConfig.backupSessions = !cfgConfig.backupSessions; continue; }
      if (selected.startsWith("  ↳ Session Projects:")) { await showSessionProjectSelect(ctx, cfgConfig); continue; }
      if (selected.startsWith("Session Project Mode:")) { cfgConfig.sessionProjectMode = cfgConfig.sessionProjectMode === "whitelist" ? "blacklist" : "whitelist"; continue; }
      if (selected.startsWith("Sync Every N Turns:")) {
        const val = await ctx.ui.input("Upload every N turns (0 = off):", String(cfgConfig.syncIntervalTurns));
        const n = val ? parseInt(val.trim(), 10) : NaN;
        if (Number.isFinite(n) && n >= 0) cfgConfig.syncIntervalTurns = n;
        continue;
      }
      if (selected.startsWith("Sync Session On Exit:")) { cfgConfig.syncSessionOnExit = !cfgConfig.syncSessionOnExit; continue; }
      if (selected.startsWith("Max Cloud Backups:")) {
        const val = await ctx.ui.input("Max cloud backups to keep (0 = keep all):", String(cfgConfig.maxBackups));
        const n = val ? parseInt(val.trim(), 10) : NaN;
        if (Number.isFinite(n) && n >= 0) cfgConfig.maxBackups = n; else ctx.ui.notify("Invalid number, keeping current value.", "warning");
        continue;
      }
    }
  }

  type BackupKind = "config" | "memory" | "agent-skills";

  async function showUploadPackage(ctx: ExtensionCommandContext, kind: BackupKind): Promise<void> {
    const config = loadConfig();
    if (kind === "memory" && !config.backupMemory) { ctx.ui.notify("Memory backup is disabled in settings.", "warning"); return; }
    if (kind === "agent-skills" && !config.backupAgentSkills) { ctx.ui.notify("Shared agent skills backup is disabled in settings.", "warning"); return; }
    const timestamp = archiveTimestamp();
    const meta = kind === "config"
      ? { filename: `pi_config_${platformTag()}_${timestamp}.tar.xz`, remoteDir: WEBDAV_CONFIG_DIR, prefix: "pi_config_" }
      : kind === "memory"
        ? { filename: `memory_${timestamp}.tar.xz`, remoteDir: WEBDAV_MEMORY_DIR, prefix: "memory_" }
        : { filename: `agent_skills_${timestamp}.tar.xz`, remoteDir: WEBDAV_AGENT_SKILLS_DIR, prefix: "agent_skills_" };
    const archivePath = path.join(os.tmpdir(), meta.filename);
    try {
      ctx.ui.notify(`Preparing ${kind} archive...`, "info");
      const contents = kind === "config"
        ? await createConfigZip(config, archivePath)
        : kind === "memory"
          ? await createMemoryZip(archivePath)
          : await createAgentSkillsZip(archivePath);
      await uploadToWebdavDir(archivePath, meta.remoteDir, meta.filename, config, ctx);
      const deleted = await pruneOldBackupsInDir(config, ctx, meta.remoteDir, meta.prefix);
      ctx.ui.notify(`🎉 Uploaded ${meta.filename}\n${contents.join("\n")}${deleted.length ? `\nPruned: ${deleted.length}` : ""}`, "info");
    } catch (error) {
      ctx.ui.notify(`❌ ${kind} backup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
  }

  async function showUploadSessionsArchive(ctx: ExtensionCommandContext): Promise<void> {
    const config = loadConfig();
    const projects = listSessionProjects().filter((project) => isProjectAllowed(project, config));
    if (projects.length === 0) { ctx.ui.notify("No allowed local session projects found.", "warning"); return; }
    const project = await enhancedSelect(ctx, "Archive session project", [...projects, "❌ Cancel"], { fuzzy: true });
    if (!project || project.includes("Cancel")) return;
    const filename = `sessions_${platformTag()}_${archiveTimestamp()}.tar.xz`;
    const archivePath = path.join(os.tmpdir(), filename);
    const remoteDir = `${WEBDAV_SESSIONS_DIR}${project}/archive/`;
    try {
      const contents = await createSessionsArchiveZip(project, archivePath);
      await uploadToWebdavDir(archivePath, remoteDir, filename, config, ctx);
      await pruneOldBackupsInDir(config, ctx, remoteDir, "sessions_");
      ctx.ui.notify(`🎉 Uploaded ${filename}\n${contents.join("\n")}`, "info");
    } catch (error) {
      ctx.ui.notify(`❌ Session archive failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
  }

  async function showRestorePackage(ctx: ExtensionCommandContext, kind: BackupKind): Promise<void> {
    const config = loadConfig();
    const meta = kind === "config"
      ? { remoteDir: WEBDAV_CONFIG_DIR, prefix: "pi_config_" }
      : kind === "memory"
        ? { remoteDir: WEBDAV_MEMORY_DIR, prefix: "memory_" }
        : { remoteDir: WEBDAV_AGENT_SKILLS_DIR, prefix: "agent_skills_" };
    try {
      const archives = (await listWebdavDir(meta.remoteDir, config, ctx)).filter((name) => name.startsWith(meta.prefix) && name.endsWith(".tar.xz")).sort().reverse();
      if (archives.length === 0) { ctx.ui.notify(`No ${kind} archives found.`, "warning"); return; }
      const selected = await enhancedSelect(ctx, `Restore ${kind} archive`, [...archives, "❌ Cancel"], { fuzzy: true });
      if (!selected || selected.includes("Cancel")) return;
      if (kind === "agent-skills") {
        const confirmed = await ctx.ui.confirm("Replace shared agent skills?", "The existing ~/.agents/skills directory will be moved to a timestamped backup before restore. Continue?");
        if (!confirmed) return;
      }
      const localPath = path.join(os.tmpdir(), path.basename(selected));
      try {
        await downloadFromWebdavDir(selected, meta.remoteDir, localPath, config, ctx);
        const restored = kind === "config"
          ? await extractConfigZip(localPath, config)
          : kind === "memory"
            ? await extractMemoryZip(localPath)
            : await extractAgentSkillsZip(localPath);
        ctx.ui.notify(`🎉 Restored:\n${restored.join("\n")}`, "info");
        if (kind !== "memory" && await ctx.ui.confirm("Reload Runtime?", "Reload Pi to apply restored configuration and skills?")) await ctx.reload();
      } finally {
        fs.rmSync(localPath, { force: true });
      }
    } catch (error) {
      ctx.ui.notify(`❌ ${kind} restore failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function showRestoreSessionsArchive(ctx: ExtensionCommandContext): Promise<void> {
    const config = loadConfig();
    const base = sessionsWebdavBase(config);
    const auth = webdavAuth(config);
    try {
      const projects = await webdavList(base, auth, ctx, (name) => name.startsWith("--") && name.endsWith("--"));
      const project = await enhancedSelect(ctx, "Restore session archive: project", [...projects, "❌ Cancel"], { fuzzy: true });
      if (!project || project.includes("Cancel")) return;
      const remoteDir = `${WEBDAV_SESSIONS_DIR}${project}/archive/`;
      const archives = (await listWebdavDir(remoteDir, config, ctx)).filter((name) => name.startsWith("sessions_") && name.endsWith(".tar.xz")).sort().reverse();
      if (archives.length === 0) { ctx.ui.notify("No archives found for this project.", "warning"); return; }
      const selected = await enhancedSelect(ctx, "Select session archive", [...archives, "❌ Cancel"], { fuzzy: true });
      if (!selected || selected.includes("Cancel")) return;
      const localPath = path.join(os.tmpdir(), path.basename(selected));
      try {
        await downloadFromWebdavDir(selected, remoteDir, localPath, config, ctx);
        const restored = await extractSessionsArchiveZip(localPath);
        ctx.ui.notify(`🎉 ${restored.join("\n")}`, "info");
      } finally {
        fs.rmSync(localPath, { force: true });
      }
    } catch (error) {
      ctx.ui.notify(`❌ Session archive restore failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  /** Legacy monolithic backup upload retained for compatibility. */
  async function showUploadBackup(ctx: ExtensionCommandContext): Promise<void> {
    const config = loadConfig();
    const filename = `pi_sync_backup_${archiveTimestamp()}_${platformTag()}.tar.xz`;
    const archivePath = path.join(os.tmpdir(), filename);
    try {
      const contents = await createZip(config, archivePath);
      await uploadToWebdav(archivePath, config, ctx);
      await pruneOldBackups(config, ctx);
      ctx.ui.notify(`🎉 Legacy backup uploaded: ${filename}\n${contents.join("\n")}`, "info");
    } catch (error) {
      ctx.ui.notify(`❌ Legacy backup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
  }

  /** Download and restore a legacy backup from WebDAV. */
  async function showDownloadBackup(ctx: ExtensionCommandContext): Promise<void> {
    const dlConfig = loadConfig();
    ctx.ui.notify("Fetching backups list from cloud...", "info");
    try {
      const backups = await listCloudBackups(dlConfig, ctx);
      if (backups.length === 0) {
        ctx.ui.notify("No cloud backups found on WebDAV server starting with 'pi_sync_backup_' (.tar.xz or .zip).", "warning");
        return;
      }

      const backupChoice = await enhancedSelect(ctx, "Select cloud backup to restore:", [
        ...backups,
        "❌ Cancel",
      ], { fuzzy: true });

      if (!backupChoice || backupChoice.includes("Cancel")) return;

      const tempDownloadZip = path.join(os.tmpdir(), path.basename(backupChoice));
      try {
        ctx.ui.notify(`Downloading ${backupChoice}...`, "info");
        await yieldToUI();
        await downloadFromWebdav(backupChoice, tempDownloadZip, dlConfig, ctx);

        const archiveEntries = await listArchiveEntries(tempDownloadZip);
        validateArchiveEntries(archiveEntries);
        const restorePlan = getRestorePlan(archiveEntries, dlConfig);
        const confirmed = await ctx.ui.confirm(
          "Confirm Restore After Inspection?",
          [
            `Backup: ${backupChoice}`,
            `Archive entries inspected: ${archiveEntries.length}`,
            ...restorePlan,
            "This can overwrite local configuration/skills/extensions, but existing local files/directories will receive timestamped backups first.",
          ].join("\n")
        );

        if (!confirmed) {
          ctx.ui.notify("Restore cancelled after archive inspection.", "info");
          return;
        }

        ctx.ui.notify("Extracting and restoring backup contents...", "info");
        await yieldToUI();
        const restoredItems = await extractZip(tempDownloadZip, dlConfig);
        ctx.ui.notify(`🎉 Restored successfully:\n${restoredItems.join("\n")}`, "info");

        const doReload = await ctx.ui.confirm("Reload Runtime?", "Would you like to reload the agent runtime now to apply restored skills and extensions?");
        if (doReload) await ctx.reload();
      } finally {
        if (fs.existsSync(tempDownloadZip)) {
          try { fs.unlinkSync(tempDownloadZip); } catch { /* ignore */ }
        }
      }
    } catch (e) {
      ctx.ui.notify(`❌ Restore failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  // Register command `/sync`
  pi.registerCommand("sync", {
    description: "Sync configurations, skills, extensions, and sessions via WebDAV",
    getArgumentCompletions: (prefix) => {
      // /sync takes no sub-actions; interactive menu handles everything.
      return null;
    },
    handler: async (args, ctx) => {
      let config = loadConfig();

      // Setup wizard
      if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) {
        if (!await showSetupWizard(ctx)) return;
        config = loadConfig();
      }

      // Interactive menu
      const menuOptions = [
        "☁️  Upload Config Backup",
        "🧠 Upload Memory Backup",
        "📦 Upload Skills Snapshot",
        "🗂️  Upload Sessions Archive",
        "📥 Restore Config Backup",
        "📥 Restore Memory Backup",
        "📥 Restore Skills Snapshot",
        "📥 Restore Sessions Archive",
        "🔄 Session Sync (live backup / restore / fork)",
        "🧰 Legacy Monolithic Backup/Restore",
        "⚙️  Configure Sync Settings",
        "❌  Cancel",
      ];
      const choice = await enhancedSelect(ctx, "Pi WebDAV Synchronization", menuOptions);
      if (!choice || choice.includes("Cancel")) return;

      if (choice.includes("Configure Sync Settings")) return showConfigureSettings(ctx);
      if (choice === "☁️  Upload Config Backup") return showUploadPackage(ctx, "config");
      if (choice === "🧠 Upload Memory Backup") return showUploadPackage(ctx, "memory");
      if (choice === "📦 Upload Skills Snapshot") return showUploadPackage(ctx, "agent-skills");
      if (choice === "🗂️  Upload Sessions Archive") return showUploadSessionsArchive(ctx);
      if (choice === "📥 Restore Config Backup") return showRestorePackage(ctx, "config");
      if (choice === "📥 Restore Memory Backup") return showRestorePackage(ctx, "memory");
      if (choice === "📥 Restore Skills Snapshot") return showRestorePackage(ctx, "agent-skills");
      if (choice === "📥 Restore Sessions Archive") return showRestoreSessionsArchive(ctx);
      if (choice.includes("Legacy Monolithic")) {
        const action = await enhancedSelect(ctx, "Legacy backup", ["Upload legacy backup", "Restore legacy backup", "❌ Cancel"]);
        if (action?.startsWith("Upload")) return showUploadBackup(ctx);
        if (action?.startsWith("Restore")) return showDownloadBackup(ctx);
        return;
      }
      if (choice.includes("Session Sync")) return showSessionSyncMenu(ctx);
    },
  });
}
