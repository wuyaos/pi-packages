# @wuyaos/pi-zotero

pi 扩展：通过 **Zotero 10 Local API 原生 HTTP**（无 MCP、无插件、无云端）为 pi agent 提供文献检索、集合导出、CSL 批量、引用审计与文献整理能力。

## 能力

| 工具 | 能力 |
|---|---|
| `zotero_search` | 文献搜索（含 FTS5 全文） |
| `zotero_collections` | 集合查/增/改/删（层级） |
| `zotero_export_collection` | 集合索引导出（JSON 写盘） |
| `zotero_batch_csl` | CSL 批量版本感知缓存（按 Server-ID 隔离） |
| `zotero_audit_citations` | 引用审计（序列/乱序/缺失/未引用，工作簿写盘） |
| `zotero_fulltext` | 条目全文内容（默认截断） |
| `zotero_attachment_path` | 附件磁盘路径（WSL 可读） |
| `zotero_saved_searches` | 保存搜索 list/execute |
| `zotero_duplicates_scan` | 疑似重复检测 |
| `zotero_items` | 条目 children 查询 + 增删查改（门控） |
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

## 边界

- 整数 itemID 不暴露（Local API 限制），但 **uris 方案已实测通过**（Zotero 10.0）：Word 动态域 `id` 可占位 0 + 正确 `uris` + 完整 `itemData`，刷新时 Zotero 自动解析 uris 并回填真 itemID（实测 8885/8506）、生成 GB/T 文献表；运行时实现位于 `extensions/zotero/docx_fields.ts`
- `zotero.sqlite` 不直读（Zotero 10 WAL 模式）
- fulltext/附件路径内容会进入 LLM 上下文（出网），fulltext 默认截断，工具描述已标注
- `write.rememberKey=true` 时，仅持久化用户选择 **Always Allow** 后返回的可复用 key，路径为 `~/.local/state/pi-zotero/auth.json`（0600，不写入 Pi 配置目录）；改为 `false` 并 `/reload` 会删除该文件
- `zotero_build_map` 遇到同标题多版本会写入 `ambiguous` 而不自动选第一条；解决歧义/缺失 key 后才能生成 Word 动态域
