export type SyncLanguage = "en" | "zh";

const EN = {
  on: "ON",
  off: "OFF",
  enabled: "enabled",
  disabled: "disabled",
  keepAll: "keep all",
  cancel: "x ✕ Cancel",
  back: "b ← Back",
  save: "s ✓ Save",

  menuTitle: "Pi WebDAV Backup",
  uploadAllBackups: "⬆️  Back Up All",
  restoreAllBackups: "⬇️  Restore All (latest)",
  uploadPiBackup: "☁️  Upload Pi Backup",
  uploadSkillsBackup: "📦 Upload Skills Backup",
  uploadCortexkitBackup: "📦 Upload Magic Context Backup",
  restorePiBackup: "📥 Restore Pi Backup",
  restoreSkillsBackup: "📥 Restore Skills Backup",
  restoreCortexkitBackup: "📥 Restore Magic Context Backup",
  configureSettings: "⚙️  Configure Backup Settings",
  switchLanguage: "🌐 Language: English → 中文",

  configureTitle: "Configure Backup Settings",
  webdavUrl: "WebDAV URL: {value}",
  webdavUsername: "WebDAV Username: {value}",
  webdavPassword: "WebDAV Password/Token: {value}",
  piBackup: "Pi Backup: {value}",
  skillsBackup: "Shared Skills Backup: {value}",
  cortexkitBackup: "Magic Context Backup: {value}",
  backupOnExit: "Back Up Enabled Categories On Exit: {value}",
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

  backupDisabled: "{kind} backup is disabled.",
  backupUploaded: "Uploaded {filename}\n{contents}{pruned}",
  backupFailed: "{kind} backup failed: {error}",
  prunedCount: "\nPruned: {count}",

  noArchivesFound: "No {kind} archives found.",
  restoreArchive: "Restore {kind} archive",
  replaceSharedSkillsTitle: "Replace shared skills?",
  replaceSharedSkillsBody: "The current ~/.agents/skills will be moved to a timestamped backup.",
  replaceCortexkitTitle: "Replace Magic Context config?",
  replaceCortexkitBody: "The current ~/.config/cortexkit will be moved to a timestamped backup.",
  restoreCompleted: "Restored {kind}:\n{contents}",
  restoreFailed: "{kind} restore failed: {error}",
  confirmPiRestoreTitle: "Restore Pi backup?",
  confirmPiRestoreBody: "Entries: {count}\n{plan}",
  confirmRestoreAllTitle: "Restore all latest backups?",
  confirmRestoreAllBody: "This restores enabled Pi, Skills, and Magic Context backups.",
  allBackupCompleted: "All backups completed:\n{results}",
  allRestoreCompleted: "Restore all completed:\n{results}",
  reloadRuntimeTitle: "Reload Runtime?",
  reloadRuntimeBody: "Reload Pi to apply the restored data?",
} as const;

export type TranslationKey = keyof typeof EN;
type TranslationParams = Record<string, string | number | boolean>;

const ZH: Record<TranslationKey, string> = {
  on: "开启",
  off: "关闭",
  enabled: "已启用",
  disabled: "已禁用",
  keepAll: "全部保留",
  cancel: "x ✕ 取消",
  back: "b ← 返回",
  save: "s ✓ 保存",

  menuTitle: "Pi WebDAV 备份",
  uploadAllBackups: "⬆️  全部备份",
  restoreAllBackups: "⬇️  全部恢复（最新）",
  uploadPiBackup: "☁️  上传 Pi 备份",
  uploadSkillsBackup: "📦 上传 Skills 备份",
  uploadCortexkitBackup: "📦 上传 Magic Context 备份",
  restorePiBackup: "📥 恢复 Pi 备份",
  restoreSkillsBackup: "📥 恢复 Skills 备份",
  restoreCortexkitBackup: "📥 恢复 Magic Context 备份",
  configureSettings: "⚙️  配置备份设置",
  switchLanguage: "🌐 语言：中文 → English",

  configureTitle: "配置备份设置",
  webdavUrl: "WebDAV 地址：{value}",
  webdavUsername: "WebDAV 用户名：{value}",
  webdavPassword: "WebDAV 密码/令牌：{value}",
  piBackup: "Pi 备份：{value}",
  skillsBackup: "共享 Skills 备份：{value}",
  cortexkitBackup: "Magic Context 配置备份：{value}",
  backupOnExit: "退出时备份已启用类别：{value}",
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

  backupDisabled: "{kind} 备份已禁用。",
  backupUploaded: "已上传 {filename}\n{contents}{pruned}",
  backupFailed: "{kind} 备份失败：{error}",
  prunedCount: "\n已清理旧备份：{count} 个",

  noArchivesFound: "未找到 {kind} 归档。",
  restoreArchive: "恢复 {kind} 归档",
  replaceSharedSkillsTitle: "替换共享 Skills？",
  replaceSharedSkillsBody: "当前 ~/.agents/skills 将移动到带时间戳的备份目录。",
  replaceCortexkitTitle: "替换 Magic Context 配置？",
  replaceCortexkitBody: "当前 ~/.config/cortexkit 将移动到带时间戳的备份目录。",
  restoreCompleted: "已恢复 {kind}：\n{contents}",
  restoreFailed: "{kind} 恢复失败：{error}",
  confirmPiRestoreTitle: "恢复 Pi 备份？",
  confirmPiRestoreBody: "归档条目：{count}\n{plan}",
  confirmRestoreAllTitle: "恢复全部最新备份？",
  confirmRestoreAllBody: "将恢复已启用的 Pi、Skills 与 Magic Context 备份。",
  allBackupCompleted: "全部备份完成：\n{results}",
  allRestoreCompleted: "全部恢复完成：\n{results}",
  reloadRuntimeTitle: "重新加载运行时？",
  reloadRuntimeBody: "现在重新加载 Pi 以应用恢复的数据？",
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
