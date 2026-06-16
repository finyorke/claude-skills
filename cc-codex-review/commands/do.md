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
   解析其 `plan/steps/assumptions/risks`。`error=codex_unavailable` → 提示用户运行 `/codex:setup` 并停。
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
