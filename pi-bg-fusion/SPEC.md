# pi-bg-fusion SPEC

## 目标

在 `src/`（已就位：pi-better-background-tasks 0.9.1 源码，MIT，见 LICENSE）之上改造出新的本地 pi 扩展包 **pi-bg-fusion**，把 patty 的交互体验（120s 自动后台、Ctrl+B）并入 better 的 Windows 感知持久化内核，并补齐 Windows 进程身份校验。

安装方式：`pi install ./pi-bg-fusion` （从 monorepo 根目录运行）（本地包，不发布 npm）。

## 已确认的需求决策（逐项，不得擅自更改）

| # | 项 | 决定 |
|---|---|---|
| 1 | 正常退出时运行中任务 | 询问用户：统一选择"全部保留/全部停止"，可逐项调整 |
| 2 | 崩溃/强杀时任务 | 继续运行；重启后恢复管理或补报结果 |
| 3 | 自动转后台阈值 | 120 秒，可配置 |
| 4 | 任务完成通知 | 通知 AI 检查退出码与日志，继续原任务，不扩大授权 |
| 5 | 重启恢复范围 | 原会话自动恢复；同项目新会话可查看但需手动接管 |
| 6 | 运行中通知 | 已实现：运行中关键词/正则唤醒及独立频率／预算按 R2a；终态 callback 与 failure/watch attention 保持不变 |
| 7 | 首版范围 | 只做 shell 命令 + 日志监控，不含后台 AI 子代理 |
| 8 | 保留期 | 已完成任务 7 天，日志按容量轮转 |
| 9 | 单任务日志上限 | 达到上限时轮转，保留最近 50 MiB，任务继续运行并标注历史已截断 |
| 10 | 退出询问形式 | 统一选择，可逐项调整 |
| 11 | 工具接口 | 沿用 `bg_task` / `bg_status`（现有 src/tools.ts 已注册，含 bg_task_spawn 等细分工具） |
| 13 | 代码底座 | pi-better-background-tasks（已就位） |
| 14 | Windows 进程身份 | `Get-CimInstance Win32_Process` 取 CreationDate + pid 双因子 |
| 15 | Ctrl+B | 移植 patty 的快捷键实现（源码在 `%TEMP%/fusion/patty/`，只读参考，不复制整文件，按需借鉴） |
| 17 | 日志目录 | `%TEMP%\pi-bg\`（沿用现状） |
| 18 | 自动转后台时输出 | 原地转，进程继续，后续输出写日志；对话立即释放 |
| 19 | 与现装插件共存 | 开发期不卸载 `@vanillagreen/pi-background-tasks`；验收通过后再切换 |
| 20 | monitor 流式工具 | 首版不做 |
| 21 | 包名 | `pi-bg-fusion`，本地安装 |

## 实现要求

### R1 shell 解析（Windows）

顺序，第一条命中即用：

1. 显式配置：环境变量 `PI_BG_FUSION_SHELL`，其次 settings 中的覆盖项
2. **跟随 pi 当前 shell**：从 `process.env.SHELL` 或 pi 进程链上已用的 bash 路径取得；**不得写死 Niubash 专属路径**
3. Git for Windows：`C:\Program Files\Git\bin\bash.exe`、`C:\Program Files (x86)\Git\bin\bash.exe`、`C:\Program Files\Git\usr\bin\bash.exe`
4. PATH 上首个 `bash.exe`，跳过 `system32` 与 `WindowsApps`（WSL 垫片）
5. POSIX：`/bin/bash`

约束：第 2 条取到的路径必须做真伪校验（存在且不是 system32/WindowsApps），否则落到第 3 条。现有 `resolveDefaultShell()` 在 `src/process.ts`，按此顺序改写。

### R2 120s 自动转后台 + Ctrl+B

- 前台 bash 工具执行超过阈值（默认 120s，可配置，0 表示关闭）时：**不重启进程**，把既有子进程的后续输出重定向到 `%TEMP%\pi-bg\<id>.log`，从工具结果中返回任务 id 与"已转后台，用 bg_status/bg_task_log 查看"的提示，立即释放对话。
- Windows 上由于已用 `exec >> log` 由子 shell 自己重定向（见 `src/process.ts: withWindowsLogRedirect`），转后台只需停止前台收集 stdout 并把任务状态改为 running/backgrounded，不需改管道。
- Ctrl+B：运行中且已超过约 2 秒时，在输入区下方显示 `(ctrl+b to run in background)` 提示；按键后立即执行与超时相同的转后台动作。参考 `%TEMP%/fusion/patty/src/shortcuts.ts`、`input.ts`、`hint.ts`。
- 转后台后任务完成仍按 R4 通知。


### R2a 运行中 output wake（已实现）

- `wake_patterns` 在任务目录创建前校验；每个模式扫描新增日志窗口，游标由 `logGeneration + 绝对字节 offset` 组成，单次窗口不超过 64 KiB。
- Wake 参数用于 `bg_task_spawn` / `bg_task_watch` 及对应 `bg_task` action；`callback` 省略或为 `true` 才扫描，前台 `bash` 不接受 wake 参数。
- 元数据先原子 fsync 提交 cursor、pending 与 summary，再通过既有 `deliverUrgent` 投递；事件身份包含 task、pattern、generation、offset。崩溃策略为宁可少发、不重复发。
- 默认同一 pattern + 同一日志行内容只唤醒一次；默认 cooldown 60 秒、单任务最多 10 次、session 每小时最多 30 次。预算文件为 `%TEMP%/pi-bg/wake-budget.json`，使用跨进程 lock + 原子 JSON 写入。
- 本地任务由 1 秒 retention tick 扫描；remote tmux append 和 command_watch append 后扫描。当前实现复用 callback batcher，不新增投递面。
- 并发前台 bash 的 Ctrl+B 策略：只选择最近启动且仍运行的调用，不弹出逐任务选择。
- 原生 `bash.timeout` 继续负责命令超时；`handoff_after_seconds` 仅负责前台移交。

### R3 Windows 进程身份与进程树

- `src/process-identity.ts` 当前在 win32 直接 `return undefined`（放弃校验）。改为：
  - 探测命令：`powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \"ProcessId=N\" | Select-Object -ExpandProperty CreationDate"`，输出转 ISO/UTC 归一化比较；`windowsHide: true`、超时 1~2s。
  - 批量探测：一次查询多个 pid（`ProcessId=1 OR ProcessId=2 ...` 或一次取全部后过滤），恢复/孤儿巡检时使用，避免逐 pid 起 powershell。
  - 判定：pid 在 + CreationDate 与记录值一致 → 存活；pid 在但 CreationDate 不同 → 视为 pid 复用（gone）；探测超时/失败 → `unknown`，下轮再问，**不得据此判死**。
  - 探测结果缓存，避免同一轮重复查询。
- 进程树终止保持现有 `taskkill /T /F`（`src/process.ts: stopProcessGroup`），不要改回 `process.kill(pid)`。
- Unix 路径行为保持现状（detached + `kill(-pgid)` + `/proc` starttime）。

### R4 退出与恢复

- 正常退出（`session_shutdown` 且 reason 为正常退出）且有 running 任务时：弹出统一选择（全部保留/全部停止），允许逐项调整后确认。选"停止"走现有终止路径；选"保留"标记为 detached 并写入 journal。
- 非交互 print mode 无法弹出 quit 选择，默认保留运行任务，并在保留路径上设置 `callback=true`，确保后续完成通知仍可发送。
- 崩溃/强杀：任务自然继续（现有 detached + 日志由子进程写的机制已保证）；重启后：
  - 同会话恢复：自动接管；
  - 其他会话的任务：可列出，需显式操作才接管，不自动向 AI 注入。
- 退出 journal：`%TEMP%\pi-bg\` 下每任务一份元数据，write→fsync→rename 原子写，记录 pid、进程启动时间(token)、命令、cwd、日志路径、状态、退出码、通知是否已消费。
- 补发：重启扫描 journal，已终态且未消费 → 通知一次并落盘消费标记；pid 已死但无终态 → 标 lost 并通知一次；无法判定 → 保持 running，交给孤儿巡检（现有 `src/stall.ts` / 恢复路径）。
- 通知语义：宁可少发不可重发；不得宣称精确一次投递。
- 保留期 7 天（沿用现有 maintenance 逻辑）。

### R5 日志

- 目录 `%TEMP%\pi-bg\`，与现有实现一致。
- 单任务日志达到 50 MiB 时轮转为 `<id>.log.1`（保留最近一份），任务不中断，任务元数据标注 `truncated`；`bg_task_log` 读取时合并轮转前后内容并提示截断。
- 运行中任务不因保留期清理删除。

### R6 不破坏现有能力

- 保留现有全部工具（`bg_task`、`bg_status`、`bg_task_spawn/watch/list/status/log/stop`）与既有 durable/wake 语义、7 天保留、stalled 检测、navigator。
- 不引入后台 AI 子代理；`src/maintenance.ts` 等原有逻辑保留。
- Windows rotation wake and budget contention have been accepted; Native Linux and interactive UI paths remain unverified.
- 包名改 `pi-bg-fusion`，version 从 0.1.0 起；保留 LICENSE 与对 pi-better-background-tasks / pi-patty-bg-tasks 的 THIRD_PARTY 署名（新建 THIRD_PARTY_NOTICES.md）。

## 验收（只认真实路径）

必须实跑并记录所用路径与结果：

1. 120s 自动转后台：Niubash 下 `bash -c 'for i in $(seq 1 200); do echo t$i; sleep 1; done'` → 120s 后工具返回提示、对话可继续、日志继续增长、进程未重启（校验 pid 不变）。
2. Ctrl+B：同一长命令运行中按键 → 立即转后台，提示消失。
3. 进程树终止：启动 `npm run dev` 类或 `bash -c 'sleep 300 & sleep 300'` → `bg_task_stop` 后用 `Get-CimInstance Win32_Process` 确认**无残留**（父与孙都消失）。
4. 崩溃恢复：启动长任务 → 强杀 pi 进程 → 重启 → 任务被接管且日志连续；任务在 pi 不在线期间结束 → 重启后收到一次完成通知（且仅一次）。
5. 正常退出询问：有运行任务时退出 → 出现统一选择；选"全部停止"后无残留进程；选"保留"后任务继续。
6. Windows 进程身份：伪造一个已死 pid + 记录的 CreationDate → 判定 gone；伪造 pid 复用（记录一个不同 CreationDate 的存活 pid）→ 判定 gone，不误收养。
7. 默认配置下行为与改前一致（`tsc --noEmit` 通过，原有工具不回归）。

无法验证的项明确标注"未验"，不得伪称通过。

## 边界

- 只改本目录内文件。参考源码 `%TEMP%/fusion/patty/`（patty）只读；不整文件复制，按需借鉴并在 THIRD_PARTY_NOTICES.md 注明。
- 不实现 patty 的 monitor/steering/agent_bg。
- Windows 上不要假设 POSIX 信号语义；不要用 `process.kill(-pid)`。
- 遇到与现有结构冲突的重大决策，上抛而非猜测。

## 预期时长

4~6 小时（含 Windows 真路径验证）。超时 2 倍或同一错误重试 2 次失败即停并回报事实。