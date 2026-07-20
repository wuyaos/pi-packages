import { type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { timestampForBackup, ensureDir, writeJsonAtomic, readJsonSafe } from "../_shared/json-io";
import { enhancedSelect } from "../_shared/enhanced-select";
import { runCommand } from "../_shared/spawn";
import { fetchWithTimeout } from "../_shared/fetch-utils";

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

// Default settings file to store user configuration
const SYNC_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "sync_config.json");
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
  /** Keep at most N cloud full backups (0 = keep all). Prune runs after each upload. */
  maxBackups: number;
}

export default function (pi: ExtensionAPI) {
  // Read and write config helpers
  function loadConfig(): SyncConfig {
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
    const allowedTopLevel = new Set(["config", "skills", "extensions", "sessions"]);
    const allowedConfigFiles = new Set(["models.json", "settings.json", "auth.json"]);

    if (entries.length === 0) {
      throw new Error("Backup archive is empty or unreadable");
    }

    for (const entry of entries) {
      const pathParts = entry.split("/");
      if (entry.startsWith("/") || /^[a-zA-Z]:\//.test(entry) || pathParts.includes("..")) {
        throw new Error(`Unsafe archive path rejected: ${entry}`);
      }

      const [topLevel, secondPart] = pathParts;
      if (!topLevel || !allowedTopLevel.has(topLevel)) {
        throw new Error(`Unexpected top-level archive entry rejected: ${entry}`);
      }

      // Under sessions/<projectDir>/... the projectDir is the encoded cwd; allow any
      // single segment there. File names under it are timestamped jsonl files.
      if (topLevel === "sessions") {
        // sessions/ alone is fine; sessions/<dir>/... is fine; reject sessions/<dir>
        // being a file directly (needs to be a directory).
        continue;
      }

      if (topLevel === "config" && secondPart && !allowedConfigFiles.has(secondPart)) {
        throw new Error(`Unexpected config file rejected: ${entry}`);
      }
    }
  }

  function getRestorePlan(entries: string[], config: SyncConfig): string[] {
    const hasConfig = entries.some((entry) => entry === "config" || entry.startsWith("config/"));
    const hasSkills = entries.some((entry) => entry === "skills" || entry.startsWith("skills/"));
    const hasExtensions = entries.some((entry) => entry === "extensions" || entry.startsWith("extensions/"));
    const hasSessions = entries.some((entry) => entry === "sessions" || entry.startsWith("sessions/"));
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

    if (plan.length === 0) {
      plan.push("No restorable config, skills, extensions, or sessions found in this archive.");
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
            const scope = selectAll ? "all" : `${added} selected`;
            contents.push(`Sessions (${scope} project${added === 1 ? "" : "s"})`);
          }
        }
      }

      if (contents.length === 0) {
        throw new Error("No components selected or found to backup!");
      }

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
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      fs.readdirSync(src).forEach((childItemName) => {
        copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
      });
    } else {
      fs.copyFileSync(src, dest);
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

  function projectDirFromCwd(cwd: string): string {
    // pi encodes cwd as "--" + cwd.replace(/\//g, "-") + "--"
    return "--" + cwd.replace(/\//g, "-") + "--";
  }

  function ensureTrailingSlash(url: string): string {
    return url.endsWith("/") ? url : url + "/";
  }

  function sessionsWebdavBase(config: SyncConfig): string {
    return ensureTrailingSlash(config.webdavUrl) + "sessions/";
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

  /** Upload the current session file (single .jsonl) to the cloud. */
  async function uploadCurrentSession(ctx: ExtensionContext, silent = false): Promise<boolean> {
    const config = loadConfig();
    if (!currentSessionFile || !currentProjectDir) {
      if (!silent) ctx.ui.notify("No active session file to upload.", "warning");
      return false;
    }
    if (!fs.existsSync(currentSessionFile)) {
      if (!silent) ctx.ui.notify(`Session file missing: ${currentSessionFile}`, "warning");
      return false;
    }
    try {
      const base = sessionsWebdavBase(config);
      const auth = webdavAuth(config);
      await webdavMkcol(base, auth, ctx);
      await webdavMkcol(base + currentProjectDir + "/", auth, ctx);
      const remote = base + currentProjectDir + "/" + encodeURIComponent(path.basename(currentSessionFile));
      await webdavPutFile(currentSessionFile, remote, auth, ctx);
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
        `☁️  Upload Current Session Now  (cur: ${cur})`,
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
      if (sel.startsWith("☁️  Upload Current")) { await uploadCurrentSession(ctx); continue; }
      if (sel.startsWith("📥 Restore Sessions")) { await showRestoreSessions(ctx); continue; }
      if (sel.startsWith("🌿 Fork Remote")) { await showForkSession(ctx); continue; }
    }
  }

  // ── Live backup event wiring ─────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    currentProjectDir = ctx.sessionManager.getSessionDir();
  });
  pi.on("agent_settled", async (_event, ctx) => {
    // refresh path (may change after compaction/fork within same session runtime)
    currentSessionFile = ctx.sessionManager.getSessionFile() ?? currentSessionFile;
    scheduleLiveBackup(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    // flush before switching/exiting
    if (liveBackupTimer) { clearTimeout(liveBackupTimer); liveBackupTimer = undefined; }
    if (loadConfig().liveSessionBackup && currentSessionFile) {
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
    if (!config.backupSessions) return "(sessions backup is OFF)";
    const n = config.sessionProjects.length;
    if (n === 0) return "ALL projects (default)";
    return `${n} project${n === 1 ? "" : "s"} selected`;
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
      items.push("a Select All");
      items.push("r Reset to All (default — empty = sync everything)");
      items.push("x Back");

      const allSelected = selectedSet.size === projects.length;
      const mode = selectedSet.size === 0 ? "ALL (empty=default)" : `${selectedSet.size}/${projects.length} selected`;
      const choice = await enhancedSelect(ctx, `Select Session Projects — ${mode}${allSelected ? " (all)" : ""}`, items, { fuzzy: true });
      if (!choice) return;
      if (choice === "x Back") return;
      if (choice === "a Select All") {
        config.sessionProjects = [...projects];
        continue;
      }
      if (choice.startsWith("r Reset to All")) {
        config.sessionProjects = [];
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
        `Backup Sessions: ${cfgConfig.backupSessions ? "ON" : "OFF"}`,
        `  ↳ Session Projects: ${describeSessionSelection(cfgConfig)}`,
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
        const val = await ctx.ui.input("WebDAV Password/Token (recommended: $ENV_VAR such as $PI_WEBDAV_TOKEN; plaintext is stored in sync_config.json):", cfgConfig.webdavPass);
        if (val) cfgConfig.webdavPass = val.trim();
        continue;
      }
      if (selected.startsWith("Backup Providers & Config:")) { cfgConfig.backupProviders = !cfgConfig.backupProviders; continue; }
      if (selected.startsWith("Backup Skills:")) { cfgConfig.backupSkills = !cfgConfig.backupSkills; continue; }
      if (selected.startsWith("Backup Extensions:")) { cfgConfig.backupExtensions = !cfgConfig.backupExtensions; continue; }
      if (selected.startsWith("Backup Sessions:")) { cfgConfig.backupSessions = !cfgConfig.backupSessions; continue; }
      if (selected.startsWith("  ↳ Session Projects:")) { await showSessionProjectSelect(ctx, cfgConfig); continue; }
      if (selected.startsWith("Max Cloud Backups:")) {
        const val = await ctx.ui.input("Max cloud backups to keep (0 = keep all):", String(cfgConfig.maxBackups));
        const n = val ? parseInt(val.trim(), 10) : NaN;
        if (Number.isFinite(n) && n >= 0) cfgConfig.maxBackups = n; else ctx.ui.notify("Invalid number, keeping current value.", "warning");
        continue;
      }
    }
  }

  /** Upload backup to WebDAV. */
  async function showUploadBackup(ctx: ExtensionCommandContext): Promise<void> {
    const ulConfig = loadConfig();
    ctx.ui.notify("Preparing local files to pack...", "info");
    await yieldToUI();
    const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const dateStr = new Date().toLocaleDateString("zh-CN").replace(/\//g, "-");
    const zipFilename = `pi_sync_backup_${dateStr}_${timestamp}_${platformTag()}.tar.xz`;
    const tempZipPath = path.join(os.tmpdir(), zipFilename);

    try {
      const packedContents = await createZip(ulConfig, tempZipPath);
      await yieldToUI();
      ctx.ui.notify(`Packed items:\n${packedContents.join("\n")}`, "info");
      ctx.ui.notify("Uploading backup archive to WebDAV server...", "info");
      await yieldToUI();
      await uploadToWebdav(tempZipPath, ulConfig, ctx);
      ctx.ui.notify(`🎉 Backup uploaded successfully as:\n${zipFilename}`, "info");
      // Retention: prune oldest cloud backups beyond maxBackups (0 = keep all).
      try {
        const deleted = await pruneOldBackups(ulConfig, ctx);
        if (deleted.length > 0) {
          ctx.ui.notify(`🧹 Pruned ${deleted.length} old backup(s) (keeping newest ${ulConfig.maxBackups}).`, "info");
        }
      } catch (e) {
        ctx.ui.notify(`⚠️ Retention prune skipped: ${e instanceof Error ? e.message : String(e)}`, "warning");
      }
    } catch (e) {
      ctx.ui.notify(`❌ Backup upload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      if (fs.existsSync(tempZipPath)) {
        try { fs.unlinkSync(tempZipPath); } catch { /* ignore */ }
      }
    }
  }

  /** Download and restore a backup from WebDAV. */
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
        "☁️  Upload Backup (Backup to cloud)",
        "📥  Download Backup (Restore from cloud)",
        "🔄 Session Sync (live backup / restore / fork)",
        "⚙️  Configure Sync Settings",
        "❌  Cancel",
      ];
      const choice = await enhancedSelect(ctx, "Pi WebDAV Synchronization", menuOptions);
      if (!choice || choice.includes("Cancel")) return;

      if (choice.includes("Configure Sync Settings")) return showConfigureSettings(ctx);
      if (choice.includes("Upload Backup")) return showUploadBackup(ctx);
      if (choice.includes("Download Backup")) return showDownloadBackup(ctx);
      if (choice.includes("Session Sync")) return showSessionSyncMenu(ctx);
    },
  });
}
