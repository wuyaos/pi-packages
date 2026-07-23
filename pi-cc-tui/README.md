# pi-cc-tui

Pi 的主题与非冲突 TUI 组件包。

## 功能

- **99 个主题**：98 个由 oh-my-pi（omp）转换的主题，以及 `claude-code` 主题。
- **Pi 动画启动头**：显示模型、thinking level、项目路径和命令提示。
- **圆角输入框**：主题色边框、光标开口与内边距；不改变 Pi 原生输入、补全和发送逻辑。
- **状态栏**：模型、上下文与累计输入/输出/缓存用量、项目路径、上下文分段色条、可选工具统计与扩展状态。
- **诊断 Overlay**：只读的上下文和工具调用诊断，不会写入模型上下文。

工具调用、Bash 标题和输出、read/grep/find/ls 预览、edit/write Diff、用户消息框及 Thinking 标签由
[`pi-tool-display`](https://www.npmjs.com/package/pi-tool-display) 统一提供。CC-TUI 不覆盖这些 renderer，避免样式和生命周期冲突。

## 配置

运行 `/cc-tui` 打开交互式配置面板，可设置：

- 图标模式；
- Pi 原生启动资源清单（`[Context]`、`[Skills]`、`[Prompts]`、`[Extensions]`、`[Themes]`）的显示／隐藏；该设置通过 Pi 的 `quietStartup` 生效，需 `/reload` 或重启；
- 状态栏信息段。

状态栏使用固定、低开销的三行布局：模型位于首行左侧，当前上下文与累计输入/输出/缓存用量及工具统计位于首行右侧；第二行的路径与上下文色条各约占一半；第三行显示扩展状态。空间不足时优先裁剪模型名称，保留右侧实时统计。

### 图标模式

CC-TUI 的启动头、输入框、状态栏和 Overlay 共用一套语义图标。默认 `unicode`；字体不完整时可改用 ASCII；安装 Nerd Font 后可选择 `nerd`；也支持 Emoji：

```bash
PI_CC_TUI_ICON_MODE=ascii pi
PI_CC_TUI_ICON_MODE=nerd pi
PI_CC_TUI_ICON_MODE=emoji pi
```

图标设定会保存到 `~/.pi/agent/config/cc-tui.json` 的 `icons` 字段；在尚未保存该字段前，环境变量仍是兼容默认值。启动资源清单开关保存到 Pi 的 `~/.pi/agent/settings.json` 的 `quietStartup` 字段。Emoji 宽度由终端字体决定，窄终端建议使用 `unicode` 或 `ascii`。

## 命令

- `/cc-tui`：打开交互式配置面板。
- `/cc-tui context`：打开只读、可滚动的上下文诊断面板；不会写入模型上下文。
- `/cc-tui tools`：打开只读、可滚动的工具调用诊断面板；仅显示工具名与成功/失败状态，不含参数或结果内容。
- `/cc-tui apply`：启用 CC-TUI 的启动头、圆角输入框和状态栏。
- `/cc-tui reset`：恢复 Pi 原生输入框和页脚。

工具呈现配置请使用 `/tool-display`。其中可设置 Bash 输出模式、收起显示行数、read/search 预览、Diff 视图和用户消息框。

## 安装

```bash
pi install git:github.com/wuyaos/pi-packages
```

安装后使用 `/theme` 选择主题。

## 致谢

- 启动头、圆角输入框及相关渲染工具移植自 [pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)，作者 Phoobobo，MIT License。
- 98 个主题转换自 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）。
