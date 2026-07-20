# pi-packages

个人 [pi](https://pi.dev) 包集合，单仓库 monorepo。

## 包

| 包 | 说明 |
|---|---|
| [pi-cc-tui](./pi-cc-tui) | 99 个主题、Pi 动画启动头、Codex 输入框、thinking 折叠和状态栏 |
| [pi-octssh](./pi-octssh) | 桥接 octssh MCP server，SSH 部署工具（exec/upload/async 等） |
| [pi-notify](./pi-notify) | pi 任务完成后的桌面通知 |
| [pi-sync](./pi-sync) | WebDAV 配置/技能/扩展/会话项目同步备份（fork from [BevalZ/pi-sync](https://github.com/BevalZ/pi-sync)，MIT） |
| [pi-tool-gate](./pi-tool-gate) | 按需工具开关：重 schema 工具默认 inactive，gate_tools loader + /tool-gate 命令，降低每轮 tools[] token 占用 |

## 安装

### 全部安装

```bash
pi install git:github.com/wuyaos/pi-packages
```

### 只加载某个子包（filter）

在 `~/.pi/agent/settings.json` 用 object form：

```json
{
  "packages": [
    {
      "source": "git:github.com/wuyaos/pi-packages",
      "extensions": ["pi-octssh/extensions/*.ts"],
      "themes": []
    }
  ]
}
```

## 开发

```bash
# 本地安装（开发期）
pi install /mnt/d/work/project/person/pi-packages

# 新建子包
mkdir pi-<name>
cd pi-<name>
# 写 package.json（含 pi-package keyword + dependencies）
# 写 extensions/<name>.ts
```

每个子包独立 `package.json`，依赖各自声明，npm workspaces 会 hoist 到根 `node_modules/`。

## pi-model-roles

模型角色路由 — 为不同任务分配不同模型+thinking level。

Fork from [@d3ara1n/pi-model-roles](https://github.com/d3ara1n/pi-extensions/tree/main/packages/pi-model-roles) (MIT)

内置角色：default(medium) / heavy(high) / fast(low) / utility(off)

配置 `~/.pi/agent/settings.json`:
```json
{
  "modelRoles": {
    "roles": {
      "heavy": { "model": "cpa-openai-completions/gpt-5.6-sol", "thinking": "high" },
      "fast": { "model": "cpa-openai-completions/glm-5.2", "thinking": "low" }
    }
  }
}
```

## pi-advisor

顾问模型 — 第二个模型审查每轮输出，注入建议/警告。

Fork from [@hk_net/pi-advisor](https://github.com/hknet/pi-extensions/tree/main/packages/pi-advisor) (EUPL-1.2)

配置 `~/.pi/agent/advisor.json`:
```json
{
  "model": "cpa-openai-completions/gpt-5.6-sol",
  "thinking": "high",
  "onDone": false,
  "whenStuck": 0,
  "timeoutMs": 120000
}
```

## pi-i18n

pi `/` 菜单汉化 — autocomplete 包装显示中文 + 命令导出模板 + 注入指令驱动 LLM 翻译。

- 扩展包装 autocomplete，`/` 菜单触发时读 `~/.pi/agent/i18n.json` 替换英文说明为中文，保留 `[sourceTag]` 来源前缀，实时读文件无需 reload
- `/i18n-translate` 唯一命令：合并内置命令与 `pi.getCommands()`（扩展+prompt+skill）导出英文原文到 `~/.pi/agent/i18n.template.json`，再读 `instructions/i18n-translate.md` 作为指令注入当前会话模型完成翻译
- 不注册 skill（package.json 无 `pi.skills`），故菜单只有 `/i18n-translate` 一个命令
- 脚本（固定流程，不调模型）：`apply.mjs` 校验合并并替换 `${APP_NAME}` 占位符后写回 `~/.pi/agent/i18n.json` / `validate.mjs` 校验格式
- 中间文件都在 `~/.pi/agent/`，不污染用户项目或开发目录
