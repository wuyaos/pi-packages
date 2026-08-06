# pi-sync promotion drafts

## English

**pi-sync 1.2** — versioned WebDAV archives for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

```bash
pi install npm:@wuyaos/pi-sync
/sync
```

Highlights:

- Direct `~/.pi/agent` archive with configurable exclusions
- Independent shared-Skills and per-project session archives
- Automatic current-project archive when Pi exits
- Back Up All / Restore All (latest)
- English and Chinese menus
- Streamed WebDAV transfers and safe archive validation
- No live or per-turn synchronization

WebDAV layout:

```text
backup/pi/
backup/skills/
backup/sessions/<project>/
```

Repository: https://github.com/wuyaos/pi-packages/tree/master/pi-sync

## 简体中文

**pi-sync 1.2**：面向 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的 WebDAV 有版本归档备份。

```bash
pi install npm:@wuyaos/pi-sync
/sync
```

主要特性：

- 直接归档 `~/.pi/agent`，支持黑名单排除
- 共享 Skills 与项目会话独立归档
- 退出 Pi 时自动归档当前项目会话
- 全部备份 / 全部恢复（最新）
- 中英文菜单切换
- WebDAV 流式传输与安全归档校验
- 不进行实时或每轮同步

WebDAV 目录：

```text
backup/pi/
backup/skills/
backup/sessions/<project>/
```

仓库：https://github.com/wuyaos/pi-packages/tree/master/pi-sync
