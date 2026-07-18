# pi-themes

98 个主题移植自 [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi)，适配 pi 的主题格式。

## 来源

- 原作者：[can1357](https://github.com/can1357)
- 原始仓库：[oh-my-pi](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/modes/theme/defaults)
- 转换差异：删除了 pi 不支持的 `statusLine*`、`pythonMode`、`toolText`、`link` 等 omp 专有 token，补充了 `thinkingMax`（用 `thinkingXhigh` 回退）

## 主题列表（98 个）

### 暗色（49）
dark-abyss · dark-arctic · dark-aurora · dark-catppuccin · dark-cavern · dark-copper · dark-cosmos · dark-cyberpunk · dark-dracula · dark-eclipse · dark-ember · dark-equinox · dark-forest · dark-github · dark-gruvbox · dark-lavender · dark-lunar · dark-midnight · dark-monochrome · dark-monokai · dark-nebula · dark-nord · dark-ocean · dark-one · dark-poimandres · dark-rainforest · dark-reef · dark-retro · dark-rose-pine · dark-sakura · dark-slate · dark-solarized · dark-solstice · dark-starfall · dark-sunset · dark-swamp · dark-synthwave · dark-taiga · dark-terminal · dark-tokyo-night · dark-tundra · dark-twilight · dark-volcanic

### 亮色（31）
light-arctic · light-aurora-day · light-canyon · light-catppuccin · light-cirrus · light-coral · light-cyberpunk · light-dawn · light-dunes · light-eucalyptus · light-forest · light-frost · light-github · light-glacier · light-gruvbox · light-haze · light-honeycomb · light-lagoon · light-lavender · light-meadow · light-mint · light-monochrome · light-ocean · light-one · light-opal · light-orchard · light-paper · light-poimandres · light-prism · light-retro · light-sand · light-savanna · light-solarized · light-soleil · light-sunset · light-synthwave · light-tokyo-night · light-wetland · light-zenith

### 中性（18）
alabaster · amethyst · anthracite · basalt · birch · graphite · limestone · mahogany · marble · obsidian · onyx · pearl · porcelain · quartz · sandstone · titanium

## 使用

安装后在 pi 设置里选主题，或编辑 `~/.pi/agent/settings.json`：

```json
{
  "theme": "dark-tokyo-night"
}
```

也可启动时指定：

```bash
pi --theme dark-catppuccin
```

## 安装

作为 pi-packages monorepo 一部分：

```bash
pi install git:github.com/wuyaos/pi-packages
```

只加载主题（filter）：

```json
{
  "packages": [{
    "source": "git:github.com/wuyaos/pi-packages",
    "themes": ["pi-themes/themes/*.json"]
  }]
}
```

## License

MIT，沿用原始 omp 许可。
