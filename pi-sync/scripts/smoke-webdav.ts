import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createPiAgentZip,
  createSessionsArchiveZip,
  listArchiveEntries,
  validateArchiveEntries,
  validateArchiveEntryTypes,
} from "../extensions/sync/archive.ts";
import { isProjectAllowed, loadConfig, SESSIONS_DIR } from "../extensions/sync/config.ts";
import {
  deleteFromWebdavDir,
  downloadFromWebdavDir,
  listWebdavDir,
  uploadToWebdavDir,
  WEBDAV_PI_BACKUP_DIR,
  WEBDAV_SESSIONS_ARCHIVE_DIR,
} from "../extensions/sync/webdav.ts";

const WRITE_CONFIRMATION = "1";

type SmokeArchive = {
  name: string;
  remoteDir: string;
  localPath: string;
  downloadPath: string;
};

function selectSessionProject(requested: string | undefined): string {
  const config = loadConfig();
  const projects = fs.existsSync(SESSIONS_DIR)
    ? fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("--") && entry.name.endsWith("--"))
      .map((entry) => entry.name)
    : [];
  const project = requested ?? projects.find((entry) => isProjectAllowed(entry, config));
  if (!project || !projects.includes(project)) {
    throw new Error("No local session project is available for the WebDAV smoke test");
  }
  if (!isProjectAllowed(project, config)) {
    throw new Error(`Session project is excluded by pi-sync configuration: ${project}`);
  }
  return project;
}

async function assertDownloadedArchive(archive: SmokeArchive): Promise<number> {
  if (fs.statSync(archive.localPath).size !== fs.statSync(archive.downloadPath).size) {
    throw new Error(`Downloaded archive size differs: ${archive.name}`);
  }
  const entries = await listArchiveEntries(archive.downloadPath);
  validateArchiveEntries(entries);
  await validateArchiveEntryTypes(archive.downloadPath);
  return entries.length;
}

async function cleanupArchive(
  archive: SmokeArchive,
  config: ReturnType<typeof loadConfig>,
  ctx: ExtensionContext,
): Promise<string> {
  // DELETE is idempotent for the generated unique name (404 is accepted by
  // deleteFromWebdavDir), so clean up even if a PUT failed after reaching the server.
  await deleteFromWebdavDir(archive.name, archive.remoteDir, config, ctx);
  const remaining = await listWebdavDir(archive.remoteDir, config, ctx);
  if (remaining.includes(archive.name)) throw new Error(`Smoke archive was not deleted: ${archive.name}`);
  return "deleted";
}

async function main(): Promise<void> {
  if (process.env.PI_SYNC_SMOKE_WRITE !== WRITE_CONFIRMATION) {
    throw new Error("Refusing WebDAV write test. Set PI_SYNC_SMOKE_WRITE=1 to create and delete temporary smoke archives.");
  }

  const config = loadConfig();
  if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) {
    throw new Error("WebDAV configuration is incomplete");
  }

  const runId = `${Date.now()}-${process.pid}`;
  const project = selectSessionProject(process.env.PI_SYNC_SMOKE_PROJECT);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-smoke-"));
  const pi: SmokeArchive = {
    name: `pi_agent_smoke_${runId}.tar.xz`,
    remoteDir: WEBDAV_PI_BACKUP_DIR,
    localPath: path.join(tempDir, `pi_agent_smoke_${runId}.tar.xz`),
    downloadPath: path.join(tempDir, `downloaded-pi_agent_smoke_${runId}.tar.xz`),
  };
  const session: SmokeArchive = {
    name: `sessions_smoke_${runId}.tar.xz`,
    remoteDir: `${WEBDAV_SESSIONS_ARCHIVE_DIR}${project}/`,
    localPath: path.join(tempDir, `sessions_smoke_${runId}.tar.xz`),
    downloadPath: path.join(tempDir, `downloaded-sessions_smoke_${runId}.tar.xz`),
  };
  const ctx = { signal: new AbortController().signal } as ExtensionContext;
  const summary: Record<string, unknown> = { project };

  try {
    const piInfo = await createPiAgentZip(config, pi.localPath);
    const piEntries = await listArchiveEntries(pi.localPath);
    validateArchiveEntries(piEntries);
    await validateArchiveEntryTypes(pi.localPath);
    if (!piEntries.includes("config/sync.json")) throw new Error("Pi archive does not contain config/sync.json");
    for (const excluded of config.piExcludePaths) {
      if (piEntries.some((entry) => entry === excluded || entry.startsWith(`${excluded}/`))) {
        throw new Error(`Pi archive unexpectedly includes excluded path: ${excluded}`);
      }
    }
    await uploadToWebdavDir(pi.localPath, pi.remoteDir, pi.name, config, ctx);
    if (!(await listWebdavDir(pi.remoteDir, config, ctx)).includes(pi.name)) {
      throw new Error("Uploaded Pi smoke archive was not listed remotely");
    }
    await downloadFromWebdavDir(pi.name, pi.remoteDir, pi.downloadPath, config, ctx);
    summary.pi = { bytes: fs.statSync(pi.localPath).size, entries: await assertDownloadedArchive(pi), reported: piInfo };

    const sessionInfo = await createSessionsArchiveZip(project, session.localPath);
    const sessionEntries = await listArchiveEntries(session.localPath);
    validateArchiveEntries(sessionEntries);
    await validateArchiveEntryTypes(session.localPath);
    if (!sessionEntries.some((entry) => entry.startsWith(`sessions/${project}/`))) {
      throw new Error("Session archive does not contain the selected project");
    }
    await uploadToWebdavDir(session.localPath, session.remoteDir, session.name, config, ctx);
    if (!(await listWebdavDir(session.remoteDir, config, ctx)).includes(session.name)) {
      throw new Error("Uploaded session smoke archive was not listed remotely");
    }
    await downloadFromWebdavDir(session.name, session.remoteDir, session.downloadPath, config, ctx);
    summary.session = { bytes: fs.statSync(session.localPath).size, entries: await assertDownloadedArchive(session), reported: sessionInfo };
    summary.result = "passed";
  } finally {
    const cleanup: Record<string, string> = {};
    try { cleanup.pi = await cleanupArchive(pi, config, ctx); }
    catch (error) { cleanup.pi = `delete-failed: ${error instanceof Error ? error.message : String(error)}`; }
    try { cleanup.session = await cleanupArchive(session, config, ctx); }
    catch (error) { cleanup.session = `delete-failed: ${error instanceof Error ? error.message : String(error)}`; }
    fs.rmSync(tempDir, { recursive: true, force: true });
    summary.cleanup = cleanup;
    console.error(`SMOKE_CLEANUP ${JSON.stringify(cleanup)}`);
  }

  console.log(JSON.stringify(summary));
  if (Object.values(summary.cleanup as Record<string, string>).some((value) => value !== "deleted")) {
    throw new Error("Smoke archive cleanup did not complete");
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
