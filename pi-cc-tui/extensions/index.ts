/**
 * pi-cc-tui 的唯一扩展入口。
 *
 * 所有可见 UI 的生命周期均从此处注册，避免 package glob 让辅助模块被
 * 当作独立扩展加载，亦为后续 tools/widgets/overlays 提供稳定的装配边界。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installEditor from "./editor.ts";
import installCommands from "./commands.ts";
import installStartupHeader from "./startup-header.ts";
import installStatusline from "./statusline.ts";

export default function installCcTui(pi: ExtensionAPI): void {
	installCommands(pi);
	installStartupHeader(pi);
	installEditor(pi);
	// pi-tool-display is the sole owner of builtin-tool, Diff, and user-message
	// rendering. CC-TUI deliberately owns only its non-conflicting UI surface.
	installStatusline(pi);
}
