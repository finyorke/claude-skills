# 🔧 codex-image-gen Plugin 技术交接文档

> 本文档供 AI Agent 阅读，以便理解和维护 codex-image-gen plugin。

## 📂 项目结构

```
claude-skills/                       # GitHub 仓库根目录
├── .claude-plugin/
│   └── marketplace.json             # Plugin 市场配置
├── codex-image-gen/                 # Plugin 目录
│   ├── .claude-plugin/
│   │   └── plugin.json             # Plugin 元信息（版本、作者等）
│   └── skills/
│       └── codex-image-gen/
│           └── SKILL.md            # 核心 Skill 定义文件 ⭐
├── README.md                        # 用户文档
├── HANDOVER.md                      # Plugin 系统介绍
└── TECHNICAL_HANDOVER.md            # 本文档
```

## 🎯 核心功能

**目的**：让 Claude 能通过调用外部 `codex` CLI 工具生成图片。

**触发条件**：
- 中文：生成图片、画一张、生图、出一张图、做一张图、渲染一张、来张图
- 英文：generate an image, draw a picture, make me a picture, render an image, create an image

## ⚙️ 关键设计决策

### 1. 命令格式（v1.3.0）

**固定模板**：
```bash
codex -a never exec -s workspace-write --cd <DIR> --skip-git-repo-check "<PROMPT>"
```

**必需参数**（缺一不可）：
- `-a never` → 非交互模式，不询问用户确认
- `exec` → 一次性执行模式
- `-s workspace-write` → 工作区写入权限（比 danger-full-access 更安全）
- `--cd <DIR>` → **始终**需要，确保权限正确
- `--skip-git-repo-check` → 允许在非 git 仓库运行

### 2. 工作目录规则

| 用户输入 | --cd 设置 | prompt 中的路径 |
|---------|----------|----------------|
| 无路径/仅文件名 | `$(pwd)` | 添加 `, 命名为 filename.png` |
| 相对路径 `./dir/file.png` | `$(pwd)` | 保持相对路径 |
| 绝对路径 `/full/path/file.png` | 父目录 | 保持绝对路径 |

### 3. Prompt 处理原则

**核心原则**：绝不修改用户的创意描述！

✅ **正确做法**：
- 原封不动传递用户的描述
- 只在缺少文件名时添加 `, 命名为 <simple-name>.png`
- 文件名基于主题简单命名（如 lazy-sheep.png, cat.png）

❌ **禁止行为**：
- 添加"卡通风格"、"色彩鲜艳"、"高清"等修饰词
- 扩展角色描述
- 添加场景细节
- 任何"改进"用户 prompt 的行为

### 4. 版本历史

| 版本 | 改动 | 原因 |
|------|------|------|
| 1.0.0 | 初始版本 | 基础功能 |
| 1.1.0 | 强调不改 prompt | Claude 过度修改用户描述 |
| 1.2.0 | workspace-write + 移除 -a never | 尝试更安全的权限（后证明不可行） |
| 1.3.0 | 恢复 -a never，强制 --cd | 权限问题 + 非交互需求 |

## 🛠️ 常见修改场景

### 场景 1：更改权限模式
**文件**：`SKILL.md` 第 40 行附近
```markdown
- `-s workspace-write` — allows writing files in the workspace
```
如需改为 `danger-full-access`，需同时更新：
1. 命令模板（第 47 行）
2. 所有示例（第 120-150 行）
3. Common pitfalls 说明（第 162 行）

### 场景 2：调整文件名生成规则
**文件**：`SKILL.md` 第 75-101 行
```markdown
## Prompt construction
```
当前规则：基于主题生成 1-3 词的简单文件名。
如需更复杂的命名（如时间戳），修改第 79-80 行。

### 场景 3：添加新的触发词
**文件**：`SKILL.md` 第 3 行（description 字段）
在 `Triggers on Chinese phrases like` 部分添加新词汇。

### 场景 4：修改 codex 参数
**文件**：`SKILL.md` 第 36-42 行
如需添加新参数（如 `--model`），记得：
1. 添加到固定参数列表
2. 更新模板
3. 更新所有示例
4. 更新 pitfalls 中的参数计数

### 场景 5：版本更新
**文件**：`codex-image-gen/.claude-plugin/plugin.json`
```json
"version": "1.3.0"  // 改这里
```

## 📋 修改检查清单

修改 SKILL.md 后，确保：

- [ ] 命令模板（第 47 行）正确
- [ ] 工作目录规则（第 54-68 行）清晰
- [ ] Prompt 构造说明（第 71-101 行）明确
- [ ] 所有示例命令（第 118-152 行）已更新
- [ ] Common pitfalls（第 156-162 行）已更新
- [ ] plugin.json 版本号已递增

## 🔍 测试方法

1. **更新 Plugin**
```bash
/plugin update codex-image-gen@fun-plugins
```

2. **测试命令生成**
```
输入：帮我生成一只猫的图片
期望：codex -a never exec -s workspace-write --cd $(pwd) --skip-git-repo-check "帮我生成一只猫的图片, 命名为 cat.png"
```

3. **验证不改 prompt**
```
输入：画一张懒羊羊在吃草的图
期望：不应添加任何描述细节，只加文件名
```

## ⚠️ 关键约束

1. **SKILL.md 中的 CRITICAL 标记**：这些是最重要的规则，不可违反
2. **用户 prompt 神圣不可侵犯**：宁可生成质量差，也不要擅自修改
3. **五个参数缺一不可**：`-a never exec -s --cd --skip-git-repo-check`

## 💬 owner 偏好

- 喜欢简洁的命令，不要冗余参数
- 重视用户意图的精确传达
- 倾向于安全但够用的权限设置（workspace-write）
- 文件名简单明了，不需要复杂规则

## 🆘 遇到问题时

1. 先看 SKILL.md 中的 Common pitfalls 部分
2. 检查版本历史，理解为何这样设计
3. 测试时用简单的 prompt 验证基础功能
4. 如不确定，保持现状，询问 owner 意见

---

**最后更新**：2024-01-19
**当前版本**：1.3.0
**维护者**：finyorke