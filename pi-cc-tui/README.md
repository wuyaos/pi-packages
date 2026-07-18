# pi-cc-tui

Claude Code 风格的 pi 终端体验包，集中提供主题和 TUI 组件。

## 功能

- **99 个主题**：98 个由 oh-my-pi（omp）转换的主题，加 `claude-code` 主题
- **Pi 动画启动头**：包含模型、thinking level、项目路径和命令提示
- **Codex 风格输入框**：圆角上下边框和主题色光标
- **thinking 折叠**：默认预览 5 行，按 `Ctrl+T` 展开完整内容
- **状态栏**：模型、项目路径、git 分支与可选文件统计、上下文 token、累计输出 token

## 配置

`PI_STATUSLINE_GIT` 默认关闭：状态栏只显示 git 分支，不运行 `git status --porcelain`。

需要显示 staged、modified 和 untracked 文件数时，在启动 pi 前设置：

```bash
export PI_STATUSLINE_GIT=1
```

## 命令

- `/use-cc-tui`：启用动画启动头、Codex 输入框和自定义状态栏
- `/use-default-tui`：恢复 pi 内置启动头、输入框和状态栏
- `/claude-thinking-preview <n>`：设置 thinking 折叠预览行数，省略参数恢复为 5 行
- `/statusline-git`：显示切换 git 状态统计所需的环境变量值

## 安装

```bash
pi install git:github.com/wuyaos/pi-packages
```

安装后使用 `/theme` 选择主题。

## 致谢

- 启动头、Codex 输入框及渲染工具移植自 [pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)，作者 Phoobobo，MIT License
- 98 个主题转换自 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）
