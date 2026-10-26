/**
 * 恢复列表构建（引擎层）。
 *
 * 扫描三类远端目录得到的 .tar.xz 文件名按严格归档名解析（parseArchiveName，
 * 失败跳过）；同一 device + platform + 精确相同 UTC 时间戳的多个类别归档合并
 * 为一行（如 pi + skills 一次恢复）。行按时间倒序排列。
 *
 * Import: import { … } from "./restore-rows"
 */

import { parseArchiveName, type ArchiveTag, type PlatformCode } from "./archive-name";

export interface RestoreRow {
  device: string;
  platform: PlatformCode;
  /** 合并行的时间（组内所有归档文件名时间戳一致，UTC）。 */
  ts: Date;
  /** 合并的类别，固定顺序 pi → skills。 */
  tags: ArchiveTag[];
  /** 类别 → 远端文件名。 */
  files: Partial<Record<ArchiveTag, string>>;
}

export const RESTORE_TAG_ORDER: readonly ArchiveTag[] = ["pi", "skills"];

const tagOrder = (tag: ArchiveTag): number => RESTORE_TAG_ORDER.indexOf(tag);

/** 解析文件名并按 device+platform+ts 聚类；无法严格解析的名字跳过。按时间倒序。 */
export function buildRestoreRows(names: readonly string[]): RestoreRow[] {
  const groups = new Map<string, RestoreRow>();
  for (const name of names) {
    const parsed = parseArchiveName(name);
    if (!parsed) continue;
    const key = `${parsed.device}\n${parsed.platform}\n${parsed.ts.getTime()}`;
    let row = groups.get(key);
    if (!row) {
      row = { device: parsed.device, platform: parsed.platform, ts: parsed.ts, tags: [], files: {} };
      groups.set(key, row);
    }
    if (row.files[parsed.tag] === undefined) row.tags.push(parsed.tag);
    row.files[parsed.tag] = name;
  }
  for (const row of groups.values()) row.tags.sort((a, b) => tagOrder(a) - tagOrder(b));
  return [...groups.values()].sort((a, b) => b.ts.getTime() - a.ts.getTime());
}

/** 设备名列表（去重，按行在倒序列表中首次出现的顺序）。 */
export function listRowDevices(rows: readonly RestoreRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) if (!seen.has(row.device)) seen.add(row.device);
  return [...seen];
}

/** 按设备筛选；device 为空表示全部。 */
export function filterRowsByDevice(rows: readonly RestoreRow[], device?: string): RestoreRow[] {
  if (!device) return [...rows];
  return rows.filter((row) => row.device === device);
}
