/**
 * Public-API renderers for edit and write, isolated from Todo and from the
 * pending-preview/projection data layers. They reuse the safe data layers to
 * produce bounded pending and result Diff summaries without re-implementing
 * filesystem access or replacement logic.
 */

import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getIcons } from "../ui/icons.ts";
import {
	buildBoundedDiffSummary,
	projectExactEdits,
	projectWriteContent,
} from "../diff/projection.ts";
import { readWorkspacePendingPreview } from "../diff/pending-preview.ts";
import {
	buildBoundedToolPreview,
	isBuiltinToolOwner,
	sanitizeToolDisplayText,
} from "./read-search-summary.ts";

type EditArgs = Readonly<{ path?: unknown; edits?: unknown; oldText?: unknown; newText?: unknown }>;
type WriteArgs = Readonly<{ path?: unknown; file_path?: unknown; content?: unknown }>;
type EditDetails = Readonly<{ diff?: unknown; patch?: unknown; firstChangedLine?: unknown }>;
type AnyToolResult = AgentToolResult<unknown>;

function pathFromArgs(args: { path?: unknown; file_path?: unknown }): string {
	const raw = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
	return raw || "…";
}

function joinSummaryLines(lines: readonly string[], expanded: boolean): string {
	const preview = buildBoundedToolPreview(lines.join("\n"), expanded);
	return preview.lines.join("\n");
}

function renderEditCall(args: EditArgs, options: ToolRenderResultOptions, theme: Theme, cwd: string, previous: Text | undefined): Text {
	const component = previous ?? new Text("", 0, 0);
	const rawPath = pathFromArgs(args);
	const header = `${getIcons().tool} edit ${rawPath}`;

	// Only compute the pending preview once arguments are complete, avoiding
	// repeated filesystem reads while the model is still streaming edits.
	if (!options.isPartial && typeof args.edits !== "undefined") {
		const preview = readWorkspacePendingPreview(cwd, typeof args.path === "string" ? args.path : "");
		if (preview.ok) {
			const projection = projectExactEdits(preview.content, args);
			if (projection.ok) {
				const body = joinSummaryLines(projection.summary.lines, options.expanded);
				component.setText(`${theme.fg("toolTitle", header)}\n${theme.fg("toolOutput", body)}`);
				return component;
			}
			component.setText(`${theme.fg("toolTitle", header)}\n${theme.fg("muted", `预览不可用：${projection.reason}`)}`);
			return component;
		}
		if (preview.problem === "missing") {
			component.setText(`${theme.fg("toolTitle", header)}\n${theme.fg("muted", "新文件")}`);
			return component;
		}
		component.setText(`${theme.fg("toolTitle", header)}\n${theme.fg("muted", `预览不可用：${preview.problem}`)}`);
		return component;
	}

	component.setText(theme.fg("toolTitle", header));
	return component;
}

function renderEditResult(
	result: AnyToolResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	previous: Text | undefined,
): Text {
	const component = previous ?? new Text("", 0, 0);
	const status = isError ? `${getIcons().error} 编辑失败` : `${getIcons().success} 已应用`;
	const details = result.details as EditDetails | undefined;
	const diffText = typeof details?.diff === "string" ? sanitizeToolDisplayText(details.diff) : "";
	const summary = diffText ? buildBoundedDiffSummary("", diffText) : undefined;
	const body = summary && summary.lines.length > 0
		? `\n${theme.fg(isError ? "error" : "toolOutput", joinSummaryLines(summary.lines, options.expanded))}`
		: "";
	component.setText(`${theme.fg(isError ? "error" : "muted", status)}${body}`);
	return component;
}

function renderWriteCall(args: WriteArgs, options: ToolRenderResultOptions, theme: Theme, cwd: string, previous: Text | undefined): Text {
	const component = previous ?? new Text("", 0, 0);
	const rawPath = pathFromArgs(args);
	const header = `${getIcons().tool} write ${rawPath}`;

	if (typeof args.content === "string") {
		const previousPreview = readWorkspacePendingPreview(cwd, typeof args.path === "string" ? args.path : "");
		const previousContent = previousPreview.ok ? previewPreviousContent(previousPreview) : undefined;
		const projection = projectWriteContent(previousContent, args.content);
		if (projection.ok) {
			const body = joinSummaryLines(projection.summary.lines, options.expanded);
			component.setText(`${theme.fg("toolTitle", header)}\n${theme.fg("toolOutput", body)}`);
			return component;
		}
		component.setText(`${theme.fg("toolTitle", header)}\n${theme.fg("muted", `预览不可用：${projection.reason}`)}`);
		return component;
	}

	component.setText(theme.fg("toolTitle", header));
	return component;
}

function previewPreviousContent(preview: { content: string }): string | undefined {
	return preview.content;
}

function renderWriteResult(
	result: AnyToolResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	previous: Text | undefined,
): Text {
	const component = previous ?? new Text("", 0, 0);
	const status = isError ? `${getIcons().error} 写入失败` : `${getIcons().success} 已写入`;
	const output = sanitizeToolDisplayText(
		result.content
			?.filter((block) => block?.type === "text")
			.map((block) => (block as { text?: unknown }).text ?? "")
			.join("\n") ?? "",
	);
	const preview = buildBoundedToolPreview(output, options.expanded);
	const body = preview.lines.length > 0
		? `\n${theme.fg(isError ? "error" : "toolOutput", preview.lines.join("\n"))}`
		: "";
	component.setText(`${theme.fg(isError ? "error" : "muted", status)}${body}`);
	return component;
}

function installEditRenderer(pi: ExtensionAPI): boolean {
	const edit = pi.getAllTools().find((tool) => tool.name === "edit");
	if (!isBuiltinToolOwner(edit)) return false;
	const base = createEditToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		renderCall(args, theme, context) {
			return renderEditCall(
				args as EditArgs,
				{ expanded: context.expanded, isPartial: context.isPartial },
				theme,
				context.cwd,
				context.lastComponent as Text | undefined,
			);
		},
		renderResult(result, options, theme, context) {
			return renderEditResult(result, options, theme, context.isError, context.lastComponent as Text | undefined);
		},
	});
	return true;
}

function installWriteRenderer(pi: ExtensionAPI): boolean {
	const write = pi.getAllTools().find((tool) => tool.name === "write");
	if (!isBuiltinToolOwner(write)) return false;
	const base = createWriteToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		renderCall(args, theme, context) {
			return renderWriteCall(
				args as WriteArgs,
				{ expanded: context.expanded, isPartial: context.isPartial },
				theme,
				context.cwd,
				context.lastComponent as Text | undefined,
			);
		},
		renderResult(result, options, theme, context) {
			return renderWriteResult(result, options, theme, context.isError, context.lastComponent as Text | undefined);
		},
	});
	return true;
}

/**
 * Register edit/write renderers only while they remain builtin-owned. If
 * pi-tool-display (or another extension) already owns them, cc-tui leaves the
 * existing renderer in place to avoid dual ownership.
 */
export function installEditWriteRenderers(pi: ExtensionAPI): { edit: boolean; write: boolean } {
	return {
		edit: installEditRenderer(pi),
		write: installWriteRenderer(pi),
	};
}
