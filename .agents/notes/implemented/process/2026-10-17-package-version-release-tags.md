# Agent Note: 按包版本发布 tag

Status: implemented

## Problem

原发布 workflow 只接受 `publish-all*` 总 tag，然后扫描所有 `pi-*` workspace。单包发布也必须使用总 tag，发布对象依赖 npm 线上版本比较，tag 本身无法表达“哪个包、哪个版本”，且复用/移动旧总 tag 容易造成发布意图不清。

## Decision

发布 workflow 支持按包和版本命名的 tag：`<package-directory>-v<semver>`，例如 `pi-cc-tui-v1.4.0`。workflow 从 tag 解析包目录与版本，校验该目录的 `package.json.version` 完全一致，并只发布对应 workspace。

保留 `publish-all*` 作为批量发布兼容入口：它继续遍历所有非 private `pi-*` workspace，并仅发布尚未存在于 npm 的版本。单包 tag 是默认推荐流程；总 tag 仅用于有意的批量发布。

每个发布任务仍采用同一认证策略：已存在的 npm 包使用 GitHub OIDC Trusted Publishing；首次发布使用 `NPM_TOKEN`，成功后应在 npm 配置 Trusted Publisher 并删除长期 token。workflow 对 npm publish 的偶发 tlog/网络错误保留重试与发布前版本复查。

## Alternatives considered

- 继续只用 `publish-all`：改动最少，但 tag 无法表达发布对象和版本，误触发全量扫描的风险保留。
- 依赖 GitHub Release 手工选择包：可读性好，但不能作为仓库内可复制的自动化流程，且增加手工步骤。

## Consequences

单包发布命令变为：先改包版本并提交，再 `git push origin master`，然后创建并推送对应 tag，例如 `git tag pi-cc-tui-v1.4.0 && git push origin pi-cc-tui-v1.4.0`。tag 版本不匹配包清单时 workflow 立即失败，不会发布错误版本。

workflow 仍保留旧总 tag 兼容路径，因此维护者需要明确选择单包 tag 或批量 tag；单包 tag 不会发布其他 package。远端推送仍依赖 GitHub 网络/代理配置，workflow 本身在 GitHub runner 上不继承本机代理。

## Verification

已根据 GitHub Actions 触发规则、npm workspace 发布命令和 semver tag 解析设计 workflow；本地应至少执行 YAML/脚本静态检查，并在网络恢复后推送一个单包 tag 观察对应 Actions run。