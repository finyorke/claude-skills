# cc-codex-review

**Claude × Codex 收敛互审。** 让 Claude(我,驱动方)和 Codex(独立复核方)对同一份工作循环互审——逼到双方都 AGREE 才算过(**RESOLVED**),否则产出结构化的 **UNRESOLVED** 裁决给你拍板。核心价值:消除"单个 AI 自说自话、自己说通过就通过"的盲区。

含两个命令:`review`(收敛互审)+ `extract-reqs`(需求提取)。

---

## 1. `/cc-codex-review:review` — 收敛互审(主命令)

```
/cc-codex-review:review [--repo <dir>] [--diff <file|->] [--plan <file>] [--model <m>] [--max-rounds <n>] [--lens <name>] [--dry-run] <评审指令>
```

| flag | 作用 |
|---|---|
| `--repo <dir>` | 给 Codex 一个**只读**工作根(读文件、跑 `git log/diff`) |
| `--diff <file\|->` | 审一份 diff(`-` = 读你粘进对话的 diff 块) |
| `--plan <file>` | 评审**基准**(任务目标/需求文件;可喂 `extract-reqs` 的产物) |
| `--max-rounds <n>` | 硬上限轮数(默认 `5`;`0` = 不设上限,仅靠停滞检测) |
| `--lens <name>` | 焦点镜头(见 §3) |
| `--model <m>` | 指定 Codex 模型 |
| `--dry-run` | 只打印「参数解析 + 评审包 + 将执行的命令」,**不调 Codex** |

**适用模式**:代码/实现、diff 签核、提案/设计文档、需求门禁、修 bug 根因复核。

```bash
# 审代码(给 repo 让 Codex 自己读)
/cc-codex-review:review --repo ~/proj 评审 src/limiter.ts 的并发与边界是否正确
# 审提案/设计文档(查遗漏)
/cc-codex-review:review --lens omission 看看这份设计方案有没有遗漏
# 只预览要发给 Codex 的内容,不真调
/cc-codex-review:review --dry-run --repo ~/proj 评审这次改动有没有引入回归
```

收敛 → `✅ RESOLVED` + 结论;不收敛(到顶/停滞)→ `⚠️ UNRESOLVED` 结构化裁决块(已达成共识 vs 未决分歧,逐条标严重度),你拍板。

---

## 2. `/cc-codex-review:extract-reqs` — 需求提取

```
/cc-codex-review:extract-reqs [界定指令] [--out <path>]
```

从**当前会话**提取**你认证过的真需求(纯 WHAT)**:按"是否经你背书"分四档(纳入①你直述 / ②我提议+你明确同意 · 待定③未表态 · 排除④我的实现决策)+ **fail-closed 硬规则**(没有你明确同意的原话,不得算需求)+ **你确认** → 产出「用户认证需求」文件。目的:让 review 对照**你的真需求**审,而不是我单方转述/夹带设计私货。

- `[界定指令]` **可选**:不给则我主动归纳范围、有多块就问你;给了按它界定。
- `--out <path>`:产物路径(默认写临时目录)。

### 闭环用法(最能堵"方向跑偏")
```bash
/cc-codex-review:extract-reqs 我要的登录功能需求     # ① 提取 → 你确认 → 产出 reqs.md
/cc-codex-review:review --plan reqs.md --repo ~/proj 评审登录实现是否满足需求   # ② 用它当基准审
```
**适用边界**:你有**独立原创需求**时最有用;"按你推荐的做"型任务(需求与实现同源)它会提醒你"防自证力弱,建议补独立验收标准"。

---

## 3. `/cc-codex-review:do` — 协作执行

```
/cc-codex-review:do <任务> [--repo <dir>] [--max-rounds <n>]
```

你给任务(问答、或动手如「建 111.txt」「做个人主页」),**Claude 动手做、Codex 只读协作把关**。**复杂任务**:双方先各自独立出方案、再对抗讨论到统一(默认 3 轮),Claude 执行、Codex 复核;**琐碎任务**:直接做+复核。Codex 全程只读,动手只由 Claude。

## 4. `--lens` 焦点镜头(验证程度不同,用前知道)

| 镜头 | 状态 | 建议 |
|---|---|---|
| `omission`(首轮遗漏检查) | ✅ 已验证 | **推荐**用于提案/设计文档评审 |
| `security` | 🟡 定性验证(本工具自审曾挖出真漏洞) | 审安全敏感代码可用 |
| `correctness` / `requirements` | ⚠️ 实验性、未验证 | 用前知此 |

镜头 = "通用评审 **+** 额外侧重",**双 AGREE 仍是全面签核**(不缩小范围);用了镜头(或我据指令隐性侧重某视角)结论里**必声明**。`--omission-check` = `--lens omission` 别名。代码评审默认不套镜头。

---

## 底层保障

- **Codex 全程只读**:fresh 轮 `-s read-only`、resume 轮 `-c sandbox_mode="read-only"` + `approval_policy="never"` + `--ignore-rules`,**绝不能改你的文件**(曾修过一个 resume 沙箱逃逸漏洞 CR-SEC-001)。
- 关键逻辑都是**确定性脚本 + 单测**(`node --test cc-codex-review/tests/*.test.mjs`,当前 147 绿):防假收敛、防漏算。
- 整套工具**被它自己审过**(dogfood)。
- **防假互审**:`review`/`do` 的结论会附 codex `thread_id`,可在 `~/.codex/sessions` 核对"真的调了 Codex"(`verify-codex-session.mjs` + 收敛门禁:没真调就不许判 RESOLVED)。

## 更多
设计、路线图与决策见 **`DESIGN.md`**(尤其 §12);需求提取的设计 spec 见 `docs/specs/2026-06-12-extract-reqs-design.md`。
