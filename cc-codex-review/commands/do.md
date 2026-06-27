---
description: 协作执行——你给任务(问答或动手),Claude 动手做、Codex 只读协作把关。复杂任务双方先各自独立出方案再对抗到统一;琐碎任务直接做+复核。也可中文触发,如「帮我做」「一起做这个」「帮我实现」。
argument-hint: '<任务> [--repo <dir>] [--max-rounds <n>]'
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

你要用 **Claude×Codex 协作**完成用户的任务。你(Claude)是**唯一动手方**(写文件、实现);Codex 是**只读协作方**(出方案、挑刺、复核),**绝不能写文件**(沿用 codex-round 的只读沙箱)。

## 1. 解析参数 + 歧义先问
从 `$ARGUMENTS` 解析:`--repo <dir>`(动手/复核的工作根)、`--max-rounds <n>`、余下为**任务**。**未给 `--repo` 时默认用当前工作目录 `.`**(让 Codex 默认就能读到本项目、复核有依据);显式给了就用给的目录。§3 出方案 / §6 复核调 codex-round 时**一律带上这个生效 repo**。开头回显里注明 `repo=<给定值|默认 .>`。
- `--max-rounds <n>`:**每个互审循环各自的轮数上限**(§4 方案对抗 ≤N 轮、§6 复核 ≤N 轮,**各自计,不是两阶段合计**),默认 `3`,`0`=无上限。非法值(负数/非整数)→ 报参数错误并停、不静默回退(同 review §1 口径);停滞检测(某轮无实质进展即提前停)同 review。
- 开始回显一行:`do:方案对抗 / 复核 各最多 N 轮(来源:默认/flag)`。
- 任务有**重大歧义**(吃不准用户到底要什么)→ 先用 AskUserQuestion 问清,再继续。
- **载入决策日志基线**:若生效 repo 非 `none`,开始时调
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/decisions-log.mjs" read`(stdin `{"repo":"<生效repo>"}`)读 `.cc-codex-review/decisions.jsonl`,把已有「已定决策/约束 + 未决项」作为本轮**已知基线**纳入考量(Codex 也会经 `--repo` 读到 `.cc-codex-review/decisions.md`)。文件不存在=空基线,正常继续。

## 2. 繁简判断
**默认走完整协作(§3–§6);只有确信"琐碎且低风险"才简化。**
- **必须走完整协作**(哪怕改动行数很小):涉及**安全 / 鉴权 / 数据 / 跨模块 / 用户可见行为 / 不可逆或 blast radius 大**的任务——"改一行也可能出大事",不得判琐碎。
- **可简化**(跳过方案对抗,直接做 §5 + Codex 快速复核 §6):确信**琐碎 + 低风险 + 明确**(如建临时文件、改文案、简单问答)。
- **拿不准 → 走完整协作**(fail-safe);若选择简化,需一句话说明分流理由。

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

**Codex 调用核对(软信号)**:do 全程的 codex `thread_id`(§3 出方案 / §4 对抗 / §6 复核)累积;收尾**尽量**用 `${CLAUDE_PLUGIN_ROOT}/scripts/verify-codex-session.mjs` 核对(查 `~/.codex/sessions`),产出附 thread_id + verified/missing + `paths`(每个 verified id 的 rollout 文件路径,便于一键打开完整对话)供人工留意。**软信号、非硬门禁**:`missing` **不挡收敛、不直接判不可信**(机制可绕、不做硬门禁);但现版本 codex 落盘可靠,故 `missing` 值得人工当回事、提示人工核;`verified` 佐证真调了 Codex。

**写回决策日志(给 Codex 的跨轮基线,见 `docs/specs/2026-06-27-decision-log-design.md`)**:本轮收尾时——
- 整理本轮 entry:**已定**(双方 AGREE 的决策/约束 → `status:decided` + `rationale`)、**未决**(仍分歧 → `status:open` + `positions.claude/codex` + `severity`)。🔶 待复核(你已回应、Codex 未确认)**先不写**,等下轮定。
- **先让 Codex 确认记录无误**:把这些拟写入条目放进**本轮最后一个 packet**,请 Codex 确认「decided 确实达成、open 立场记对了」(不是让它对内容表态)。
- 确认后调 `node "${CLAUDE_PLUGIN_ROOT}/scripts/decisions-log.mjs" upsert`,stdin `{"repo":"<生效repo>","ops":[...]}`:新决策/未决用 `{op:"append",entry:{...}}`;某 `open` 本轮谈拢→优先 `append` 一条新 `decided` 并 `supersedes:[旧id]`(裸 set-status 翻 decided 会因缺 rationale 被拦)。脚本会写 jsonl + 重渲染 `decisions.md`。
- **生效 repo 为 `none`(不适用 do,do 总有 repo)或脚本报错**:把错误如实告诉用户,不阻断主产出。
- **不自动 `git commit`**;可提示用户"决策已记到 `.cc-codex-review/decisions.md`,需要的话自行提交"。

## 注意
- **Codex 全程只读**(codex-round 已固定只读沙箱),绝不让它写文件;动手只由你(Claude)。
- 轮数默认 3、`--max-rounds` 可改、到顶提示可加轮;**不收敛 ≠ 失败**,综合"已一致的"给用户。
- 临时文件放系统临时目录。
