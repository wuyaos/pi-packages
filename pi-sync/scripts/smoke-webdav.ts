import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createPiAgentZip,
  listArchiveEntries,
  validateArchiveEntries,
  validateArchiveEntryTypes,
} from "../extensions/sync/archive.ts";
import { DEFAULT_REMOTE_BASE_DIR, loadConfig, webdavDir } from "../extensions/sync/config.ts";
import {
  deleteFromWebdavDir,
  downloadFromWebdavDir,
  listWebdavDir,
  uploadToWebdavDir,
} from "../extensions/sync/webdav.ts";

const WRITE_CONFIRMATION = "1";

async function main(): Promise<void> {
  if (process.env.PI_SYNC_SMOKE_WRITE !== WRITE_CONFIRMATION) {
    throw new Error("Refusing WebDAV write test. Set PI_SYNC_SMOKE_WRITE=1 to create and delete a temporary smoke archive.");
  }

  const config = loadConfig();
  const smokeDir = webdavDir("pi", { remoteBaseDir: config.remoteBaseDir || DEFAULT_REMOTE_BASE_DIR });
  if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) throw new Error("WebDAV configuration is incomplete");

  const runId = `${Date.now()}-${process.pid}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-smoke-"));
  const name = `pi_agent_smoke_${runId}.tar.xz`;
  const localPath = path.join(tempDir, name);
  const downloadPath = path.join(tempDir, `downloaded-${name}`);
  const ctx = { signal: new AbortController().signal } as ExtensionContext;
  try {
    const reported = await createPiAgentZip(config, localPath);
    const entries = await listArchiveEntries(localPath);
    validateArchiveEntries(entries);
    await validateArchiveEntryTypes(localPath);
    if (!entries.includes("config/sync.json")) throw new Error("Pi archive does not contain config/sync.json");
    for (const excluded of config.piExcludePaths) {
      if (entries.some((entry) => entry === excluded || entry.startsWith(`${excluded}/`))) {
        throw new Error(`Pi archive unexpectedly includes excluded path: ${excluded}`);
      }
    }
    await uploadToWebdavDir(localPath, smokeDir, name, config, ctx);
    if (!(await listWebdavDir(smokeDir, config, ctx)).includes(name)) throw new Error("Uploaded smoke archive was not listed remotely");
    await downloadFromWebdavDir(name, smokeDir, downloadPath, config, ctx);
    if (fs.statSync(localPath).size !== fs.statSync(downloadPath).size) throw new Error("Downloaded archive size differs");
    console.log(JSON.stringify({ result: "passed", bytes: fs.statSync(localPath).size, entries: entries.length, reported }));
  } finally {
    try {
      await deleteFromWebdavDir(name, smokeDir, config, ctx);
      if ((await listWebdavDir(smokeDir, config, ctx)).includes(name)) throw new Error("Smoke archive was not deleted");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
