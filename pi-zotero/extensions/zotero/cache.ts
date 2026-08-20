/**
 * JSON/CSL 缓存：
 * - 原子写：唯一 tmp → rename
 * - Server-ID 命名空间与文件内双重校验，防跨库复用
 * - 每条 CSL 记录 Zotero item version，元数据更新后自动失效
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export class JsonCache<T> {
  constructor(readonly filePath: string) {}

  load(): T | null {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as T;
    } catch {
      return null;
    }
  }

  save(data: T): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
}

export interface Versioned<T> {
  version: number;
  data: T;
}

export interface CslCacheState {
  schemaVersion: 1;
  serverId: string;
  /** Local API 固定使用 users/0；保留字段用于未来 group/user 扩展。 */
  userId: number;
  items: Record<string, Versioned<Record<string, unknown>>>;
}

export function emptyCslCache(serverId: string, userId = 0): CslCacheState {
  return { schemaVersion: 1, serverId, userId, items: {} };
}

export function isCslCacheState(value: unknown): value is CslCacheState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CslCacheState>;
  return candidate.schemaVersion === 1 &&
    typeof candidate.serverId === "string" &&
    typeof candidate.userId === "number" &&
    !!candidate.items &&
    typeof candidate.items === "object";
}

export function cslCacheData(state: CslCacheState): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(state.items).map(([key, entry]) => [key, entry.data]));
}

/** 默认缓存目录：env > 配置文件 > <cwd>/.zotero-cache */
export function defaultCacheDir(cwd: string, configured?: string | null): string {
  return process.env.ZOTERO_CACHE_DIR ?? configured ?? path.join(cwd, ".zotero-cache");
}

/** 按 Server-ID + userID 组织缓存命名空间（防跨库复用缓存）。 */
export function cacheNamespace(cacheDir: string, serverId: string, userId: number): string {
  return path.join(cacheDir, `${serverId}-${userId}`);
}
