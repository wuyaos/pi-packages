---
name: octssh
description: SSH remote operations via the octssh tool set. Use when the user asks to run commands on, transfer files to/from, or manage remote servers (minipc, qnap, fnos, interserver, para-GPU-N40, para-GPU-N56, para-CPU-A6). Triggers include "ssh to X", "run on server", "deploy to", "check on minipc/qnap", "upload to/download from server", "restart service on host", or any task targeting a host in ssh_config. 中文触发词：在服务器上执行、远程运行命令、部署到、连到主机、ssh 登录、上传到服务器、从服务器下载、重启服务器上的服务、查看主机状态、传文件到远程、从远程拉文件。
---

# octssh — SSH Remote Operations

This skill is bundled with the `pi-octssh` package. It declares the **octssh tool set** so the agent knows these tools are available for SSH operations on remote hosts configured in `~/.ssh/config`.

## When to Use

Use the octssh tools when you need to operate on a **remote host**:

- Run a command on a server (sync or background)
- Upload/download files
- Manage long-running async tasks (poll logs, write stdin, cancel)
- List configured hosts and inspect host info

中文场景：在服务器上执行命令、远程运行、部署到主机、连到服务器、ssh 登录远程、上传文件到服务器、从服务器下载文件、重启远程服务、查看主机状态、传文件到远程、从远程拉文件。

## Available Tools

| Tool | Purpose |
|---|---|
| `list` | 列出 ssh_config 中配置的所有主机 |
| `exec` | 在远程主机执行命令。`mode=sync`(默认)等待结果；`mode=async` 后台运行返回 session_id。`sudo=true` 以 root 执行。高危操作(覆盖/删除)返回 confirm_code，需带 confirm_code 重试 |
| `transfer` | 上传/下载文件。`direction=upload` 传到远程，`download` 传到本地。`async=true` 非阻塞。覆盖已存在文件需 confirm_code |

**Async task management** (for `mode=async` tasks):
`get-result` 查询状态/日志 · `grep-result` 搜索日志 · `write-stdin` 写入输入 · `cancel` 终止任务 · `sleep` 轮询等待

## Hosts (from ssh_config)

minipc · qnap · fnos · interserver · para-GPU-N40 · para-GPU-N56 · para-CPU-A6

## Usage Patterns

### 1. Run a quick command (sync)
```
exec(machine="minipc", command="uname -a")
```

### 2. Run as root
```
exec(machine="qnap", command="docker ps", sudo=true)
```

### 3. Long task in background (async)
```
exec(machine="minipc", command="./build.sh", mode="async")
# returns session_id, then poll:
get-result(session_id="...", lines=50)
```

### 4. Upload a file
```
transfer(machine="minipc", direction="upload", localPath="./app.py", remotePath="/home/wuya/app.py")
```

### 5. High-risk confirm flow
```
exec(machine="minipc", command="rm -rf /tmp/old")
# → returns confirm_code, then:
exec(machine="minipc", command="rm -rf /tmp/old", confirm_code="a1b2c3")
```

## When NOT to Use

- **Local operations** on the current machine → use `bash` tool directly.
- **Multi-step scripts** with loops/conditionals → octssh `exec` runs single commands; for complex scripts, consider `bash` with `ssh host 'bash -s' <<EOF` instead.
- **Quick ad-hoc ssh** where you don't need async/sudo/transfer → `bash` + `ssh` may be simpler.

## Pitfalls

- `exec` is designed for **single commands**. Complex multi-line scripts should be chained with `&&`/`;` or use `bash`+`ssh`.
- High-risk commands (`rm -rf`, file overwrites) trigger a **confirm_code** round-trip — pass `confirm_code` to actually execute.
- Async tasks persist on the remote host in a `screen` session; they survive even if this session ends. Use `get-result` to check and `cancel` to clean up.
- The octssh subprocess must be alive (auto-started on session_start). If tools return "octssh 进程未运行", run `/reload` or restart the session.

## Verification

Call `list` to confirm the bridge is working and see all configured hosts.
