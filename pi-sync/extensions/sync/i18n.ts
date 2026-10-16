export type SyncLanguage = "en" | "zh";

const EN = {
  on: "ON",
  off: "OFF",
  enabled: "enabled",
  disabled: "disabled",
  keepAll: "keep all",
  back: "b ← Back",

  menuTitle: "Pi WebDAV Backup",
  menuBackup: "⬆️  Back Up",
  menuRestore: "⬇️  Restore",
  menuRepair: "🛠️  Repair Cross-Platform Issues",
  menuSettings: "⚙️  Settings",
  menuQuit: "x ✕ Quit",
  switchLanguage: "🌐 Language: English → 中文",

  backupSelectTitle: "Select categories to back up",
  runBackupAction: "[Ctrl+S Run Backup]",
  categoryMissingDir: "{kind} (directory missing)",
  backupSummary: "Backup finished:\n{results}",
  backupRunningTitle: "Backing up…",
  restoreRunningTitle: "Restoring…",
  progressCompleted: "Progress: {completed}/{total}",
  progressCurrent: "Current: {value}",
  commandError: "Sync command failed: {error}",
  resultRowOk: "{status} {kind}: {text}",
  resultRowFail: "{status} {kind}: {text}",
  lockBusy: "another backup is running",

  restoreSelectTitle: "Select an archive set to restore",
  restorePickTitle: "Select categories to restore",
  runRestoreAction: "[Ctrl+S Run Restore]",
  restoreNoArchives: "No restore archives found on the server.",
  deviceFilterAll: "All devices",
  deviceFilterLabel: "Device: {value}  (←/→ to switch)",
  localBadge: "[local]",
  platformWin: "Windows",
  platformLinux: "Linux",
  platformMac: "macOS",
  restoreSourceBrief: "归档来自 {device}（{platform}），跨设备恢复后如路径异常可用「修复」处理。",
  restoreSourceBrief: "Archive from {device} ({platform}). Run Repair if paths break after cross-device restore.",
  restoreCrossPlatformWarn: "These archives were created on {platform}; embedded paths recorded for the other OS may need Repair afterwards.",
  restoreSummary: "Restore finished:\n{results}",
  restoreInterrupted: "Stopped after a failure; completed items are listed above.",

  repairTitle: "Cross-Platform Repair",
  repairNoIssues: "No platform-specific issues found.",
  repairRunAction: "[Ctrl+S Apply Fixes]",
  repairSuggestTarget: "clear (use Pi default)",
  repairManualTarget: "edit manually",
  repairActionAuto: "auto",
  repairActionSuggest: "suggest",
  repairActionManual: "manual",
  repairWslWarn: "WSL path: fix manually",
  repairAfterRestore: "Run cross-platform repair with the source-home mapping from this archive?",
  repairPromptValue: "Edit value for {key}:",
  repairReport: "Fixed: {fixed} · Skipped: {skipped} · Manual: {manual}",

  settingsTitle: "Settings",
  settingsWebdav: "WebDAV: {value}",
  settingsExitBackup: "Back up on exit: {value} (skips when nothing changed)",
  settingsExitScope: "Exit backup categories: {value}",
  settingsDeviceName: "Device name: {value}",
  settingsRemoteBaseDir: "Archive base dir (from WebDAV app root): {value}",
  promptDeviceName: "Device name (letters, digits, dash):",
  promptRemoteBaseDir: "Archive base dir on WebDAV, full path from the app root (e.g. sync/pibak/):",
  remoteBaseDirInvalid: "Invalid prefix; each segment may only contain letters, digits, dot, dash, underscore.",
  exitBackupNoChanges: "Nothing changed since the last backup; skipped.",

  piExcludePaths: "Pi Backup Exclusions: {value}",
  maxCloudBackups: "Max Cloud Backups: {value}",
  language: "Language: English",
  notSet: "(not set)",
  passwordSet: "(set)",
  none: "(none)",
  piKind: "Pi",
  skillsKind: "Skills",
  cortexkitKind: "Magic Context",

  setupRequired: "WebDAV is not configured. Please set it up now.",
  promptWebdavUrl: "WebDAV URL:",
  promptWebdavUsername: "WebDAV username:",
  promptWebdavPassword: "WebDAV token (or $ENV_VAR):",
  promptExcludePaths: "Excluded paths (comma separated, relative to ~/.pi/agent):",
  promptMaxBackups: "Maximum backups (0 = keep all):",
  configSaved: "Backup configuration updated.",

} as const;

export type TranslationKey = keyof typeof EN;
type TranslationParams = Record<string, string | number | boolean>;

const ZH: Record<TranslationKey, string> = {
  on: "开启",
  off: "关闭",
  enabled: "已启用",
  disabled: "已禁用",
  keepAll: "全部保留",
  back: "b ← 返回",

  menuTitle: "Pi WebDAV 备份",
  menuBackup: "⬆️  备份",
  menuRestore: "⬇️  恢复",
  menuRepair: "🛠️  修复跨平台问题",
  menuSettings: "⚙️  设置",
  menuQuit: "x ✕ 退出",
  switchLanguage: "🌐 语言：中文 → English",

  backupSelectTitle: "选择要备份的类别",
  runBackupAction: "[Ctrl+S 运行备份]",
  categoryMissingDir: "{kind}（目录缺失）",
  backupSummary: "备份完成：\n{results}",
  backupRunningTitle: "备份中…",
  restoreRunningTitle: "恢复中…",
  progressCompleted: "进度：{completed}/{total}",
  progressCurrent: "当前：{value}",
  commandError: "同步命令执行失败：{error}",
  resultRowOk: "{status} {kind}：{text}",
  resultRowFail: "{status} {kind}：{text}",
  lockBusy: "另一个备份正在进行",

  restoreSelectTitle: "选择要恢复的归档",
  restorePickTitle: "勾选要恢复的类别",
  runRestoreAction: "[Ctrl+S 运行恢复]",
  restoreNoArchives: "服务器上没有可恢复的归档。",
  deviceFilterAll: "全部设备",
  deviceFilterLabel: "设备：{value}（←/→ 切换）",
  localBadge: "［本机］",
  platformWin: "Windows",
  platformLinux: "Linux",
  platformMac: "macOS",
  restoreCrossPlatformWarn: "归档来自 {platform} 平台，其中另一操作系统的路径事后可能需要用「修复」处理。",
  restoreOtherDeviceWarn: "归档来自设备「{device}」。",
  restoreSummary: "恢复完成：\n{results}",
  restoreInterrupted: "失败后已中断，上方为已完成项。",

  repairTitle: "跨平台修复",
  repairNoIssues: "未发现平台特定问题。",
  repairRunAction: "[Ctrl+S 执行修复]",
  repairSuggestTarget: "清空（使用 Pi 默认）",
  repairManualTarget: "需人工修改",
  repairActionAuto: "自动",
  repairActionSuggest: "建议",
  repairActionManual: "手动",
  repairWslWarn: "WSL 路径：需人工修改",
  repairAfterRestore: "是否立即运行跨平台修复（使用归档的源 home 映射）？",
  repairPromptValue: "编辑 {key} 的值：",
  repairReport: "已修复 {fixed} · 跳过 {skipped} · 待人工 {manual}",

  settingsTitle: "设置",
  settingsWebdav: "WebDAV：{value}",
  settingsExitBackup: "退出时备份：{value}（无变化时跳过）",
  settingsExitScope: "退出备份类别：{value}",
  settingsDeviceName: "设备名：{value}",
  settingsRemoteBaseDir: "归档根目录（自 WebDAV 应用根起）：{value}",
  promptDeviceName: "设备名（字母、数字、连字符）：",
  promptRemoteBaseDir: "WebDAV 归档根目录，自应用根起的完整路径（如 sync/pibak/）：",
  remoteBaseDirInvalid: "前缀无效：每段仅允许字母、数字、点、连字符、下划线。",
  exitBackupNoChanges: "数据无变化，已跳过备份。",

  piExcludePaths: "Pi 备份排除项：{value}",
  maxCloudBackups: "云端最大备份数：{value}",
  language: "语言：中文",
  notSet: "（未设置）",
  passwordSet: "（已设置）",
  none: "（无）",
  piKind: "Pi",
  skillsKind: "Skills",
  cortexkitKind: "Magic Context 配置",

  setupRequired: "尚未配置 WebDAV，请先完成设置。",
  promptWebdavUrl: "WebDAV 地址：",
  promptWebdavUsername: "WebDAV 用户名：",
  promptWebdavPassword: "WebDAV 令牌（或 $ENV_VAR）：",
  promptExcludePaths: "排除路径（以逗号分隔，相对于 ~/.pi/agent）：",
  promptMaxBackups: "最大备份数（0 = 全部保留）：",
  configSaved: "备份配置已更新。",

};

const STRINGS: Record<SyncLanguage, Record<TranslationKey, string>> = { en: EN, zh: ZH };

export function normalizeLanguage(value: unknown): SyncLanguage {
  return typeof value === "string" && value.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function t(language: SyncLanguage, key: TranslationKey, params?: TranslationParams): string {
  let message = STRINGS[language][key];
  if (!params) return message;
  for (const [name, value] of Object.entries(params)) message = message.split(`{${name}}`).join(String(value));
  return message;
}
