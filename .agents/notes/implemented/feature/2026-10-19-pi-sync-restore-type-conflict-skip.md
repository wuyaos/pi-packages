# pi-sync 恢复：file/dir 类型冲突从硬失败改为跳过+告警

日期：2026-10-19 · 包：pi-sync · 影响版本：1.6.6 引入的行为变更

## 现象

跨设备恢复 Pi 归档时报 `Unsafe restore destination rejected: ...\skills\.smart-search-backups\5a89...`，Pi 类别整体失败（"失败后已中断"）。

## 根因

`copyExtractedTree` 对"归档条目类型与本地已有节点类型不一致"（归档是目录、本地是同名文件，或反之）一律抛 `Unsafe restore destination rejected` 并中断整个恢复。

该冲突的典型来源：smart-search-cli 不同版本对 `.smart-search-backups/<hash>` 的存储形态不同（目录 vs 文件）。备份端（wuya-win）是目录，恢复端（thinkbook/minipc）是同名文件 → 类型不匹配 → 硬失败。这不是路径逃逸攻击，只是结构演化冲突。

## 决策

- **普通 file/dir 类型冲突**：跳过该条目，向恢复结果追加 `Type conflict, skipped: <相对路径>` 告警，继续恢复其余文件。不自动覆盖（删除本地目录/文件属破坏性操作，留给用户手动或 Repair）。
- **destination 是符号链接**：仍硬失败（真实攻击面，保持原有安全语义）。
- `extractPiAgentZip` 空结果判断放宽为 `fileCount === 0 && warnings.length === 0`，全部条目冲突时不再误报 "contained no files"。

## 拒绝的替代方案

- 自动用归档内容替换本地冲突节点：恢复语义变成隐式删除用户数据，风险不可接受。
- 备份时排除 `.smart-search-backups`：会把工具内部缓存从备份里静默丢掉，改变备份完整性承诺。

## 测试

`restore.test.ts` 新增 3 个用例：dir-over-file 跳过、file-over-dir 跳过、全冲突时仍返回计数+告警。符号链接拒绝用例保持不变（Windows 无开发者模式时环境性 skip）。
