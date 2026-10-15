# pi-sync

[English](./README.md) | **简体中文**

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

面向 [Pi](https://github.com/earendil-works/pi-coding-agent) 的 WebDAV 归档备份与恢复工具。

`pi-sync` 为 Pi agent 数据和共享 Skills 创建有版本的 `.tar.xz` 归档。它是**纯归档模式**：没有实时上传、每轮 hook、定时同步或多机合并冲突。

## 特性

- 直接打包 `~/.pi/agent`，不创建完整临时副本
- 通过可配置黑名单排除可重装或临时目录
- `~/.agents/skills` 独立、可选归档
- 退出 Pi 时自动备份已启用类别
- 一次操作备份或恢复所有已启用类别
- `/sync` 菜单支持英文/简体中文即时切换
- WebDAV 上传和下载使用流式传输，不把整个归档读入内存
- 拒绝危险路径、符号链接、特殊节点和不安全恢复目标

## 安装

```bash
pi install npm:@wuyaos/pi-sync
```

或安装整个 monorepo：

```bash
pi install git:github.com/wuyaos/pi-packages
```

安装后重启 Pi 或执行 `/reload`。

## 用法

运行 `/sync`，交互菜单提供：

- **全部备份** / **全部恢复（最新）**
- 单独上传或恢复 **Pi 备份**
- 单独上传或恢复 **Skills 备份**
- 配置备份设置
- 中英文菜单切换

首次运行若缺少 WebDAV 地址、用户名或密码，会自动打开配置向导。

## 归档模型

### Pi 备份

Pi 归档直接打包 `~/.pi/agent`。默认黑名单：

```json
["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"]
```

这样会保留配置与扩展状态，同时排除可重装的包源码、临时扩展缓存、对话历史、后台任务状态和 Web UI RPC 运行时 socket。除非显式加入黑名单，`config/sync.json` 也会进入归档。

```text
backup/pi/pi_agent_<platform>_<timestamp>.tar.xz
```

### 共享 Skills 备份

`~/.agents/skills` 使用独立归档，默认关闭：

```text
backup/skills/agent_skills_<timestamp>.tar.xz
```

## WebDAV 目录结构

```text
<webdavUrl>/
└── backup/
    ├── pi/
    │   └── pi_agent_<platform>_<timestamp>.tar.xz
    └── skills/
        └── agent_skills_<timestamp>.tar.xz
```

`maxBackups` 在每个备份目录内独立生效；设为 `0` 表示全部保留。

## 配置

配置文件为 `~/.pi/agent/config/sync.json`：

```json
{
  "webdavUrl": "https://example.com/dav/pi",
  "webdavUser": "user",
  "webdavPass": "$PI_WEBDAV_PASS",
  "language": "zh",
  "backupProviders": true,
  "backupAgentSkills": false,
  "piExcludePaths": ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"],
  "backupOnExit": true,
  "maxBackups": 10
}
```

旧配置中已移除归档类别的字段会被静默忽略。密码支持环境变量引用（如 `$PI_WEBDAV_PASS`）。未设置 `language` 时，会读取 `settings.json → piSwitch.language`，无法识别则默认英文。

## 恢复行为与安全

- 检查归档中的绝对路径和目录穿越。
- 解压前拒绝符号链接和非普通文件节点。
- 先解压到临时目录，再合并到目标目录。
- 若目标路径包含符号链接或类型冲突则拒绝恢复。
- Pi 恢复只改写归档中存在的文件，黑名单目录保持原样。
- Skills 恢复前会把现有 `~/.agents/skills` 移到带时间戳的备份目录。
- Pi 恢复前展示计划，完成后可选择 `/reload`。

归档可能包含 WebDAV 凭据、API Key、provider 配置及其他秘密，应把 WebDAV 存储视为敏感数据。

## Windows 新机引导

`pi-bootstrap.ps1` 会从 `backup/pi/` 下载最新归档，并合并到 `%USERPROFILE%\.pi\agent`：

> **仅限可信归档：** 此 bootstrap 脚本不执行 pi-sync TypeScript 恢复流程的路径和符号链接校验。日常恢复请使用 `/sync`，仅在可信 WebDAV 端点和可信归档场景下使用该脚本。

```powershell
$env:PI_WEBDAV_URL  = "https://example.com/dav/pi"
$env:PI_WEBDAV_USER = "user"
$env:PI_WEBDAV_PASS = "app-password"
.\pi-bootstrap.ps1
```

## 故障排查

| 现象 | 处理 |
|---|---|
| HTTP 401 / 403 | 检查 WebDAV 地址，并使用应用专用密码。 |
| PROPFIND 失败 | 确认服务端支持 `Depth: 1` 的 WebDAV `PROPFIND`。 |
| tar 报错 | 安装支持 xz 的 `tar`。 |
| 退出时未备份 | 检查 `backupOnExit`、已启用的类别和 WebDAV 凭据。 |
| Pi 恢复后插件缺失 | 运行 `pi update --extensions`，或按 `settings.json` 重新安装 packages。 |

## 开发验证

```bash
node pi-sync/tests/run.mjs
```

专用 runner 使用已安装 Pi SDK 的 `jiti`，仅创建测试临时文件，并使用本机 `127.0.0.1` fixture 完成传输测试。

## 更新日志

### v1.4.0

- 删除按项目的对话归档备份与恢复能力。
- 保留 Pi 与共享 Skills 的备份/恢复，以及退出时备份已启用类别。

### v1.2.0

- 从实时同步改为有版本的纯归档备份/恢复。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
