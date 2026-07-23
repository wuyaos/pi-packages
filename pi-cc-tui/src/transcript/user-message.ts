/** User-message transcript patch with bounded per-instance render caching. */

import { type ExtensionAPI, type Theme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { installPrototypePatch } from "../runtime/prototype-patch.ts";
import { renderUserMessageChrome } from "./user-message-chrome.ts";

const MAX_CACHE_LINES = 80;
const MAX_CACHE_CHARS = 64 * 1024;

type RuntimeUserMessage = { text?: unknown };
type CachedRender = { width: number; theme: Theme | undefined; text: string | undefined; lines: string[] };
const cache = new WeakMap<object, CachedRender>();

function isCacheable(lines: readonly string[]): boolean {
	if (lines.length > MAX_CACHE_LINES) return false;
	let chars = 0;
	for (const line of lines) {
		chars += line.length;
		if (chars > MAX_CACHE_CHARS) return false;
	}
	return true;
}

function isStringLines(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((line) => typeof line === "string");
}

export function installUserMessageTranscript(pi: ExtensionAPI): void {
	let activeTheme: Theme | undefined;
	const renderCleanup = installPrototypePatch(
		UserMessageComponent.prototype,
		"render",
		"cc-tui:user-message-render",
		({ predecessor, receiver, args }) => {
			const width = args[0];
			if (typeof width !== "number") return Reflect.apply(predecessor, receiver, args);
			const runtime = receiver as RuntimeUserMessage;
			const text = typeof runtime.text === "string" ? runtime.text : undefined;
			const cached = cache.get(receiver as object);
			if (cached?.width === width && cached.theme === activeTheme && cached.text === text) return cached.lines;

			const rendered = Reflect.apply(predecessor, receiver, args);
			if (!isStringLines(rendered)) return rendered;
			const lines = renderUserMessageChrome(rendered, width, (token, value) =>
				activeTheme?.fg(token === "border" ? "border" : "accent", value) ?? value,
			);
			if (isCacheable(lines)) cache.set(receiver as object, { width, theme: activeTheme, text, lines });
			return lines;
		},
	);
	const invalidateCleanup = installPrototypePatch(
		UserMessageComponent.prototype,
		"invalidate",
		"cc-tui:user-message-invalidate",
		({ predecessor, receiver, args }) => {
			cache.delete(receiver as object);
			return Reflect.apply(predecessor, receiver, args);
		},
	);

	pi.on("session_start", (_event, ctx) => {
		activeTheme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
	});
	pi.on("session_shutdown", () => {
		activeTheme = undefined;
		invalidateCleanup();
		renderCleanup();
	});
}
