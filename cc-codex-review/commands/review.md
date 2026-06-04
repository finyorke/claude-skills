---
description: Claude 与 Codex 围绕某项工作循环互审,直到双方 AGREE
argument-hint: '[--repo <dir>] [--diff <file|->] [--plan <file>] [--model <m>] [--max-rounds <n>] [--dry-run] <评审指令>'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

你要执行一次「Claude × Codex 收敛互审」。你(Claude)是驱动方/主张方,Codex 是对抗式复核方。
被审材料可能是计划、代码 diff、执行结果、草案等。每轮 Codex 的调用通过辅助脚本完成:
`${CLAUDE_PLUGIN_ROOT}/scripts/codex-round.mjs`(schema 在 `${CLAUDE_PLUGIN_ROOT}/schemas/verdict.schema.json`)。

原始参数:
`$ARGUMENTS`

## 适用模式与边界(先读)
本工具用于「文本与代码类」评审,但**不同模式需要不同 rubric,且有硬边界**——先判断属于哪类,据此组装评审包与 Codex 职责:
- **代码 / 实现**:质疑实现路径、边界用例、潜藏 bug、是否覆盖需求。
- **diff 签核**:**必须先界定覆盖范围**;只审了部分 diff 就不能给完整 AGREE(用 schema 的 `truncated`/`reviewed_scope` 标注)。
- **纯文字稿 / 提案 / 研究计划**:质疑论点是否成立、证据是否充分、结构与遗漏;**不要套用代码 rubric**(别问"有没有 bug")。
- **需求 / 计划门禁**:质疑需求完整性、可验证性、依赖与风险。
- **修 bug**:根因是否正确、是否引入回归、是否有更稳改法。**硬边界**:Codex 只读,**跑不了 repro / 测试 / 构建**;需要动态证据时,由你(或用户)把 repro 步骤、测试/构建输出作为「待审材料」提供,Codex 据此判断,而非自行运行。

## 1. 解析参数
从 `$ARGUMENTS` 中解析可选 flag,余下作为「评审指令」:
- `--repo <dir>`:Codex 工作根(可读文件、跑 git);不给则纯文本/diff 评审。
- `--diff <file|->`:一份 diff;`-` 表示从本对话里用户粘贴的 diff 块取。
- `--plan <file>`:任务目标/规格文件。
- `--model <m>`:传给 Codex 的模型。
- `--max-rounds <n>`:硬上限轮数。
- `--dry-run`:只组装并打印「评审包」+ 将要执行的命令,**不真正调用 Codex**,然后停止。

硬上限优先级:`--max-rounds` > 评审指令自然语言里出现的轮数("最多 5 轮"等,你来解析) > 默认无硬上限。
- **门禁 / 签核用途强烈建议显式设 `--max-rounds`**:无硬上限 + 对抗式分歧下可能不收敛;门禁场景宁可到顶产出「UNRESOLVED」也不要无限循环。

## 2. 收集被审材料
- 从本对话中收集用户最近粘贴的材料(执行结果、代码片段、计划、提案等),可多段并标注来源。
- 若给了 `--plan <file>`,读取它;否则用对话里的目标;都没有就**问用户**目标是什么。
- 若给了 `--diff`,读取/取出该 diff 文本。
- 若既无任何材料、也无 `--repo`/`--diff` 可审 → **停下来问用户要评审什么**,不要猜。

## 3. 形成你的初版主张
基于 评审指令 + 材料 + 目标(+ repo/diff),写出:结论(通过 / 返工 / 阻止)+ 理由 + 给后续的具体修改建议。

## 4. 组装评审包(写入临时文件 packet.txt)
结构:
```
## 任务目标
<目标内容或文件引用>

## 待审材料
<材料;或 "见下方代码上下文">

## 代码上下文
<若有 --repo:指示 Codex 在工作根自行运行 `git log -n 20` / `git diff` 查看;
 若有 --diff:内联粘贴该 diff;否则:无>

## Claude 当前主张
<你的判断 + 理由 + 修改建议>

## 你的职责
你是对抗式复核方。请**对照「任务目标」复核「待审材料 / 代码上下文」这份工作本身**,
并评估上面「Claude 当前主张」是否成立——Claude 的主张只是一个输入,不要默认它对。
有任何实质疑虑就给 verdict=CHANGES;不要为了收敛而同意。
优先质疑(按本次评审模式选取,见顶部「适用模式与边界」):实现路径、设计取舍、假设是否成立、需求是否完整覆盖、有无潜藏 bug、边界用例、论点/证据是否充分。
按提供的 JSON Schema 输出全部字段:verdict / remaining_issues / rationale / truncated / reviewed_scope / assumptions。
- `truncated`:若你只看到了材料/改动的一部分(被摘要、截断、或仅 diff 片段),置 true。
- `reviewed_scope`:一句话说明你实际审了什么范围(如「仅 packet 内摘要,未读全量 diff」)。
- `assumptions`:你为得出结论而做的假设(如「假设测试通过」)。
- **范围 gate**:若 `truncated=true` 且被省略的部分对结论是必要证据,**不得给 AGREE**,应给 CHANGES 并说明需要补哪些证据。仅当你确无实质异议、且范围足以支撑结论时才给 AGREE。
```
材料过大时你(Claude)可摘要,但必须在包里**显式标注截断了什么**,并据实让 Codex 在 verdict 里置 `truncated`/`reviewed_scope`。

## 5. dry-run 短路
若有 `--dry-run`:打印组装好的 packet.txt 全文 + 下一节将执行的 `codex-round.mjs` 命令行,然后**结束**,不调用 Codex。

## 6. 互审循环
维护 `thread_id`(初始空)、`round=0`、`prev`(上一轮的 issue 摘要,初始空)。

每轮:
1. `round++`。
2. 调用辅助脚本(第 1 轮 fresh,无 `--resume`;第 2 轮起带 `--resume <thread_id>`):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-round.mjs" \
     --schema "${CLAUDE_PLUGIN_ROOT}/schemas/verdict.schema.json" \
     --out "<临时文件 last.json>" \
     [--repo <dir>] [--model <m>] [--resume <thread_id>] \
     < <packet 或增量文件>
   ```
   - 第 1 轮 stdin 喂完整 packet.txt;第 2 轮起只喂**增量**(你对上轮每条 issue 的逐条回应 + 修订后的「Claude 当前主张」)。
3. 解析脚本 stdout 的那行 JSON:
   - `error=codex_unavailable` → 告诉用户运行 `/codex:setup`,**停止**。
   - `error=bad_verdict` → 已重试仍失败;把 `raw_message` + `codex_exit` + `stdout_tail`/`stderr_tail`(含 codex 的 error/turn.failed 事件)给用户帮助排查,**停止**。
   - 成功:记下 `thread_id`、`verdict`、`remaining_issues`、`truncated`、`reviewed_scope`、`assumptions`。
4. **打印进度行**:`第 N 轮 · Codex=<verdict> · 剩 <k> issue(<b> blocker) · Claude=<同意/持异议>`。
5. 处理:
   - 若 Codex=CHANGES:对**每条 issue** 要么采纳并修订你的主张,要么带理由反驳(写下你的理由)。更新你的主张。
   - 你给出本轮自己的立场:无任何剩余异议 → Claude=AGREE,否则 Claude=持异议。
6. **双 AGREE 闸门**:仅当 `Codex.verdict==AGREE` 且你也 Claude=AGREE → 收敛,跳出。
7. **终止条件**(任一即停):
   - 双 AGREE → 收敛成功。
   - 设了硬上限且 `round>=max` → **UNRESOLVED**(未收敛)。
   - **停滞**:本轮 `remaining_issues` 与上一轮实质相同、且你的主张未实质变化 → **UNRESOLVED**。
   - 把本轮 issue 摘要存入 `prev` 供下一轮比较。

## 7. 输出
- 收敛成功:打印
  ```
  ✅ 收敛结论(状态:RESOLVED)
  <商定的结论>
  <后续行动的具体建议>
  ```
  若最后一轮 `truncated=true`,**必须**在结论顶部加一行 `⚠️ 基于截断材料(reviewed_scope: ...),非完整签核`,避免被误读为全量通过。
- 未收敛(硬上限 / 停滞 / 用户打断):打印**结构化 UNRESOLVED 块**,供用户裁决:
  ```
  ⚠️ 未收敛(状态:UNRESOLVED · 原因:<到达 max-rounds / 停滞 / 用户打断>)
  · Claude 最后立场:<...>
  · Codex 最后立场:<verdict + 关键 remaining_issues>
  · 卡点(双方分歧):<逐条>
  · 建议:<用户需决策什么 / 或建议设/调 --max-rounds>
  ```

## 注意
- 只有真的无异议才输出 AGREE;不认同 Codex 就带理由反驳,而非投降。顺从式同意视为失败。
- 临时文件放系统临时目录,用完可留痕便于排查。
- 绝不让 Codex 写文件(脚本已固定 `-s read-only`)。
