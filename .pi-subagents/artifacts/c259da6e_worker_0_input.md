# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
完成 pi-cc-tui 合并包的剩余工作。工作目录: /mnt/d/work/project/person/pi-packages

## 背景
正在把 4 个包合并成 1 个 pi-cc-tui 包，放在 monorepo /mnt/d/work/project/person/pi-packages/ 里。
已完成的文件:
- pi-cc-tui/themes/ (99 个 json, 已从 pi-themes + pi-claude-thinking 复制)
- pi-cc-tui/extensions/render-utils.ts (已从 pi-claude-code-tui 复制, 纯工具函数无 default export)
- pi-cc-tui/extensions/thinking.ts (已从 pi-claude-thinking 复制, monkey-patch prototype)
- pi-cc-tui/extensions/startup-header.ts (已创建, 含 Pi 动画 logo 启动头, 导出 applyStartupHeader/disposeStartupHeader/default)

## 还需要做的

### 1. 创建 pi-cc-tui/extensions/codex-editor.ts
从 pi-claude-code-tui 的 claude-code-startup.ts 提取 CodexStyleEditor 类和 setEditorComponent 逻辑。
源文件在: ~/.pi/agent/npm/node_modules/pi-claude-code-tui/extensions/claude-code-startup.ts
- 提取 CodexStyleEditor class (继承 CustomEditor, constructor 接收 tui/theme/keybindings/cursorOpen)
- 创建 applyCodexEditor(ctx) 函数: ctx.ui.setEditorComponent((tui, theme, keybindings) => { const cursorOpen = () => cursorOpenFromFgAnsi(ctx.ui.theme.getFgAnsi("accent")); return new CodexStyleEditor(tui, theme, keybindings, cursorOpen); })
- 导出 restoreDefaultEditor(ctx): ctx.ui.setEditorComponent(undefined)
- default export function(pi): pi.on("session_start", (_e, ctx) => applyCodexEditor(ctx))
- imports: CustomEditor, type ExtensionAPI, type ExtensionContext from @earendil-works/pi-coding-agent; type EditorTheme, type KeybindingsManager, type TUI from @earendil-works/pi-tui; applyRoundedEditorBorders, cursorOpenFromFgAnsi, restyleEditorCursor from ./render-utils.ts

### 2. 创建 pi-cc-tui/extensions/statusline.ts
基于 /mnt/d/work/project/person/pi-packages/pi-statusline/extensions/statusline.ts, 但做以下修改:
- 去掉 setTimeout hack (不再需要跟 pi-claude-code-tui 竞争)
- 直接在 session_start 同步调用 ctx.ui.setFooter(factory)
- git 默认关闭: const gitEnabled = process.env.PI_STATUSLINE_GIT === "1"
- 导出 applyStatusline(ctx) 和 restoreDefaultFooter(ctx) 函数, applyStatusline 包含 setFooter 逻辑, restoreDefaultFooter 调 ctx.ui.setFooter(undefined)
- 保留 /statusline-git 命令
- 保留所有功能: 模型名/路径/git(分支+staged+modified+untracked)/上下文token/输出
- 颜色用 theme.fg tokens: accent/dim/success/warning/error/borderAccent/muted
- default export function(pi): pi.on("session_start", (_e, ctx) => applyStatusline(ctx)) + pi.on("session_shutdown", ...) 清理 timer + pi.registerCommand("statusline-git", ...)

### 3. 创建 pi-cc-tui/extensions/commands.ts
注册统一命令:
- /use-cc-tui: 调用 applyStartupHeader(pi,ctx) + applyCodexEditor(ctx) + applyStatusline(ctx)
- /use-default-tui: 调用 disposeStartupHeader() + restoreDefaultEditor(ctx) + restoreDefaultFooter(ctx) + ctx.ui.setTitle("pi") + ctx.ui.setHeader(undefined)
- 从 ./startup-header.ts import { applyStartupHeader, disposeStartupHeader }
- 从 ./codex-editor.ts import { applyCodexEditor, restoreDefaultEditor }
- 从 ./statusline.ts import { applyStatusline, restoreDefaultFooter }
- default export function(pi) 注册命令, 不需要 session_start

### 4. 给 render-utils.ts 加空 default export
render-utils.ts 是纯工具函数, 没有 default export。pi 的 extensions glob 可能要求每个 .ts 都有 default export。
先读文件, 在末尾加: `export default function() {}`

### 5. 创建 pi-cc-tui/package.json
```json
{
  "name": "pi-cc-tui",
  "version": "1.0.0",
  "description": "Claude Code 风格 pi 体验: 99 主题 + Pi 启动头 + Codex 输入框 + thinking 折叠 + 状态栏",
  "keywords": ["pi-package"],
  "license": "MIT",
  "pi": {
    "themes": ["./themes/*.json"],
    "extensions": ["./extensions/*.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  }
}
```

### 6. 创建 pi-cc-tui/README.md
中文文档, 说明:
- 功能列表 (99主题/启动头/codex输入框/thinking折叠/状态栏)
- 环境变量 PI_STATUSLINE_GIT (默认关闭, 设 "1" 开启)
- 命令列表 (/use-cc-tui, /use-default-tui, /claude-thinking-preview, /statusline-git)
- 致谢 pi-claude-code-tui (MIT, Phoobobo) 和 oh-my-pi (omp) 主题
- 安装方式: pi install git:github.com/wuyaos/pi-packages

### 7. 删除旧包目录
- rm -rf /mnt/d/work/project/person/pi-packages/pi-themes
- rm -rf /mnt/d/work/project/person/pi-packages/pi-statusline

### 8. git 提交
cd /mnt/d/work/project/person/pi-packages
git add -A
git -c user.name=wuya -c user.email=wuya@local commit -m "feat: 合并为 pi-cc-tui 单包

- 99 主题 (98 omp + claude-code)
- Pi 动画 logo 启动头 (移植自 pi-claude-code-tui, MIT Phoobobo)
- Codex 风格圆角输入框
- thinking 默认折叠 5 行
- 状态栏: 模型/路径/git/上下文/输出
- 统一 /use-cc-tui 和 /use-default-tui 命令
- 删除 pi-themes 和 pi-statusline 子包"
git push

### 重要约束
- 不要修改 ~/.pi/agent/ 下的任何文件
- 不要修改 /mnt/c/Users/wff19/Desktop/222/pi-claude-thinking 源目录
- extensions 目录下每个 .ts 文件都必须有 export default function(pi)
- TypeScript 文件用 jiti 加载, import 支持 .ts 后缀
- 完成后验证: 每个 .ts 文件都有 export default, 语法正确

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```