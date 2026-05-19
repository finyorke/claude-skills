# Claude Skills Collection

个人 Claude Code Skills 集合，用于扩展 Claude 的功能。

## 🎯 Skills 列表

### codex-image-gen
通过外部 `codex` CLI 生成图片的 skill。

**功能**：让 Claude 能够直接生成图片文件到本地
**触发词**：生成图片、画一张、生图、generate an image 等

## 📦 安装方法

### 方法 1：直接下载（推荐）

```bash
# 1. 创建 skill 目录
mkdir -p ~/.claude/skills/codex-image-gen

# 2. 下载 SKILL.md
curl -o ~/.claude/skills/codex-image-gen/SKILL.md \
  https://raw.githubusercontent.com/finyorke/claude-skills/main/skills/codex-image-gen/SKILL.md

# 3. 重启 Claude Code 对话即可使用
```

### 方法 2：克隆整个仓库

```bash
# 1. 克隆仓库
git clone https://github.com/finyorke/claude-skills.git /tmp/claude-skills

# 2. 复制需要的 skill
cp -r /tmp/claude-skills/skills/codex-image-gen ~/.claude/skills/

# 3. 重启 Claude Code 对话
```

## 🔧 前置要求

### codex-image-gen
需要先安装 [codex CLI](https://github.com/openai/codex)：

```bash
# macOS/Linux
npm install -g @openai/codex

# 验证安装
which codex
```

## 📝 使用示例

```
用户: 帮我生成一张可爱的猫咪图片
Claude: [调用 codex-image-gen skill 生成图片]

用户: 画一张赛博朋克风格的城市
Claude: [生成 cyberpunk-city.png 到当前目录]
```

## 🚀 更新

```bash
# 拉取最新版本
cd ~/.claude/skills/codex-image-gen
curl -o SKILL.md \
  https://raw.githubusercontent.com/finyorke/claude-skills/main/skills/codex-image-gen/SKILL.md
```

## 📄 License

MIT

## 🤝 贡献

欢迎提交 PR 或 Issue！