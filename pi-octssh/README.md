# pi-octssh

A [pi](https://pi.dev) extension package that bridges the
[`@aliyahzombie/octssh`](https://www.npmjs.com/package/@aliyahzombie/octssh)
MCP server (SSH deployment tools — list hosts, exec, sudo, upload/download,
async sessions) into native pi tools.

## How it works

On `session_start` the extension spawns the `octssh` binary as a subprocess,
performs the MCP `initialize` handshake, calls `tools/list`, and dynamically
registers every upstream tool via `pi.registerTool()`. Each registered tool
forwards calls to the subprocess over JSON-RPC (`tools/call`) and returns the
result content. On `session_shutdown` the subprocess is killed.

**Aggregated tool set** — 15 个上游工具聚合为 9 个 pi 工具，token 开销降 55%（1806→819）：

| pi 工具 | 上游工具 | 说明 |
|---|---|---|
| `list` | list | 列主机 |
| `info` | info | 主机详情 |
| `exec` | exec / sudo-exec / exec-async / exec-async-sudo | `mode`+`sudo` 参数分发 |
| `transfer` | upload / download / upload-async / download-async | `direction`+`async` 参数分发 |
| `get-result` | get-result | 查询异步任务 |
| `grep-result` | grep-result | 搜索日志 |
| `write-stdin` | write-stdin | 写入 stdin |
| `cancel` | cancel | 终止任务 |
| `sleep` | sleep | 休眠 |

## Install

```bash
# 1. install the upstream MCP server (provides the `octssh` binary)
npm i -g @aliyahzombie/octssh

# 2. install this pi package (local path)
pi install /home/wuya/pi-packages/pi-octssh
```

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `OCTSSH_COMMAND` | `octssh` | Binary to spawn (full path or PATH-resolved name) |
| `OCTSSH_ARGS` | *(empty)* | Whitespace-separated extra args |

If the binary is missing or the handshake fails, a single `octssh` diagnostic
tool is registered that returns install instructions, so the agent degrades
gracefully instead of silently breaking.

## Commands

- `/octssh` — print bridge status (alive? tool count).

## Verify

```bash
pi -e /home/wuya/pi-packages/pi-octssh/extensions/octssh.ts
# then in a session: ask the agent to list SSH hosts
```
