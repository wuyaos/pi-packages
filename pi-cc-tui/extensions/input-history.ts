/**
 * 输入历史持久化（项目级）。
 *
 * pi 内置的 ↑/↓ 历史只存在编辑器内存里：仅当前会话、/reload 后丢失、重开进程只剩启动回填。
 * 这里把最近 100 条已提交输入持久化到 <sessionDir>/input-history，同一项目（session 目录）
 * 下所有会话共享；编辑器工厂重建时（启动、/reload、切换会话）由 index.ts 从磁盘回填。
 *
 * 与 pi 原生回填的分工：session_start 时 renderInitialMessages 会把当前会话的 user 消息
 * 再次 unshift 进编辑器历史，所以回填只灌「其他会话」的部分，当前会话交给原生，避免
 * 二次回填把项目历史挤出编辑器 100 条上限。
 *
 * 历史格式：单条文本以 \0 分隔的纯文件（避免 JSON 半截写入解析失败）。
 * 已知限制：多实例同项目并发提交时为 last-write-wins，可能丢一条（无跨进程锁）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_HISTORY = 100;
const SEPARATOR = "\0";

export function historyFile(sessionDir: string): string {
	return join(sessionDir, "input-history");
}

/**
 * 读历史。ENOENT 视为无历史（[]）；其他错误返回 null，
 * 调用方应跳过写盘，避免一次读取失败把既有历史覆盖掉。
 */
export async function loadHistory(sessionDir: string): Promise<string[] | null> {
	try {
		return (await readFile(historyFile(sessionDir), "utf8"))
			.split(SEPARATOR)
			.filter(Boolean);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return null;
	}
}

export async function saveHistory(sessionDir: string, history: string[]): Promise<void> {
	await mkdir(sessionDir, { recursive: true });
	await writeFile(historyFile(sessionDir), history.join(SEPARATOR), "utf8");
}

/** 去重置顶；strip NUL（分隔符保留字符）后为空则原样返回。 */
export function pushHistory(history: string[], text: string): string[] {
	const clean = text.replace(/\0/g, "").trim();
	if (!clean) return history;
	const next = [clean, ...history.filter((h) => h !== clean)];
	return next.length > MAX_HISTORY ? next.slice(0, MAX_HISTORY) : next;
}

/** 当前会话已提交的用户文本（旧→新），口径与 pi 的 getUserMessageText 一致。 */
export function sessionUserTexts(ctx: ExtensionContext): string[] {
	const texts: string[] = [];
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			content?: string | null | Array<{ type: string; text?: string }>;
		};
		if (message.role !== "user" || message.content == null) continue;
		const blocks = typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.filter((block) => block.type === "text");
		const text = blocks.map((block) => block.text ?? "").join("").trim();
		if (text) texts.push(text);
	}
	return texts;
}

/** 从持久化历史中扣除当前会话已计入的条目（按出现次数，避免误删其他会话的同名输入），保持新→旧。 */
export function otherSessionHistory(persisted: string[], sessionTexts: string[]): string[] {
	const counts = new Map<string, number>();
	for (const text of sessionTexts) counts.set(text, (counts.get(text) ?? 0) + 1);
	return persisted.filter((h) => {
		const remaining = counts.get(h) ?? 0;
		if (remaining > 0) {
			counts.set(h, remaining - 1);
			return false;
		}
		return true;
	});
}

/**
 * 全量回填（reload / resume / new / fork / apply 等无原生回填或原生回填被丢弃的路径）：
 * 当前会话新→旧在前，其他会话在后。
 */
export function fullHistory(persisted: string[], sessionTexts: string[]): string[] {
	return [...[...sessionTexts].reverse(), ...otherSessionHistory(persisted, sessionTexts)];
}
