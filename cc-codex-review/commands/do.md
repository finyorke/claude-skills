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
1. 你(Claude)**先独立**想一个方案,只放在**对话 / scratch(你的私有上下文)**——**绝不写进 repo、不进 packet、不放任何 Codex 可读的位置**(否则 Codex 出方案时会读到、被你锚定)。
2. 调脚本让 Codex **独立**基于同一任务出方案(**必须加 `--raw`**:plan 是非 verdict 结构;packet **只含任务、不含你的方案**):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-round.mjs" \
     --schema "${CLAUDE_PLUGIN_ROOT}/schemas/plan.schema.json" --raw \
     --out "<临时 plan.json>" [--repo <dir>] < <只含任务的 packet>
   ```
   - 成功:`{ok:true, result:{plan,steps,assumptions,risks}}` —— 取 `result`。
   - `error=codex_unavailable` → 提示用户运行 `/codex:setup` 并停;其它 `ok:false`(如 bad_verdict)→ 把 error 告诉用户并停。
   - ⚠️ 若带 `--repo`:确保 repo 工作树里**没有你刚写的方案**(你本就不该写进去),避免 Codex 读到而被锚定。
3. 现在有**两个独立方案**(你的 + Codex 的)。

## 4. 对抗到统一(仅复杂任务)
1. 逐点对比两方案,分成 **一致点** / **分歧点**;**每点标来源**(来自你的方案 / Codex 方案 / 两者)。
2. 对**每个分歧点**走互审(复用 review 协议 + `${CLAUDE_PLUGIN_ROOT}/scripts/review-state.mjs` 记账):把"该分歧点 + 双方各自主张"写成 packet,调 codex-round(**verdict schema,不加 --raw**)让 Codex 裁定;你采纳或带理由反驳。每个分歧点当一条带稳定 id 的 issue,走 open→candidate→agreed 直到了结。
3. **统一方案 = 全部分歧点了结(agreed)**。轮数上限 = `--max-rounds`(默认 3)。
4. **到顶 / 僵持**(仍有分歧点未了结):**不假装统一** → 产出「**已一致的方案骨架**(每点标来源)+ **仍分歧的几处**(各自主张 + 严重度)」,请用户拍板要不要继续 / 怎么定,再决定是否执行。

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
返回做完的东西 + 待用户拍板的点(若有)。**统一方案 / 关键结论的每一条都附来源**(依据了哪段代码 / 事实 / 需求,或来自谁的方案、哪轮达成),可溯源、可核对。琐碎任务直接给结果(复核结论也注明依据)。

## 注意
- **Codex 全程只读**(codex-round 已固定只读沙箱),绝不让它写文件;动手只由你(Claude)。
- 轮数默认 3、`--max-rounds` 可改、到顶提示可加轮;**不收敛 ≠ 失败**,综合"已一致的"给用户。
- 临时文件放系统临时目录。
