import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PENDING_PREVIEW_BYTES, readWorkspacePendingPreview } from "./pending-preview.ts";

function withWorkspace(run: (workspace: string, outside: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "cc-tui-preview-"));
	const workspace = join(root, "workspace");
	const outside = join(root, "outside");
	mkdirSync(workspace);
	mkdirSync(outside);
	try {
		run(workspace, outside);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("pending preview reads only regular workspace files", () => withWorkspace((workspace) => {
	writeFileSync(join(workspace, "note.txt"), "安全内容\n");
	const preview = readWorkspacePendingPreview(workspace, "note.txt");
	assert.equal(preview.ok, true);
	if (preview.ok) {
		assert.equal(preview.content, "安全内容\n");
		assert.equal(preview.bytes, Buffer.byteLength("安全内容\n"));
		assert.equal(preview.resolvedPath, join(workspace, "note.txt"));
	}

	mkdirSync(join(workspace, "folder"));
	const directory = readWorkspacePendingPreview(workspace, "folder");
	assert.deepEqual(directory.ok ? undefined : directory.problem, "not-regular-file");
}));

test("pending preview rejects lexical and symlink escapes without reading outside files", () => withWorkspace((workspace, outside) => {
	writeFileSync(join(outside, "secret.txt"), "OUTSIDE_SECRET");
	symlinkSync(join(outside, "secret.txt"), join(workspace, "escape.txt"));

	const lexical = readWorkspacePendingPreview(workspace, "../outside/secret.txt");
	assert.deepEqual(lexical.ok ? undefined : lexical.problem, "outside-workspace");
	const linked = readWorkspacePendingPreview(workspace, "escape.txt");
	assert.deepEqual(linked.ok ? undefined : linked.problem, "outside-workspace");
	assert.equal(JSON.stringify(linked).includes("OUTSIDE_SECRET"), false);
}));

test("pending preview reports missing, invalid, and oversized files without partial reads", () => withWorkspace((workspace) => {
	const missing = readWorkspacePendingPreview(workspace, "new.txt");
	assert.deepEqual(missing.ok ? undefined : missing.problem, "missing");
	const invalid = readWorkspacePendingPreview(workspace, "\0bad");
	assert.deepEqual(invalid.ok ? undefined : invalid.problem, "invalid-path");

	writeFileSync(join(workspace, "huge.txt"), "x".repeat(MAX_PENDING_PREVIEW_BYTES + 1));
	const huge = readWorkspacePendingPreview(workspace, "huge.txt");
	assert.deepEqual(huge.ok ? undefined : huge.problem, "too-large");
}));
