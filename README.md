# pi-packages

个人 [pi](https://pi.dev) 包集合，单仓库 monorepo。

## 包

| 包 | 说明 |
|---|---|
| [pi-cc-tui](./pi-cc-tui) | 99 个主题、Pi 动画启动头、Codex 输入框、thinking 折叠和状态栏 |
| [pi-octssh](./pi-octssh) | 桥接 octssh MCP server，SSH 部署工具（exec/upload/async 等） |
| [pi-notify](./pi-notify) | pi 任务完成后的桌面通知 |

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
