/**
 * winrt-toast.ts — Windows WinRT Toast 通知后端。
 *
 * 用 PS5 (powershell.exe) + WinRT ToastGeneric API 发现代 Toast 通知。
 * 需要先运行 `/notify-install` 注册 AUMID（写注册表 + 开始菜单快捷方式），
 * 否则 Windows 11 会静默丢弃 Toast（只进通知中心，不弹横幅）。
 *
 * 中文支持：脚本写到临时 .ps1 文件（UTF-8 with BOM），用 -File 执行。
 * 不能走 -Command 命令行传参（会按系统 ANSI 转换导致乱码）。
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

// 本文件是 notify.ts 的辅助模块，并非扩展入口。
// 根目录 package.json 用 glob `pi-*/extensions/*.ts` 扫描扩展，
// 会把本文件也当入口加载，故提供一个空默认工厂避免报错。
export default function () {}
import { tmpdir } from "node:os";
import { join } from "node:path";

/** AUMID，必须与 /notify-install 注册的一致 */
export const PI_AUMID = "PiCodingAgent.Notify";
/** Windows 侧固定图标相对路径（install 时部署到 USERPROFILE 下） */
const ICON_WIN_REL = "AppData\\Local\\pi-notify\\pi-logo.png";

const POWERSHELL_EXE = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

function isWSL(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch { return false; }
}

/** 找 powershell.exe（WSL 用 /mnt/c 路径，原生 Windows 用 PATH） */
function findPowerShell(): string | null {
  if (isWSL()) {
    return existsSync(POWERSHELL_EXE) ? POWERSHELL_EXE : null;
  }
  if (process.platform === "win32") return "powershell.exe";
  return null;
}

/** 通过 powershell.exe 查询 Windows 用户目录（WSL 下 HOME 不可靠） */
export function queryWindowsUserprofile(): string | null {
  const ps = findPowerShell();
  if (!ps) return null;
  try {
    const out = execFileSync(ps, ["-NoProfile", "-Command", "Write-Output $env:USERPROFILE"], {
      timeout: 5000,
      encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 把字符串以 UTF-8 with BOM 写入文件（PS5 见 BOM 才按 UTF-8 解码） */
function writeUtf8Bom(path: string, content: string): void {
  const BOM = "\uFEFF";
  writeFileSync(path, BOM + content, "utf8");
}

/** 推断 Windows 侧图标绝对路径（通过 powershell.exe 查 USERPROFILE） */
function resolveIconWinPath(): string | null {
  const up = queryWindowsUserprofile();
  return up ? up + "\\" + ICON_WIN_REL : null;
}

/** Windows 路径转 WSL 路径（用于在 WSL 侧访问 Windows 文件） */
function wslPath(winPath: string): string | null {
  if (!isWSL()) return winPath;
  const m = winPath.match(/^([A-Z]):\\(.+)$/i);
  if (m) {
    return "/mnt/" + m[1].toLowerCase() + "/" + m[2].replace(/\\/g, "/");
  }
  return null;
}

/** WSL 路径转 Windows 路径 */
function winPath(p: string): string {
  if (!isWSL()) return p;
  const m = p.match(/^\/mnt\/([a-z])\/(.+)$/i);
  if (m) {
    return m[1].toUpperCase() + ":\\" + m[2].replace(/\//g, "\\");
  }
  return p;
}

/** 检测 Windows 侧文件是否存在（WSL 下转 /mnt/c 路径检查） */
function existsIconWin(winPath: string): boolean {
  const wsl = wslPath(winPath);
  if (wsl) return existsSync(wsl);
  return existsSync(winPath);
}

/** 构造 Toast XML（ToastGeneric，支持图标）。XML 属性用双引号，便于嵌入 PS 单引号字符串。 */
function buildToastXml(title: string, body: string, iconUri: string | null): string {
  const imgTag = iconUri
    ? '<image placement="appLogoOverride" src="' + iconUri + '"/>'
    : "";
  return (
    '<toast><visual><binding template="ToastGeneric">' +
    '<text>' + escapeXml(title) + '</text>' +
    '<text>' + escapeXml(body) + '</text>' +
    imgTag +
    '</binding></visual></toast>'
  );
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
      default: return c;
    }
  });
}

/**
 * 发送 WinRT Toast 通知。
 * @returns true 表示命令已成功执行（不代表通知一定显示）
 */
export function sendWinrtToast(title: string, body: string): boolean {
  const ps = findPowerShell();
  if (!ps) return false;

  const iconWinPath = resolveIconWinPath();
  const iconUri = iconWinPath && existsIconWin(iconWinPath)
    ? "file:///" + iconWinPath.replace(/\\/g, "/")
    : null;

  const xml = buildToastXml(title, body, iconUri);

  // 写临时 ps1 到 Windows 侧（UTF-8 with BOM；PS5 不认 Linux 路径）
  const up = queryWindowsUserprofile();
  if (!up) return false;
  const tmpScriptWin = up + "\\AppData\\Local\\Temp\\pi-toast-" + Date.now() + ".ps1";
  const tmpScriptWsl = wslPath(tmpScriptWin);
  if (!tmpScriptWsl) return false;

  const SQ = String.fromCharCode(39);
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$xmlStr = " + SQ + xml + SQ,
    "$xmlDoc = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]::new()",
    "$xmlDoc.LoadXml($xmlStr)",
    "$toast = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]::new($xmlDoc)",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]::CreateToastNotifier('" + PI_AUMID + "').Show($toast)",
  ].join("\n");

  try {
    writeUtf8Bom(tmpScriptWsl, script);
  } catch {
    return false;
  }

  try {
    execFile(
      ps,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmpScriptWin],
      { timeout: 8000 },
      () => {
        try { unlinkSync(tmpScriptWsl); } catch {}
      },
    );
    return true;
  } catch {
    return false;
  }
}
