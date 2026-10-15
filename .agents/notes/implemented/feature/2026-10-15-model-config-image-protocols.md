# Agent Note: model-config 自有多服务商图像协议

Status: implemented

## Problem

Pi 1.2.0 的 host image catalog 只提供 `openrouter-images`。`pi-model-config` 已经能为插件自有 provider 注册 image 模型，但把 OpenAI、Gemini、xAI 或 DashScope 图像模型标为 host API 会在运行时找不到 operation；直接静态导入宿主未公开的 lazy API 子路径也违反 loader 边界。图像 URL 下载还需要避免把 bearer token 带到外部地址或让服务端将请求导向内网。

已检查 [2026-10-14 model-config provider boundaries](2026-10-14-model-config-provider-boundaries.md)：该笔记的 host-owned operation 原则仍适用于已有 host API，本决定仅为 host 未提供的四种 image API 增加插件自有、请求级实现，因此属于部分重叠并保留原笔记。

## Decision

`pi-model-config` 直接实现 `openai-images`、`gemini-images`、`xai-images` 和 `dashscope-images` 的 `generateImages()`，在 `runtime.ts` 中只为这四个 API 建立自有 images map；`openrouter-images` 继续委派 Pi host catalog。所有 adapter 都消费 request-local `options.fetch`、`signal`、headers 与 API key，因而 provider proxy 与 anonymous transport 继续经过既有包装，不修改全局 fetch、dispatcher 或环境。

模型级 Base URL 优先于服务商级；两者缺失时，四个新协议才采用各自的官方默认 URL。`openrouter-images` 和未被本插件识别的自定义协议没有默认 URL，仍要求用户明确配置。图像 usage/cost 不推导，结果保持为空。

DashScope 使用同步 `/services/aigc/multimodal-generation/generation`，从 `output.choices[0].message.content[].image` 读取 URL 字符串或 `{ url }`；不发送 `X-DashScope-Async`。下载不携带认证头，拒绝 localhost、私有/CGNAT/IP-mapped IPv6 和带凭据/secret query 的 URL，只允许初始 origin 内最多五次手动重定向，下载有 30 秒 timeout 与 10 MiB 流式上限。

协议 endpoint、最小 body 与响应形状参考本机 `img-research` 中 `@amaster.ai/pi-image-gen` 的 Apache-2.0 发布包 `dist/providers/{openai,gemini,dashscope}.js`，并核对其依赖的 `pi-image-gen-core/src/providers/xai.ts`。本项目独立实现：没有复制源码、UI、缓存、宿主图像管线或注册逻辑。

## Alternatives considered

### 继续只使用 Pi host image map

这能让适配器完全由宿主维护，但 Pi 1.2.0 catalog 没有四个 API，用户保存后会得到不支持 API 的运行时错误，不能交付已确认的协议集合。

### 静态导入 Pi 的未公开 lazy adapter 子路径

若宿主未来实现其中一个协议，这看似可复用，但实际 extension loader 不保证这些子路径的 alias/virtual module；会重现已有 loader 兼容性问题，因此拒绝。

### 让 DashScope 自动跟随任意图片 URL 或跨域重定向

这会将 extension 的网络能力变成 SSRF 跳板，且可能把服务商认证头泄漏给签名 URL 或跳转目标。同步下载改为无认证、同源手动重定向和明确资源上限。

## Consequences

用户可在 image API 下拉框选择四个有本地 operation 的协议，模型与服务商 Base URL 覆盖规则一致；缺少 Base URL 的已知协议可安全使用固定默认 endpoint。代价是插件现在维护四种公开 wire contract，服务商行为变更需要更新 adapter 与 fixture。实现仅覆盖文本 prompt、单图结果和协议最小字段；不支持宿主图像管线、编辑/多图输入、真实网络验证或计费统计。

## Verification

离线 `image-apis.test.ts` mock fetch 覆盖 URL/body/headers、OpenAI model-family format、xAI 最小 payload/JPEG 假定、Gemini `inline_data`、DashScope 同步 choices URL 下载、私网/CGNAT/IP-mapped IPv6 拒绝、五跳限制、10 MiB 上限、非 2xx body 脱敏、default URL、schema enum 和匿名拒绝自有 image API。全套离线测试、strict typecheck 与真实 loader smoke 均在同一改动中执行；未访问真实 provider。
