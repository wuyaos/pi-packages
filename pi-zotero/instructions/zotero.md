# pi-zotero 使用指引（给 pi agent）

本扩展通过 Zotero 10 Local API（http://127.0.0.1:23119）操作文献库。**Zotero 必须在 Windows 端运行**，WSL 直连 23119。

## 工具选择

| 场景 | 工具 |
|---|---|
| 找文献/验证在库 | `zotero_search`（单查询 q 或批量 queries；全文搜索 qmode=everything） |
| 看有哪些集合 | `zotero_collections` action=list |
| 导出集合索引 | `zotero_export_collection`（写盘 JSON） |
| 为审计备数据 | `zotero_batch_csl`（按 Server-ID 隔离、按 item version 自动失效） |
| 引用核验 | `zotero_audit_citations`（工作簿写盘，含行号/乱序） |
| 读某篇全文 | `zotero_fulltext`（默认截断 2000 字，**内容将发送至 LLM**） |
| 读 PDF 原文 | `zotero_attachment_path` → 用 read/pdf 工具读 /mnt/ 路径 |
| 执行保存搜索 | `zotero_saved_searches` action=execute |
| 查重 | `zotero_duplicates_scan`（只标记不删） |
| 查条目子项 | `zotero_items` action=children |
| 查/恢复回收站 | `zotero_items` action=trash-list / restore（restore 需 items 写门控，不需 delete 总闸） |
| 构建引用映射 | `zotero_build_map`（DOI 优先；标题用年份/作者消歧；输出 matchMethod/confidence） |
| DOCX 标记转动态域 | `zotero_docx_fields`（生成新文件；验证/刷新见 `instructions/zotero-word-fields.md`） |
| 按 DOI 拉取正确元数据 | `zotero_doi_lookup`（doi.org 内容协商，出网；可选回填条目或新建） |
| 整理（打标签/改元数据/移动/增删） | `zotero_items`/`zotero_collections` 写 action（**需配置 write 开启**） |

## 工作流（综述写作）

1. `zotero_collections` list → 定位目标集合 key
2. `zotero_export_collection` → 集合索引（key/title/年份/DOI）
3. `zotero_batch_csl` collectionKey → CSL 缓存
4. `zotero_build_map` → citation map；检查 `truncated` 和 `matches[].matchMethod/confidence`，再解决 `ambiguous` / 未匹配项
5. `zotero_audit_citations` → 核验序列/缺失/乱序 → 按行号修正文
6. `zotero_docx_fields` → 生成带动态域的新 docx → Word 中执行 ZoteroRefresh
7. 缺失文献：`zotero_search` 查库 → 无则 `zotero_items` add（DOI）补录

## 写操作铁律

- 写 action 受配置门控（`~/.pi/agent/config/zotero.json` 的 `write` 段），默认全关
- **调用写 action 前必须向用户展示变更摘要并获确认**
- delete 类需 `write.delete: true`（默认关）；`restore` 是可逆恢复，只需 items 写门控
- **弹窗机制（Zotero 10 设计，已查证官方文档）**：每次 `POST /authorize` 都弹窗；点"允许"=key 单次（每个 Local API 写请求重新授权；附件 init/register 会各授权一次）；点"**始终允许**"=key 无限复用
- 批量 tag/move/trash/restore/delete 顺序执行并返回 `succeeded/failed/skipped`；401/403/429 后停止。一次性 Allow 无法跨请求复用，批量整理优先选“始终允许”
- **0 弹窗姿势**：弹窗点"始终允许" + 配置 `write.rememberKey=true`（默认开）→ key 持久化到 `~/.local/state/pi-zotero/auth.json`（600 权限）→ 跨会话自动恢复，不再调 authorize、不弹窗
- key 失效（401）时扩展自动重新授权（弹窗一次）；`appName` 固定为 pi-zotero，勿改
- 创建条目**不要带假 DOI**（触发 Zotero 在线检索卡顿）；用真实 DOI 或省略；先用 `zotero_doi_lookup` 获取再填入
- 若装了自动处理插件（如 Z Linter）：新建条目会被插件改写（加标签/在线校验，期间 API 可能短暂无响应）；update/回填已内置重试与写后核验，报告“未持久化”时检查插件设置后重试

## 边界

- Local API 不暴露整数 itemID；动态域使用 `id:0 + uris + itemData`，经 Zotero 10.0 + Word 实测可在 Refresh 时解析并回填
- 不直读 zotero.sqlite（WAL 模式）
- `collection=` 查询参数无效（Zotero 10 Local API）→ 集合操作内部已走 `/collections/:key/items`
- 列表产物若 `truncated=true`，不得把未匹配/无重复当作全库结论；提高 `maxItems` 或缩小集合后重试
- Zotero 版本跨 major 时 API 行为可能变化：从源码仓库运行 `scripts/zotero_api_probe.py` 回归（该开发脚本不随 npm 包发布）
