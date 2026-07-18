# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
完成 pi-cc-tui 合并包的剩余工作。工作目录: /mnt/d/work/project/person/pi-packages

## 背景
正在把 4 个包合并成 1 个 pi-cc-tui 包，放在 monorepo /mnt/d/work/project/person/pi-packages/ 里。
已完成的文件:
- pi-cc-tui/themes/ (99 个 json, 已从 pi-themes + pi-claude-thinking 复制)
- pi-cc-tui/extensions/render-utils.ts (已从 pi-claude-code-tui 复制)
- pi-cc-tui/extensions/thinking.ts (已从 pi-claude-thinking 复制)
- pi-cc-tui/extensions/startup-header.ts (已创建, 含 Pi 动画 logo 启动头)

## 还需要做的

### 1. 创建 pi-cc-tui/extensions/codex-editor.ts
从 pi-claude-code-tui 的 claude-code-startup.ts 提取 CodexStyleEditor 类和 applyCodexEditor 函数。
源文件在: ~/.pi/agent/npm/node_modules/pi-claude-code-tui/extensions/claude-code-startup.ts
- 提取 CodexStyleEditor class (继承 CustomEditor)
- 提取 setEditorComponent 相关逻辑到 applyCodexEditor(ctx) 函数
- 需要 import: CustomEditor, ExtensionContext from pi-coding-agent; KeybindingsManager, EditorTheme, TUI from pi-tui
- 需要 import: applyRoundedEditorBorders, cursorOpenFromFgAnsi, restyleEditorCursor from ./render-utils.ts
- 导出 default function(pi) 在 session_start 时调用 applyCodexEditor(ctx)
- 也导出 applyCodexEditor 和 restoreDefaultEditor (ctx.ui.setEditorComponent(undefined))

### 2. 创建 pi-cc-tui/extensions/statusline.ts
从 /mnt/d/work/project/person/pi-packages/pi-statusline/extensions/statusline.ts 复制, 但做以下修改:
- 去掉 setTimeout hack (不再需要跟 pi-claude-code-tui 竞争)
- 直接在 session_start 同步调用 ctx.ui.setFooter(factory)
- git 默认关闭: const gitEnabled = process.env.PI_STATUSLINE_GIT === "1"
- 保留所有功能: 模型名/路径/git(分支+staged+modified+untracked)/上下文token/输出
- 颜色用 theme.fg tokens: accent/dim/success/warning/error/borderAccent/muted
- 也导出 applyStatusline(ctx) 和 restoreDefaultFooter(ctx) 函数
- 命令 /statusline-git 保留

### 3. 创建 pi-cc-tui/package.json
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

### 4. 创建 pi-cc-tui/README.md
中文文档, 说明:
- 功能列表 (99主题/启动头/codex输入框/thinking折叠/状态栏)
- 环境变量 PI_STATUSLINE_GIT (默认关闭, 设 "1" 开启)
- 命令列表 (/use-claude-code, /use-default-tui, /claude-thinking-preview, /statusline-git)
- 致谢 pi-claude-code-tui (MIT, Phoobobo) 和 oh-my-pi (omp) 主题
- 安装方式: pi install git:github.com/wuyaos/pi-packages

### 5. 检查 thinking.ts 的命令名
读 pi-cc-tui/extensions/thinking.ts, 看它注册了什么命令。如果有 /claude-thinking-preview 命令, 保留。如果它的 export default 里有 session_start 之外的逻辑, 确保不与 startup-header/codex-editor/statusline 冲突。thinking.ts 是 monkey-patch prototype, 不用 session_start, 所以不冲突。

### 6. 创建统一命令文件 pi-cc-tui/extensions/commands.ts
注册 /use-cc-tui 和 /use-default-tui 命令:
- /use-cc-tui: 调用 applyStartupHeader + applyCodexEditor + applyStatusline
- /use-default-tui: 调用 disposeStartupHeader + restoreDefaultEditor + restoreDefaultFooter + ctx.ui.setHeader(undefined)
- 需要从 startup-header/codex-editor/statusline import 对应的函数

### 7. 删除旧包目录
- rm -rf /mnt/d/work/project/person/pi-packages/pi-themes
- rm -rf /mnt/d/work/project/person/pi-packages/pi-statusline

### 8. git 提交
cd /mnt/d/work/project/person/pi-packages
git add -A
git -c user.name=wuya -c user.email=wuya@local commit -m "feat: 合并 pi-themes + pi-statusline + pi-claude-thinking + pi-claude-code-tui 为 pi-cc-tui

- 99 主题 (98 omp + claude-code)
- Pi 动画 logo 启动头 (移植自 pi-claude-code-tui, MIT Phoobobo)
- Codex 风格圆角输入框
- thinking 默认折叠 5 行
- 状态栏: 模型/路径/git/上下文/输出
- 统一 /use-cc-tui 和 /use-default-tui 命令
- 删除 pi-themes 和 pi-statusline 子包"
git push

### 重要约束
- 不要修改 ~/.pi/agent/ 下的任何文件 (settings.json 等由用户手动处理)
- 不要修改 pi-claude-thinking 源目录 /mnt/c/Users/wff19/Desktop/222/pi-claude-thinking
- extensions 目录下每个 .ts 文件都必须有 export default function(pi: ExtensionAPI)
- render-utils.ts 不是 extension, 没有 default export, 但它被其他文件 import, pi 加载它时会报错吗? 检查: 如果 pi 对 extensions/*.ts glob 的每个文件都要求 default export, 则 render-utils.ts 需要改名或移到非 extensions 目录。查 pi 文档确认: pi 的 extensions glob 只加载有 default export 的文件。render-utils.ts 没有 default export 会被跳过或报错。为安全起见, 如果不确定, 可以给 render-utils.ts 加一个空的 default export: export default function() {}
- 所有 TypeScript 文件用 jiti 加载, 支持 .ts 扩展名的 import (带 .ts 后缀)


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