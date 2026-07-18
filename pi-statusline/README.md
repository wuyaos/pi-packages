# pi-statusline

omp 风格状态栏，移植自 oh-my-pi 的 statusLine 设计。

## 显示内容

```
glm-5.2  ~/project  main +2 ~3 ?1  12k/128k  ↑5.2k
```

| 段 | 示例 | 颜色 token | 说明 |
|---|---|---|---|
| 模型名 | `glm-5.2` | `accent` | 当前模型 |
| 项目路径 | `~/project` | `dim` | 当前工作目录 |
| git 分支 | `main` | `success`(干净)/`warning`(有改动) | 当前分支 |
| staged | `+2` | `success` | 已 staged 文件数 |
| modified | `~3` | `warning` | 已修改未 staged |
| untracked | `?1` | `error` | 未跟踪文件数 |
| 上下文 | `12k/128k` | `borderAccent` | 已用/上下文窗口 |
| 输出 | `↑5.2k` | `muted` | 累计输出 token |

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_STATUSLINE_GIT` | `1` | `0` 关闭 git 状态统计 |

关闭 git 统计后只显示分支名，不跑 `git status --porcelain`，适合 WSL `/mnt/c` 等慢路径。

## 命令

- `/statusline-git` — 提示如何切换 git 统计开关

## 安装

作为 pi-packages monorepo 一部分：

```bash
pi install git:github.com/wuyaos/pi-packages
```

只加载状态栏（filter）：

```json
{
  "packages": [{
    "source": "git:github.com/wuyaos/pi-packages",
    "extensions": ["pi-statusline/extensions/*.ts"]
  }]
}
```

## 性能

- git 状态每 2 秒异步刷新一次（`git status --porcelain`）
- 分支变化由 pi 的 footerData watcher 实时通知
- WSL `/mnt/c` 路径可关闭 git 统计降低开销
