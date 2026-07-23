/** cc-tui 的可扩展持久化配置模式与兼容迁移。 */

import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createIconSet, normalizeIconMode, type IconMode, type IconOverrides, type IconSet } from "../ui/icons.ts";
import { readJsonObject, updateJsonObject, type JsonRecord } from "./json-store.ts";

export const CC_TUI_CONFIG_VERSION = 1;
export const CC_TUI_CONFIG_PATH = join(homedir(), ".pi", "agent", "config", "cc-tui.json");

/** 当前固定三行状态栏的可见区块。 */
export type SegmentConfig = {
	model: boolean;
	context: boolean;
	tools: boolean;
	path: boolean;
	bar: boolean;
	extensions: boolean;
};

export type CcTuiConfig = Readonly<{
	version: number;
	segments: SegmentConfig;
	icons: Readonly<{
		mode: IconMode;
		overrides: IconOverrides;
	}>;
}>;

export const SEGMENT_NAMES = [
	"model",
	"context",
	"tools",
	"path",
	"bar",
	"extensions",
] as const;

export type SegmentName = (typeof SEGMENT_NAMES)[number];

export const DEFAULT_SEGMENTS: SegmentConfig = Object.freeze({
	model: true,
	context: true,
	tools: false,
	path: true,
	bar: false,
	extensions: true,
});

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSegments(value: unknown): SegmentConfig {
	const record = isRecord(value) ? value : {};
	const segments: SegmentConfig = { ...DEFAULT_SEGMENTS };
	for (const name of SEGMENT_NAMES) {
		if (typeof record[name] === "boolean") segments[name] = record[name] as boolean;
	}
	return segments;
}

function normalizeIconOverrides(value: unknown): IconOverrides {
	if (!isRecord(value)) return {};
	const overrides: IconOverrides = {};
	for (const [key, icon] of Object.entries(value)) {
		if (typeof icon === "string" && icon.length > 0) {
			overrides[key as keyof IconOverrides] = icon;
		}
	}
	return overrides;
}

/** Parse permissively; unknown future keys remain on disk but do not affect this version. */
export function parseCcTuiConfig(value: unknown): CcTuiConfig {
	const record = isRecord(value) ? value : {};
	const iconRecord = isRecord(record.icons) ? record.icons : {};
	return Object.freeze({
		version: typeof record.version === "number" && Number.isSafeInteger(record.version)
			? Math.max(1, record.version)
			: CC_TUI_CONFIG_VERSION,
		segments: normalizeSegments(record.segments),
		icons: Object.freeze({
			mode: normalizeIconMode(iconRecord.mode),
			overrides: normalizeIconOverrides(iconRecord.overrides),
		}),
	});
}

/** Read defaults on absent/corrupt configs; only explicit writes ever mutate a user file. */
export function loadCcTuiConfig(path = CC_TUI_CONFIG_PATH): CcTuiConfig {
	const state = readJsonObject(path);
	return state.kind === "valid" ? parseCcTuiConfig(state.record) : parseCcTuiConfig({});
}

/** True only when an on-disk config explicitly owns icon appearance. */
export function hasCcTuiIconConfiguration(path = CC_TUI_CONFIG_PATH): boolean {
	const state = readJsonObject(path);
	return state.kind === "valid" && isRecord(state.record.icons);
}

export function saveCcTuiSegments(segments: SegmentConfig, path = CC_TUI_CONFIG_PATH): CcTuiConfig {
	const record = updateJsonObject(path, (next) => {
		next.version = CC_TUI_CONFIG_VERSION;
		next.segments = normalizeSegments(segments);
	});
	return parseCcTuiConfig(record);
}

export function saveCcTuiIcons(
	icons: { mode: IconMode; overrides?: IconOverrides },
	path = CC_TUI_CONFIG_PATH,
): CcTuiConfig {
	const record = updateJsonObject(path, (next) => {
		next.version = CC_TUI_CONFIG_VERSION;
		next.icons = {
			mode: normalizeIconMode(icons.mode),
			overrides: normalizeIconOverrides(icons.overrides),
		};
	});
	return parseCcTuiConfig(record);
}

export function resolveCcTuiIcons(config: CcTuiConfig): IconSet {
	return createIconSet(config.icons);
}

/**
 * Preserve corrupt config for manual recovery, then start clean only when a
 * caller deliberately opts in. Normal runtime loading never calls this.
 */
export function archiveCorruptCcTuiConfig(path = CC_TUI_CONFIG_PATH, now = Date.now()): string | undefined {
	const state = readJsonObject(path);
	if (state.kind !== "corrupt" || !existsSync(path)) return undefined;
	const archivePath = join(dirname(path), `cc-tui.corrupt-${now}.json`);
	renameSync(path, archivePath);
	return archivePath;
}
