# Agent Note: model-config 保存时自动探测 chat 参数（auto probe on save）

Status: implemented

## Problem

远程发现或 models.json 外部 chat 模型经常缺少 `contextWindow` / `maxTokens` / thinking 元数据；此前只能落盘 Pi 兼容默认值 128K/16K 并标 `compat`（未验证）。手动逐模型 Ctrl+K/Ctrl+L 探测成本高、入口分散，用户保存时往往直接带着未验证默认值写入配置。

## Decision

保存流程进入 preview 前（`preparePreview` 内，`Ctrl+S` 之后、preview 展示之前），对 selectedDraft 中 metadata 仍为 `compat`（或无 metadata 条目）的 chat 模型逐个**串行**发送一个最小探测请求：`POST {baseUrl}/chat/completions`，body `{ model, messages: [{ role: "user", content: "用中文写一段约300字的描写" }], max_tokens: 100000 }`，单请求 15 秒超时。每个请求都是真实调用、可能计费；期间显示统一盒式进度面板（X/Y 已完成），Esc 取消剩余请求，已完成结果保留。

推断规则（`src/auto-probe.ts` 纯函数 `inferAutoProbeParams`）：

- `finish_reason=length` 且 `usage.completion_tokens_details.reasoning_tokens > 0`（或 `message.reasoning_content` 非空）→ `maxTokens = max(2 × reasoning_tokens, 16384)`，`reasoning=true` + 协议默认 thinkingLevelMap；
- `finish_reason=length` 无 reasoning → `maxTokens = max(completion_tokens, 16384)`（保守取当前截断点）；
- `finish_reason=stop` → `maxTokens = 32768`；
- 其他 finish_reason、HTTP 非 2xx、超时、取消、JSON/形状不可信 → 返回 null，模型静默沿用 128K/16K 兼容默认值。

探测成功回填草稿并标 `contextSource/maxTokensSource/thinkingSource="probed"` + `verifiedAt`；contextWindow 无法由探测可靠测出，保留现值或 128000，但也标 `probed` 表示"本轮已探测确认保留默认"。失败项保持 `compat`，因此下次保存会再次尝试探测——这是有意的：探测失败可能是暂时性的（网络/限流），不应把失败伪装成已验证。preview「模型配置」分类为新增条目追加「参数已自动探测（实测）」来源标记；最终落盘仍需 preview 用户确认。

凭据与 URL 安全自动复用 discovery 规则：URL 过 `validateHttpUrl`（HTTP(S) only、禁嵌入凭据/secret query）；`$ENV`/`$$` 字面量按 discovery 同样解析；reuse-pi 的 Pi 凭据仅在与模型地址同 origin 时经 `Authorization: Bearer` 转发（`resolveProbeApiKey`）；provider 专属代理同样生效。探测请求永不抛出——所有失败路径返回 null。

开关：`model-config.json` 顶层 `"autoProbeOnSave": false` 整体关闭；缺省开启。schema、类型与 `parseModelConfig` 校验同步。

## Alternatives considered

### 复用现有 Ctrl+K 上下文探测（runContextProbe/streamSimple）

它测 contextWindow 下界但需要 runtime 已加载模型（保存前的新勾选模型通常不在 registry），且不产生 maxTokens/thinking 信息；每个目标还要多次大 payload 请求，费用远高于单次最小请求。放弃作为自动路径，保留为手动深探测。

### 探测失败时也标记 probed 防止重复请求

这会把"没测出来"记成"测过"，与 `probed` 语义（实测确认）冲突；下次保存重试 15 秒一次的代价小于错误元数据被永久固化。

### 并发探测

顺序更快，但多模型同时打真实请求更容易触发服务商限流，也会让"Esc 取消剩余"的语义复杂化。串行是最小正确实现。

## Consequences

新增勾选模型保存即得到经过一次真实调用校准的 maxTokens/thinking 元数据，而不是未验证的 128K/16K。代价：每次保存都可能对 compat 目标发出付费请求（Esc 可中止；`autoProbeOnSave: false` 可整体关闭）；推断规则是启发式——`stop→32768`、`length→2×reasoning` 都是保守估计，不是服务商承诺值；探测只覆盖 OpenAI 兼容 `/chat/completions` 端点，anthropic-messages/google 等原生协议的模型若无兼容网关将探测失败并留在 `compat`。

## Verification

`tests/auto-probe.test.ts`（13 例，mock fetch）：请求形状（URL/headers/body/max_tokens=100000）、length+reasoning（2× 与 16384 下限）、length 无 reasoning（截断点与下限）、stop→32768、reasoning_content 判定、错误/超时/取消/bad JSON/bad shape→null、URL SSRF 规则、`resolveProbeApiKey`（env/`$$`/reuse-pi origin 限制）、`probeTargetsFor` 目标筛选、`runProbeQueue` 串行顺序与 Esc 取消语义、`autoProbeOnSave` 配置校验与默认值。
