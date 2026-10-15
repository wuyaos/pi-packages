# @wuyaos/pi-model-config

面向当前 Pi 原生 provider/model API 的交互式模型配置插件。唯一命令是：

```text
/model-config
```

插件管理 provider 连接、独立 Discovery URL、认证、远程目录合并、多类型模型选择和 provider 级代理。它不会卸载其他插件、不会自动迁移旧配置，也不会在安装时修改 `~/.pi`。

## 安装

```bash
pi install npm:@wuyaos/pi-model-config
```

或随 monorepo 安装：

```bash
pi install git:github.com/wuyaos/pi-packages
```

安装完成后进入 Pi TUI，运行 `/model-config`。保存后运行 `/reload`，使 provider transport、classifier 和 image 注册生效；Pi 的 `/model` 也会重新读取 `models.json`。

## Language / 语言

`/model-config` 主界面标题为“模型与服务商配置”，并显示 `界面语言：{当前语言}`；也可直接运行：

```text
/model-config language
```

支持 `简体中文 (zh-CN)` 与 `English (en)`，选择后立即切换，无需 `/reload`。语言偏好单独保存在 `<agent-dir>/model-config-ui.json`：

```json
{
  "version": 1,
  "language": "en"
}
```

只有用户在语言选择器中明确选择语言时才写该文件。打开配置、切换页面或取消模型编辑都不会写 UI 偏好；已经主动选择的语言不会因取消模型编辑而回滚。语言文件与 `models.json` / `model-config.json` 的快照和事务完全分离。默认语言为 `zh-CN`。本插件不读取或调用 `pi-i18n` 等外部汉化插件；两者可以同时安装，但这里只负责自己的展示文本。

集中 typed 字典覆盖主表单、selector、状态/来源/只读提示、masked input、loader、diff、确认、保存和错误。provider/model ID、API 名、`models.json` 等配置 key 保持原文。内部错误使用稳定的 `MCFG_E_*` code；外部服务或系统错误只显示经过长度限制、控制字符清理和 secret 脱敏的安全详情。

## 配置文件职责

模型配置只在用户明确确认后写两个文件（语言选择只写独立的 `model-config-ui.json`）：

- `~/.pi/agent/models.json`：标准 Pi 配置，仅保存 **chat** 模型与 provider 的 Base URL / `apiKey`。不会伪造 `type: classifier`、`type: image` 或 `api: typesafe`。
- `~/.pi/agent/model-config.json`：插件自己的 classifier/image 目录、Discovery URL、模型归属和 provider 代理设置。

`PI_CODING_AGENT_DIR` 生效时，上述路径随 Pi agent directory 改变。

保存采用：独占锁 → 启动快照复核 → 仅为实际变化的文件写入临时文件并 `fsync` → JSON 复核 → 备份 → 写入 `<agent-dir>/.model-config-tx.json` journal → 依次替换 → 删除 journal。journal 记录 txId、两份目标路径、是否变化及备份路径；启动读取配置前若发现 journal，会在遵守既有锁语义的前提下把所有已变化文件恢复到同一旧版本并提示。缺少备份或恢复失败时 journal 保留，错误会明确要求按 journal 内路径手动恢复，绝不继续解析混合世代配置。第二个文件替换失败时也会尝试回滚。锁文件记录 PID 和创建时间：owner 仍存活时绝不抢锁；owner 不存在且 mtime 超过 30 秒时，经独立 recovery lock 二次复核后自动隔离并清理；内容不可读的锁至少保留 10 分钟。无法安全判定时宁可拒绝保存。

`/model-config` 使用显式 `overlay: true` 的盒式页面控制器，页面层级固定为“总览 → 连接/模型 → 预览”。overlay 使用 96% 终端宽度、90% 最大高度并保留 margin。总览默认焦点在服务商列表；按 `/` 才聚焦搜索，普通字符和空格留给 Input。左侧只列 `models.json.providers ∪ model-config.json.providers`，右侧只显示当前选中项摘要；当前行始终有不依赖颜色的 `→ ` 前缀并加粗。搜索框保持 Input/IME 焦点时，Up/Down 仍直接移动左侧当前服务商并联动右侧详情，无需先按 Tab。底部固定为 `[Enter] 进入服务商 / [Ctrl+X] 启用或禁用 / [Ctrl+Del] 删除服务商 / [Ctrl+N] 添加服务商 / [Esc] 关闭 / [F2] 界面语言`，动作绝不插入 provider 列表。总览按 Enter 直接进入当前服务商的连接编辑页，不再经过独立只读详情页。连接底部提供 Enter 修改、Ctrl+M 模型、条件显示的 Ctrl+T 接管、Ctrl+P 批量测试、Ctrl+S 预览和 Esc 返回总览。自定义服务商显示 `Custom`，builtin 显示 `Built-in`；不会把整个自定义服务商标成 external/read-only，也不会在每行重复“已配置（未验证）”。普通 80 列可双栏；窄屏通过方向键/Tab 切换 pane。所有动作栏固定在盒子底部，可换行但始终计入 viewport 高度预算。

已有 provider、模型和未知元数据会保留。插件用 `(provider, type, id)` 标识模型；取消勾选只移除 `managedChatIds` / `models` 中由本插件管理的条目，不删除其他 provider，也不修改 Pi 内置目录。服务商面板提供真实的 `[T] 接管已有模型 / Manage existing models`：它只接管当前服务商已经写在 `models.json` 中、但尚未列入 `managedChatIds` 的 chat 模型。确认接管只改变内存草稿；最终确认保存后才更新 `managedChatIds`。原始模型对象从 `models.json` 原样复用，因此未知字段和元数据保持不变；取消、返回或放弃不写盘，接管后取消勾选会在最终保存时移除该模型。Pi builtin catalog 和其他 runtime extension 仅存在于运行时的模型仍保持只读，不能把取消勾选伪装成删除。空管理集合有单独二次确认。

## Model parameter editing and thinking-level probe

The model page exposes [Ctrl+E] Edit model parameters for managed models. It opens an independent full-screen overlay with a left field list and right current value: Enter edits the selected field inline, Ctrl+S requests the shared ConfirmationPanel, and Esc returns without applying. Name, K/M-scaled context/max tokens, chat reasoning and per-level thinkingLevelMap, input/output modalities, and four non-negative cost rates are edited only in the in-memory draft; external/read-only entries must be taken over first. A blank thinking mapping restores the protocol/catalog default, while `-` or `null` disables that level. New, discovered, and newly taken-over chat models default to `reasoning=true`. Known chat APIs (`anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, and `pi-messages`) also receive an API-specific, unverified protocol map; unknown APIs do not receive an invented map. Explicit existing/remote values and runtime catalog values remain authoritative. maxTokens cannot exceed contextWindow. Applying the editor marks relevant metadata as user and still requires Preview plus the final ConfirmationPanel transaction.

[Ctrl+L] Thinking-level probe is opt-in and disabled by default. It requires the same saved/reloaded, enabled, clean, persistent-auth managed runtime model gate as context probing and currently applies to chat models; image is unsupported. Explicit remote mapping wins over runtime catalog, then existing config, then a conservative known-protocol map. Protocol defaults record `thinkingSource=protocol` without `verifiedAt`. The confirmation action and model-page shortcut are both `[Ctrl+L]`. Each explicitly mapped, enabled level is tested serially with a minimal terminal stream request; unmapped or `null` levels are shown as unsupported without a request. Acceptance means only that the server accepted the resolved wire value, not that the model reasoned better. Applying accepted levels changes only the draft thinkingLevelMap and records thinkingSource=probed until final save.

Action bars now use Tab/ShiftTab for regions and Left/Right within actions. Up/Down never changes the focused action. Enter executes the arrow-marked action; narrow layouts wrap without removing actions.

## Context metadata and probing

The plugin never relies on Pi's silent JSON defaults. When a managed/new chat model lacks context/max output, it explicitly writes Pi compatibility values contextWindow=128000 and maxTokens=16384; classifier writes contextWindow=128000. These are shown as “Pi compatibility default (unverified)” and final confirmation lists every affected model. Image models have no context/max fields.

model-config.json stores modelMetadata entries keyed by type/id with contextSource/maxTokensSource (existing, remote, catalog, user, compat, probed) plus optional verifiedAt/probeLower/probeUpper/probeEstimated. Metadata is plugin-only and is never passed into native ProviderModelConfig. Old provider defaultContextWindow/defaultMaxTokens fields remain readable for compatibility but are hidden and are not applied to new models.

The model page exposes [Ctrl+K] Probe context capacity for saved/reloaded managed chat/classifier models only. Provider must be enabled, draft clean, auth persistent, and runtime model available; image and unmanaged external models are blocked. The probe serially tries 32K/64K/128K/256K approximate x-space payloads with 30s per-step timeout, uses streamSimple/classify terminal results and provider usage only, and treats only explicit context-overflow errors as an upper bound. Results are not exact: tokenizers, gateway truncation, or compression can invalidate the estimate. “Use safe lower bound” changes only in-memory contextWindow and probed metadata; maxTokens is never auto-adjusted, and final preview/save confirmation is still required.

## Discovery

- 显式 Discovery URL 始终是唯一候选且优先级最高。未配置时按 chat API profile 和有效 Base URL 生成有序、同源、仅存于当前 session 的候选：
  - generic OpenAI：已有 /models 保持；末尾 /vN 追加 /models；root 优先 /v1/models，再同源 /models。
  - OpenAI Codex Responses：/backend-api → /backend-api/codex/models；/codex/responses 或 /codex → /codex/models；仅在路径明确合理时提供同源 /v1/models 备选。
  - Anthropic、Mistral：/v1/models。
  - Google Generative AI：仅明确该 API 且未启用 provider 代理时使用 /v1beta/models。
  - Azure、Bedrock、Vertex、pi-messages 没有可靠通用目录，要求显式 Discovery URL。
- 自动候选不会按 provider 名称猜 CLIProxyAPI，也不会添加 client_version；这类服务应显式配置。首候选仅在 HTTP 404/405 时尝试下一个同源候选；401/403/429/5xx、JSON/shape/分页错误都不 fallback。成功 URL 才写入内存 draft，并且只有最终 Save 才落盘。
- 仅接受 HTTP(S)，拒绝 URL 用户名/密码和密钥查询参数。响应 body 流式读取，上限 1 MiB；Content-Length 超限提前拒绝。HTTP 错误正文最多读取安全小段，并进行控制字符清理和凭据脱敏。
- 支持顶层数组以及 data/models/list/result 数组；元素可为字符串或 object，Codex slug/display_name 可解析。ID 会 trim、限制 256 字符并拒绝 C0/C1/ANSI；名称清理并限长。类型仅采用显式 type/model_type/task，不根据名称猜 reasoning、vision 或类型。
- 请求有 15 秒超时和 Esc 取消。手动重定向仅允许同 origin、最多 5 跳，每跳先取消旧 response body。
- pagination marker 的 0、空串、null、false 不视为下一页；明确或未知的有效分页 marker 仍整体拒绝，不把部分目录当完整结果。
- 当前已管理模型即使不在远程响应中也会保留并默认勾选；远程空目录不会删除已有模型。远程新增项默认不勾选，同 identity 时已有 managed/external/installed metadata 优先。

连接页左侧字段、右侧解释，当前字段始终显示 `→ `，Enter 使用 Pi 标准 dialog 修改；`Ctrl+S` 预览，Esc 返回当前服务商。模型页默认焦点在模型列表，按 `/` 聚焦顶栏搜索；左侧多选、右侧当前模型参数，当前行明确显示 `→ [✓]` 或 `→ [ ]`；底部固定显示 `[Ctrl+R] 获取远程模型列表`，可 Tab 到动作区后用方向键选择并以 Enter/Space 执行，也可在任意焦点直接按 Ctrl+R。`Ctrl+S` 预览，Esc 返回服务商，Enter 勾选，`Ctrl+A/D` 只作用于过滤集，`Ctrl+T` 切换远程项类型。没有 Discovery URL 时 Ctrl+R 会弹出“进入编辑连接设置 / 取消获取”选择；返回后当前 draft、搜索词和 selection 不丢失。普通字符和空格只进入 Input，全局 Ctrl/F2 快捷键仍优先；模型搜索保持焦点时，标准 CSI、SS3 和 Kitty Up/Down 都会移动当前模型并联动参数详情，且在顶部/底部 clamp，不要求 Tab 到列表。逐行只对非托管模型显示“只读”，右侧区分“尚未接管的 models.json 模型”和“builtin/runtime catalog 模型”两种原因。

远程接口缺少上下文窗口或最大输出时，使用 provider 页面中可编辑的默认值；价格默认为 0。协议必须从已支持列表中选择，否则保存会被阻止。这表示“能注册并调用”，不表示服务端兼容性已经过网络探测。

## 认证

| 方式 | 是否落盘 | 说明 |
|---|---:|---|
| literal | 是 | 通过专用掩码输入写入 `models.json`；确认 diff 和错误消息不显示值 |
| `$ENV` | 仅引用 | `models.json` 保存 `$NAME`，运行 Pi 的进程必须设置该变量 |
| 复用 Pi auth | 否 | 复用同 provider ID 的 `auth.json`；自定义 provider 当前只支持其中的 API-key credential，内置 provider 继续使用其原生 OAuth/API-key 解析 |
| 临时密钥 | 否 | 只用于本次 Discovery；选完模型后必须改选可持久运行的认证方式 |
| 匿名 | 否 | 只允许能安全抑制认证头的适配器；不支持的协议会阻止保存 |

密钥输入始终显示为圆点。输入组件解码 Kitty printable 与可跨 chunk 的 bracketed paste，并过滤真正的终端控制序列；长密钥只显示末端掩码窗口，光标和 `Enter 保存` 提示在窄屏仍保留。`[已掩码]` 只是展示文本，代码从不把它当成密钥保存。普通 URL、名称和数值输入框不用于输入密钥。Discovery 认证头默认 `auto`：Anthropic 使用 `x-api-key` + `anthropic-version`，Google 使用 `x-goog-api-key`，Azure 使用 `api-key`，generic OpenAI/Mistral 使用 Bearer；也可显式选择 bearer、x-api-key、api-key、x-goog-api-key、anthropic 或 none。`reuse-pi` 配合 none 不转发任何 Pi auth header；reuse-pi 的可信 origin 优先取有效 draft/resolved model Base URL，其次取当前 SDK AuthResult.auth.baseUrl；只要需要发送 API key/OAuth/credential header，而可信 origin 缺失或与 Discovery origin 不同，就在发请求前 fail closed，并要求改用临时/显式密钥或 none。

## 原生 API 与模型类型

Chat 写入 Pi 标准 `models.json`。Classifier 和 image 通过 Pi 的原生 mixed-operation provider 注册，并分别进入 `models.getAvailableOfType("classifier")` 与 `models.getAvailableOfType("image")`；它们不会出现在 chat `/model`，也不会被注册成 chat。启动时按模型 type 严格校验 API 集合；某个 provider 配置错误时只跳过该 provider，并保留 `/model-config` 供修复，不让 factory lookup 的断言崩溃整个插件。

运行时不静态导入 `@earendil-works/pi-ai/api/*.lazy`。Pi 的真实 extension loader 只把 host-owned `@earendil-works/pi-ai`、`compat`、`oauth` 和 `providers/all` 放入 alias/virtual module 表；因此插件从 `@earendil-works/pi-ai/providers/all` 的 `builtinProviders()` 枚举 host native Provider，并按其实际 chat/classifier/image 模型 API 建立 operation map。这样复用同一 host SDK 对象和 adapter，不 hardcode Pi 安装路径、不加载第二份 pi-ai，也不依赖 loader 未暴露的子路径。

支持的 classifier API：

- `typesafe-system-one`（TypeSafe / System One 原生协议）
- `cloudflare-workers-ai-system-one`
- `openai-decisions`

`llama-cpp-classify` 由 Pi 的 llama.cpp built-in extension 动态提供，不属于 `providers/all` 的 host provider catalog；本插件不会绕过 loader 去静态导入其 lazy adapter，因此不能把它保存为插件自有 provider 的 classifier API。

支持的 image API：

- `openrouter-images`

支持的 chat API：

- `anthropic-messages`
- `openai-completions`
- `openai-responses`
- `azure-openai-responses`
- `openai-codex-responses`
- `mistral-conversations`
- `pi-messages`
- `bedrock-converse-stream`
- `google-generative-ai`（无 provider 代理时）
- `google-vertex`（无 provider 代理时）

“插件自有”只应对自定义 provider 启用。Pi 文档明确说明，extension 的 `models` 会替换该 provider 的完整多类型目录；因此插件禁止向未接管的内置/外部 provider 注入 classifier/image，避免覆盖其目录。未接管 provider 仍可管理 chat 的 `models.json` overlay；provider 代理/匿名 transport 只支持 Pi 内置 provider 或插件自有 provider。第三方 extension provider 无法在启动阶段安全包装完整 native `stream` / `streamSimple`，因此不会伪装支持。

## 统一确认面板

所有需要确认的插件操作均使用同一个盒式 ConfirmationPanel：宽屏 summary/details 双栏、窄屏上下布局、warning/error theme、固定 `→` action 指示和安全默认项。Tab/Shift+Tab、方向键选择，Enter/Space 执行，Esc 返回 cancel。覆盖最终保存、删除服务商、模型参数应用、dirty leave 三选、preview discard、接管、清空 managed、Discovery 候选、付费测试和 image 二次确认；源码中不再使用 `ctx.ui.confirm()`。总览启停是可逆的直接 transaction，不弹确认面板。

## 服务商启用、禁用与批量测试

- model-config.json 的 provider 支持 enabled（默认 true）。总览 Ctrl+X 直接通过双文件 transaction 写入启停状态，不弹确认面板；禁用不会删除 models.json、model-config.json 模型或 auth。/reload 后，扩展以同名 models: [] overlay 隐藏该 provider 的 chat/classifier/image catalog；重新启用并 /reload 后恢复底层 builtin/models.json/owned provider。
- 安全禁用只允许 Pi builtin、存在 models.json 配置的 custom provider、或 config.owned provider。未接管的第三方 runtime extension provider 不能同名注册，会被拒绝。
- 当前会话正在使用目标 provider 模型时禁止禁用；插件不会自动切换模型。其他已打开 Pi session 不会被扫描或强制迁移，需各自切换/重载，这是当前限制。
- 启停立即落盘但不即时修改当前 registry；仍需 /reload 才生效。
- `[Ctrl+Del] 删除服务商` 需危险 ConfirmationPanel（默认取消）：会同时移除 models.json provider 条目和 model-config.json provider overlay，不删除 auth.json 凭据；若另一个扩展也管理该 provider，其运行时目录仍可能由该扩展决定。删除 builtin 后 /reload 恢复 Pi 内置目录；当前会话正在使用目标模型、或目标是未接管的第三方 runtime provider 时拒绝。有 `models.json` 条目的自定义 provider 可以删除或直接启停。
- 服务商详情提供 Ctrl+P 批量测试模型。测试仅使用当前 session registry 已加载的目标 provider 模型；disabled、temporary auth 或 dirty draft 会阻止测试并要求先保存/启用/reload。
- Chat 使用 streamSimple 并完整消费到 done/error，maxTokens=1；classifier 使用原生 classify bool；image 默认不选，选中后需单独二次确认并调用 generateImages 生成红点。默认并发 2；chat/classifier timeout 15s，image 120s；Esc 全局取消。
- 结果只存内存，状态区分 success/auth/rate-limit/timeout/unsupported/aborted/error，并显示 latency 与可用 usage。失败不会自动取消勾选、删除模型或修改配置；结果页可重试失败项。

## Provider 专属代理

代理示例 `http://127.0.0.1:7890` 只是 UI placeholder，不会修改系统设置。实现不会写 `process.env`，也不会调用 `setGlobalDispatcher`：

- `createProviderFetch()`：为单个 provider 创建 Undici `ProxyAgent`，通过 request-local `fetch` 的 `dispatcher` 注入；自动重定向关闭。
- `applyProviderTransport()`：把该 fetch 注入 chat/classifier/image 的原生 options。
- Bedrock：只向该请求的 `options.env` 注入 `HTTP_PROXY` / `HTTPS_PROXY`；Pi 原生 Bedrock adapter 会据此创建 request-local `HttpProxyAgent` / `HttpsProxyAgent`。
- OpenAI Codex Responses：启用代理时强制 SSE，因为 WebSocket transport 不使用 `options.fetch`。

当前 Pi 的 Google Generative AI 与 Google Vertex adapter 会明确拒绝 custom fetch，所以这两个协议启用 provider 代理时无法保存；插件不会静默直连。`pi-messages`、Bedrock、Google Generative AI 和 Google Vertex 当前也不允许匿名模式。

代理能力只覆盖 HTTP request path。服务端返回 3xx 时 request-local fetch 不自动跟随，以避免 provider 凭据跨 origin；需要把 Base URL 配到最终地址。

## 保存前审阅与安全边界

连接页或模型页只有 `Ctrl+S`/底部预览动作会进入独立预览；字段修改后仍停留在连接列表。临时密钥统一禁止所有预览保存路径，必须先选择持久认证。连接/模型 validation 错误只在当前页 notify 并保留 draft。连接页或模型页按 `Ctrl+S` 后进入独立预览：左侧只有“服务商设置”和“模型配置”，右侧显示 diff；底部固定为 `[Ctrl+S] 保存 / [Esc] 返回原编辑页 / [Ctrl+D] 放弃`。Esc 保留 draft、模型勾选、搜索和滚动；放弃会先二次确认，确认后才清空当前服务商草稿并回总览；保存还会经过最终 confirm，确认后才调用双文件 transaction。全部取消勾选仍有单独二次确认。离开当前服务商回总览时若 dirty，会明确询问是否放弃；非 dirty 直接返回。F2 只在总览生效；连接、模型、预览和测试页不显示也不响应 F2。

插件是与 Pi 同权限运行的扩展，可以读取模型配置和认证。只从可信来源安装；优先使用 `$ENV` 或 Pi auth，避免长期 literal。

## 从 jev-use 迁移到原生 classifier

本插件不会卸载或禁用 `jev-use`。建议手工迁移：

1. 安装并重载本插件。
2. 运行 `/model-config`，对自定义 TypeSafe/System One provider 选择 `classifier`，API 选 `typesafe-system-one`。
3. 保存并 `/reload`。
4. 启用 Pi 的 `codemode` 后，用 `models.getAvailableOfType("classifier")` 确认原生 classifier 可见，并让实际工作流改用 `models.classify(...)`。
5. 确认不再调用旧工具后，在 `pi config` 或 `settings.json` 中禁用旧扩展；是否卸载由用户自行决定。

在第 4 步完成前不要同时让自动流程调用旧 jev 工具和原生 classifier，以免重复请求。

## 参考实现与许可证

- 行为调研参考了 @indexyz/pi-provider-sub2api（MIT）对 Codex manifest、slug/display_name 和保守失败策略的说明，以及 @router-for-me/pi-cliproxyapi-provider（MIT）公开的 endpoint 约定。
- 同时查看了 @keywaytech/pi-provider-manager 的发布包行为；其 package 标记 UNLICENSED，因此本项目没有复制或改写其源码，只独立实现了协议 profile、认证头和安全读取逻辑。
- 本实现没有照搬上述包的缓存、client_version、名称正则推理、provider 注册或 UI 代码；尤其不会仅凭 CLIProxy 名称添加查询参数。

## 已知限制

- 只提供 TUI 命令；RPC / print / JSON 模式不支持自定义多选界面。
- Discovery 分页尚未实现，检测到分页即整体拒绝。
- 不探测协议兼容性，不发送测试模型调用；选择 API 表示用户确认上游实现该协议。
- 不管理自定义 headers 编辑；已有 headers 会保留。Discovery 仅可选 bearer / x-api-key / none；选择 none 会完全抑制复用的 Pi auth headers。
- 插件自有 provider 的“复用 Pi auth”仅处理同 ID 的 API-key credential；OAuth 只适用于未被插件接管、继续使用原生认证实现的 provider，不能移植到另一个自定义 provider ID。
- 第三方 extension provider 若不由本插件接管，只能管理 chat overlay，不能启用本插件代理或匿名 transport。
- 保存模型配置后需要 `/reload` 才能更新 extension transport 与 classifier/image 注册；仅切换界面语言不需要 reload。
