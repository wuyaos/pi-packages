import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AtomicWriteOptions {
  mode?: number;
}

/** 同目录临时文件 + fsync + rename，避免留下半截配置、JSON 或报告。 */
export function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", options.mode ?? 0o666);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    if (options.mode !== undefined) fs.chmodSync(filePath, options.mode);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

export function writeJsonAtomic(filePath: string, value: unknown, options: AtomicWriteOptions = {}): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n", options);
}
