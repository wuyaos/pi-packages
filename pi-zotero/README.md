# @wuyaos/pi-zotero

pi 扩展：通过 **Zotero 10 Local API 原生 HTTP**（无 MCP、无插件、无云端）为 pi agent 提供文献检索、集合导出、CSL 批量、引用审计与文献整理能力。

## 能力

| 工具 | 能力 |
|---|---|
| `zotero_search` | 文献搜索（含 FTS5 全文）；支持 `queries` 批量并发搜索（≤20 查询，逐条返回命中/截断/失败） |
| `zotero_collections` | 集合查/增/改/删（层级） |
| `zotero_export_collection` | 集合索引导出（JSON 写盘） |
| `zotero_batch_csl` | CSL 批量版本感知缓存（按 Server-ID 隔离） |
| `zotero_audit_citations` | 引用审计（序列/乱序/缺失/未引用，工作簿写盘） |
| `zotero_build_map` | DOI、标题、年份、作者分级匹配，输出匹配证据和歧义候选 |
| `zotero_fulltext` | 条目全文内容（默认截断） |
| `zotero_attachment_path` | 附件磁盘路径（WSL 可读） |
| `zotero_saved_searches` | 保存搜索 list/execute |
| `zotero_duplicates_scan` | 疑似重复检测 |
| `zotero_items` | 条目 children、回收站列表；增删改、trash/restore（写门控）；update 支持题名/DOI/日期/页码/卷/期/期刊名/出版社/ISBN/ISSN/类型/作者，写后逐字段核验 |
| `zotero_doi_lookup` | 按 DOI 从 doi.org 拉取权威 CSL 元数据（出网），可回填现有条目（默认只补空字段）或创建新条目 |
| `zotero_searches` / `zotero_tags` | 保存搜索/标签管理（门控） |
| `zotero_docx_fields` | docx 方括号标记 → Zotero 动态域（Node.js/XML 节点级处理，uris 方案） |

## 前置条件

- **Zotero 10** 运行中（Windows 端），设置 → 高级 → 允许其他应用通信（Local API 端口 23119）
- WSL2 需 localhost 转发/mirrored 网络（本机已验证）；失败时配置 `baseUrl` 为 Windows 宿主 IP
- 写操作（增删改）需在 Zotero 弹窗中授权（Allow），且受 `write` 配置门控，默认关闭

## 配置（`~/.pi/agent/config/zotero.json`，env 覆盖）

```json
{
  "baseUrl": "http://127.0.0.1:23119/api",
  "timeoutMs": 15000,
  "cacheDir": null,
  "maxItems": 5000,
  "write": {
    "enabled": false,
    "tools": ["items", "collections", "searches"],
    "delete": false,
    "rememberKey": true
  }
}
```

env：`ZOTERO_BASE_URL` / `ZOTERO_TIMEOUT_MS` / `ZOTERO_CACHE_DIR`（优先级高于配置文件）。默认缓存按 `<cacheDir>/<Server-ID>-0/` 隔离；CSL 条目记录 Zotero item version，元数据变更后自动失效。

## v0.2 数据完整性

- 列表读取保留 Zotero `Total-Results`，达到调用 `limit` 或 `maxItems` 时返回 `truncated=true`；查重、集合导出和引用映射不再静默给出不完整结论
- cite_map 为每条成功匹配记录 `matchMethod`、`confidence` 和 DOI/年份/作者证据；优先级为 DOI → 标题精确+年份/作者消歧；低置信标题包含及 DOI 冲突只进入 `ambiguous`，不自动写入 Word 引用
- 批量 tag/move/trash/restore/delete 顺序执行并返回逐 key 的 `succeeded/failed/skipped`；401/403/429 后停止，避免连续弹授权或继续撞限流
- 附件上传采用“两遍流式”：第一遍计算 MD5，第二遍通过 HTTP `application/octet-stream` 发送原始二进制流（非 Base64、不直写 Zotero/storage），不把整个 PDF 载入 Pi 进程内存
- 引用管理插件（如 Better BibTeX）会把 CSL 响应的 `id` 改写为 citation key；CSL 批量获取对可解析 id 走批量配对，其余 key 自动回退单条请求（关联由请求路径保证），versions 同理
- `update` 与 DOI 回填使用 `updateItemVerified`：412 自动重试、写后轮询读回并逐字段报告持久化结果；检测到被自动处理插件（如 Z Linter）覆盖时自动重写一次并如实报告
- DOI 元数据来自 doi.org 内容协商（`Accept: application/vnd.citationstyles.csl+json`），这是本扩展唯一的出网请求（仅 GET 公开元数据）；DOI 未注册时明确报错
- 配置、CSL 缓存、集合索引、审计报告和 cite_map 均使用同目录临时文件 + fsync + rename 原子写入

## Word 动态域

完整的 Word COM 打开验证、`ZoteroRefresh` 和故障排查见 [`skills/zotero/word-fields.md`](skills/zotero/word-fields.md)；agent 面向的使用指引以包级 skill 形式随包分发（`skills/zotero/SKILL.md`），触发词覆盖查文献/审计/DOI/动态域等场景。旧 Python/MCP skill 不属于 npm 运行时依赖。

## 边界

- 整数 itemID 不暴露（Local API 限制），但 **uris 方案已实测通过**（Zotero 10.0）：Word 动态域 `id` 可占位 0 + 正确 `uris` + 完整 `itemData`，刷新时 Zotero 自动解析 uris 并回填真 itemID（实测 8885/8506）、生成 GB/T 文献表；运行时实现位于 `extensions/zotero/docx_fields.ts`
- `zotero.sqlite` 不直读（Zotero 10 WAL 模式）
- fulltext/附件路径内容会进入 LLM 上下文（出网），fulltext 默认截断，工具描述已标注
- 集合导出默认排除回收站条目，并在结果中报告仍保留该集合关系的回收站 key；可用 `zotero_items action=restore` 恢复
- `write.rememberKey=true` 时，仅持久化用户选择 **Always Allow** 后返回的可复用 key，路径为 `~/.local/state/pi-zotero/auth.json`（0600，不写入 Pi 配置目录）；改为 `false` 并 `/reload` 会删除该文件
- `zotero_build_map` 只有在 DOI 或标题+年份/作者证据能唯一消歧时才自动匹配；其余同分候选写入 `ambiguous`，解决歧义/缺失 key 后才能生成 Word 动态域
- 一次性 **Allow** key 只允许一个 Local API 写请求；批量整理建议在 Zotero 授权框选择 **Always Allow**，否则可能逐项弹窗
