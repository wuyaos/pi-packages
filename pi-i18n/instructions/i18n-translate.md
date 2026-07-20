---
name: i18n-translate
description: 把 pi 的 `/` 菜单命令说明翻译成中文。当用户运行 /i18n-translate 或要求汉化菜单时使用。
---

# pi 菜单汉化翻译

你要把 pi `/` 菜单命令的英文说明翻译成简体中文。**你只负责翻译这一步**，其余固定流程由脚本完成。

## 前置

你收到这段指令是因为用户运行了 `/i18n-translate` 命令。该命令已合并 pi.getCommands()（扩展+prompt+skill）与内置命令，导出所有命令英文原文到 `~/.pi/agent/i18n.template.json`。**直接读这个文件开始翻译，不要自行创建或重新导出**。

## 工作流程（严格按顺序执行）

### 1. 读取模板

读取 `~/.pi/agent/i18n.template.json`，结构如下：

```json
{
  "version": 1,
  "commands": {
    "settings": "Open settings menu",
    "skill:foo": "[u:git:x/y] Do foo",
    "i18n-translate": "翻译 pi 菜单：导出当前所有 / 命令原文并调用当前模型翻译"
  },
  "sources": { "settings": "builtin", "skill:foo": "skill" }
}
```

拿到 `commands` 里所有键值对，这是待翻译的原文。

### 2. 翻译

把每条 `description` 译成简体中文。规则：

- **命令名（key）完全不改**，只翻译值
- 简洁，符合中文软件习惯，不要机翻味
- 长度尽量与原文相当
- **专有名词保留原文**：GitHub gist、HTML、JSONL、Ctrl+P、provider、WebDAV、SSH 等
- **`${APP_NAME}` 占位符必须原样保留**（如 `quit` 的值 `Quit ${APP_NAME}`），apply 脚本会自动替换为实际 app 名
- **`[sourceTag]` 前缀不要出现在翻译里**——那是 autocomplete 自动加的来源标签（如 `[u:git:x/y]`），apply 时会自动保留。你只翻译前缀后面的正文
- 值已经是中文的（如 `i18n-translate` 自己的描述）保留不动

把翻译结果写成同样结构（只含 `commands` 对象，key 不变，value 为中文），保存为 `~/.pi/agent/i18n.translated.json`。

### 3. 校验并写回

运行应用脚本（不调模型，校验格式 + 合并 + 替换占位符 + 写回 `~/.pi/agent/i18n.json`）：

```bash
node "<apply 脚本绝对路径>"
```

脚本自动校验：
- 翻译的命令名是否与模板一致（缺失/多余会报错或警告）
- 每条值是否为非空字符串
- 替换 `${APP_NAME}` 占位符
- 合并已有翻译，丢弃已废弃的命令名

校验通过后写入 `~/.pi/agent/i18n.json`。写入后下次按 `/` 即可看到中文菜单（扩展实时读文件，无需 reload）。

### 4. 验证

运行校验脚本确认最终文件格式正确：

```bash
node "<validate 脚本绝对路径>"
```

输出 `✓ 通过` 即完成。

## 注意

- **不要**自己用文本工具直接改 `~/.pi/agent/i18n.json`，必须走 `apply.mjs` 以保证格式和命令名一致性
- **不要**翻译命令名（key）、`${APP_NAME}` 占位符、`[sourceTag]` 前缀
- 脚本的绝对路径在下方「运行环境」已给出，直接用；模板和翻译文件都在 `~/.pi/agent/`
