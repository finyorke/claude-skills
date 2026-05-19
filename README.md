# Claude Code Plugin Marketplace

这是一个 Claude Code Plugin 市场，提供各种实用的 plugins。

## 🚀 快速安装

在 Claude Code 中运行：

```bash
# 1. 添加 marketplace
/plugin marketplace add finyorke/claude-skills

# 2. 安装 plugin
/plugin install codex-image-gen@fun-plugins
```

## 📦 Available Plugins

### codex-image-gen
通过外部 `codex` CLI 生成图片的插件。

- **功能**：让 Claude 直接生成图片文件
- **触发词**：
  - 中文：生成图片、画一张、生图、出一张图、做一张图、渲染一张、来张图
  - 英文：generate an image, draw a picture, make me a picture, render an image, create an image

## 📋 前置要求

### codex-image-gen
需要先安装 [codex CLI](https://github.com/openai/codex)：

```bash
# 安装 codex（如果还没装）
npm install -g @openai/codex

# 验证安装
which codex
```

## 💡 使用示例

```
用户: 帮我生成一张可爱的猫咪图片
Claude: [调用 codex-image-gen 生成图片]

用户: 画一张赛博朋克风格的城市
Claude: [生成 cyberpunk-city.png 到当前目录]

用户: Generate an image of a sunset over mountains
Claude: [生成 sunset-mountains.png]
```

## 🔄 更新 Plugin

```bash
# 查看已安装的 plugins
/plugin list

# 更新到最新版本
/plugin update codex-image-gen@fun-plugins
```

## 📁 仓库结构

```
claude-skills/
├── .claude-plugin/
│   └── marketplace.json      # marketplace 配置
├── codex-image-gen/         # plugin 目录
│   ├── .claude-plugin/
│   │   └── plugin.json      # plugin 元信息
│   └── skills/
│       └── codex-image-gen/
│           └── SKILL.md     # skill 定义
└── README.md
```

## 🤝 贡献

欢迎提交新的 plugins！请确保：

1. 在独立目录中组织你的 plugin
2. 包含 `.claude-plugin/plugin.json` 文件
3. 在 `.claude-plugin/marketplace.json` 中注册
4. 更新 README 说明用法

## 📄 License

MIT

## 🐛 问题反馈

如有问题，请在 [Issues](https://github.com/finyorke/claude-skills/issues) 中反馈。