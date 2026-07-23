/**
 * 用户拥有的 JSON 配置的安全原子存储。
 *
 * 写入同目录私有临时文件、fsync 后 rename，避免 Pi 在退出、崩溃或断电时留下
 * 半截 JSON。已有文件的权限会保留；符号链接会解析后写入其目标，以保持传统
 * 配置文件的链接语义。解析失败时更新操作拒绝覆盖原文件。
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type JsonRecord = Record<string, unknown>;

export type JsonFileState =
	| { kind: "missing"; writePath: string; record: JsonRecord }
	| { kind: "valid"; writePath: string; record: JsonRecord; mode: number }
	| { kind: "corrupt"; error: unknown };

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

/** Read one object-shaped JSON file without ever treating malformed JSON as empty settings. */
export function readJsonObject(path: string): JsonFileState {
	let writePath = path;
	try {
		const linkStat = lstatSync(path);
		if (linkStat.isSymbolicLink()) writePath = realpathSync(path);
		const stat = statSync(writePath);
		const parsed: unknown = JSON.parse(readFileSync(writePath, "utf8"));
		if (!isRecord(parsed)) {
			return { kind: "corrupt", error: new Error("top-level JSON value must be an object") };
		}
		return { kind: "valid", writePath, record: parsed, mode: stat.mode & 0o7777 };
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return { kind: "missing", writePath, record: {} };
		}
		return { kind: "corrupt", error };
	}
}

/**
 * Atomically replace a JSON object. Existing permissions are retained; new
 * configuration defaults to owner-readable/writable only (0600 before umask).
 */
function writeJsonObjectAtomically(path: string, record: JsonRecord, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", mode ?? 0o600);
		if (mode !== undefined) fchmodSync(descriptor, mode);
		writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporaryPath, path);
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// The original persistence error remains authoritative.
			}
		}
		try {
			unlinkSync(temporaryPath);
		} catch (cleanupError) {
			if (errorCode(cleanupError) !== "ENOENT") {
				// Best-effort cleanup must not mask the write failure.
			}
		}
		throw error;
	}
}

/**
 * Update a JSON object without clobbering a corrupt or unreadable user file.
 * The callback receives the original object so unrelated, future settings are
 * preserved by default.
 */
export function updateJsonObject(
	path: string,
	mutate: (record: JsonRecord) => void,
): JsonRecord {
	const state = readJsonObject(path);
	if (state.kind === "corrupt") {
		const detail = state.error instanceof Error ? ` (${state.error.message})` : "";
		throw new Error(`Refusing to overwrite corrupt cc-tui configuration at ${path}${detail}`);
	}
	mutate(state.record);
	writeJsonObjectAtomically(state.writePath, state.record, state.kind === "valid" ? state.mode : undefined);
	return state.record;
}
