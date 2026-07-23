/**
 * Safe, bounded input for a future edit/write pending-Diff renderer.
 *
 * This module is intentionally data-only: it neither registers a renderer nor
 * writes files. Every existing target is realpathed before opening and read
 * through the verified descriptor, so a preview never follows a symlink out of
 * the workspace or reads more than 1 MiB plus one boundary byte.
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_PENDING_PREVIEW_BYTES = 1_000_000;

export type PendingPreviewProblem =
	| "invalid-path"
	| "workspace-unavailable"
	| "outside-workspace"
	| "missing"
	| "unreadable"
	| "not-regular-file"
	| "too-large";

export type PendingPreviewRead = Readonly<
	| { ok: true; workspacePath: string; resolvedPath: string; content: string; bytes: number }
	| { ok: false; problem: PendingPreviewProblem; message: string }
>;

function isWithinWorkspace(workspacePath: string, targetPath: string): boolean {
	const pathFromWorkspace = relative(workspacePath, targetPath);
	return pathFromWorkspace === "" || (
		pathFromWorkspace !== ".." &&
		!pathFromWorkspace.startsWith(`..${sep}`) &&
		!isAbsolute(pathFromWorkspace)
	);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function failed(problem: PendingPreviewProblem, message: string): PendingPreviewRead {
	return Object.freeze({ ok: false, problem, message });
}

function resolveWorkspace(cwd: string): string | PendingPreviewRead {
	try {
		const workspacePath = realpathSync(cwd);
		if (!statSync(workspacePath).isDirectory()) {
			return failed("workspace-unavailable", "当前工作区不是可访问的目录。");
		}
		return workspacePath;
	} catch {
		return failed("workspace-unavailable", "当前工作区无法解析，未读取预览文件。");
	}
}

/**
 * Read an existing regular UTF-8 file only when it resolves beneath cwd.
 * Missing targets are reported explicitly so a write preview can represent a
 * pending create without probing elsewhere on disk.
 */
export function readWorkspacePendingPreview(cwd: string, rawPath: unknown): PendingPreviewRead {
	if (typeof rawPath !== "string" || rawPath.trim() === "" || rawPath.includes("\0")) {
		return failed("invalid-path", "预览路径无效。");
	}

	const workspace = resolveWorkspace(cwd);
	if (typeof workspace !== "string") return workspace;

	const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspace, rawPath);
	// Reject lexically before realpath so arbitrary outside locations are never probed.
	if (!isWithinWorkspace(workspace, candidate)) {
		return failed("outside-workspace", "预览目标位于当前工作区之外。");
	}

	let target: string;
	try {
		target = realpathSync(candidate);
	} catch (error) {
		return errorCode(error) === "ENOENT"
			? failed("missing", "预览目标尚不存在。")
			: failed("unreadable", "预览目标无法解析。")
	}
	if (!isWithinWorkspace(workspace, target)) {
		return failed("outside-workspace", "预览目标解析后位于当前工作区之外。");
	}

	let descriptor: number | undefined;
	try {
		// Avoid following a final symlink swapped in after realpath(). Node lacks
		// portable openat() directory handles, so the canonical-path validation
		// plus O_NOFOLLOW (where available) is the strongest cross-runtime guard.
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		descriptor = openSync(target, constants.O_RDONLY | noFollow);
		const stats = fstatSync(descriptor);
		if (!stats.isFile()) return failed("not-regular-file", "预览目标不是常规文件。");
		if (stats.size > MAX_PENDING_PREVIEW_BYTES) {
			return failed("too-large", `预览目标超过 ${MAX_PENDING_PREVIEW_BYTES} 字节读取上限。`);
		}

		// Always reserve one extra byte: if the file grows during reading, it is
		// rejected rather than quietly exceeding the promised 1 MiB boundary.
		const buffer = Buffer.allocUnsafe(MAX_PENDING_PREVIEW_BYTES + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const read = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
			if (read === 0) break;
			bytes += read;
		}
		if (bytes > MAX_PENDING_PREVIEW_BYTES) {
			return failed("too-large", `预览目标超过 ${MAX_PENDING_PREVIEW_BYTES} 字节读取上限。`);
		}
		return Object.freeze({
			ok: true,
			workspacePath: workspace,
			resolvedPath: target,
			content: buffer.toString("utf8", 0, bytes),
			bytes,
		});
	} catch {
		return failed("unreadable", "预览目标无法作为常规文件读取。");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}
