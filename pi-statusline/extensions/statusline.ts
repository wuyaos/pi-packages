/**
 * pi-statusline — omp 风格状态栏。
 *
 * 显示: 模型名  项目路径  git(分支 +staged ~modified ?untracked)  上下文token  ↑输出
 * git 统计可配置开关。
 *
 * 配置：
 *   PI_STATUSLINE_GIT — "0" 关闭 git 状态统计（默认开启）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";

const GIT_REFRESH_MS = 2000;

function execAsync(cmd: string, args: string[], opts: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as string);
    });
  });
}

interface GitStats { staged: number; modified: number; untracked: number; }

async function getGitStats(cwd: string): Promise<GitStats | null> {
  try {
    const stdout = await execAsync("git", ["status", "--porcelain"], {
      cwd, encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    let staged = 0, modified = 0, untracked = 0;
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const x = line[0], y = line[1];
      if (x === "?" && y === "?") untracked++;
      else {
        if (x !== " " && x !== "?") staged++;
        if (y !== " " && y !== "?") modified++;
      }
    }
    return { staged, modified, untracked };
  } catch {
    return null;
  }
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtPath(p: string): string {
  const home = homedir();
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

export default function (pi: ExtensionAPI) {
  const gitEnabled = process.env.PI_STATUSLINE_GIT === "1";
  let gitStats: GitStats | null = null;
  let gitTimer: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const doRefresh = async () => {
        if (!gitEnabled) return;
        const cwd = ctx.sessionManager.getCwd();
        const stats = await getGitStats(cwd);
        if (stats) gitStats = stats;
        tui.requestRender();
      };
      doRefresh();
      gitTimer = setInterval(doRefresh, GIT_REFRESH_MS);

      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: () => {
          unsubBranch();
          if (gitTimer) { clearInterval(gitTimer); gitTimer = null; }
        },
        invalidate() { doRefresh(); },
        render(width: number): string[] {
          // 模型名
          const model = (ctx.model as any)?.id || "no-model";
          const modelStr = theme.fg("accent", model);

          // 项目路径
          const cwd = ctx.sessionManager.getCwd();
          const pathStr = theme.fg("dim", fmtPath(cwd));

          // git 块: 分支 + staged/modified/untracked
          let gitStr = "";
          const branch = footerData.getGitBranch();
          if (branch) {
            const hasChanges = gitStats && (gitStats.staged || gitStats.modified || gitStats.untracked);
            const branchColor = hasChanges ? "warning" : "success";
            gitStr = theme.fg(branchColor, branch);
            if (gitStats) {
              const parts: string[] = [];
              if (gitStats.staged > 0) parts.push(theme.fg("success", `+${gitStats.staged}`));
              if (gitStats.modified > 0) parts.push(theme.fg("warning", `~${gitStats.modified}`));
              if (gitStats.untracked > 0) parts.push(theme.fg("error", `?${gitStats.untracked}`));
              if (parts.length > 0) gitStr += " " + parts.join(" ");
            }
          }

          // 上下文 token
          let ctxStr = "";
          try {
            const usage = ctx.getContextUsage();
            if (usage && typeof usage.tokens === "number") {
              const ctxWindow = (ctx.model as any)?.context_window || 128000;
              ctxStr = theme.fg("borderAccent", `${fmtTokens(usage.tokens)}/${fmtTokens(ctxWindow)}`);
            }
          } catch { /* ignore */ }

          // 输出指示 (累计 output tokens)
          let output = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && (e.message as any).role === "assistant") {
              output += (e.message as any).usage?.output || 0;
            }
          }
          const outputStr = theme.fg("muted", `↑${fmtTokens(output)}`);

          // 组装: model  path  git  ctx  output
          const parts: string[] = [modelStr, pathStr];
          if (gitStr) parts.push(gitStr);
          if (ctxStr) parts.push(ctxStr);
          parts.push(outputStr);
          const full = parts.join("  ");

          const fullW = visibleWidth(full);
          if (fullW <= width) {
            return [full];
          }
          return [truncateToWidth(full, width)];
        },
      };
    });
  });

  pi.on("session_shutdown", () => {
    if (gitTimer) { clearInterval(gitTimer); gitTimer = null; }
  });

  pi.registerCommand("statusline-git", {
    description: "切换 git 状态统计开关",
    handler: async (_args, ctx) => {
      const next = gitEnabled ? "0" : "1";
      ctx.ui.notify(
        `重启 pi 后生效: PI_STATUSLINE_GIT=${next}`,
        "info"
      );
    },
  });
}
