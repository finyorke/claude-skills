# `do` 协作执行命令 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 按任务执行(建议 inline,Task 5 验收依赖当前会话)。步骤用 `- [ ]` 跟踪。

**Goal:** 新增 `/cc-codex-review:do` —— 你给任务(问答/动手),Claude 动手做、Codex 只读协作把关;复杂任务双方先各自独立出方案再对抗到统一,琐碎任务直接做+复核。并把 review 默认轮数改 3、extract-reqs 加对话深度参数。

**Architecture:** prompt 级命令(`commands/do.md`,同 review/extract-reqs 模式)+ 一个新的 `schemas/plan.schema.json`(Codex 出方案的结构化输出)。复用现有 `codex-round.mjs`(只读沙箱、重试)。

**Tech Stack:** Markdown 命令 + JSON Schema;复用 codex-round / review 协议。

> ⚠️ do.md 本身无确定性纯逻辑,验证靠实跑 + 对照 spec(同 extract-reqs);唯一可单测的是新 schema(加一条 schema 合法性测试)。依据 spec:`docs/specs/2026-06-19-collaborative-commands-design.md`。

---

### Task 1: 新增 `schemas/plan.schema.json`(Codex 出方案的输出结构)

**Files:** Create: `cc-codex-review/schemas/plan.schema.json` · Test: 追加到 `cc-codex-review/tests/verdict-schema.test.mjs`

- [ ] **Step 1: 写 schema 文件**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["plan", "steps", "assumptions", "risks"],
  "properties": {
    "plan": { "type": "string", "description": "方案正文:怎么做、关键取舍" },
    "steps": { "type": "array", "items": { "type": "string" }, "description": "落地步骤(有序)" },
    "assumptions": { "type": "array", "items": { "type": "string" }, "description": "为出此方案所做的假设" },
    "risks": { "type": "array", "items": { "type": "string" }, "description": "已知风险 / 待澄清点" }
  }
}
```

- [ ] **Step 2: 加 schema 合法性测试**(追加到 `tests/verdict-schema.test.mjs`)

```javascript
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE2 = dirname(fileURLToPath(import.meta.url));
test('plan.schema.json 合法且约束 required/additionalProperties', () => {
  const s = JSON.parse(readFileSync(resolve(HERE2, '../schemas/plan.schema.json'), 'utf8'));
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required.sort(), ['assumptions', 'plan', 'risks', 'steps']);
});
```

- [ ] **Step 3: 跑测试 + 提交**

Run: `node --test cc-codex-review/tests/*.test.mjs`(期望 148 绿)
```bash
git add cc-codex-review/schemas/plan.schema.json cc-codex-review/tests/verdict-schema.test.mjs
git commit -m "feat(cc-codex-review): plan.schema.json — Codex 出方案的结构化输出(do 用)"
```

---

### Task 2: 写 `commands/do.md`(协作执行命令)

**Files:** Create: `cc-codex-review/commands/do.md`

- [ ] **Step 1: 创建文件,完整内容如下**

````markdown
---
description: 协作执行——你给任务(问答或动手),Claude 动手做、Codex 只读协作把关。复杂任务双方先各自独立出方案再对抗到统一;琐碎任务直接做+复核。也可中文触发,如「帮我做」「一起做这个」「帮我实现」。
argument-hint: '<任务> [--repo <dir>] [--max-rounds <n>]'
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

你要用 **Claude×Codex 协作**完成用户的任务。你(Claude)是**唯一动手方**(写文件、实现);Codex 是**只读协作方**(出方案、挑刺、复核),**绝不能写文件**(沿用 codex-round 的只读沙箱)。

## 1. 解析参数 + 歧义先问
从 `$ARGUMENTS` 解析:`--repo <dir>`(可选,动手/复核的工作根)、`--max-rounds <n>`(方案对抗轮数上限,默认 3,`0`=无上限),余下为**任务**。
- 开始回显一行:`do:最多 N 轮方案对抗(来源:默认/flag)`。
- 任务有**重大歧义**(吃不准用户到底要什么)→ 先用 AskUserQuestion 问清,再继续。

## 2. 繁简判断
- **琐碎且明确**(建个文件、改一行、简单问答)→ **跳过方案对抗**,直接做(§5)+ Codex 快速复核(§6)。
- **复杂 / 有方案空间**(做页面、实现功能、设计)→ 走完整协作 §3–§6。

## 3. 双方独立出方案(仅复杂任务)
1. 你(Claude)**先独立**想一个方案并写下(**先不给 Codex 看**,避免锚定它)。
2. 调脚本让 Codex **独立**基于同一任务出方案(packet **只含任务、不含你的方案**):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-round.mjs" \
     --schema "${CLAUDE_PLUGIN_ROOT}/schemas/plan.schema.json" \
     --out "<临时 plan.json>" [--repo <dir>] < <只含任务的 packet>
   ```
   解析其 `plan/steps/assumptions/risks`。`error=codex_unavailable` → 提示 `/codex:setup` 并停。
3. 现在有**两个独立方案**(你的 + Codex 的)。

## 4. 对抗到统一(仅复杂任务)
- 摆出两方案,逐点对比:**一致的** / **分歧的**。
- 对分歧走互审(复用 `review` 的协议与 `${CLAUDE_PLUGIN_ROOT}/scripts/review-state.mjs` 记账:你采纳或带理由反驳,Codex 裁定),收敛到**统一方案**。轮数上限 = `--max-rounds`(默认 3)。
- **到顶 / 僵持**:**不假装统一** → 产出「双方已一致的方案骨架 + 仍分歧的几处(各自主张 + 严重度)」,请用户拍板要不要继续 / 怎么定,再决定是否执行。

## 5. 执行(Claude 动手)
按统一方案(或用户拍板后的方案),你用 Write/Edit/Bash 动手做。**Codex 不参与写**。

## 6. 复核(Codex 只读)
调脚本让 Codex **复核你做出来的结果**是否满足任务/方案:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-round.mjs" \
  --schema "${CLAUDE_PLUGIN_ROOT}/schemas/verdict.schema.json" \
  --out "<临时 last.json>" [--repo <dir>] < <含任务 + 你做的产物的 packet>
```
Codex 给 `CHANGES` 且有实质问题 → 修 → 再复核(同样受 `--max-rounds` 约束;到顶把未决问题如实告诉用户)。

## 7. 产出
返回做完的东西 + 待用户拍板的点(若有)。琐碎任务直接给结果。

## 注意
- **Codex 全程只读**(codex-round 已固定只读沙箱),绝不让它写文件;动手只由你(Claude)。
- 轮数默认 3、`--max-rounds` 可改、到顶提示可加轮;**不收敛 ≠ 失败**,综合"已一致的"给用户。
- 临时文件放系统临时目录。
````

- [ ] **Step 2: 提交**

```bash
git add cc-codex-review/commands/do.md
git commit -m "feat(cc-codex-review): 新增 do 协作执行命令(Claude 动手 + Codex 只读把关)"
```

---

### Task 3: review 默认轮数 5→3 + extract-reqs 加对话深度

**Files:** Modify: `cc-codex-review/commands/review.md`(§1 默认轮数)· `cc-codex-review/commands/extract-reqs.md`(§1/§2 深度参数)

- [ ] **Step 1: review.md 默认轮数 5→3**

把 review.md §1 里"内置默认上限 `5`"相关措辞改为 `3`(含"默认 `5`"与示例①"默认 `effective_max=5`")。保留 `--max-rounds`/`0`=无上限/优先级规则不变,仅默认值 5→3。

- [ ] **Step 2: extract-reqs.md 加 `--depth <n>` 对话深度**

§1 解析参数加一行:
```
- `--depth <n>`(可选):只看最近 n 轮对话来提取需求;不给则由你判断从哪开始算。
```
§2 定范围补:给了 `--depth n` → 只在最近 n 轮对话里归纳;不给 → 维持现状(自动归纳 + 多块问)。

- [ ] **Step 3: 跑测试 + 提交**

Run: `node --test cc-codex-review/tests/*.test.mjs`(期望仍 148 绿;本任务不碰脚本)
```bash
git add cc-codex-review/commands/review.md cc-codex-review/commands/extract-reqs.md
git commit -m "feat(cc-codex-review): review 默认轮数 5→3(质量优先)+ extract-reqs 加 --depth 对话深度"
```

---

### Task 4: DESIGN / README / 版本(v0.10.0)

**Files:** Modify: `DESIGN.md`(§3 命令列表 + §12 记录)· `README.md`(加 do)· `.claude-plugin/plugin.json`(0.9.1→0.10.0)

- [ ] **Step 1: DESIGN §3 命令列表加 do**

在 §3 配套命令处补:
```
**配套命令 `do`(协作执行,v0.10.0,见 §12 / docs/specs/2026-06-19-collaborative-commands-design.md)**:`/cc-codex-review:do <任务> [--max-rounds <n>]` —— 你给任务,Claude 动手做、Codex 只读协作把关;复杂任务双方各自独立出方案再对抗到统一(默认 3 轮),琐碎任务直接做+复核。
```

- [ ] **Step 2: DESIGN §12 加一条**(状态:v0.10.0)

```
- **协作执行命令 do + 三功能厘清(v0.10.0)**:补"给任务让两 AI 协作做掉"的入口。三命令成流水线:do(做之中,协作完成,Claude 动手/Codex 只读把关,复杂任务独立出方案+对抗到统一)、review(做之后审)、extract-reqs(中间固化需求)。同时 review 默认轮数 5→3(质量优先)、extract-reqs 加 --depth。spec:docs/specs/2026-06-19-collaborative-commands-design.md。
```

- [ ] **Step 3: README 加 do**(在 review/extract-reqs 之后补一节,含命令签名 + 一句说明 + 一个示例)。

- [ ] **Step 4: plugin.json 版本 0.9.1 → 0.10.0**

- [ ] **Step 5: 跑测试 + 提交**

Run: `node --test cc-codex-review/tests/*.test.mjs`(期望 148 绿)
```bash
git add -A && git commit -m "docs(cc-codex-review): v0.10.0 — do 接入 DESIGN/README + review 轮数/extract-reqs depth + 版本"
```

---

### Task 5: 实跑验收 + 对抗自审(inline)

> 验证靠实跑,不是单测。**本任务 inline 执行**(实跑 do 需当前会话动手 + Codex)。

- [ ] **Step 1: 实跑琐碎路径** —— `do` 一个琐碎任务(如"在 /tmp 建 do_probe.txt 写 hello"),核对:跳过方案对抗、Claude 直接做、Codex 复核、产出正确。
- [ ] **Step 2: 实跑复杂路径** —— `do` 一个有方案空间的小任务(如"给 cc-codex-review 写一个 1 段式的功能简介草稿"),核对:Claude 与 Codex 各自独立出方案 → 对抗到统一(或到顶综合)→ Claude 执行 → Codex 复核。确认"独立出方案"时没把 Claude 方案喂给 Codex。
- [ ] **Step 3: 对照 spec 核对** §3 全流程各条(歧义先问/繁简/独立出方案/对抗到统一/Codex 只读/不收敛综合)是否如实发生,记 PASS/问题。
- [ ] **Step 4: 对抗自审** —— 用 `review` 审 `commands/do.md` + `plan.schema.json` 是否忠实实现 spec、Codex 只读铁律有无漏洞、流程有无歧义;按收敛结果修正(发现真问题改 Task 1/2 内容并复跑)。
- [ ] **Step 5: 验收结论记 DESIGN §12,提交。**

---

### Task 6: 发布(推送 + 部署 + tag v0.10.0)

- [ ] **Step 1:** `GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519_finyorke -o IdentitiesOnly=yes' git push git@github.com:finyorke/claude-skills.git main`
- [ ] **Step 2:** `claude plugin marketplace update fun-plugins` + `claude plugin update cc-codex-review@fun-plugins`(→0.10.0);验证缓存含 `commands/do.md` + `schemas/plan.schema.json`。
- [ ] **Step 3:** `claude plugin tag -m "cc-codex-review %s — do 协作执行命令" <repo>` + 推 tag `cc-codex-review--v0.10.0`(同 finyorke key)。
- [ ] **Step 4:** 提示用户重启生效;标 #22 completed。

---

## 自审(对照 spec 覆盖)
- spec §2 三命令职责 → Task2(do)+ Task3(review/extract-reqs 微调)+ Task4(文档)✓
- spec §3 do 流程(歧义先问/繁简/独立出方案/对抗到统一/执行/复核/产出)→ Task2 do.md §1–§7 ✓
- spec §3 角色铁律(Claude 写/Codex 只读)→ do.md 头 + §5/§6 + 注意 ✓
- spec §3.3 独立出方案(plan schema)→ Task1 + do.md §3 ✓
- spec §4 review 默认轮数 3 → Task3 Step1 ✓
- spec §5 extract-reqs 深度 → Task3 Step2 ✓
- spec §6 贯穿规则(默认3/回显/不收敛综合)→ do.md §1/§4/§7 + Task3 review ✓
- 占位符扫描:无 TBD;do.md 与 schema 完整给出。
- 命名一致:命令 `do`、schema 字段 plan/steps/assumptions/risks 在 Task1 与 do.md §3 一致。
