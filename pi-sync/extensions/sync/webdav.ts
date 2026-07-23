import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchWithTimeout } from "../_shared/fetch-utils";
import { resolvePassword, type SyncConfig } from "./config";

export const WEBDAV_FETCH_TIMEOUT_MS = 120_000;
export const WEBDAV_CONFIG_DIR = "config/";
export const WEBDAV_AGENT_SKILLS_DIR = "agent-skills/";
export const WEBDAV_SESSIONS_DIR = "sessions/";

export const ensureTrailingSlash = (url: string): string => url.endsWith("/") ? url : `${url}/`;
export const webdavDirBase = (config: SyncConfig, remoteDir: string): string => ensureTrailingSlash(config.webdavUrl) + remoteDir.replace(/^\/+/, "");
export const configWebdavBase = (config: SyncConfig): string => webdavDirBase(config, WEBDAV_CONFIG_DIR);
export const agentSkillsWebdavBase = (config: SyncConfig): string => webdavDirBase(config, WEBDAV_AGENT_SKILLS_DIR);
export const sessionsWebdavBase = (config: SyncConfig): string => webdavDirBase(config, WEBDAV_SESSIONS_DIR);
export const webdavAuth = (config: SyncConfig): string => "Basic " + Buffer.from(`${config.webdavUser}:${resolvePassword(config.webdavPass)}`).toString("base64");

export async function webdavList(url: string, auth: string, ctx: ExtensionContext, filter?: (name: string) => boolean): Promise<string[]> {
  const response = await fetchWithTimeout(url, { method: "PROPFIND", headers: { Authorization: auth, Depth: "1", "Content-Type": "application/xml" } }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
  if (!response.ok) throw new Error(`WebDAV PROPFIND HTTP ${response.status}: ${response.statusText}`);
  const text = await response.text();
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  const display = /<[a-zA-Z0-9:-]*displayname>([^<]+)<\/[a-zA-Z0-9:-]*displayname>/g;
  while ((match = display.exec(text))) if (match[1]?.trim()) names.add(match[1].trim());
  if (names.size === 0) {
    const href = /<[a-zA-Z0-9:-]*href>([^<]+)<\/[a-zA-Z0-9:-]*href>/g;
    while ((match = href.exec(text))) {
      const name = path.basename(decodeURIComponent(match[1]!.trim()));
      if (name) names.add(name);
    }
  }
  let result = [...names];
  if (filter) result = result.filter(filter);
  return result.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

export async function webdavPutFile(localPath: string, remoteUrl: string, auth: string, ctx: ExtensionContext): Promise<void> {
  const stream = fs.createReadStream(localPath);
  try {
    const response = await fetchWithTimeout(remoteUrl, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/octet-stream" },
      body: stream as unknown as BodyInit,
      // Node fetch requires this for a streaming request body.
      duplex: "half",
    } as RequestInit, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
    if (!response.ok) throw new Error(`WebDAV PUT HTTP ${response.status}: ${response.statusText}`);
  } finally {
    stream.destroy();
  }
}

export async function webdavGetFile(remoteUrl: string, destPath: string, auth: string, ctx: ExtensionContext): Promise<void> {
  const response = await fetchWithTimeout(remoteUrl, { method: "GET", headers: { Authorization: auth } }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
  if (!response.ok) throw new Error(`WebDAV GET HTTP ${response.status}: ${response.statusText}`);
  if (!response.body) throw new Error("WebDAV GET returned an empty response body");
  const tempPath = `${destPath}.part-${process.pid}-${Date.now()}`;
  try {
    await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(tempPath), { signal: ctx.signal });
    fs.renameSync(tempPath, destPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export async function webdavMkcol(url: string, auth: string, ctx: ExtensionContext): Promise<void> {
  const response = await fetchWithTimeout(url, { method: "MKCOL", headers: { Authorization: auth } }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
  if (!response.ok && response.status !== 405) throw new Error(`WebDAV MKCOL HTTP ${response.status}: ${response.statusText}`);
}

export async function listWebdavDir(remoteDir: string, config: SyncConfig, ctx: ExtensionContext): Promise<string[]> {
  try { return await webdavList(webdavDirBase(config, remoteDir), webdavAuth(config), ctx); }
  catch (error) { if (error instanceof Error && /HTTP 404/.test(error.message)) return []; throw error; }
}

export async function ensureWebdavDirectory(remoteDir: string, config: SyncConfig, ctx: ExtensionContext): Promise<string> {
  let current = ensureTrailingSlash(config.webdavUrl);
  for (const segment of remoteDir.split("/").filter(Boolean)) {
    current += `${encodeURIComponent(segment)}/`;
    await webdavMkcol(current, webdavAuth(config), ctx);
  }
  return current;
}

export async function uploadToWebdavDir(localPath: string, remoteDir: string, remoteName: string, config: SyncConfig, ctx: ExtensionContext): Promise<void> {
  const base = await ensureWebdavDirectory(remoteDir, config, ctx);
  await webdavPutFile(localPath, base + encodeURIComponent(remoteName), webdavAuth(config), ctx);
}

export async function downloadFromWebdavDir(remoteName: string, remoteDir: string, destPath: string, config: SyncConfig, ctx: ExtensionContext): Promise<void> {
  await webdavGetFile(webdavDirBase(config, remoteDir) + encodeURIComponent(remoteName), destPath, webdavAuth(config), ctx);
}

export async function deleteFromWebdavDir(remoteName: string, remoteDir: string, config: SyncConfig, ctx: ExtensionContext): Promise<void> {
  const response = await fetchWithTimeout(webdavDirBase(config, remoteDir) + encodeURIComponent(remoteName), { method: "DELETE", headers: { Authorization: webdavAuth(config) } }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);
  if (!response.ok && response.status !== 404) throw new Error(`WebDAV DELETE HTTP ${response.status}: ${response.statusText}`);
}

export async function pruneOldBackupsInDir(config: SyncConfig, ctx: ExtensionContext, remoteDir: string, prefix: string): Promise<string[]> {
  if (config.maxBackups <= 0) return [];
  const files = (await listWebdavDir(remoteDir, config, ctx)).filter((name) => name.startsWith(prefix) && name.endsWith(".tar.xz")).sort().reverse();
  const deleted = files.slice(config.maxBackups);
  for (const name of deleted) try { await deleteFromWebdavDir(name, remoteDir, config, ctx); } catch { /* best effort */ }
  return deleted;
}
