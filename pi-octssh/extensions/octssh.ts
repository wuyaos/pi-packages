/**
 * pi-octssh — MCP-stdio → pi tool bridge for the octssh SSH deployment server.
 *
 * On session_start: spawns `octssh`, does MCP initialize, then registers an
 * AGGREGATED tool set (9 tools) that dispatches to the upstream 15 tools.
 * Each tool forwards tools/call over JSON-RPC and returns the content.
 * On session_shutdown the child is killed.
 *
 * Config (env): OCTSSH_COMMAND (default "octssh"), OCTSSH_ARGS (default "").
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * 解析 octssh 可执行入口，三层 fallback：
 * 1. OCTSSH_COMMAND 环境变量（OCTSSH_ARGS 为额外参数）
 * 2. 本包 node_modules/@aliyahzombie/octssh/dist/index.js（用 node 跑）
 * 3. 全局 PATH 上的 octssh
 */
function resolveOctsshBin(): { cmd: string; args: string[] } {
  if (process.env.OCTSSH_COMMAND) {
    const args = process.env.OCTSSH_ARGS ? process.env.OCTSSH_ARGS.split(/\s+/).filter(Boolean) : [];
    return { cmd: process.env.OCTSSH_COMMAND, args };
  }
  try {
    const pkgJsonPath = require.resolve("@aliyahzombie/octssh/package.json");
    const pkgDir = path.dirname(pkgJsonPath);
    const bin = JSON.parse(readFileSync(pkgJsonPath, "utf8")).bin?.octssh;
    if (bin) return { cmd: process.execPath, args: [path.resolve(pkgDir, bin)] };
  } catch { /* not installed locally */ }
  return { cmd: "octssh", args: [] };
}

// ---------- MCP stdio bridge ----------

class McpBridge {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buf = "";
  alive = true;

  constructor(cmd: string, args: string[], onExit: (code: number | null) => void) {
    this.child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => this.onData(d));
    this.child.on("exit", (code) => {
      this.alive = false;
      for (const p of this.pending.values()) p.reject(new Error(`octssh exited (code ${code})`));
      this.pending.clear();
      onExit(code);
    });
    this.child.on("error", (e) => {
      this.alive = false;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = msg.id;
      if (id != null && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error("octssh process not alive"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: any) {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async init() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-octssh", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async callTool(name: string, args: any): Promise<any> {
    return await this.request("tools/call", { name, arguments: args });
  }

  kill() { try { this.child.kill() } catch {} }
}

// ---------- Aggregated tool definitions ----------
// 9 pi tools → dispatch to 15 upstream octssh tools.

interface ToolDef {
  name: string;
  description: string;
  parameters: any;
  /** Returns [upstreamToolName, upstreamArgs] */
  dispatch: (p: any) => [string, any];
}

const TOOLS: ToolDef[] = [
  {
    name: "list",
    description: "列出 ssh_config 中配置的所有主机",
    parameters: Type.Object({}),
    dispatch: () => ["list", {}],
  },
  {
    name: "info",
    description: "获取主机缓存的扩展信息（可 refresh）",
    parameters: Type.Object({
      machine: Type.String({ description: "主机名" }),
      refresh: Type.Optional(Type.Boolean({ description: "刷新缓存 (default false)" })),
    }),
    dispatch: (p) => ["info", { machine: p.machine, ...(p.refresh != null ? { refresh: p.refresh } : {}) }],
  },
  {
    name: "exec",
    description: "在远程主机执行命令。mode=sync(默认)等待结果；mode=async 后台运行返回 session_id。sudo=true 以 root 执行。高危操作(覆盖/删除)返回 confirm_code，需带 confirm_code 重试。",
    parameters: Type.Object({
      machine: Type.String({ description: "主机名" }),
      command: Type.String({ description: "shell 命令" }),
      mode: Type.Optional(Type.Union(
        [Type.Literal("sync"), Type.Literal("async")],
        { description: "sync(默认等待) | async(后台运行)" },
      )),
      sudo: Type.Optional(Type.Boolean({ description: "以 root 执行 (default false)" })),
      confirm_code: Type.Optional(Type.String({ description: "高危操作确认码" })),
    }),
    dispatch: (p) => {
      const isAsync = p.mode === "async";
      const isSudo = p.sudo === true;
      const upstream = isAsync
        ? (isSudo ? "exec-async-sudo" : "exec-async")
        : (isSudo ? "sudo-exec" : "exec");
      const args: any = { machine: p.machine, command: p.command };
      if (p.confirm_code) args.confirm_code = p.confirm_code;
      return [upstream, args];
    },
  },
  {
    name: "transfer",
    description: "上传/下载文件。direction=upload 传到远程，download 传到本地。async=true 非阻塞。覆盖已存在文件需 confirm_code。",
    parameters: Type.Object({
      machine: Type.String({ description: "主机名" }),
      direction: Type.Union(
        [Type.Literal("upload"), Type.Literal("download")],
        { description: "upload(传到远程) | download(传到本地)" },
      ),
      localPath: Type.String({ description: "本地路径" }),
      remotePath: Type.String({ description: "远程路径" }),
      async: Type.Optional(Type.Boolean({ description: "非阻塞 (default false)" })),
      confirm_code: Type.Optional(Type.String({ description: "覆盖确认码" })),
    }),
    dispatch: (p) => {
      const upstream = p.async ? `${p.direction}-async` : p.direction;
      const args: any = { machine: p.machine, localPath: p.localPath, remotePath: p.remotePath };
      if (p.confirm_code) args.confirm_code = p.confirm_code;
      return [upstream, args];
    },
  },
  {
    name: "get-result",
    description: "查询异步任务状态/尾部日志",
    parameters: Type.Object({
      session_id: Type.String({ description: "异步任务 id" }),
      lines: Type.Optional(Type.Number({ description: "尾部行数" })),
    }),
    dispatch: (p) => ["get-result", { session_id: p.session_id, ...(p.lines != null ? { lines: p.lines } : {}) }],
  },
  {
    name: "grep-result",
    description: "在异步任务日志中搜索",
    parameters: Type.Object({
      session_id: Type.String(),
      pattern: Type.String({ description: "正则" }),
      maxMatches: Type.Optional(Type.Number()),
      contextLines: Type.Optional(Type.Number()),
    }),
    dispatch: (p) => ["grep-result", {
      session_id: p.session_id, pattern: p.pattern,
      ...(p.maxMatches != null ? { maxMatches: p.maxMatches } : {}),
      ...(p.contextLines != null ? { contextLines: p.contextLines } : {}),
    }],
  },
  {
    name: "write-stdin",
    description: "向运行中的异步任务 stdin 写入数据",
    parameters: Type.Object({
      session_id: Type.String(),
      data: Type.String(),
      append_newline: Type.Optional(Type.Boolean({ description: "追加换行 (default true)" })),
    }),
    dispatch: (p) => ["write-stdin", {
      session_id: p.session_id, data: p.data,
      ...(p.append_newline != null ? { append_newline: p.append_newline } : {}),
    }],
  },
  {
    name: "cancel",
    description: "终止运行中的异步任务",
    parameters: Type.Object({
      session_id: Type.String(),
      signal: Type.Optional(Type.String({ description: "信号 (default SIGTERM)" })),
    }),
    dispatch: (p) => ["cancel", { session_id: p.session_id, ...(p.signal != null ? { signal: p.signal } : {}) }],
  },
  {
    name: "sleep",
    description: "休眠毫秒，用于轮询异步任务",
    parameters: Type.Object({
      time: Type.Number({ description: "毫秒" }),
    }),
    dispatch: (p) => ["sleep", { time: p.time }],
  },
];

// ---------- Extension ----------

export default function (pi: ExtensionAPI) {
  const { cmd, args: baseArgs } = resolveOctsshBin();

  let bridge: McpBridge | null = null;
  let registered = false;

  function registerTools() {
    for (const t of TOOLS) {
      const upstreamName = t.name;
      pi.registerTool({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: t.parameters,
        async execute(_toolCallId, params) {
          if (!bridge?.alive) {
            return {
              content: [{ type: "text", text: "octssh 进程未运行。请 /reload 或重启 session。" }],
              isError: true,
              details: {},
            };
          }
          const [upstream, upArgs] = t.dispatch(params);
          try {
            const res = await bridge.callTool(upstream, upArgs);
            return {
              content: res.content ?? [{ type: "text", text: JSON.stringify(res) }],
              details: {},
            };
          } catch (e: any) {
            return {
              content: [{ type: "text", text: `octssh 工具 '${upstreamName}' 失败: ${e.message}` }],
              isError: true,
              details: {},
            };
          }
        },
      });
    }
  }

  async function setup(ctx: any) {
    if (registered) return;
    registered = true;
    try {
      bridge = new McpBridge(cmd, baseArgs, () => {});
      await bridge.init();
      registerTools();
      ctx?.ui?.notify?.(`octssh: ${TOOLS.length} 工具已加载`, "info");
    } catch (e: any) {
      bridge?.kill();
      bridge = null;
      ctx?.ui?.notify?.(`octssh 启动失败: ${e.message}`, "error");
      // graceful degradation
      pi.registerTool({
        name: "octssh",
        label: "octssh",
        description: "octssh SSH 桥接。当前不可用——返回安装说明。",
        parameters: Type.Object({}),
        async execute() {
          return {
            content: [{
              type: "text",
              text: `octssh 桥接失败: ${e.message}\n\n安装:\n  npm i -g @aliyahzombie/octssh\n\n设置 OCTSSH_COMMAND 为二进制路径，OCTSSH_ARGS 为额外参数，然后 /reload。`,
            }],
            isError: true,
            details: {},
          };
        },
      });
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await setup(ctx);
  });

  pi.on("session_shutdown", () => {
    bridge?.kill();
    bridge = null;
    registered = false;
  });

  pi.registerCommand("octssh", {
    description: "octssh 桥接状态",
    handler: async (_args, ctx) => {
      if (!bridge?.alive) {
        ctx.ui.notify("octssh: 未运行", "error");
        return;
      }
      ctx.ui.notify(`octssh: 运行中, ${TOOLS.length} 工具`, "info");
    },
  });
}
