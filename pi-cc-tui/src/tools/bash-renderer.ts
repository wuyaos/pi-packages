/** Public ToolDefinition renderer for Bash, isolated from Diff and Todo modules. */

import {
	createBashToolDefinition,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getIcons } from "../ui/icons.ts";
import { describeReadSearchResult, isBuiltinToolOwner, toolResultText } from "./read-search-summary.ts";
import { BashActivityRegistry, bashElapsed, formatBashElapsed, type BashActivityState } from "./bash-activity.ts";

type BashArgs = Readonly<{ command?: unknown; timeout?: unknown }>;

function commandFromArgs(args: BashArgs): string {
	return typeof args.command === "string" && args.command.trim() ? args.command.trim() : "…";
}

function renderBashCall(args: BashArgs, theme: Theme, state: BashActivityState, previous: Text | undefined): Text {
	const component = previous ?? new Text("", 0, 0);
	const elapsed = bashElapsed(state);
	const activity = elapsed === undefined || state.endedAt !== undefined
		? ""
		: ` · ${getIcons().running} ${formatBashElapsed(elapsed)}`;
	component.setText(theme.fg("toolTitle", `${getIcons().tool} bash ${commandFromArgs(args)}${activity}`));
	return component;
}

function renderBashResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	state: BashActivityState,
	previous: Text | undefined,
): Text {
	const component = previous ?? new Text("", 0, 0);
	const output = describeReadSearchResult(toolResultText(result), options.expanded);
	const elapsed = bashElapsed(state);
	const duration = elapsed === undefined ? "" : ` · ${formatBashElapsed(elapsed)}`;
	const status = options.isPartial && !isError ? `${getIcons().running} 运行中${duration}` : `${isError ? getIcons().error : getIcons().success}${duration}`;
	const body = output ? `\n${theme.fg(isError ? "error" : "toolOutput", output)}` : "";
	component.setText(`${theme.fg(isError ? "error" : "muted", status)}${body}`);
	return component;
}

/**
 * Register Bash only while it remains a builtin. If pi-tool-display owns it,
 * we do nothing; explicit later migration can disable the old owner safely.
 */
export function installBashRenderer(pi: ExtensionAPI): () => void {
	const bash = pi.getAllTools().find((tool) => tool.name === "bash");
	if (!isBuiltinToolOwner(bash)) return () => {};

	const activities = new BashActivityRegistry();
	const base = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		renderCall(args, theme, context) {
			const state = context.state as BashActivityState;
			activities.observe(state, {
				executionStarted: context.executionStarted,
				isPartial: context.isPartial,
				isError: context.isError,
				invalidate: context.invalidate,
			});
			return renderBashCall(args as BashArgs, theme, state, context.lastComponent as Text | undefined);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as BashActivityState;
			activities.observe(state, {
				executionStarted: context.executionStarted,
				isPartial: options.isPartial,
				isError: context.isError,
				invalidate: context.invalidate,
			});
			return renderBashResult(result, options, theme, context.isError, state, context.lastComponent as Text | undefined);
		},
	});

	return () => activities.dispose();
}
