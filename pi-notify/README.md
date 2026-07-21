# pi-notify

[pi](https://pi.dev) 桌面通知扩展：任务完成时弹通知。跨平台（WSLg / Windows / Linux / macOS）。

## 工作原理

- `agent_start` 记录运行开始时间
- `agent_settled`（pi 空闲）时若运行时长 ≥ 阈值则弹通知
- 短任务不通知，避免打扰

## 通知方式（按优先级 fallback）

**Windows / WSL**：
1. **WinRT Toast**（现代 Toast，带 pi 图标）— 需先运行 `/notify-install` 注册 AUMID
2. `powershell.exe` BalloonTip（老式保底，无需注册）

**Linux / WSLg**：
1. `notify-send`

**macOS**：
1. `osascript`

## 首次安装（Windows / WSL）

Windows 11 默认会把未注册身份的 Toast 静默进通知中心（不弹横幅）。
安装后请运行一次：

```
/notify-install
```

它会完成（幂等，可重复运行）：
1. 部署 pi 图标到 `~/.pi/agent/assets/pi-logo.png`
2. 注册 AUMID `PiCodingAgent.Notify` 到注册表
3. 创建开始菜单快捷方式「Pi Coding Agent」（AUMID 载体）

之后 `/notify-test` 发的 Toast 才会弹成右下角横幅。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_NOTIFY_MIN_SECONDS` | `10` | 最小运行秒数才通知 |
| `PI_NOTIFY_TITLE` | `pi` | 通知标题 |
| `PI_NOTIFY_DISABLE` | *(空)* | `1` 禁用 |

## 命令

- `/notify-install` — 注册 Windows Toast AUMID（首次安装后运行一次）
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
