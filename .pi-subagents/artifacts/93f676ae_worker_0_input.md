# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
升级 pi-cc-tui 状态栏，加入 7 项新特性。工作目录: /mnt/d/work/project/person/pi-packages

## 当前文件
pi-cc-tui/extensions/statusline.ts 已存在，需要重写升级。

## 要加入的 7 项特性

### 第一优先（4 项）

#### 1. context 阈值变色
context 段根据使用百分比变色:
- <70%: success (绿)
- 70-85%: warning (黄)
- 85-95%: error (橙)
- >95%: error (红，加粗)
显示格式: `12k/128k (9%)` 或 `12k/128k` 都行，百分比可选。
计算: usage.tokens / contextWindow * 100

#### 2. `❯` 分隔符
所有段之间用 ` ❯ ` 分隔（注意前后有空格），替换当前的 `  `（双空格）。
示例: `glm-5.2 ❯ ~/project ❯ main +2 ~3 ?1 ❯ 12k/128k ❯ ↑5.2k`
分隔符用 theme.fg("dim", "❯") 着色

#### 3. `/cc-tui` 段配置器
注册 `/cc-tui` 命令，交互式 show/hide 各段:
- `/cc-tui` 或 `/cc-tui list` — 列出所有段及当前状态
- `/cc-tui only model git context` — 只显示指定段
- `/cc-tui show model` — 显示某段
- `/cc-tui hide model` — 隐藏某段
- `/cc-tui all` — 显示全部
- `/cc-tui none` — 全部隐藏
段名: model, git, context, output, cost, tokens, thinking, extensions
配置持久化到 ~/.pi/agent/config/cc-tui.json:
```json
{
  "segments": {
    "model": true,
    "git": true,
    "context": true,
    "output": true,
    "cost": false,
    "tokens": false,
    "thinking": false,
    "extensions": false
  }
}
```
默认: model/git/context/output 为 true，其余 false

#### 4. thinking 级别段
显示当前 thinking 级别: `think:medium` 或 `think:med` 缩写
通过 pi.getThinkingLevel() 获取
颜色: 用 theme.fg("accent", ...) 或根据级别着色

### 第二优先（3 项）

#### 5. cost($) 段
累计花费: `$0.123`
从 sessionManager.getBranch() 累加 message.usage.cost.total
颜色: 按金额梯度变色:
- <$0.10: muted
- $0.10-$1.00: dim
- >$1.00: warning

#### 6. TTFT + TPS 段
- TTFT (Time To First Token): 首 token 延迟秒数
- TPS (Tokens Per Second): 实时生成速度
实现:
- 在 before_provider_request 事件记录 startTime
- 在 message_update 事件检测第一个 output token 到达，计算 TTFT = now - startTime
- 在 message_update 持续更新 tokenCount，TPS = (currentTokens - firstTokenTime) / (now - firstTokenTime)
显示: `TTFT 2.7s ❯ 62 TPS` 或合并为一段 `2.7s/62tps`
颜色: TTFT >3s 红色, TPS <10 红色

#### 7. 扩展状态段
显示其他扩展通过 ctx.ui.setStatus() 发布的状态:
通过 footerData.getExtensionStatuses() 获取，返回 Map<string, string>
显示: 各状态用空格分隔
颜色: dim

## 实现要求

### 文件结构
只改 pi-cc-tui/extensions/statusline.ts，不需要新文件。

### 导出
保持现有导出不变:
- applyStatusline(ctx)
- restoreDefaultFooter(ctx)
- default function(pi)

### 配置加载/保存
```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const CONFIG_PATH = `${homedir()}/.pi/agent/config/cc-tui.json`;

interface SegmentConfig {
  model: boolean; git: boolean; context: boolean; output: boolean;
  cost: boolean; tokens: boolean; thinking: boolean; extensions: boolean;
}

const DEFAULT_CONFIG: SegmentConfig = {
  model: true, git: true, context: true, output: true,
  cost: false, tokens: false, thinking: false, extensions: false,
};

function loadConfig(): SegmentConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      return { ...DEFAULT_CONFIG, ...raw.segments };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg: SegmentConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ segments: cfg }, null, 2));
  } catch {}
}
```
注意: 配置要在模块加载时读取一次（因为 render 是同步的高频调用），命令修改后重新读取。

### TTFT/TPS 状态变量（模块级）
```typescript
let providerStartTime: number | null = null;
let firstTokenTime: number | null = null;
let tokenCount = 0;
let lastTTFT: number | null = null;
let lastTPS: number | null = null;
```

### 事件监听（在 default function(pi) 里）
```typescript
pi.on("before_provider_request", () => {
  providerStartTime = Date.now();
  firstTokenTime = null;
  tokenCount = 0;
});

pi.on("message_update", (event, ctx) => {
  if (!providerStartTime) return;
  // 检测 output token 增长
  const msg = (event as any).message;
  if (msg?.role === "assistant") {
    const output = msg.usage?.output || 0;
    if (output > 0) {
      if (!firstTokenTime) {
        firstTokenTime = Date.now();
        lastTTFT = (firstTokenTime - providerStartTime) / 1000;
      }
      tokenCount = output;
      if (firstTokenTime) {
        const elapsed = (Date.now() - firstTokenTime) / 1000;
        if (elapsed > 0.1) lastTPS = tokenCount / elapsed;
      }
    }
  }
});
```

### render 函数段组装
render 里按配置顺序组装段，每段如果配置为 false 就跳过。
顺序: model, thinking, git, context, tokens, output, cost, extensions
用 ` ❯ ` 分隔（dim 着色）

### /cc-tui 命令
保留原来的 /statusline-git 命令不变。
新增 /cc-tui 命令处理段配置。

### 命令处理
对于 `/cc-tui` 无参数或 list，用 ctx.ui.notify() 通知当前配置状态。
对于 show/hide/only/all/none，修改配置后 saveConfig，然后 tui.requestRender()（如果拿到 tui 的话，或通过 setFooter 重新注册）。
注意: 命令 handler 里没有 tui 引用。可以在 applyStatusline 时把 setFooter 的 factory 返回的对象存到模块级变量，命令修改配置后调用 setFooter 重新注册。或者更简单: 命令修改配置后调 ctx.ui.notify 提示"重启后生效"或直接重新 setFooter。
最简单方案: 命令修改配置后，直接重新调用 applyStatusline(ctx) 重新注册 footer。

## 完成后
1. 检查语法: node --check 无法检查 TS，但可以目视检查
2. git add -A
3. git -c user.name=wuya -c user.email=wuya@local commit -m "feat(pi-cc-tui): 状态栏升级 — 7 项新特性

- context 阈值变色 (绿→黄→橙→红)
- ❯ 分隔符
- /cc-tui 段配置器 (持久化 JSON)
- thinking 级别段
- cost($) 累计花费段
- TTFT + TPS 段
- 扩展状态段"
4. git push

## 重要约束
- 不修改 ~/.pi/agent/ 下任何文件
- 保持现有 applyStatusline/restoreDefaultFooter/default 导出
- 配置文件路径 ~/.pi/agent/config/cc-tui.json
- git 默认关闭 (PI_STATUSLINE_GIT=1 开启) 不变

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