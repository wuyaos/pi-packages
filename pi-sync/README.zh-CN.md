# pi-sync

[English](./README.md) | **简体中文**

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

面向 [Pi](https://github.com/earendil-works/pi-coding-agent) 的 WebDAV 归档备份与恢复工具。

`pi-sync` 为 Pi agent 数据、共享 Skills 和项目会话创建有版本的 `.tar.xz` 归档。它现在是**纯归档模式**：没有实时上传、每轮 hook、定时同步或多机合并冲突。

## 特性

- 直接打包 `~/.pi/agent`，不创建完整临时副本
- 通过可配置黑名单排除可重装或临时目录
- `~/.agents/skills` 独立、可选归档
- 会话按项目独立归档
- 退出 Pi 时自动归档当前项目
- 一次操作备份或恢复所有已启用类别
- `/sync` 菜单支持英文/简体中文即时切换
- WebDAV 上传和下载使用流式传输，不把整个归档读入内存
- 拒绝危险路径、符号链接、特殊节点和不安全恢复目标

## 安装

从 npm 安装：

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
- 单独上传或恢复 **会话归档**
- 配置备份设置
- 中英文菜单切换

首次运行若缺少 WebDAV 地址、用户名或密码，会自动打开配置向导。

## 归档模型

### Pi 备份

Pi 归档直接打包 `~/.pi/agent`。默认黑名单：

```json
["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"]
```

这样会保留配置与扩展状态，同时排除可重装的包源码、临时扩展缓存、单独归档的会话、工作区历史、后台任务状态和 Web UI RPC 运行时 socket。除非显式加入黑名单，`config/sync.json` 也会进入归档。

归档名称：

```text
backup/pi/pi_agent_<platform>_<timestamp>.tar.xz
```

### 共享 Skills 备份

`~/.agents/skills` 使用独立归档，默认关闭：

```text
backup/skills/agent_skills_<timestamp>.tar.xz
```

### 会话归档

会话按项目归档，不再进行实时同步，也没有 `_latest.json` marker：

```text
backup/sessions/<projectDir>/sessions_<platform>_<timestamp>.tar.xz
```

项目选择支持：

- **白名单**：仅归档列表中的项目；空列表表示全部不归档。
- **黑名单**：排除列表中的项目；空列表表示归档全部项目。

开启 `backupOnExit` 后，Pi 在 `session_shutdown` 时归档当前允许的项目；仍可通过 `/sync` 手动归档。

## WebDAV 目录结构

```text
<webdavUrl>/
└── backup/
    ├── pi/
    │   └── pi_agent_<platform>_<timestamp>.tar.xz
    ├── skills/
    │   └── agent_skills_<timestamp>.tar.xz
    └── sessions/
        └── <projectDir>/
            └── sessions_<platform>_<timestamp>.tar.xz
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
  "backupSessions": true,
  "backupAgentSkills": false,
  "piExcludePaths": ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"],
  "backupOnExit": true,
  "sessionProjectMode": "blacklist",
  "sessionProjects": [],
  "maxBackups": 10
}
```

密码支持环境变量引用（如 `$PI_WEBDAV_PASS`）。未设置 `language` 时，会读取 `settings.json → piSwitch.language`，无法识别则默认英文。

## 恢复行为与安全

- 检查归档中的绝对路径和目录穿越。
- 解压前拒绝符号链接和非普通文件节点。
- 先解压到临时目录，再合并到目标目录。
- 若目标路径包含符号链接或类型冲突则拒绝恢复。
- Pi 恢复只改写归档中存在的文件，黑名单目录保持原样。
- Skills 恢复前会把现有 `~/.agents/skills` 移到带时间戳的备份目录。
- 会话恢复以合并方式写入 `~/.pi/agent/sessions`。
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

该脚本用于可信归档和新机恢复。恢复后需要安装/更新 packages，以重建被排除的 `npm/` 和 `git/` 目录。

## 故障排查

| 现象 | 处理 |
|---|---|
| HTTP 401 / 403 | 检查 WebDAV 地址，并使用应用专用密码。 |
| PROPFIND 失败 | 确认服务端支持 `Depth: 1` 的 WebDAV `PROPFIND`。 |
| tar 报错 | 安装支持 xz 的 `tar`。 |
| 退出时未备份 | 检查 `backupOnExit`、`backupSessions`、项目黑白名单和 WebDAV 凭据。 |
| Pi 恢复后插件缺失 | 运行 `pi update --extensions`，或按 `settings.json` 重新安装 packages。 |

## 开发验证

```bash
cd /mnt/d/work/project/person/pi-packages
node --import tsx --test pi-sync/extensions/sync/*.test.ts
npm run typecheck
```

monorepo 类型检查可能报告其他包的既有错误；pi-sync 自身错误路径以 `pi-sync/` 开头。

### WebDAV 烟雾测试

仓库内的 smoke harness 会创建唯一命名的临时 Pi 与会话归档，执行上传、列举、下载和校验，最后删除测试对象；它不会输出凭据，且默认拒绝写入：

```bash
cd /mnt/d/work/project/person/pi-packages
PI_SYNC_SMOKE_WRITE=1 bash --noprofile --norc pi-sync/scripts/verify.sh
```

`verify.sh` 还会执行单元测试、严格的 pi-sync 类型检查、扩展加载检查、发布白名单检查和 diff 检查。它读取 `~/.pi/agent/config/sync.json`；可通过 `PI_SYNC_SMOKE_PROJECT` 指定一个允许归档的本地会话目录名（如 `--home-user--`）。

## 更新日志

### v1.2.0

- 从实时同步改为有版本的纯归档备份/恢复
- 新增 Pi 主目录直接 tar 打包与黑名单排除
- 分离 Pi、共享 Skills 和项目会话归档
- 新增退出时会话归档、手动全部备份/全部恢复
- 新增中英文菜单切换
- 新增 WebDAV 流式传输、配置缓存和归档/恢复安全检查
- 删除实时同步、定时同步、custom-path、memory 和 legacy 单体代码

### v1.1.1

- 缓存 WebDAV 目录创建结果与已加载配置，减少重复 I/O

### v1.0.0

- 初始 WebDAV 备份/恢复版本

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
