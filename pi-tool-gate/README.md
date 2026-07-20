# pi-tool-gate

按需工具开关 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 扩展。
把重 schema 工具默认 inactive，需要时再激活，降低每轮请求 `tools[]` 的固定 token 占用（subagent schema 一项就 5-8k tokens）。

提供两套入口：

- **`gate_tools` loader 工具**（常驻 active）—— 模型自己判断需要某工具时调用，按 query 激活匹配的工具（additive，激活后跨轮保留）。
- **`/tool-gate` 命令**（用户手动管）—— `status` / `list` / `on` / `off` / `all` / `profile` / `reset` / `stats`，以及无参交互菜单。

## 工作机制

### 激活集单源真相

```
A = (全部工具中 不在 disabled∪userDisabled 或 在 protected∪HARDCODED_PROTECTED 的) ∪ sessionGranted
```

- `disabled`：默认 disabled 名单（`reset` 写回 `DEFAULT_DISABLED`）
- `userDisabled`：用户显式 `/tool-gate off` 的工具（loader 不可激活）
- `protected`：配置的受保护工具
- `HARDCODED_PROTECTED = [read, write, edit, bash]`：硬底线，不可被 config 编辑绕过
- `sessionGranted`：loader 运行时授予的工具集（会话级，session_start 清空）

### 四道闸（幂等应用）

| 事件 | 动作 |
|---|---|
| `session_start` | 清空 sessionGranted，首次应用 |
| `before_agent_start` | 重应用（比对实际 active 与 target，相同则跳过保 cache） |
| `model_select` | 换模型后 active 可能被重置，重应用（sessionGranted 保留） |
| `session_compact` | compaction 后同上 |

防抖比对 `pi.getActiveTools()` 而非内存签名，外部 reset 后能正确重应用。

### 不变式

1. `P ⊆ A`：protected 工具即使写进 disabled 也会被捞回
2. `HARDCODED_PROTECTED` 不可移除（即使手编 config）
3. `off all` 永远跳过 `P ∪ HARDCODED_PROTECTED`
4. `A` 为空 → 回退全开
5. loader 不可激活 `userDisabled` 的工具
6. `sessionGranted` 不可绕过 `userDisabled`（用户显式 off 后 loader 授予的工具也会被关闭）

## 默认配置

配置文件：`~/.pi/agent/config/tool-gate.json`（首次运行自动生成）

默认 disabled 名单（重 schema / 低频工具）：

```
subagent, subagent_wait, image_gen, image_review, tg_attach,
process_thought, generate_summary, clear_history, export_session,
import_session, get_thinking_history, get_thinking_status, sequential_think,
advisor, memory_search, session_search, skill_manage
```

默认 protected（永不关闭）：

```
read, write, edit, bash, grep, find, ffgrep, fffind,
ls, gate_tools, tool-gate, get_goal, create_goal, update_goal, memory
```

> **注意**：`memory` / `memory_search` / `session_search` / `recall` 等 proactive 认知工具**不在**默认 disabled 名单中 —— 它们是模型跨会话记忆的基础，模型不会主动调 loader 找它们，默认关会破坏记忆连续性。

## 命令

```
/tool-gate                 交互菜单（切换单个工具开关）
/tool-gate status          当前状态摘要
/tool-gate list            列出全部工具及开关状态
/tool-gate on <name>       开启某工具
/tool-gate off <name>      关闭某工具（写入 userDisabled，loader 不可恢复）
/tool-gate on all          开启全部
/tool-gate off all         关闭全部（跳过 protected ∪ HARDCODED_PROTECTED）
/tool-gate profile <name>  应用预设 profile
/tool-gate reset           重置为默认 disabled 名单（清空 userDisabled）
/tool-gate stats           使用统计
```

## gate_tools loader

模型可调用的参数化工具，常驻 active：

- `query`（string）：描述需要什么能力（如 "生成图片"、"搜索网页"）
- `activate`（string[]）：明确指定要激活的工具名
- `limit`（number，默认 10，最大 50）：最多激活几个匹配工具

loader 候选 = 全部工具 − 当前 active − protected − userDisabled。激活是 additive（`setActiveTools([...current, ...toAdd])`），且激活的工具加入 `sessionGranted`，下轮 `before_agent_start` 保留。

## 安装

本包是 [wuyaos/pi-packages](https://github.com/wuyaos/pi-packages) monorepo 的子包。

### 随整个 monorepo 安装

```bash
pi install git:github.com/wuyaos/pi-packages
```

### 只加载本子包（filter）

在 `~/.pi/agent/settings.json`：

```json
{
  "packages": [
    {
      "source": "git:github.com/wuyaos/pi-packages",
      "extensions": ["pi-tool-gate/index.ts"],
      "themes": [],
      "skills": []
    }
  ]
}
```

> 安装后需重启 pi 生效。本扩展会在 `session_start` 自动应用默认 gate，把重 schema 工具移出 `tools[]`，可观察到首轮 context token 显著下降（约 20k → 8-10k）。

## 与 pi-skill-gate 的关系

- `pi-skill-gate` 管 **skills**（prompt 扩展层）
- `pi-tool-gate` 管 **tools**（`pi.getAllTools()` / `setActiveTools()` 层）

两者无冲突，可同时使用。

## 开发

源码 `index.ts` 单文件，pi 运行时经 jiti 编译，无需预构建。类型检查：

```bash
cd pi-tool-gate
npx tsc --noEmit --skipLibCheck index.ts
```

（`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` 模块解析错误在隔离目录下是预期的，pi 运行时环境可正常解析。）

## License

MIT
