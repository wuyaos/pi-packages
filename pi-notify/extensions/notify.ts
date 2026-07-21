/**
 * pi-notify — 任务完成桌面通知。
 *
 * agent_start 记录运行开始，agent_settled（pi 空闲）时若运行时长
 * ≥ PI_NOTIFY_MIN_SECONDS（默认 10s）则弹桌面通知。短任务不打扰。
 *
 * 跨平台通知（按优先级 fallback）：
 * Windows/WSL：
 *   1. WinRT Toast（现代 Toast，带 pi 图标；需先运行 /notify-install 注册 AUMID）
 *   2. powershell.exe BalloonTip（老式，无需注册，保底）
 * Linux：notify-send（WSLg 也走这条）
 * macOS：osascript
 *
 * 配置：
 *   PI_NOTIFY_MIN_SECONDS — 最小运行秒数才通知（默认 10）
 *   PI_NOTIFY_TITLE       — 通知标题（默认 "pi"）
 *   PI_NOTIFY_DISABLE     — "1" 禁用
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { sendWinrtToast } from "./winrt-toast.js";
import { runInstall } from "./install.js";

function isWSL(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch { return false; }
}

function notifySend(title: string, body: string): boolean {
  if (!existsSync("/usr/bin/notify-send")) return false;
  execFile("notify-send", ["-a", "pi", "-i", "dialog-information", title, body], () => {});
  return true;
}

function powershellToast(title: string, body: string): boolean {
  const candidates = [
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    "powershell.exe",
  ];
  for (const ps of candidates) {
    if (ps.includes("/") && !existsSync(ps)) continue;
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(5000, '${title.replace(/'/g, "''")}', '${body.replace(/'/g, "''")}', [System.Windows.Forms.ToolTipIcon]::Info)
[System.Console]::Beep(800, 200)
Start-Sleep -Seconds 6
$n.Dispose()
`;
    try {
      execFile(ps, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 8000 }, () => {});
      return true;
    } catch { /* try next */ }
  }
  return false;
}

function tryNotify(title: string, body: string) {
  // Windows / WSL：优先 WinRT Toast（带图标、现代样式），失败回退 BalloonTip
  if (isWSL() || process.platform === "win32") {
    if (sendWinrtToast(title, body)) return true;
    if (powershellToast(title, body)) return true;
  }
  // Linux / WSLg：notify-send
  if (notifySend(title, body)) return true;
  // macOS
  if (existsSync("/usr/bin/osascript")) {
    execFile("osascript", ["-e", `display notification "${body}" with title "${title}"`], () => {});
    return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  const disabled = process.env.PI_NOTIFY_DISABLE === "1";
  const minSeconds = parseInt(process.env.PI_NOTIFY_MIN_SECONDS ?? "10", 10);
  const defaultTitle = process.env.PI_NOTIFY_TITLE ?? "pi";
  let runStart = 0;

  pi.on("agent_start", async () => {
    runStart = Date.now();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (disabled) return;
    if (!ctx.isIdle()) return; // 还有后续 run，不打扰
    if (!runStart) return;
    const elapsed = (Date.now() - runStart) / 1000;
    runStart = 0;
    if (elapsed < minSeconds) return;
    const mins = Math.floor(elapsed / 60);
    const secs = Math.floor(elapsed % 60);
    const dur = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
    // 标题用项目名（cwd 目录名），正文带会话名 + 时长 + 错误状态
    const cwd = ctx.cwd || process.cwd();
    const projectName = cwd.split(/[\/]/).filter(Boolean).pop() || "pi";
    const sessionName = ctx.sessionManager?.getSessionName?.();
    const prefix = lastErrorTool ? `⚠️ ${lastErrorTool} 出错` : "完成";
    const body = sessionName
      ? `会话「${sessionName}」${prefix} (${dur})`
      : `任务${prefix} (${dur})`;
    tryNotify(projectName, body);
  });

  pi.registerCommand("notify-test", {
    description: "测试桌面通知",
    handler: async (_args, ctx) => {
      const ok = tryNotify(defaultTitle, "pi-notify 测试");
      ctx.ui.notify(ok ? "已发送测试通知" : "未找到可用通知方式", ok ? "info" : "warning");
    },
  });

  pi.registerCommand("notify-install", {
    description: "注册 Windows Toast AUMID（首次安装后运行一次，让 Toast 能弹横幅）",
    handler: async (args, ctx) => {
      const force = (args || "").includes("--force");
      ctx.ui.notify("正在注册 AUMID...", "info");
      const result = await runInstall(force);
      ctx.ui.notify(result, "info");
    },
  });

  pi.registerCommand("notify", {
    description: "发送自定义桌面通知: /notify <标题> [正文]",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const title = parts[0] || defaultTitle;
      const body = parts.slice(1).join(" ") || "(无正文)";
      tryNotify(title, body);
      ctx.ui.notify(`已发送: ${title}`, "info");
    },
  });
}
