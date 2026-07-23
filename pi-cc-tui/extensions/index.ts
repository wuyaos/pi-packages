/**
 * pi-cc-tui 的唯一扩展入口。
 *
 * 所有可见 UI 的生命周期均从此处注册，避免 package glob 让辅助模块被
 * 当作独立扩展加载，亦为后续 tools/widgets/overlays 提供稳定的装配边界。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installCodexEditor from "./codex-editor.ts";
import installCommands from "./commands.ts";
import installStartupHeader from "./startup-header.ts";
import installStatusline from "./statusline.ts";
import installThinking from "./thinking.ts";
import { installUserMessageTranscript } from "../src/transcript/user-message.ts";
import { installLowRiskBuiltinRenderers } from "../src/tools/read-search-renderers.ts";
import { installBashRenderer } from "../src/tools/bash-renderer.ts";
import { installEditWriteRenderers } from "../src/tools/edit-write-renderers.ts";

export default function installCcTui(pi: ExtensionAPI): void {
	installCommands(pi);
	installStartupHeader(pi);
	installCodexEditor(pi);
	installThinking(pi);
	installUserMessageTranscript(pi);
	// Coexists safely with pi-tool-display: this registers only still-built-in
	// read/grep/find/ls definitions and never replaces an extension-owned tool.
	installLowRiskBuiltinRenderers(pi);
	const disposeBashRenderer = installBashRenderer(pi);
	installEditWriteRenderers(pi);
	pi.on("session_shutdown", () => disposeBashRenderer());
	installStatusline(pi);
}
