# pi-sync

[English](./README.md) | **简体中文**

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

面向 [Pi](https://github.com/earendil-works/pi-coding-agent) 的 WebDAV 归档备份与恢复工具。

`pi-sync` 为 Pi agent 数据和共享 Skills 创建有版本的 `.tar.xz` 归档。它是**纯归档模式**：没有实时上传、每轮 hook、定时同步或多机合并冲突。

## 特性

- 直接打包 `~/.pi/agent`，不创建完整临时副本
- 通过可配置黑名单排除可重装或临时目录，另套固定的文件名通配排除（`*.log`、`*.bak`、`*.tmp`、`*.swp`、`sync-state.json`、`*.bak-*`）
- `~/.agents/skills` 独立、可选归档
- 退出 Pi 时自动备份已启用类别；指纹无变化时自动跳过上传
- 多选类别一次性备份；恢复按设备+平台+时间戳合并归档行，支持设备筛选与逐行类别多选
- 跨平台修复：扫描 `settings.json` / `mcp.json` / `model-config.json` 中的外来操作系统路径，改写为可移植的 `~/` 形式
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

运行 `/sync`，一级菜单五项：

- **备份** —— 多选 Pi / Skills / Magic Context（本地目录缺失的类别置灰不可选），`Ctrl+S` 串行执行（文件锁互斥）
- **恢复** —— 扫描三类远端目录，把同设备+同平台+同时间戳的归档合并为一行（只显示 设备/平台/时间/本机徽标），按时间倒序，`←`/`→` 切换设备筛选；回车进入第二步多选该行的类别（默认全选，跨平台/非本机提示作为置灰行展示），`Ctrl+S` 后按 pi → skills → cortexkit 顺序串行恢复所选类别，失败即中断
- **修复跨平台问题** —— 见[跨平台修复](#跨平台修复)
- **设置** —— WebDAV 凭据、退出备份开关、存档保留数、退出备份类别、设备名、归档目录前缀、Pi 排除项、语言；修改即时保存（每个编辑项自带取消）
- **退出**

首次运行若缺少 WebDAV 地址、用户名或密码，会自动打开配置向导。

## 归档模型

### Pi 备份

Pi 归档直接打包 `~/.pi/agent`。默认黑名单：

```json
["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack", "install"]
```

这样会保留配置与扩展状态，同时排除可重装的包源码、临时扩展缓存、对话历史、后台任务状态、Web UI RPC 运行时 socket 和本地包安装树。黑名单之外，所有归档还会固定排除以下文件名通配：`*.log`、`*.bak`、`*.tmp`、`*.swp`、`sync-state.json`、`*.bak-*`（事务备份，如 `model-config.json.bak-123`）。除非显式加入黑名单，`config/sync.json` 也会进入归档。

```text
<remoteBaseDir>pi/<device>-<platform>-pi_<YYYYMMDD-HHMMSS>.tar.xz  （默认 pibak/pi/…）
```

### 共享 Skills 备份

`~/.agents/skills` 使用独立归档。排除 `__pycache__/`、`*.pyc` 与共用文件名通配排除清单。

```text
<remoteBaseDir>skills/<device>-<platform>-skills_<YYYYMMDD-HHMMSS>.tar.xz  （默认 pibak/skills/…）
```

### Magic Context 备份

`~/.config/cortexkit` 使用独立归档。排除命中共用通配清单的文件（`*.log`、`*.bak`、`*.tmp`、`*.swp`、`sync-state.json`、`*.bak-*`）。

```text
<remoteBaseDir>cortexkit/<device>-<platform>-cortexkit_<YYYYMMDD-HHMMSS>.tar.xz  （默认 pibak/cortexkit/…）
```

归档命名统一为 `<device>-<platform>-<tag>_<UTC 时间戳>.tar.xz`：`device` 为配置的设备名，`platform` 为 `win` / `mac` / `linux`，时间戳一律 UTC，保证跨设备排序一致。

## WebDAV 目录结构

```text
<webdavUrl>/
└── <remoteBaseDir>/   （自 WebDAV 应用根起的完整路径，可带前导 `/`；默认 "pibak/"，如 "sync/pibak/" 或 "/sync/pibak/"）
    ├── pi/
    │   └── <device>-<platform>-pi_<时间戳>.tar.xz
    ├── skills/
    │   └── <device>-<platform>-skills_<时间戳>.tar.xz
    └── cortexkit/
        └── <device>-<platform>-cortexkit_<时间戳>.tar.xz
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
  "backupCortexkit": false,
  "piExcludePaths": ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack", "install"],
  "backupOnExit": true,
  "maxBackups": 10,
  "deviceName": "DESKTOP-JK3-win",
  "remoteBaseDir": "pibak/",
  "exitBackupScope": ["pi", "skills", "cortexkit"]
}
```

旧配置中已移除归档类别的字段会被静默忽略。密码支持环境变量引用（如 `$PI_WEBDAV_PASS`）。未设置 `language` 时，会读取 `settings.json → piSwitch.language`，无法识别则默认英文。`deviceName` 缺省为清洗后的主机名加平台后缀，用于归档命名与远端 prune 归属判断。`remoteBaseDir` 是自 WebDAV 应用根（即 `webdavUrl` 所指目录）起的完整归档根路径，各类别归档位于 `<remoteBaseDir><kind>/`。可带前导 `/`（根相对），每段仅含字母、数字、点、连字符、下划线，末尾必有 `/`，如 `"sync/pibak/"` 或 `"/sync/pibak/"`，与 `webdavUrl` 拼接得 `https://dav.example.com/dav/sync/pibak/pi/`。`exitBackupScope` 限定退出备份上传的类别。

## 恢复行为与安全

- 恢复行合并同设备+同平台+精确相同时间戳的全部归档，一行可同时覆盖 Pi + Skills + Magic Context。恢复为两步：先选行，再在多选面板勾选要恢复的类别（默认全选）；所选类别按固定顺序 pi → skills → cortexkit 串行恢复，失败即中断并汇报已完成项。
- 跨平台与非本机设备的行在恢复前会给出警示；任一类别恢复成功后同步指纹失效，下一次退出备份会重新上传。
- 检查归档中的绝对路径和目录穿越。
- 解压前拒绝符号链接和非普通文件节点。
- 先解压到临时目录，再合并到目标目录。
- 若目标路径包含符号链接或类型冲突则拒绝恢复。
- Pi 恢复只改写归档中存在的文件，黑名单目录保持原样。
- Skills 恢复前会把现有 `~/.agents/skills` 移到带时间戳的备份目录。

归档可能包含 WebDAV 凭据、API Key、provider 配置及其他秘密，应把 WebDAV 存储视为敏感数据。

## 跨平台修复

**修复**扫描 `settings.json`、`mcp.json`、`model-config.json` 中属于其他操作系统的值：

- Windows 特定：盘符路径（`C:\` / `C:/`）、反斜杠路径分隔符、`*.exe` 二进制、Windows 的 `shellPath`（powershell/pwsh/cmd）
- POSIX 特定：`/home`、`/Users`、`/root` 开头的绝对路径、POSIX 的 `shellPath`（bash/zsh/sh/fish）
- 可移植值（`~/…`、`$VAR…`、空）与当前平台的原生值不会误报

每个问题分为三类：

- **auto** —— 值位于当前家目录下，改写为可移植的 `~/` 形式（默认勾选）
- **suggest** —— `shellPath` 清空，回退 Pi 平台默认
- **manual** —— 无法自动映射，列出原值人工编辑（默认不勾选）

修复原子写回（带 `.bak` 备份），且流程幂等：修复后再次扫描为 0 项。

## Windows 新机引导

`pi-bootstrap.ps1` 会从 `pibak/pi/` 下载最新归档，并合并到 `%USERPROFILE%\.pi\agent`：

> **仅限可信归档：** 此 bootstrap 脚本不执行 pi-sync TypeScript 恢复流程的路径和符号链接校验。日常恢复请使用 `/sync`，仅在可信 WebDAV 端点和可信归档场景下使用该脚本。

```powershell
$env:PI_WEBDAV_URL  = "https://example.com/dav/pi"
$env:PI_WEBDAV_USER = "user"
$env:PI_WEBDAV_PASS = "app-password"
.\pi-bootstrap.ps1
```

若归档前缀不是默认的 `pibak`，请设置 `PI_SYNC_REMOTE_BASE_DIR`。

## 故障排查

| 现象 | 处理 |
|---|---|
| HTTP 401 / 403 | 检查 WebDAV 地址，并使用应用专用密码。 |
| PROPFIND 失败 | 确认服务端支持 `Depth: 1` 的 WebDAV `PROPFIND`。 |
| tar 报错 | 安装支持 xz 的 `tar`。 |
| 退出时未备份 | 检查 `backupOnExit`、`exitBackupScope` 和 WebDAV 凭据；指纹无变化或有并发备份锁时也会静默跳过。 |
| Pi 恢复后插件缺失 | 运行 `pi update --extensions`，或按 `settings.json` 重新安装 packages。 |

## 开发验证

```bash
node pi-sync/tests/run.mjs
```

专用 runner 使用已安装 Pi SDK 的 `jiti`，仅创建测试临时文件，并使用本机 `127.0.0.1` fixture 完成传输测试。

## 更新日志

### v1.6.0

- `/sync` 菜单重构为 备份 / 恢复 / 修复 / 设置 / 退出 五项；语言切换移入设置。
- 归档命名统一为 `<device>-<platform>-<tag>_<UTC 时间戳>.tar.xz`，远端根目录可配置（默认 `pibak/`），每类备份独立目录、按设备 prune。
- 备份改为类别多选（文件锁串行执行）；恢复按设备+平台+时间戳合并行并支持设备筛选。
- 新增跨平台修复，处理 Pi 配置文件中的外来操作系统路径。
- 退出备份接入指纹比对，无变化跳过上传，并遵循 `exitBackupScope`。

### v1.4.0

- 删除按项目的对话归档备份与恢复能力。
- 保留 Pi 与共享 Skills 的备份/恢复，以及退出时备份已启用类别。

### v1.2.0

- 从实时同步改为有版本的纯归档备份/恢复。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
