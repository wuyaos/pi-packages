/**
 * pi-notify — 任务完成桌面通知（带断路器 + 待答触发）。
 *
 * 触发：agent_settled（pi 空闲）时，运行时长 ≥ PI_NOTIFY_MIN_SECONDS（默认 10s）则安排通知。
 * （pi 停下来等你输入的所有场景——完成任务、问问题、权限确认——都走 agent_settled）
 *
 * 断路器（借鉴 pi-archimedes/notify）：
 *   通知不是即时弹，而是延迟 PI_NOTIFY_DELAY_MS（默认 3s）后弹；
 *   期间用户任何活动（input / 按键 / 新 run 开始）即取消 pending。
 *   delay=0 退化为即时弹。
 *
 * 跨平台通知（按优先级 fallback）：
 * Windows/WSL：
 *   1. WinRT Toast（现代 Toast，带 pi 图标；需先运行 /notify-install 注册 AUMID）
 *   2. powershell.exe BalloonTip（老式，无需注册，保底）
 * Linux：notify-send（WSLg 也走这条）
 * macOS：osascript
 *
 * 配置：
 *   PI_NOTIFY_MIN_SECONDS   — 最小运行秒数才通知（默认 10）
 *   PI_NOTIFY_DELAY_MS      — 通知延迟毫秒，期间可被取消（默认 3000；0=即时）
 *   PI_NOTIFY_TITLE         — 通知标题（默认 "pi"）
 *   PI_NOTIFY_DISABLE       — "1" 禁用
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
  const delayMs = parseInt(process.env.PI_NOTIFY_DELAY_MS ?? "3000", 10);
  const defaultTitle = process.env.PI_NOTIFY_TITLE ?? "pi";
  let runStart = 0;
  let lastErrorTool: string | null = null;

  // ── 断路器状态（借鉴 pi-archimedes/notify）──
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingNotify: { title: string; body: string } | null = null;

  function cancelPending(): void {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    pendingNotify = null;
  }

  /** 安排通知：delay>0 延迟弹（可被取消），delay=0 即时弹 */
  function scheduleNotify(title: string, body: string): void {
    cancelPending();
    if (delayMs > 0) {
      pendingNotify = { title, body };
      pendingTimer = setTimeout(() => {
        const n = pendingNotify;
        pendingNotify = null;
        pendingTimer = null;
        if (n) tryNotify(n.title, n.body);
      }, delayMs);
      pendingTimer.unref?.();
    } else {
      tryNotify(title, body);
    }
  }

  pi.on("agent_start", async () => {
    cancelPending();
    runStart = Date.now();
    lastErrorTool = null;
  });

  // 用户发消息 / 新 run 开始 → 取消 pending（用户已回屏，不需打扰）
  pi.on("input", () => cancelPending());
  pi.on("before_agent_start", () => cancelPending());


  // 跟踪本轮工具执行错误（如 bash 命令失败、文件不存在等）
  pi.on("tool_execution_end", async (event) => {
    if (event.isError && event.toolName) lastErrorTool = event.toolName;
  });

  /** 提取一条消息的纯文本（content 可能是 string 或 TextContent[] 等） */
  function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }

  /** 把摘要裁剪到单行、限定长度，避免通知正文被系统截断看不全 */
  function summarize(text: string, max = 80): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
  }

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
    // 标题用会话名（无则退回项目目录名，再无则默认标题）
    const cwd = ctx.cwd || process.cwd();
    const projectName = cwd.split(/[\/]/).filter(Boolean).pop() || "pi";
    const sessionName = ctx.sessionManager?.getSessionName?.();
    const title = sessionName || projectName || defaultTitle;
    // 正文：目录名 + 状态/时长 + 最后一条助手回复摘要
    const status = lastErrorTool ? `⚠️ ${lastErrorTool} 出错` : "完成";
    // 从当前分支倒序找最后一条助手消息
    let summary = "";
    try {
      const entries = ctx.sessionManager?.getBranch?.() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e: any = entries[i];
        if (e?.type === "message" && e.message?.role === "assistant") {
          summary = summarize(extractText(e.message.content));
          break;
        }
      }
    } catch {}
    const body = summary
      ? `${projectName} · ${status} (${dur})\n${summary}`
      : `${projectName} · ${status} (${dur})`;
    scheduleNotify(title, body);
  });

  // session_start 注册 terminal input 取消（任何按键 → 取消 pending）
  pi.on("session_start", (_e, ctx: any) => {
    ctx?.ui?.onTerminalInput?.(() => cancelPending());
  });

  pi.on("session_shutdown", () => cancelPending());

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
