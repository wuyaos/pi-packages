# Zotero Word 动态域验证与刷新

`zotero_docx_fields` 将 docx 中的 `[n]`、`[n-m]` 标记替换为 Zotero `ZOTERO_ITEM` 动态域，并插入 `ZOTERO_BIBL`。实现使用 `id=0 + uris + itemData`；Zotero Refresh 会解析 URI 并回填真实 itemID，不需要 MCP `run_javascript`。

## 推荐流程

1. `zotero_build_map` 生成 cite_map；先处理 `ambiguous` 和 `unmatched`。
2. `zotero_audit_citations` 确认 marker 顺序和映射长度。
3. 关闭 Word 中的源文件和输出文件。
4. 调用 `zotero_docx_fields`，始终让 `out` 与 `src` 使用不同路径。
5. 可选执行 Word COM 只读打开验证。
6. Word 打开输出文件，点击 Zotero 工具栏 **Refresh**，必要时先选择引用样式。

工具生成前会检查 ZIP/XML、残留 marker、跨容器复杂 run 和 Server-ID；任何检查失败都不会覆盖已有输出。

## Word COM 只读打开验证

在 Windows PowerShell 中执行；把 `OUT.docx` 替换为 Windows 绝对路径：

```powershell
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open('OUT.docx', $false, $true)
  Write-Output ('OPEN_OK fields=' + $doc.Fields.Count)
  $doc.Close($false)
}
catch {
  Write-Output ('OPEN_FAIL: ' + $_)
}
finally {
  $word.Quit()
}
```

`OPEN_OK` 只证明 Word 能读取文档；仍需执行 Zotero Refresh 验证引用和文献表语义。

## 刷新说明

- 宏名为 `ZoteroRefresh`；常用宏还有 `ZoteroAddEditCitation`、`ZoteroAddEditBibliography`、`ZoteroSetDocPrefs`。
- Zotero 按正文引用首次出现顺序重新编号，原方括号数字不保证保留，这是预期行为。
- 首次刷新可能弹出 Document Preferences，应选择投稿需要的 CSL 样式。
- Refresh 会接管 BIBL 域并生成最终文献表；不要手工编辑动态域指令 JSON。

## 故障排查

| 现象 | 检查与处理 |
|---|---|
| Word 无法读取内容 | 保留工具报错和源文件；不要用字符串替换 XML。确认输出来自当前 Node/XML DOM 实现。 |
| 引用刷新后为空 | 检查 cite_map key 是否属于当前 Server-ID；确认 CSL `itemData` 已获取。 |
| 文献表为空 | 检查是否存在一个 `ZOTERO_BIBL` 域；重新执行工具，不手工拼接 `ADDIN`。 |
| 输出文件被占用 | 关闭 Word 中该文件后重试；不要强制终止包含其他未保存文档的 WINWORD。 |
| marker 未全部替换 | 先补齐 cite_map；工具会拒绝生成部分替换的输出。 |
| 修订模式文档行为异常 | 先在副本中接受或拒绝修订，再运行转换。 |

## OOXML 约束

每个 `fldChar`、`instrText` 和显示文本必须位于平级 `w:r`，不得嵌套 run。`instrText` 需带前后空格并保持 `xml:space="preserve"`。这些约束由 `extensions/zotero/docx_fields.ts` 统一生成，不应在外部脚本重复实现。
