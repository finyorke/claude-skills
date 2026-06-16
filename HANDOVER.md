# claude-skills — 交接说明

> 给"刚接手、零上下文"的人 / 未来的我。目标:**60 秒看懂这仓库是什么、怎么用、怎么继续**。

`claude-skills` 是一个 **Claude Code 插件市场(marketplace)仓库**,含两个插件:

| 插件 | 作用 | 状态 |
|---|---|---|
| **cc-codex-review** | Claude × Codex 收敛互审(`review`)+ 需求提取(`extract-reqs`) | 活跃迭代 · v0.9.1 |
| **codex-image-gen** | 用 codex CLI 生成图片(中英文触发) | 稳定 |

## 安装 / 更新
```bash
/plugin marketplace add finyorke/claude-skills
/plugin install cc-codex-review@fun-plugins        # 或 codex-image-gen@fun-plugins
/plugin update  cc-codex-review@fun-plugins         # 更新后需重启 Claude Code 才生效
```

## cc-codex-review 速用
依赖 Codex CLI(`codex --version` 要能跑);**Codex 全程只读,绝不改你的文件**。
```bash
# 收敛互审:把工作丢给 Codex 对抗复核 → 双 AGREE 出 ✅RESOLVED,否则 ⚠️UNRESOLVED 裁决
/cc-codex-review:review --repo . 评审这次改动有没有引入回归
# 需求提取:从会话提取"你认证过的需求",供 review --plan 当评审基准
/cc-codex-review:extract-reqs 我要的登录功能需求
```
两命令全部用法见 **`cc-codex-review/README.md`**。

## codex-image-gen 速用
对话里直接说"帮我生成一张猫咪图片"(或英文)即可触发。

## 想继续开发 cc-codex-review
1. **先读** `cc-codex-review/DESIGN.md` —— 尤其 **§12 路线图**(P0–P4 设计决策与取舍)和 **§10 手动验收清单**。
2. 改 `scripts/*.mjs` 后跑 `node --test cc-codex-review/tests/*.test.mjs`(当前 **147 绿**)。
3. `commands/*.md` 是 prompt 本体(改它=改评审/提取行为);确定性逻辑才进 `scripts/` 并配单测。
4. 提交前习惯:**用 cc-codex-review 自己审自己**(dogfood)。

## 当前状态(快照)
- cc-codex-review **v0.9.1**:`review` + `extract-reqs` 两命令均可用;147 测试绿;tag 到 `cc-codex-review--v0.9.1`。
- 待办与决策详见 `cc-codex-review/DESIGN.md §12`(backlog:correctness/requirements 镜头验证、P3 扩样、真人盲评、full-P4 等)。
- 仓库:https://github.com/finyorke/claude-skills
