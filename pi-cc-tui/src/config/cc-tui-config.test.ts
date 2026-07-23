import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	archiveCorruptCcTuiConfig,
	DEFAULT_SEGMENTS,
	hasCcTuiIconConfiguration,
	loadCcTuiConfig,
	parseCcTuiConfig,
	resolveCcTuiIcons,
	saveCcTuiIcons,
	saveCcTuiSegments,
} from "./cc-tui-config.ts";
import { updateJsonObject } from "./json-store.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "cc-tui-config-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("missing configuration uses defaults without creating a file", () => {
	withTempDir((dir) => {
		const path = join(dir, "config", "cc-tui.json");
		assert.deepEqual(loadCcTuiConfig(path).segments, DEFAULT_SEGMENTS);
		assert.equal(existsSync(path), false);
		saveCcTuiSegments(DEFAULT_SEGMENTS, path);
		assert.equal(statSync(path).mode & 0o777, 0o600);
	});
});

test("segment saves migrate legacy files and preserve unrelated future settings", () => {
	withTempDir((dir) => {
		const path = join(dir, "cc-tui.json");
		writeFileSync(path, JSON.stringify({ segments: { cost: true }, future: { keep: true } }));
		const config = saveCcTuiSegments({ ...DEFAULT_SEGMENTS, tokens: true }, path);
		const stored = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(config.version, 1);
		assert.equal(config.segments.tokens, true);
		assert.equal(stored.version, 1);
		assert.deepEqual(stored.future, { keep: true });
		assert.equal(stored.segments.cost, false);
	});
});

test("icon saves use the same versioned document and resolve semantic icons", () => {
	withTempDir((dir) => {
		const path = join(dir, "cc-tui.json");
		assert.equal(hasCcTuiIconConfiguration(path), false);
		const config = saveCcTuiIcons({ mode: "ascii", overrides: { success: "done" } }, path);
		assert.equal(hasCcTuiIconConfiguration(path), true);
		assert.equal(config.icons.mode, "ascii");
		assert.equal(resolveCcTuiIcons(config).success, "done");
		assert.equal(resolveCcTuiIcons(config).path, "cwd");
	});
});

test("atomic updates retain existing permissions and safely follow an existing config symlink", () => {
	withTempDir((dir) => {
		const target = join(dir, "target.json");
		const link = join(dir, "cc-tui.json");
		writeFileSync(target, JSON.stringify({ segments: {} }));
		chmodSync(target, 0o640);
		symlinkSync(target, link);

		saveCcTuiSegments({ ...DEFAULT_SEGMENTS, bar: true }, link);
		assert.equal(lstatSync(link).isSymbolicLink(), true);
		assert.equal(JSON.parse(readFileSync(target, "utf8")).segments.bar, true);
		assert.equal(statSync(target).mode & 0o777, 0o640);
	});
});

test("corrupt configuration is never overwritten and can only be archived explicitly", () => {
	withTempDir((dir) => {
		const path = join(dir, "cc-tui.json");
		writeFileSync(path, "{ broken");
		assert.deepEqual(loadCcTuiConfig(path).segments, DEFAULT_SEGMENTS);
		assert.throws(
			() => saveCcTuiSegments({ ...DEFAULT_SEGMENTS, cost: true }, path),
			/Refusing to overwrite corrupt/,
		);
		assert.equal(readFileSync(path, "utf8"), "{ broken");
		const archivePath = archiveCorruptCcTuiConfig(path, 1234);
		assert.equal(archivePath, join(dir, "cc-tui.corrupt-1234.json"));
		assert.equal(existsSync(path), false);
		assert.equal(readFileSync(archivePath!, "utf8"), "{ broken");
	});
});

test("generic update rejects malformed JSON and parser ignores invalid fields", () => {
	withTempDir((dir) => {
		const path = join(dir, "cc-tui.json");
		writeFileSync(path, "[]");
		assert.throws(() => updateJsonObject(path, () => undefined), /Refusing to overwrite corrupt/);
		const config = parseCcTuiConfig({
			version: -1,
			segments: { model: false, cost: "not-a-bool" },
			icons: { mode: "not-a-mode", overrides: { success: "" } },
		});
		assert.equal(config.version, 1);
		assert.equal(config.segments.model, false);
		assert.equal(config.segments.cost, false);
		assert.equal(resolveCcTuiIcons(config).success, "✓");
	});
});
