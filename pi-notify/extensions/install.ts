/**
 * install.ts — 跨平台通知环境安装命令 `/notify-install`。
 *
 * 根据系统类型做对应安装（幂等，可重复运行）：
 *
 *   Windows / WSL：
 *     1. 部署 pi 图标到 C:\Users\<user>\.pi\agent\assets\pi-logo.png
 *     2. 注册 AUMID PiCodingAgent.Notify 到注册表（DisplayName + IconUri）
 *     3. 创建开始菜单快捷方式「Pi Coding Agent」（AUMID 载体）
 *     → 让 WinRT Toast 能弹横幅（否则只进通知中心）
 *
 *   Linux / WSLg：
 *     检测 notify-send 是否可用，缺失则提示安装命令。
 *
 *   macOS：
 *     osascript 系统自带，无需安装，仅提示。
 */

import { execFileSync, execFile } from "node:child_process";
import { existsSync, readFileSync, copyFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PI_AUMID } from "./winrt-toast.js";

const POWERSHELL_EXE = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

function isWSL(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch { return false; }
}

function findPowerShell(): string | null {
  if (isWSL()) {
    return existsSync(POWERSHELL_EXE) ? POWERSHELL_EXE : null;
  }
  if (process.platform === "win32") return "powershell.exe";
  return null;
}

/** 包内图标资源路径（相对于本文件 extensions/install.ts -> assets/pi-logo.png） */
function bundledIconPath(): string {
  return join(__dirname, "..", "assets", "pi-logo.png");
}

/** 通过 powershell.exe 查询 Windows 用户目录（WSL 下 HOME 不可靠） */
function queryWindowsUserprofile(): string | null {
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

/** Windows 路径转 WSL 路径（用于在 WSL 侧访问 Windows 文件） */
function wslPath(winPath: string): string | null {
  if (!isWSL()) return winPath;
  const m = winPath.match(/^([A-Z]):\\(.+)$/i);
  if (m) {
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  }
  return null;
}

/** WSL 路径转 Windows 路径 */
function winPath(p: string): string {
  if (!isWSL()) return p;
  const m = p.match(/^\/mnt\/([a-z])\/(.+)$/i);
  if (m) {
    return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  }
  return p;
}

// ── Windows / WSL 安装 ───────────────────────────────────────────────

async function installWindows(force: boolean): Promise<string> {
  const winHome = queryWindowsUserprofile();
  if (!winHome) {
    return "❌ 无法定位 Windows 用户目录（USERPROFILE 为空）";
  }
  const winAssetsDir = `${winHome}\\AppData\\Local\\pi-notify`;
  const dstIcon = `${winAssetsDir}\\pi-logo.png`;
  const dstIconWsl = wslPath(dstIcon);

  // 1. 部署图标
  const srcIcon = bundledIconPath();
  if (!existsSync(srcIcon)) {
    return `❌ 包内图标资源缺失：${srcIcon}`;
  }
  try {
    if (dstIconWsl) {
      mkdirSync(dirname(dstIconWsl), { recursive: true });
      copyFileSync(srcIcon, dstIconWsl);
    }
  } catch (e) {
    return `❌ 图标部署失败：${e instanceof Error ? e.message : String(e)}`;
  }

  // 2. 生成安装脚本
  const startMenuDir = `${winHome}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs`;
  const shortcutPath = `${startMenuDir}\\Pi Coding Agent.lnk`;
  const targetExe = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$appId = '${PI_AUMID}'
$displayName = 'Pi Coding Agent'
$iconUri = '${dstIcon}'
$shortcutPath = '${shortcutPath}'
$startMenuDir = '${startMenuDir}'

# 注册表
$regKey = "HKCU:\\Software\\Classes\\AppUserModelId\\$appId"
if (-not (Test-Path $regKey)) { New-Item -Path $regKey -Force | Out-Null }
Set-ItemProperty -Path $regKey -Name 'DisplayName' -Value $displayName -Type String
Set-ItemProperty -Path $regKey -Name 'IconUri' -Value $iconUri -Type String
Write-Host "REG OK: $regKey"

# 开始菜单快捷方式
if (-not (Test-Path $startMenuDir)) { New-Item -Path $startMenuDir -ItemType Directory -Force | Out-Null }
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcutPath)
$sc.TargetPath = '${targetExe}'
$sc.IconLocation = $iconUri
$sc.Description = $displayName
$sc.Save()
Write-Host "SHORTCUT OK: $shortcutPath"
Write-Host "INSTALL DONE"
`.trim();

  // 写临时脚本到 Windows 侧（UTF-8 with BOM，PS5 才能正确解码；且 PS5 不认 Linux 路径）
  const tmpScriptWin = `${winHome}\\AppData\\Local\\Temp\\pi-notify-install-${Date.now()}.ps1`;
  const tmpScriptWsl = wslPath(tmpScriptWin);
  if (!tmpScriptWsl) {
    return `❌ 无法转换临时脚本路径：${tmpScriptWin}`;
  }
  try {
    const BOM = "\uFEFF";
    writeFileSync(tmpScriptWsl, BOM + script, "utf8");
  } catch (e) {
    return `❌ 脚本写入失败：${e instanceof Error ? e.message : String(e)}`;
  }

  // 3. 执行
  const ps = findPowerShell()!;
  return new Promise((resolve) => {
    execFile(
      ps,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmpScriptWin],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        try { unlinkSync(tmpScriptWsl); } catch {}
        if (err) {
          resolve(`❌ 安装脚本执行失败：${err.message}\n${stderr}`);
          return;
        }
        if (stdout.includes("INSTALL DONE")) {
          resolve(
            `✅ Windows Toast 环境安装成功\n` +
            `   AUMID: ${PI_AUMID}\n` +
            `   图标: ${dstIcon}\n` +
            `   快捷方式: ${shortcutPath}\n` +
            `   现在运行 /notify-test 验证（应弹出带 pi 图标的横幅）`
          );
        } else {
          resolve(`⚠️ 安装结果未知：\n${stdout}\n${stderr}`);
        }
      },
    );
  });
}

// ── Linux / WSLg 安装 ────────────────────────────────────────────────

async function installLinux(): Promise<string> {
  if (existsSync("/usr/bin/notify-send")) {
    return "✅ Linux 通知环境就绪：notify-send 已安装，无需其他配置";
  }
  // 检测包管理器给安装建议
  const hints: string[] = [];
  if (existsSync("/usr/bin/apt")) hints.push("  Debian/Ubuntu: sudo apt install libnotify-bin");
  if (existsSync("/usr/bin/dnf")) hints.push("  Fedora: sudo dnf install libnotify");
  if (existsSync("/usr/bin/pacman")) hints.push("  Arch: sudo pacman -S libnotify");
  if (existsSync("/usr/bin/zypper")) hints.push("  openSUSE: sudo zypper install libnotify-tools");
  return (
    `⚠️ 未找到 notify-send，无法发桌面通知。\n` +
    `请安装 libnotify：\n` +
    (hints.length ? hints.join("\n") : "  请用系统包管理器安装 libnotify / notify-send")
  );
}

// ── macOS ────────────────────────────────────────────────────────────

async function installMacos(): Promise<string> {
  if (existsSync("/usr/bin/osascript")) {
    return "✅ macOS 通知环境就绪：osascript 系统自带，无需其他配置";
  }
  return "❌ 未找到 osascript，macOS 系统异常";
}

// ── 入口 ─────────────────────────────────────────────────────────────

/**
 * 根据当前系统类型执行对应安装。返回人类可读结果。
 */
export async function runInstall(force: boolean): Promise<string> {
  if (isWSL() || process.platform === "win32") {
    return installWindows(force);
  }
  if (process.platform === "darwin") {
    return installMacos();
  }
  if (process.platform === "linux") {
    return installLinux();
  }
  return `❌ 不支持的平台：${process.platform}`;
}
