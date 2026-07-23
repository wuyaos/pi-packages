# AGENTS — pi-packages monorepo

本仓库是 pi 扩展的 monorepo(npm workspaces),包含 7 个 `@wuyaos/xxx` 包。
下面是开发、发布、安装的使用规范。

## 包清单

| 包 | npm 名 | 说明 |
|---|---|---|
| pi-cc-tui | @wuyaos/pi-cc-tui | 99 主题、Pi 动画启动头、Codex 输入框、thinking 折叠、状态栏 |
| pi-notify | @wuyaos/pi-notify | pi 任务完成后的桌面通知 |
| pi-sync | @wuyaos/pi-sync | WebDAV 配置/技能/扩展/会话同步备份 |
| pi-tool-gate | @wuyaos/pi-tool-gate | 按需工具开关,降低 tools[] token 占用 |
| pi-model-roles | @wuyaos/pi-model-roles | 模型角色路由 |
| pi-advisor | @wuyaos/pi-advisor | 顾问模型审查每轮输出 |
| pi-i18n | @wuyaos/pi-i18n | pi `/` 菜单汉化 |

> SSH 工具在独立仓库 [pi-octssh](https://github.com/wuyaos/pi-octssh),不属于本 monorepo。

## 安装

两种方式任选:

### 全部安装(git 批量)
```bash
pi install git:github.com/wuyaos/pi-packages
```

### 单个原子安装(npm)
```bash
pi install npm:@wuyaos/pi-cc-tui
pi install npm:@wuyaos/pi-notify
pi install npm:@wuyaos/pi-sync
pi install npm:@wuyaos/pi-tool-gate
pi install npm:@wuyaos/pi-model-roles
pi install npm:@wuyaos/pi-advisor
pi install npm:@wuyaos/pi-i18n
```
可带版本锁定:`pi install npm:@wuyaos/pi-cc-tui@1.0.0`

### 本地 registry 镜像 404 的处理
本机 npm 默认 registry 指向腾讯云镜像,新发布的包镜像同步有延迟,`pi install npm:` 可能报 `no such package available`。临时绕过:
```bash
npm_config_registry=https://registry.npmjs.org/ pi install npm:@wuyaos/xxx
```
或直接装 tarball:
```bash
pi install https://registry.npmjs.org/@wuyaos/xxx/-/xxx-1.0.0.tgz
```

## 发布

### 触发方式:总 tag
改任意包的 `version` 字段后,commit push,然后:
```bash
git tag publish-all
git push --tags
```
workflow (`.github/workflows/publish.yml`) 会遍历所有 `pi-*` 包,逐个串行处理:
- npm 上已存在该版本 → 跳过
- npm 上存在包但版本不同 → **OIDC Trusted Publishing**(无需 token)
- npm 上不存在该包 → 需 `NPM_TOKEN` secret 首次发布

因此:
- 只改一个包 version → 打 tag 只发那一个,其余跳过
- 改多个包 → 打 tag 批量发

### 认证:OIDC Trusted Publishing
7 个包都已配 npm Trusted Publisher,GitHub Action 通过 OIDC 免 token 发布,**不要重新往 GitHub Secrets 加 NPM_TOKEN**。

配 Trusted Publisher(仅新包首次需要):
1. npmjs.com → 包页面 → Settings(access)
2. Trusted Publisher → Add GitHub Action
3. 填:Organization=`wuyaos` / Repository=`pi-packages` / Workflow filename=`publish.yml` / Environment 留空 / Allowed actions=`npm publish`
4. 提交时需 2FA 安全密钥确认

### 新包首次发布(Trusted Publisher 的鸡生蛋)
npm Trusted Publisher 必须在**已存在**的包上配置,新包首次发不了 OIDC。流程:
1. 临时往 GitHub Secrets 加 `NPM_TOKEN`(granular token,限 `@wuyaos` scope)
2. workflow 检测到包不存在,用 `NPM_TOKEN` 首次发布
3. 去 npmjs.com 给该包配 Trusted Publisher
4. **删除 GitHub 的 `NPM_TOKEN` secret**
5. 之后纯 OIDC

### 版本号规则
- 每个包独立版本,各自 `package.json` 的 `version`
- tag 的版本必须和 package.json 一致(workflow 会校验,不一致报错)
- 发版前确认 `git status` 干净,避免误发未提交改动

## 开发规范

### 目录结构
- 每个子包独立 `pi-<name>/package.json` + `extensions/*.ts`
- 根 `package.json` workspaces: `["pi-*"]`
- 根 `pi.extensions`: `["pi-*/extensions/*.ts"]`(git 批量安装时自动发现)

### package.json 必须字段
- `name`: `@wuyaos/pi-xxx`
- `version`: 语义化版本
- `repository`: `{ "type": "git", "url": "github.com/wuyaos/pi-packages", "directory": "pi-xxx" }`(Trusted Publisher 校验仓库匹配)
- `publishConfig`: `{ "access": "public" }`(scope 包公开)
- `files`: 白名单,只发布必要文件,避免误发 `.pi-subagents/`、测试文件等
- `pi`: `{ "extensions": [...], "themes": [...], "skills": [...] }`(可选)

### 导入路径
pi 的加载器(tsx/jiti)支持 `.ts` 后缀的相对导入,extensions 间可直接 `from "./xxx.ts"`,无需编译。

### 不要
- 不要在 monorepo 里加 `package-lock.json`(已 gitignore,用 `npm install` 不用 `npm ci`)
- 不要 `npm audit fix --force`(@wuyaos 包本身无漏洞,警告多来自别的扩展的依赖树)
- 不要把 `NPM_TOKEN` 长期留在 GitHub Secrets
- 不要在本仓库放 pi-octssh(它在独立仓库)
