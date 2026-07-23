/** Pi 原生启动资源清单的全局设置适配。 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonObject, updateJsonObject } from "./json-store.ts";

export const PI_SETTINGS_PATH = join(
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
	"settings.json",
);

/**
 * Pi 的 quietStartup 会同时隐藏内置启动帮助和资源清单；CC-TUI 自有启动头仍会
 * 正常安装。配置缺失或不可读时保留 Pi 的默认行为（显示资源）。
 */
export function isStartupResourceListingVisible(path = PI_SETTINGS_PATH): boolean {
	const state = readJsonObject(path);
	return state.kind !== "valid" || state.record.quietStartup !== true;
}

/**
 * 保存到 Pi 全局 settings。项目级 quietStartup 若存在，仍可能覆盖此全局偏好。
 * 调用方应提示用户 reload 或重启，以便 Pi 在初始化资源容器前读取新值。
 */
export function saveStartupResourceListingVisible(visible: boolean, path = PI_SETTINGS_PATH): void {
	updateJsonObject(path, (settings) => {
		settings.quietStartup = !visible;
	});
}
