# pi-notify

[pi](https://pi.dev) 桌面通知扩展：任务完成时弹通知。跨平台（WSLg / Windows / Linux / macOS）。

## 工作原理

- `agent_start` 记录运行开始时间
- `agent_settled`（pi 空闲）时若运行时长 ≥ 阈值则弹通知
- 短任务不通知，避免打扰

## 通知方式（按优先级 fallback）

1. `notify-send`（Linux / WSLg）
2. `powershell.exe` BalloonTip（Windows / WSL）
3. `osascript`（macOS）

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_NOTIFY_MIN_SECONDS` | `10` | 最小运行秒数才通知 |
| `PI_NOTIFY_TITLE` | `pi` | 通知标题 |
| `PI_NOTIFY_DISABLE` | *(空)* | `1` 禁用 |

## 命令

- `/notify-test` — 测试通知
- `/notify <标题> [正文]` — 自定义通知

## 安装

作为 pi-packages monorepo 一部分：

```bash
pi install git:github.com/<user>/pi-packages
```

只加载 pi-notify（filter）：

```json
{
  "packages": [{
    "source": "git:github.com/<user>/pi-packages",
    "extensions": ["pi-notify/extensions/*.ts"]
  }]
}
```
