/**
 * 同步进程文件锁（引擎层）。
 *
 * - lockFileSync：wx 原子创建锁文件，内容为 { pid, ts }；已被持有时返回 null（tryLock 语义，
 *   退出备份路径拿不到锁直接跳过，不阻塞）。
 * - 陈旧锁（超过 staleMs，默认 60s）视为持有进程已消亡，删除后重试抢占一次。
 * - unlockFileSync：只删除自己创建的锁（pid 不匹配说明锁已被他人重写，不动）。
 *
 * Import: import { … } from "./lock"
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const LOCK_STALE_MS = 60_000;

export interface FileLock {
  path: string;
  pid: number;
}

export interface LockOptions {
  /** 锁视为陈旧的阈值，默认 60s。 */
  staleMs?: number;
}

function readLockPayload(lockPath: string): { pid?: unknown; ts?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (parsed && typeof parsed === "object") return parsed as { pid?: unknown; ts?: unknown };
    return null;
  } catch {
    return null;
  }
}

/** 尝试获取互斥文件锁；失败（被持有且未陈旧）返回 null，绝不阻塞等待。 */
export function lockFileSync(lockPath: string, options: LockOptions = {}): FileLock | null {
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
  // 至多两次：首次 wx 失败后，仅在锁已陈旧时删除重试一次。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, payload, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return { path: lockPath, pid: process.pid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      const existing = readLockPayload(lockPath);
      const ts = typeof existing?.ts === "number" ? existing.ts : 0;
      if (Date.now() - ts <= staleMs) return null;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return null; // 已被其他进程抢走
      }
    }
  }
  return null;
}

/** 释放锁；锁已被他人重写或已不存在时静默跳过。 */
export function unlockFileSync(lock: FileLock): void {
  const existing = readLockPayload(lock.path);
  if (existing && existing.pid !== lock.pid) return;
  try {
    fs.unlinkSync(lock.path);
  } catch {
    // 锁文件已消失，视为已释放。
  }
}
