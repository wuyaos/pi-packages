# Agent Note: model-config 的目录归属、双文件事务与请求级代理

Status: implemented

## Problem

Pi 的 chat 配置属于标准 `models.json`，而 classifier/image 需要 extension provider 的原生 operation 实现。把三种类型都伪装进 `models.json` 会破坏 schema 与调用分发；另一方面，extension `models` 会替换 provider 的完整多类型目录，直接给内置 provider 注入非 chat 模型会覆盖其目录。Provider 代理还必须覆盖 discovery 和后续请求，同时不能修改进程环境或全局 Undici dispatcher。

## Decision

`@wuyaos/pi-model-config` 使用两个持久化文件并维护显式归属：

- `models.json` 只存 chat 模型、标准 provider endpoint 与标准 `apiKey` 值。
- `model-config.json` 存 classifier/image、Discovery URL、代理和 `managedChatIds`。
- `(provider, type, id)` 是选择与 diff 的唯一身份。
- 未勾选只删除插件管理集合；未知字段、其他 provider 和内置目录保持原样。非托管 `models.json` chat 初始以 `external-config` 原因只读；显式 `Manage existing models` 仅把当前服务商这些原始 chat 行加入内存 managed scope 并默认选中，最终 Save 才更新 `managedChatIds`。保存时直接复用原始 models.json 对象以保留未知字段；接管后取消勾选才会移除该行。仅来自 builtin/runtime extension 的 catalog 模型使用不同的 `runtime-catalog` 只读原因，不能伪装成可删除。
- 合并同 identity 时 managed / external / installed 元数据优先于 remote；只有新增 identity 使用远程缺省，类型切换若撞到现有 identity 则拒绝。
- `/model-config` 使用显式页面状态机：Overview → Connection/Models → Preview。Overview 左侧只列 `models.json.providers ∪ model-config.json.providers`，右侧只显示选中摘要，动作固定在底部；Overview Enter 直接创建/恢复当前 provider draft 并进入 Connection；独立只读 Detail 已删除。服务商来源只标 `Custom` 或 `Built-in`，不把已有自定义 models.json 服务商整体标成 external/read-only，也不在每行重复 configured/not verified。未配置 runtime extension provider 不进 Overview；builtin 新建以 `owned=false` 进入 draft。总览 `[Ctrl+Del] 删除服务商` 经危险 ConfirmationPanel 后用既有双文件 transaction 同时删除目标 `models.json.providers[id]` 和 `model-config.json.providers[id]`；不删除 `auth.json`，并说明若另一个扩展管理同 provider，其运行时目录可能仍由该扩展决定。删除 builtin 后 reload 恢复 Pi 内置目录；有 models.json 条目的 custom provider 可删除/启停；仅没有 models.json、非 builtin 且未接管的第三方 runtime provider 被拒绝；当前会话正使用目标 provider 也拒绝。
- classifier/image 只允许注册到用户明确标记为插件自有的自定义 provider。未接管 provider 只能使用 chat overlay；完整 transport wrapper 仅用于可重建 native provider 的 Pi 内置 provider，第三方 extension provider 会被拒绝。
- provider 注册按 type 分别验证 chat/classifier/image API 集合。单个 provider 失败只形成启动 issue 并被跳过，命令继续注册以便修复。

保存使用独占锁、起始字节快照复核、仅为实际变化文件创建 staging、每文件备份、`.model-config-tx.json` journal 和失败回滚。journal 在 rename 前 fsync，记录 txId、两目标、变更标记和备份路径；启动读取前发现它时取得同一锁语义下的 transaction lock，将所有已变化文件恢复到同一旧世代，再删除 journal。缺备份或恢复失败时 journal 保留并给出明确人工恢复错误。锁记录 PID/时间：存活 owner 从不抢占；dead PID 且 mtime 超过 30 秒时通过独立 recovery lock 二次复核并隔离旧锁；不可读锁至少保留 10 分钟。它仍不是文件系统级跨文件原子提交，但崩溃不再静默暴露混合世代。

显式 Discovery URL 始终是单一最高优先候选；自动发现由 chat API profile 生成有序同源候选。Generic OpenAI、Codex、Anthropic、Google Generative AI、Mistral 使用各自保守 path 规则；Azure/Bedrock/Vertex/pi-messages 不猜目录。只在首候选 HTTP 404/405 时 fallback，认证、限流、5xx、解析和分页错误不 fallback；实际成功 URL 才进入 draft，最终 Save 才持久化。响应按 1 MiB 上限流式读取，HTTP error 只读 8 KiB 安全片段并脱敏；redirect 每跳取消旧 body、仅同源最多 5 次。auto auth 按 API 选择 Bearer/x-api-key/api-key/x-goog-api-key/Anthropic headers，reuse-pi credential 的可信 origin 优先取 draft/resolved model Base，其次取 AuthResult.auth.baseUrl；可信 origin 缺失或不同源都在请求前 fail closed。分页继续 fail closed，但 0/空/null/false marker 不误报。远程结果只驻留内存，空目录不删除已有选择。

代理由 `createProviderFetch` 创建 provider-local Undici `ProxyAgent`，通过原生 request options 的 `fetch` 注入 chat/classifier/image。Bedrock 使用原生 adapter 已支持的 request-local `options.env` 代理路径；OpenAI Codex 在代理下强制 SSE。Google Generative AI / Vertex 明确拒绝 custom fetch，因此启用代理时阻止保存，不静默直连。代码绝不修改 `process.env` 或全局 dispatcher。

API implementation 不通过 `@earendil-works/pi-ai/api/*.lazy` 静态导入：真实 Pi loader 的 alias/virtual module 表没有暴露这些子路径，只保证 host-owned root/compat/oauth/providers-all。运行时从 `@earendil-works/pi-ai/providers/all` 的 `builtinProviders()` 收集 native Provider operation，并按 catalog model type/API 建立 chat/classifier/image map。自有 provider 对 host 已提供的 API 委派给这些 host Provider 方法，因此保持同一 SDK 实例，不 hardcode 安装路径、不桥接第二份 package。Pi 1.2.0 host catalog 未提供的四个图像协议例外：它们是插件自有、请求级 operation，见 [多服务商图像协议](2026-10-15-model-config-image-protocols.md)；不会静态导入未公开 lazy 子路径。`llama-cpp-classify` 只由 coding-agent 的 llama built-in extension 动态提供，不在 providers/all catalog 中，所以插件不再宣称可把该 API 注册到自有 provider。

认证的 literal 只通过掩码组件输入，`$ENV` 只保存引用，临时 key 只参与一次 Discovery，匿名模式通过 request options 抑制认证头。掩码输入复用 Pi 的输入事实：先解码 Kitty printable，再缓冲 bracketed paste，粘贴内容删除终端控制序列但保留可打印 key；长值只渲染末端窗口和光标。`reuse-pi` 与 discovery header `none` 组合时不转发任何 Pi auth header。不能安全表达匿名的协议在保存前被拒绝。

UI 语言是独立状态：`model-config-ui.json` 只包含 `{ version, language }`，默认 `zh-CN`，仅显式语言选择写入；它不进入模型配置快照或双文件事务。命令主界面和 `/model-config language` 都能即时选择 `zh-CN` / `en`，取消后已保存语言不回滚。所有用户文案来自 typed 双语字典，内部错误携带稳定 `MCFG_E_*` code；未知外部错误只经过脱敏、控制字符清理与长度限制后作为“外部详情”显示。插件不依赖 `pi-i18n` 或其他外部汉化状态。

TUI 通过 `ctx.ui.custom(..., { overlay: true })` 显式进入 overlay，不占 editor inline 槽；96% width、90% maxHeight 与 margin 按真实 viewport 预算。每页 action bar 固定在盒子底部并参与高度预算，不插入列表或正文；快捷键在 search/list/details/actions 任一焦点全局生效，普通字符和 Space 留给 Input。Overview 与 Model 的 search focus 仍保留 Pi Input/IME 焦点，但 CSI、SS3、Kitty Up/Down 会先由页面控制器移动左侧当前行、clamp 边界并联动右侧详情，不再被 Input 吞掉。所有选择列表当前行始终渲染固定 `→ `，模型行组合为 `→ [✓]`/`→ [ ]`，同时再应用主题加粗而不只依赖颜色；action focus 也使用固定箭头。Model footer 始终包含真实可聚焦的 Ctrl+R fetch action，全局 Ctrl+R 与 action Enter/Space 共用同一结果；缺少 Discovery URL 时显式选择进入连接设置或取消，取消/loader abort 不改变 selection 或配置字节。`Ctrl+E` 打开独立整屏模型参数表单：左边字段、右边当前值，Enter inline 修改，thinking map 每档可用空值恢复默认或 `-`/`null` 禁用，Ctrl+S 再经 ConfirmationPanel 才把变更写入当前 provider draft。Overview、Connection、Model、Preview 各自持有显式 UI state（page/focus/search/selection/scroll），F2 语言切换和 Esc 层级返回复用同一状态与 draft。Connection 左字段右解释，Model 顶栏搜索、左多选右参数，Preview 左两类右 diff；Ctrl+R 仅把远程结果留在内存，无 Discovery URL 时引导连接设置且不丢 selection。Preview Esc 返回原编辑页，Ctrl+D 才丢弃；Ctrl+S 后仍需最终 confirm 才调用 transaction。离开 current provider 回 Overview 时仅 dirty 草稿请求放弃确认。

## Reference and license boundary

- Behavioral research referenced @indexyz/pi-provider-sub2api (MIT) for documented Codex manifest/slug behavior and @router-for-me/pi-cliproxyapi-provider (MIT) for its published endpoint contract.
- @keywaytech/pi-provider-manager is marked UNLICENSED; no source was copied or adapted. Authentication profiles, candidate ordering, bounded readers, redirect handling, parsing, and tests were independently implemented.
- This package deliberately does not copy persistent caches, client_version behavior, model-name regex inference, provider registration, or UI code from those packages.

## Alternatives considered

### 把所有类型写入 models.json

单文件直观，且可以复用 Pi 的文件重载；但当前 Pi 的 `models.json` schema 只有 chat model definition。伪造 classifier/image 或 `api: typesafe` 会让类型和 operation 分发失真，因此否决。

### 给每个 provider 一律调用 legacy registerProvider(models)

实现最短，并可一次注册混合模型；但 Pi 明确规定该 `models` 会替换 provider 的全部 chat/image/classifier 目录，会破坏内置或其他扩展 provider，因此只对显式“插件自有” provider 使用完整目录注册。

### 用 HTTP_PROXY / setGlobalDispatcher 实现代理

覆盖面看似更广，但会影响 Pi 中其他 provider、插件和普通 HTTP 请求，违反 provider 隔离。当前实现只使用每请求 `fetch` / `env` 注入；原生 adapter 没有注入点时功能被禁用。

### 自动跟随 Discovery 或模型请求的跨域重定向

兼容某些网关，但自定义认证头可能跨域泄漏。Discovery 只跟随同 origin，模型代理 fetch 关闭自动跟随，要求用户配置最终 Base URL。

### 复用 pi-i18n 或系统 locale

复用外部语言状态可以少一个偏好文件，但会让本插件的可用文案、切换时机和兼容性依赖另一个可选插件，系统 locale 也不能表达用户在 Pi 内的主动选择。因此使用独立、最小的 UI 偏好文件；外部 i18n 只影响其自己的展示。

## Verification

确认面包括：`extensions/model-config.ts` 是唯一 extension 入口；`command.ts` 的 `chatToJson` 剥离 chat type 且 classifier/image 只进入插件配置；`transport.ts` 只有 request-local `ProxyAgent` / `options.env`，没有进程环境写入或全局 dispatcher；`runtime.ts` 只从 loader 明确暴露的 host `providers/all` 收集 operation；`config.ts` 在提交前两次复核启动快照并包含双文件回滚；`i18n.ts` 集中 typed 双语字典和稳定错误 code；`ui-config.ts` 是独立语言偏好的唯一读写点。28 个一方/测试 TypeScript 文件通过 parser 与 host 1.2.0 strict typecheck，离线测试 115/115 通过，覆盖真实四层页面结构、Overview 列表与固定底栏顺序、Detail 不含其他 provider、全局快捷键跨 search/list/details/actions、F2/preview-back 状态保留、连接长字段、模型 Ctrl+R selection 保留、全屏逐模型表单的 inline 字段、K/M/max/cost/thinking map/模态校验、Esc 不落盘和 Ctrl+S 确认后的 dirty 链路、删除 builtin/custom/owned 条目、models.json-only custom 正例、未接管第三方和当前模型拦截、journal 的部分 rename 启动恢复/失败保留、config-only transaction 不写 models.json 及并发拒绝、直接启停无确认、新建 builtin/custom 与 label→ID。隔离 agent dir 的真实 `loadExtensions()` smoke 使用 10 个 chat API、3 个 classifier API 和 1 个 image API，成功加载唯一 extension、注册 `/model-config` 并产生一个 native provider registration；未调用模型或外部网络。

## Model parameter editor and thinking probe

Managed model editing covers numeric invariants, modalities, costs, reasoning, and valid Pi thinking-level keys, preserving all changes in draft until final transaction. New, remotely discovered, and newly taken-over chat models default to `reasoning=true`; explicit existing/remote values and runtime catalog values remain authoritative. `anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, and `pi-messages` receive API-specific protocol maps, while unknown APIs receive no invented map. The generic `openai-completions` map covers standard `reasoning_effort` values through `high` but keeps model-specific `xhigh`/`max` unsupported until explicitly mapped. Protocol defaults are unverified and record `thinkingSource=protocol`; model details, the editor, and its confirmation show Pi's clamped medium baseline plus map provenance, and the editor permits per-level `null`. `thinkingSource` tracks remote/catalog/existing/protocol/user/probed precedence through selector reopen. Context/max accept positive integers with K/M scaling and enforce max ≤ context in either edit direction; costs require finite non-negative decimal values; input cannot be empty and image output must retain `image`. Only checked draft-managed rows enter the editor, while external `models.json` rows direct the user through takeover first. Edits remain dirty across selector reopen, Preview, and final confirmation. Ctrl+L serially tests only explicit resolved wire mappings from terminal events and never interprets model text as capability: the probe passes a model copy carrying that resolved map, reports `null`/missing levels as unsupported without requests, and writes back only accepted concrete mappings. Empty local/catalog maps fall back to protocol defaults; explicit remote or user maps, including empty and partial maps, remain authoritative. Action focus is horizontally navigated across all shared panels, including the model-test result panel, whose Back/Retry actions use Left/Right plus Enter rather than a standalone Ctrl+R retry panel. The plugin-local offline suite covers these defaults, precedence, editor display/editing, persistence, API maps, and the complete edit-to-confirm chain.

## Context compatibility metadata and probe

Managed/new missing chat metadata is explicitly persisted as 128000/16384 and classifier context as 128000, with compat source and an unverified warning in the final ConfirmationPanel; image is unaffected. modelMetadata keeps existing/remote/catalog/user/compat/probed provenance and probe bounds separately from native model objects. Legacy provider-wide defaults remain readable but hidden and are not applied to new models.

Ctrl+K probes only saved/reloaded clean managed chat/classifier runtime models. It serially exercises approximate 32K–256K inputs, records provider usage where available, treats only explicit overflow as upper, and never claims exact capacity. Applying a lower bound changes only the in-memory model plus probed metadata until final transaction; maxTokens is not auto-adjusted.

## Unified confirmation controller

All plugin confirmations use one boxed ConfirmationPanel with summary/details, severity theme, explicit safe default action, fixed arrow selection, Tab/ShiftTab/arrows, Enter/Space, shortcuts, and Esc-to-cancel. Final save, provider deletion, model-parameter apply, dirty-leave three-way choice, preview discard, takeover, empty managed set, Discovery candidate choice, paid model tests, and image opt-in all use it. No ctx.ui.confirm calls remain. Overview enable/disable is a reversible direct transaction and does not show this panel. F2 is overview-only.

## Provider enablement and runtime model checks

Provider config has enabled?: boolean (default true). A disabled builtin, models.json custom, or owned provider is registered through the verified legacy same-name models: [] overlay, hiding all operation types after reload without deleting model/auth data. Unowned config-only third-party runtime providers are rejected because same-name registration is unsafe. Disabling the provider of ctx.model is blocked; other sessions are not scanned. Enable/disable writes this single config setting immediately through the existing two-file transaction, without a ConfirmationPanel; reload makes the overlay state effective.

Provider detail exposes a current-registry-only model test flow. Chat fully consumes streamSimple to done/error with maxTokens=1; classifier uses classify bool; image uses generateImages for a red dot and is opt-in with a second confirmation. The worker queue is dependency-free with concurrency 2, operation-specific timeouts, root cancellation, typed in-memory results, latency/usage rendering, and retry-failed. It never mutates selections or configuration, and dirty/disabled/temporary-key drafts are blocked before testing.

Human-state rules now default searchable pages to list focus; / explicitly focuses Input. Validation, temporary-auth save blocking, fetch errors, and transaction errors remain on the originating page. Preview discard requires a second confirmation; Back preserves draft without confirmation.

## Consequences

收益：标准 Pi chat 配置保持兼容；classifier/image 使用真实原生 operation；内置目录和 external 模型不被插件管理集合误删；远程缺省不降级已有元数据；一个坏 provider 不再阻断修复命令；中英文可以即时、独立切换且不触碰模型事务；代理有明确隔离边界；保存前 diff 不暴露 key；并发修改会在写入前中止。

代价：维护者必须同步两套 typed 文案和错误模板；模型保存后仍需要 `/reload` 更新 extension runtime（语言切换不需要）；Discovery 暂不支持分页；接管范围只包括当前服务商已经存在于 models.json 的 chat 行，不包括 builtin/runtime extension catalog；外部/内置 provider 不能由本插件注入 classifier/image；Google transport 的 provider 代理不可用；跨文件提交依赖补偿回滚而不是文件系统事务。验证只使用离线 fixture、strict typecheck 和真实 loader smoke，没有真实服务商请求或模型调用。
