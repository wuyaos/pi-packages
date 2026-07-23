/** Public-API renderers for the low-risk read/search tool batch. */

import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type AgentToolResult,
	type ExtensionAPI,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	describeReadSearchCall,
	describeReadSearchResult,
	isBuiltinToolOwner,
	toolResultText,
	type ReadSearchArgs,
	type ReadSearchToolName,
} from "./read-search-summary.ts";

type BuiltinDefinition = ToolDefinition<any, any, any>;
type ToolFactory = (cwd: string) => BuiltinDefinition;

const TOOL_FACTORIES: Readonly<Record<ReadSearchToolName, ToolFactory>> = {
	read: createReadToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

export const LOW_RISK_BUILTIN_TOOLS = Object.freeze(Object.keys(TOOL_FACTORIES) as ReadSearchToolName[]);

function renderCall(name: ReadSearchToolName, args: ReadSearchArgs, theme: Theme, previous: Text | undefined): Text {
	const component = previous ?? new Text("", 0, 0);
	component.setText(theme.fg("toolTitle", describeReadSearchCall(name, args)));
	return component;
}

function renderResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	previous: Text | undefined,
): Text {
	const component = previous ?? new Text("", 0, 0);
	const body = describeReadSearchResult(toolResultText(result), options.expanded);
	component.setText(body ? `\n${theme.fg(isError ? "error" : "toolOutput", body)}` : "");
	return component;
}

/**
 * Same-name registration is Pi's supported override mechanism. To avoid dual
 * renderer ownership we only register when `getAllTools()` still says builtin.
 * If pi-tool-display (or another extension) owns a tool, it remains untouched.
 */
export function installLowRiskBuiltinRenderers(pi: ExtensionAPI): readonly ReadSearchToolName[] {
	const configured = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const installed: ReadSearchToolName[] = [];

	for (const name of LOW_RISK_BUILTIN_TOOLS) {
		if (!isBuiltinToolOwner(configured.get(name))) continue;
		const factory = TOOL_FACTORIES[name];
		const base = factory(process.cwd());
		pi.registerTool({
			...base,
			renderCall(args, theme, context) {
				return renderCall(name, args as ReadSearchArgs, theme, context.lastComponent as Text | undefined);
			},
			renderResult(result, options, theme, context) {
				return renderResult(result, options, theme, context.isError, context.lastComponent as Text | undefined);
			},
		});
		installed.push(name);
	}

	return Object.freeze(installed);
}
