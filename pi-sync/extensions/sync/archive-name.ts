/**
 * 备份归档命名与解析（引擎层）。
 *
 * 统一命名格式：`<device>-<platform>-<tag>_<YYYYMMDD-HHMMSS>.tar.xz`
 * - device：经 sanitizeDeviceName 清洗，仅 [A-Za-z0-9-]
 * - platform 简码：win | mac | linux（WSL 归 linux）
 * - tag：pi | skills
 * - 时间戳一律 UTC，保证跨设备排序一致
 *
 * Import: import { … } from "./archive-name"
 */

import * as os from "node:os";

export type PlatformCode = "win" | "mac" | "linux";
export type ArchiveTag = "pi" | "skills";

export interface ParsedArchiveName {
  device: string;
  platform: PlatformCode;
  tag: ArchiveTag;
  /** 归档时间（UTC），按文件名秒级精度解析。 */
  ts: Date;
}

export const ARCHIVE_SUFFIX = ".tar.xz";

/** 严格匹配归档名；device 段与 sanitizeDeviceName 的输出字符集一致。 */
const ARCHIVE_NAME_RE = /^([A-Za-z0-9-]+)-(win|mac|linux)-(pi|skills)_(\d{8}-\d{6})\.tar\.xz$/;

/** 当前运行平台的简码。win32→win，darwin→mac，其余（含 WSL 下的 linux）→linux。 */
export function platformCode(): PlatformCode {
  const platform = os.platform();
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  return "linux";
}

/** 既有 platformTag() 值（windows11/macos 等）映射到简码；未知值归 linux。 */
export function toPlatformCode(tag: string): PlatformCode {
  switch (tag) {
    case "win":
    case "windows10":
    case "windows11":
      return "win";
    case "mac":
    case "macos":
      return "mac";
    default:
      return "linux";
  }
}

/** 设备名清洗：[A-Za-z0-9-] 以外的字符一律转 -；结果为空则回退 `pi-<platform 简码>`。 */
export function sanitizeDeviceName(raw: string): string {
  const sanitized = String(raw ?? "").replace(/[^A-Za-z0-9-]/g, "-");
  return sanitized || `pi-${platformCode()}`;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

function formatUtcStamp(tsUtc: Date): string {
  return (
    `${tsUtc.getUTCFullYear()}${pad2(tsUtc.getUTCMonth() + 1)}${pad2(tsUtc.getUTCDate())}` +
    `-${pad2(tsUtc.getUTCHours())}${pad2(tsUtc.getUTCMinutes())}${pad2(tsUtc.getUTCSeconds())}`
  );
}

/** 生成归档文件名：`<device>-<platform>-<tag>_<YYYYMMDD-HHMMSS>.tar.xz`（UTC 时间戳）。 */
export function formatArchiveName(
  device: string,
  platform: string,
  tag: string,
  tsUtc: Date | number,
): string {
  const ts = tsUtc instanceof Date ? tsUtc : new Date(tsUtc);
  return `${sanitizeDeviceName(device)}-${toPlatformCode(platform)}-${tag}_${formatUtcStamp(ts)}${ARCHIVE_SUFFIX}`;
}

/** 解析归档文件名；不符合严格格式（含旧版命名）返回 null。 */
export function parseArchiveName(filename: string): ParsedArchiveName | null {
  const match = ARCHIVE_NAME_RE.exec(filename);
  if (!match) return null;
  const device = match[1]!;
  const platform = match[2] as PlatformCode;
  const tag = match[3] as ArchiveTag;
  const stamp = match[4]!;
  const [datePart, timePart] = stamp.split("-");
  const ts = new Date(Date.UTC(
    Number(datePart!.slice(0, 4)),
    Number(datePart!.slice(4, 6)) - 1,
    Number(datePart!.slice(6, 8)),
    Number(timePart!.slice(0, 2)),
    Number(timePart!.slice(2, 4)),
    Number(timePart!.slice(4, 6)),
  ));
  return { device: device!, platform, tag, ts };
}
