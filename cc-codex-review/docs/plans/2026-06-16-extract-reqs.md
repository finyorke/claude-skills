# extract-reqs 需求提取命令 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 按任务执行(本计划建议 inline 执行,见末尾"执行交接")。步骤用 checkbox(`- [ ]`)跟踪。

**Goal:** 新增 `/cc-codex-review:extract-reqs` 命令——从当前会话提取「经用户背书的需求(纯 WHAT)」,三档分类 + fail-closed 硬规则 + 用户确认,产出「用户认证需求」文件供 `review --plan` 用作评审基准。

**Architecture:** **prompt 级命令**(`commands/extract-reqs.md`,与 `review.md` 同模式),无确定性脚本。与 review 解耦衔接(产物即 `--plan` 文件)。

**Tech Stack:** Markdown 命令文件(Claude Code plugin 命令自动发现);复用 review 既有 `--plan`。

> ⚠️ **TDD 不适用**:本功能无可单测的确定性纯逻辑(分档=语义判断,靠用户确认兜底,spec §7/§9)。验证方式 = **实跑一次 + 对照 spec §8 验收清单逐条核对**(同 #11 lens 手动验收的范式)。计划据此适配,不写假单测。

依据 spec:`cc-codex-review/docs/specs/2026-06-12-extract-reqs-design.md`(已批准)。

---

### Task 1: 写 `commands/extract-reqs.md` 命令文件

**Files:**
- Create: `cc-codex-review/commands/extract-reqs.md`

- [ ] **Step 1: 创建命令文件,完整内容如下**

````markdown
---
description: 从当前会话提取「经用户背书」的需求(纯 WHAT),分三档+用户确认,产出「用户认证需求」文件供 /cc-codex-review:review --plan 用作评审基准。也可用中文触发,如「提取需求」「需求提取」「帮我把需求整理出来」。
argument-hint: '[界定指令] [--out <path>]'
allowed-tools: Read, Glob, Grep, Write, AskUserQuestion
---

你要执行一次「需求提取」:从**当前会话对话**里,把**用户(开发人员)真正的需求**提取出来,产出一份「用户认证需求」文件。它将作为 `/cc-codex-review:review --plan` 的评审基准——所以**只收录经用户背书的 WHAT(要什么),绝不夹带你(Claude)未经用户确认的 HOW(怎么做)**。

## 为什么(背景)
评审要对照「需求」判断工作合格与否。若需求由你单方转述,可能漏传/传歪,或把你自己的设计决策当成需求混入,使评审退化为"在你定义的需求内自证"、发现不了方向跑偏。本命令把"需求基准"从你的私货里剥干净。三方角色:**用户**=需求权威;**你(Claude)**=实现者+整理者(对自己设计有偏向);评审里的 **Codex**=独立复核方。

## 1. 解析参数
从 `$ARGUMENTS` 解析:
- `[界定指令]`(可选):限定提取范围,如「游戏 UI 相关需求」。
- `--out <path>`(可选):产物输出路径;不给则写入系统临时目录并在对话内呈现路径。

## 2. 定范围
- **给了 `[界定指令]`** → 以它为范围。
- **没给(默认主用法)** → 扫描当前会话,归纳"用户最近让你做的需求活动":
  - **单一清晰块** → 直接取;
  - **多块 / 范围模糊** → **先用 AskUserQuestion 问用户确认范围**(给候选,如「① 刚才的 X ② 整个会话的需求 ③ 其它」),据答复界定。
- **原则:宁可问,不瞎猜、不全量乱提**。
- **诚实局限**:只基于**当前会话可见上下文**;会话很长可能已被压缩,你归纳的是可见部分——产出时**提示用户**"更早/已压缩的需求若没覆盖,请补充"。

## 3. 扫描提取
在确定范围内,逐条识别需求点(用户想要什么、约束、验收期望)。

## 4. 分档(判据 = **是否经用户背书**,不是谁先提出)
对每个点归入四档之一,**每条都要给对话原话出处**:

| 档 | 内容 | 出处要求 |
|---|---|---|
| 纳入① | 用户**直接提**的需求/约束 | 附用户原话 |
| 纳入② | 源自你(Claude)、但用户**明确同意**的论断 | **必附"用户表示同意"的那句原话** |
| 待定③ | 你提的、用户**未明确表态**(仅默许/未反对/没回应) | 附你的提议原文 |
| 排除④ | 你**单方**的实现/设计细节(用户没参与) | 列出,供用户核对"排除得对不对" |

**硬规则(fail-closed,防私货洗白)**:第②档**必须**附得出"用户明确同意"的原话(如"对/可以/同意/就这样");**附不出,就降级到③**。无用户明确背书,**不得**擅自把任何点计入需求。

## 5. 用户确认
把四档清单呈现给用户(②附同意原话,③附你的提议),请用户:**改 / 增 / 删**,并**勾选③里哪些计入需求**。**等用户确认后才产出**(可用 AskUserQuestion 收集勾选)。

## 6. 产出「用户认证需求」
把 纳入①② + 用户勾选的③ 写成 markdown(写到 `--out` 路径或系统临时文件):
```
# 用户认证需求:<范围描述>
(生成时间 · 来源会话 · 经用户确认 ✓)

## 需求(评审基准 · 纯 WHAT)
- [R1] <需求点>  · 出处:<用户原话>        · 来源:用户直述
- [R2] <需求点>  · 出处:<用户同意的原话>  · 来源:Claude 提议 + 用户同意

## 附录:已排除项(非需求 / 属被审的实现决策)
- <你的单方设计>  · 原因:用户未背书
```
产出后告诉用户文件路径,并提示:**接下来可用 `/cc-codex-review:review --plan <该文件> <评审指令>`**,Codex 将以这份「用户认证需求」为基准评审。

## 注意
- **只收 WHAT,不收你未经确认的 HOW**;HOW 是被审对象,不是评审标准。
- 每条需求**必带出处**,让用户能核对你没编、没把自己的设计洗白成需求。
- 只写产物文件,不碰其它文件。
- 范围/确认拿不准就**问**,别替用户拍板。
````

- [ ] **Step 2: 提交**

```bash
git add cc-codex-review/commands/extract-reqs.md
git commit -m "feat(cc-codex-review): 新增 extract-reqs 需求提取命令(prompt 级,按 spec)"
```

---

### Task 2: 文档与版本同步

**Files:**
- Modify: `cc-codex-review/DESIGN.md`(§3 命令接口列表 + §12 把 extract-reqs 从"待实现"→"已实现")
- Modify: `cc-codex-review/README.md`(用法加一行)
- Modify: `cc-codex-review/.claude-plugin/plugin.json`(版本 bump)

- [ ] **Step 1: DESIGN §3 命令接口列表加 extract-reqs**

在 §3 列出命令的位置补一条:
```
- `/cc-codex-review:extract-reqs [界定指令] [--out <path>]`:从当前会话提取「经用户背书的需求(纯 WHAT)」,三档分类+用户确认,产出「用户认证需求」供 review --plan(见 docs/specs/2026-06-12-extract-reqs-design.md)。
```

- [ ] **Step 2: DESIGN §12 把 extract-reqs 条目从"待实现"更新为"已实现 v0.9.0"**(改该条目开头状态措辞)。

- [ ] **Step 3: README 用法加一行**

```
/cc-codex-review:extract-reqs [界定指令]   # 先把"你认证过的需求"提出来,再 review --plan 用它当基准
```

- [ ] **Step 4: plugin.json 版本 0.8.10 → 0.9.0**(新增命令=minor)。

- [ ] **Step 5: 跑测试确认无回归 + 提交**

```bash
node --test cc-codex-review/tests/*.test.mjs   # 期望 147/147(本任务不碰脚本,应不变)
git add -A && git commit -m "docs(cc-codex-review): v0.9.0 — extract-reqs 接入 DESIGN/README + 版本"
```

---

### Task 3: 实跑验收(对照 spec §8)+ 对抗自审

> 验证靠实跑,不是单测。**本任务必须 inline 执行**——实跑 extract-reqs 需要"当前会话的对话上下文"作素材,fresh subagent 没有。

- [ ] **Step 1: 实跑 extract-reqs**,拿一段含「用户需求 + Claude 设计 + 用户对部分设计的同意/默许」的真实对话(本会话的 extract-reqs 设计讨论本身就是现成素材)跑一遍。

- [ ] **Step 2: 对照 spec §8 逐条核对**,记录 PASS/问题:
  - 无参数时能自动归纳范围;多块/模糊主动问;给指令时按指令界定;
  - 用户直述→①、用户明确同意的 Claude 论断→②(附同意原话)、未表态→③、Claude 单方设计→④;
  - ②无同意原话→降级③(硬规则生效);
  - 产物仅 WHAT、每条带出处、排除项单列;
  - 用户可改/勾选后产出确认版;
  - `review --plan` 能消费该产物。

- [ ] **Step 3(符合用户"提交前对抗检查"偏好):用 cc-codex-review 自审本 diff**。`/cc-codex-review:review --repo <cc-codex-review> 评审 commands/extract-reqs.md 是否忠实实现 extract-reqs spec、有无遗漏/规格偏差`,按收敛结果修正(发现真问题则改 Task 1/2 内容并复跑)。

- [ ] **Step 4: 把验收结果记入 DESIGN §12**(extract-reqs 条目补"实跑验收 + 自审结论"),提交。

---

### Task 4: 发布(部署 + tag)

- [ ] **Step 1: 推送**

```bash
GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519_finyorke -o IdentitiesOnly=yes' git push git@github.com:finyorke/claude-skills.git main
```

- [ ] **Step 2: 部署到插件缓存**

```bash
claude plugin marketplace update fun-plugins
claude plugin update cc-codex-review@fun-plugins   # → 0.9.0
```
验证:`ls ~/.claude/plugins/cache/fun-plugins/cc-codex-review/0.9.0/commands/extract-reqs.md` 存在。

- [ ] **Step 3: 打 release tag**

```bash
claude plugin tag -m "cc-codex-review %s — extract-reqs 需求提取命令" /Users/fun/D/Projects/claude-skills/cc-codex-review
GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519_finyorke -o IdentitiesOnly=yes' git push git@github.com:finyorke/claude-skills.git refs/tags/cc-codex-review--v0.9.0
```

- [ ] **Step 4: 提示用户重启 Claude Code 使新命令生效**;更新任务 #16 为 completed。

---

## 自审(对照 spec 覆盖)
- spec §3 接口(界定指令可选/--out)→ Task1 §1/§2 ✓
- spec §4 过程(定范围/扫描/分档/硬规则/确认/产出)→ Task1 §2–§6 ✓
- spec §5 产物格式 → Task1 §6 ✓
- spec §6 与 review 关系(解耦,--plan)→ Task1 §6 提示 + Task3 验收 ✓
- spec §7 prompt 级形态 → Task1 是 .md、无脚本 ✓
- spec §8 验收 → Task3 实跑对照 ✓
- spec §9 局限(可见上下文/压缩/人工兜底)→ Task1 §2 诚实标注 ✓
- spec §10 YAGNI(不做内置一条龙/跨会话/版本管理)→ 计划未引入 ✓
- 占位符扫描:无 TBD/TODO;命令内容完整给出。
- 类型/命名一致:命令名 `extract-reqs`、产物字段(R 编号/出处/来源/附录)在 Task1 与 spec §5 一致。
