/**
 * JsonCache — 简单 JSON 文件缓存（审查修正版）。
 *  - 原子写：唯一 tmp（pid+rand）→ rename，并发安全
 *  - 版本感知：缓存条目可带 item version，配合 format=versions 对比失效
 *  - 命名空间：缓存文件路径由调用方按 Server-ID+userID 组织（防跨库投毒）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export class JsonCache<T> {
  constructor(readonly filePath: string) {}

  load(): Record<string, T> | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? (obj as Record<string, T>) : null;
    } catch {
      return null;
    }
  }

  save(data: Record<string, T>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }

  /** 计算 keys 中尚未缓存（或缓存为错误）的缺失项 */
  missingKeys(keys: string[], valid: (v: T | undefined) => boolean = (v) => !!v): string[] {
    const cache = this.load() ?? {};
    return keys.filter((k) => !valid(cache[k]));
  }

  /**
   * 版本化缓存值：{ v: itemVersion, data: T }。
   * 缓存条目 version < 当前 version → 过期，需重拉。
   */
  static wrap<T>(data: T, version?: number): Versioned<T> {
    return { v: version ?? 0, data };
  }

  static isStale<T>(entry: Versioned<T> | undefined, currentVersion: number | undefined): boolean {
    if (!entry) return true;
    if (currentVersion === undefined) return false;
    return entry.v < currentVersion;
  }
}

export interface Versioned<T> {
  v: number;
  data: T;
}

/** 默认缓存目录：ZOTERO_CACHE_DIR 或 <cwd>/.zotero-cache */
export function defaultCacheDir(cwd: string): string {
  return process.env.ZOTERO_CACHE_DIR ?? path.join(cwd, ".zotero-cache");
}

/** 按 Server-ID + userID 组织缓存命名空间（防跨库复用缓存） */
export function cacheNamespace(cacheDir: string, serverId: string, userId: number): string {
  return path.join(cacheDir, `${serverId}-${userId}`);
}
