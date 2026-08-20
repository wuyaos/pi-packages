# pi-zotero 使用指引（给 pi agent）

本扩展通过 Zotero 10 Local API（http://127.0.0.1:23119）操作文献库。**Zotero 必须在 Windows 端运行**，WSL 直连 23119。

## 工具选择

| 场景 | 工具 |
|---|---|
| 找文献/验证在库 | `zotero_search`（全文搜索：qmode=everything） |
| 看有哪些集合 | `zotero_collections` action=list |
| 导出集合索引 | `zotero_export_collection`（写盘 JSON） |
| 为审计备数据 | `zotero_batch_csl`（CSL 增量缓存） |
| 引用核验 | `zotero_audit_citations`（工作簿写盘，含行号/乱序） |
| 读某篇全文 | `zotero_fulltext`（默认截断 2000 字，**内容将发送至 LLM**） |
| 读 PDF 原文 | `zotero_attachment_path` → 用 read/pdf 工具读 /mnt/ 路径 |
| 执行保存搜索 | `zotero_saved_searches` action=execute |
| 查重 | `zotero_duplicates_scan`（只标记不删） |
| 查条目子项 | `zotero_items` action=children |
| 整理（打标签/改元数据/移动/增删） | `zotero_items`/`zotero_collections` 写 action（**需配置 write 开启**） |

## 工作流（综述写作）

1. `zotero_collections` list → 定位目标集合 key
2. `zotero_export_collection` → 集合索引（key/title/年份/DOI）
3. `zotero_batch_csl` collectionKey → CSL 缓存
4. 构建 citation map（marker→keys）写入项目文件
5. `zotero_audit_citations` → 核验序列/缺失/乱序 → 按行号修正文
6. 缺失文献：`zotero_search` 查库 → 无则 `zotero_items` add（DOI）补录

## 写操作铁律

- 写 action 受配置门控（`~/.pi/agent/config/zotero.json` 的 `write` 段），默认全关
- **调用写 action 前必须向用户展示变更摘要并获确认**
- delete 类需 `write.delete: true`（默认关）
- **弹窗机制（Zotero 10 设计，已查证官方文档）**：每次 `POST /authorize` 都弹窗；点"允许"=key 单次（每次写都重授权、每会话必弹窗）；点"**始终允许**"=key 无限复用
- **0 弹窗姿势**：弹窗点"始终允许" + 配置 `write.rememberKey=true`（默认开）→ key 持久化到 `~/.local/state/pi-zotero/auth.json`（600 权限）→ 跨会话自动恢复，不再调 authorize、不弹窗
- key 失效（401）时扩展自动重新授权（弹窗一次）；`appName` 固定为 pi-zotero，勿改
- 创建条目**不要带假 DOI**（触发 Zotero 在线检索卡顿）；用真实 DOI 或省略

## 边界

- 不暴露整数 itemID（Local API 限制）→ Word 动态域写入不在本扩展范围
- 不直读 zotero.sqlite（WAL 模式）
- `collection=` 查询参数无效（Zotero 10 Local API）→ 集合操作内部已走 `/collections/:key/items`
- Zotero 版本跨 major 时 API 行为可能变化：跑 `python3 pi-zotero/scripts/zotero_api_probe.py` 回归
