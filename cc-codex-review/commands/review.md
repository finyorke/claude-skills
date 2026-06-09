---
description: Claude 与 Codex 围绕某项工作循环互审,收敛于双方 AGREE,否则到顶/停滞产出 UNRESOLVED 裁决
argument-hint: '[--repo <dir>] [--diff <file|->] [--plan <file>] [--model <m>] [--max-rounds <n>] [--omission-check] [--dry-run] <评审指令>'
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
- `--max-rounds <n>`:硬上限轮数;`--max-rounds 0` 显式表示**不设上限**(仅靠停滞检测 + 人工兜底)。
- `--omission-check`:开启后**仅在第 1 轮**给 Codex 追加一次「遗漏检查」指令(见 §4.5),让其前置列出"应覆盖却缺失/未触及"的点。默认关。
  - **用法建议(基于 P3 实验,见 DESIGN §12;小样本启发式,非定论)**:它是个**召回↑ / 精度↓的权衡开关**——
    · ✅ 推荐用于**提案 / 设计文档 / 计划评审**(空白多、几乎不增噪音,实测多挖大量真实遗漏);
    · ✅ 推荐用于**需高召回的深挖 / 高风险签核**(宁可多查也别漏,愿容忍少量噪音);
    · ⛔ **代码评审默认关**(实测会引入少量噪音如"无触发的理论问题",质量优先下不划算);
    · ⚠️ **别指望它省轮或加速收敛**——它增加的是"发现"而非"收敛速度",紧预算下两臂都更可能 UNRESOLVED。
  - 实验对照工具:`scripts/experiment.mjs`(A=关 / B=开 的配对比较 + 质量优先 decide)。
- `--dry-run`:只组装并打印「评审包」+ 将要执行的命令,**不真正调用 Codex**,然后停止。

硬上限优先级:`--max-rounds` flag > 评审指令自然语言里出现的轮数("最多 5 轮"等) > **内置默认上限 `5`**。
- **解析与归一化**:先得出 `max`(按上述优先级)。`max` 必须是**非负整数**;若解析出负数 / 非整数 / 无法识别的值 → **停止并报参数错误**,不要静默回退默认。再归一化出 `effective_max`:**仅当 `max` 来自 `--max-rounds 0`(flag)** → `effective_max=null`(无上限);否则 `effective_max=max`。**§6/§7 的「到顶」判定一律用 `effective_max`**(避免把 0 误当成"0 轮即终止")。
- **自然语言轮数**:仅当评审指令里出现**明确的"最多/上限 N 轮"(N≥1)**才采纳;模糊措辞("多审几轮")不改默认。**自然语言里的"0 轮"不被接受为"无限"**(反直觉)——"无上限"只能由 flag `--max-rounds 0` 显式表达;自然语言 0 视为非法 → 报参数错误。
- 设计原则:**有界是默认,放开是显式 opt-in**。对抗式复核里 Codex 常不会自然让步、停滞检测也可能不触发(它每轮挖出*新*问题就不算停滞),故默认必须有上限,否则可能无限循环、空烧 Codex 调用。
- **默认 `5` 的定位**:它是**调用预算 / 成本天花板,不是"已充分收敛"的阈值**。到顶产出 UNRESOLVED 只代表"用完预算仍未双 AGREE",**不代表问题已穷尽**——下一轮可能仍在有效推进,故 UNRESOLVED 的裁决建议应据此提示"可调高 `--max-rounds` 继续"。
- 想多谈 → 调高 `--max-rounds`(如 `10`);想彻底放开 → 显式 `--max-rounds 0`(把"无上限"变成主动选择,而非默认)。
- 门禁 / 签核场景:可按需调整,但**切勿用 `--max-rounds 0`**;宁可到顶产出「UNRESOLVED」也不要无限循环。

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
按提供的 JSON Schema 输出全部字段:verdict / remaining_issues / candidate_dispositions / rationale / truncated / reviewed_scope / assumptions。
- `remaining_issues[].id`:每条 issue 一个**稳定短 id**(如 `I1`/`I2`)。**新** issue 自取一个本次评审内唯一的 id;若是续审/重提**增量里已带 id 的点**(见下),**复用原 id**,不要换新。
- `candidate_dispositions`:针对**增量里 Claude 列出的每个 candidate(按其 id)**给出裁定 `{id, disposition}`,`disposition ∈ {confirmed(认可该修订、不再质疑), rejected(仍不接受)}`。**首轮无 candidate 时输出空数组 `[]`**;不得引用未在增量中出现的 id;每个被列出的 candidate 都要给一条(不可遗漏)。`rejected` 的点应同时在 `remaining_issues` 里(用同一 id)给出仍存在的理由。
- `truncated`:若你只看到了材料/改动的一部分(被摘要、截断、或仅 diff 片段),置 true。
- `reviewed_scope`:一句话说明你实际审了什么范围(如「仅 packet 内摘要,未读全量 diff」)。
- `assumptions`:你为得出结论而做的假设(如「假设测试通过」)。
- **范围 gate**:若 `truncated=true` 且被省略的部分对结论是必要证据,**不得给 AGREE**,应给 CHANGES 并说明需要补哪些证据。仅当你确无实质异议、且范围足以支撑结论时才给 AGREE。
```
材料过大时你(Claude)可摘要,但必须在包里**显式标注截断了什么**,并据实让 Codex 在 verdict 里置 `truncated`/`reviewed_scope`。

## 4.5 首轮遗漏检查(仅 `--omission-check`;用法判据见 §1)
**仅当**给了 `--omission-check`、**且为第 1 轮**:在「你的职责」末尾追加**一条**指令(其余轮不追加、不带 flag 时整段跳过):
```
## 额外:首轮遗漏检查(本轮一次性)
在常规复核之外,对照「任务目标」与「待审材料/代码上下文」做一次**遗漏检查**:列出当前主张或材料中
**应被覆盖却缺失/未触及**的点(如未处理的输入域、未声明的前置条件、目标里要求却没落实的项)。
**硬约束**:① 只基于**当前已在场的证据与目标**判断遗漏,**不要预判投机性的二阶/连锁问题**;
② **不要输出任何 completeness 自评分或百分比**;③ 发现的遗漏照常并入 `remaining_issues`(各带稳定 id)。
```
- 设计意图:把"本该首轮就发现的遗漏"前置,验证能否减少后续轮数而**不增噪音/不降质量**。决策靠 `scripts/experiment.mjs` 的配对比较 + 质量优先规则,不靠直觉。
- 边界:此追加**不改变**收敛判定、状态机、度量口径或 §7 输出——只影响第 1 轮喂给 Codex 的 packet 文本。

## 5. dry-run 短路
若有 `--dry-run`:依次打印 ① **参数解析回显**;② 组装好的 packet.txt 全文;③ 下一节将执行的 `codex-round.mjs` 命令行,然后**结束**,不调用 Codex。
- **参数解析回显**(使 §1 的解析对用户可眼检,而非只能信执行者)打印一行:
  `解析结果:effective_max=<n|null> (来源:flag/自然语言/默认) · max-rounds-raw=<原值> · repo=<…|无> · diff=<…|无> · plan=<…|无> · model=<…|默认> · omission-check=<on|off>`
  - `effective_max=null` 表示无上限(仅 `--max-rounds 0` 会得到);来源标明该值取自 `--max-rounds` flag、自然语言「最多 N 轮」还是内置默认 5。
  - 若参数非法(`--max-rounds` 为负/非整数、自然语言「0 轮」等,见 §1),dry-run 同样要**先打印解析错误并停止**:`解析错误:<原因>`,不组装评审包。

## 6. 互审循环
维护 `thread_id`(初始空)、`round=0`、`prev`(上一轮的 issue 摘要,初始空)、`agreed`(**已达成一致清单**,初始空)、`candidate`(**候选共识清单**,初始空)。
- **两级晋升,防止把未经双方确认的点当成"已定结论"**:
  - 当你本轮对某条 issue 作出回应——**采纳并修订(adopted)** 或 **带理由反驳(rebutted)**——该点先进 `candidate`(你已表态,但 Codex 尚未复核)。每条 candidate 记为结构化条目:`{id(稳定,如 C1/C2…), 来源 issue 严重度(blocker/major/minor), response_type(revision|rebuttal), 修订摘要 或 反驳理由, 待 Codex 确认的点}`——**id 跨轮稳定不变**。反驳的 candidate 被 Codex `confirmed`=接受反驳→该点了结(agreed);`rejected`=重申→回 open。
  - **晋升须 Codex 明确确认(用结构化 `candidate_dispositions`,不靠猜)**:在下一轮增量里**逐条列出未决 candidate(带 id)请 Codex 确认**;Codex 在 `candidate_dispositions` 里对每个 id 回 `confirmed` 才晋升到 `agreed`,回 `rejected` 则**退回 `❌`**。**「该 id 这轮没出现在 dispositions 里」不算确认**(按协议 Codex 须覆盖全部,缺失视为协议异常,不得据此晋升)。
  - **可撤销(方向要对)**:若已晋升的 `agreed` 点在后续轮又被 Codex 重新质疑 → 此时双方已重新对峙,**退回 `❌ 仍未达成一致`**(不是退回 candidate);仅当 Claude 再次**回应**(采纳修订或带理由反驳)后,才再次进入 `candidate`。
  - **完整状态机**:`❌` ──(Claude 采纳修订 adopted / 反驳 rebutted)──▶ `🔶 candidate` ──(Codex confirmed)──▶ `✅ agreed`;`🔶` ──(Codex rejected)──▶ `❌`;`✅` ──(Codex 重新质疑)──▶ `❌`;point ──(合并)──▶ `merged`(终态)。任何"消失/沉默"都不构成状态迁移。
- 只有 `agreed`(已确认)才计入 §7 的「✅ 已达成一致」;`candidate` 不算"已定结论"。仅记双方实质都接受的点,勿充数。
- **确定性记账每轮必经 `${CLAUDE_PLUGIN_ROOT}/scripts/review-state.mjs`**(无状态纯函数 helper,CLI 经 bash 调用,stdin JSON→stdout JSON)——不要在散文里手工维护 candidate/agreed,避免漏算/误判。每轮固定管线:**`validate-round`(reduce 前)→ `reduce` → `validate-state`(reduce 后)→ `converge`(判收敛)**;state 在本次循环内于各轮间传递。命令:
  - `validate-round`(在 `reduce` **之前**,对上一轮 state 校验本轮事件协议):disposition 覆盖全部 candidate、不引用未知/非 candidate、confirmed/rejected 与 remaining_issues 一致、adopted 只作用于 open、merge 前置态。**有 error 就先停、按协议异常处理,别带病 reduce。**
  - `reduce`(`{prevState, round}`→新 state):把本轮语义决策(`adopted`/`rebutted`/`candidate_dispositions`/`merges`/`annotations`)施加为状态迁移。
  - `validate-state`(对 reduce 后的新 state):id 唯一、合并图双向 reciprocity 且目标为活跃点(无链/环)等结构不变量。
  - `converge`(`{state, codexVerdict, claudeAgree}`):收敛闸门——candidate / open 非空一律拒(防假 RESOLVED)。
  - `render-unresolved`(`{state, meta}`):出四段块。
  - state 只在本次循环内传递、不持久化(守 §1);语义决策与分歧标注(annotations)仍由你(Claude)给,脚本不自行判断(守 §2)。
  - **每次 CLI 调用都须显式传 state(防漏传清空历史→假收敛,RS-P2-013-R1)**:`reduce`/`validate-round` 必须带 `prevState.points`(**第 1 轮显式传 `{"round":0,"points":[]}`**,不可省略);`converge` 必须带 `state.points` 且 `claudeAgree` 为严格布尔。脚本对缺省/坏输入返回 `{ok:false,error:...}` 而非默认放行。
- **每轮记 P1 度量(`${CLAUDE_PLUGIN_ROOT}/scripts/metrics.mjs`)**:reduce 之后调 `round-metrics`(传 `prevState` + 本轮 `round`〔含你给的语义标签 `revision_induced`/`stuck`〕+ codex-round 输出的 `wall_clock_ms` 与 `attempts`)得本轮记录;循环结束 `aggregate` 汇总(含 `retried_rounds`=发生过重试的轮数)。**汇总时传 `expectedRounds`=本次循环已开始(`round++` 到达)的轮数**:若某轮因 `bad_verdict`/`codex_unavailable` 中断而没产出度量记录,`records.length < expectedRounds` → `complete:false` 且 `total_wall_clock_ms`/`retried_rounds` 归 null,**不拿残缺记录伪装完整成本**(修 MET-ERR-001)。`new/repeat` 由 id 是否在 prevState 出现**确定性判定**;`revision_induced`(⊆new:因上轮修订才出现)/`stuck`(⊆repeat:连续≥2 轮实质未变)由你据实标注。用于"轮次耗在新发现 vs 确认 vs 反复"的数据化复盘(跨 ≥3 个真实任务用 `aggregate-tasks`,各任务 `expectedRounds` 对齐传入)。

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
   - 第 1 轮 stdin 喂完整 packet.txt;第 2 轮起只喂**增量**,增量须含三部分:① 你对上轮每条 issue 的逐条回应;② 修订后的「Claude 当前主张」;③ **所有仍未确认的 `candidate`(带稳定 id)+ 逐条请 Codex 确认/拒绝** —— candidate 持续随每轮增量携带,直到被明确确认、拒绝或撤销。
3. 解析脚本 stdout 的那行 JSON:
   - `error=codex_unavailable` → 告诉用户运行 `/codex:setup`,**停止**。
   - `error=bad_verdict` → 已重试仍失败;把 `raw_message` + `codex_exit` + `stdout_tail`/`stderr_tail`(含 codex 的 error/turn.failed 事件)给用户帮助排查,**停止**。
   - 成功:记下 `thread_id`、`verdict`、`remaining_issues`(含各条 `id`)、`candidate_dispositions`、`truncated`、`reviewed_scope`、`assumptions`、`wall_clock_ms`(本轮交付耗时,含重试)、`attempts`(尝试次数,>1 即有重试)——后两者供 P1 度量。
4. **打印进度行**:`第 N 轮 · Codex=<verdict> · 剩 <k> issue(<b> blocker) · Claude=<同意/持异议>`。
5. 处理:对**每条 open issue**二选一(两者都使该点进 `candidate`、等下一轮 Codex 裁定):
   - **采纳并修订**(`adopted`,response_type=revision):接受该 issue,改你的主张。
   - **带理由反驳**(`rebutted`,response_type=rebuttal):不接受,写下反驳理由。**反驳同样要走 candidate→Codex 裁定**:Codex `confirmed`=接受你的反驳(该点了结→`agreed`),`rejected`=重申(回 `open`)。这保证"反驳成功"的点也能被了结、从而能收敛(否则 open 永挂)。
   - 你给出本轮自己的立场:无任何剩余异议 → Claude=AGREE,否则 Claude=持异议。
6. **双 AGREE 闸门(确认一律靠结构化 `candidate_dispositions`,无隐式确认)**:收敛当且仅当 `Codex.verdict==AGREE` 且 Claude=AGREE 且 **`candidate` 与 `open` 均为空**。
   - 晋升只认 `candidate_dispositions` 里的逐条 `confirmed`;**`verdict=AGREE` 本身不隐式确认任何 candidate**(协议要求 Codex 每轮覆盖全部未决 candidate 的 disposition,故 AGREE 时它们必已被逐条 confirmed,无需"整体确认"这一冲突说法)。
   - 任一 candidate 未被 `confirmed`(被 `rejected` 或未覆盖)→ **不得收敛**;未覆盖属协议异常(`validate-round` 会报),补一轮列全求裁定。杜绝"AGREE 却隐藏未确认项"的假 RESOLVED。
7. **终止条件**(任一即停):
   - 双 AGREE → 收敛成功。
   - `effective_max != null` 且 `round >= effective_max` → **UNRESOLVED**(到顶未收敛)。
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
- 未收敛(硬上限 / 停滞 / 用户打断):打印**结构化 UNRESOLVED 块**,供用户裁决。**必须既展示已达成的共识、也逐条标注未决分歧的类型与影响**,让用户能区分"地基已牢、只差几处"还是"全程在吵",并判断每条卡点要不要现在管:
  ```
  ⚠️ 未收敛(状态:UNRESOLVED · 原因:<到达 max-rounds / 停滞 / 用户打断>)
  评审范围:<最后一轮 reviewed_scope>  ·  关键假设:<assumptions 摘要>
  <若最后一轮 truncated=true,加一行:⚠️ 基于截断材料,下列「已达成一致」均为非完整签核,人工裁决时须复核范围>

  ### ✅ 已达成一致(双方已确认,可视为已定结论)
  <逐条列出 `agreed`(已确认级)清单;Codex 已明确确认的点。若确实一条都没有,写"无——双方自始至终未就任何要点达成一致">

  ### 🔶 待复核确认(Claude 已回应:修订或反驳,Codex 尚未确认 —— 不算定论)
  <逐条列出 `candidate`,每条带:id · 来源严重度[blocker/major/minor] · response_type(修订/反驳)· 修订摘要 或 反驳理由 · 待确认的点。
   这些既非已确认共识、也非仍在对峙的分歧,需用户/下一轮复核确认。
   保留「来源严重度」是为了让用户知道——一条由 blocker 修订而来、却仍待确认的 candidate,其风险不应因转入此段而被埋没。若为空写"无">

  ### ❌ 仍未达成一致
  <对每条未决卡点(两个维度独立标注,勿混);不要把 `candidate` 项重复列进这里:
   · 卡点:<分歧内容>
   · Claude 立场 / Codex 立场:<各自主张,一句话>
   · 状态(解决路径):[固有局限 | 待补工作 | 待裁决分歧]
   · 影响严重度:[blocker | major | minor]  ← 复用 Codex verdict 的严重度口径
   · 影响后果(若不解决):<具体会发生什么>
   · 解决需要:<谁做什么 / 或需用户决策什么>>

  ### 📋 给用户的裁决建议
  <按 影响严重度 排序的下一步;到达 max-rounds 时提示"可调高 `--max-rounds` 继续"(因到顶≠问题已穷尽)>
  ```
  - **状态(解决路径)判定**:`固有局限`=任何方案都绕不开的理论/能力边界;`待补工作`=方向双方都认可、只是本次未纳入并复核的具体工作;`待裁决分歧`=双方仍各持立场的实质争议(方案取舍、事实判断、证据是否充分等),需用户拍板。注意:`固有局限` **不等于可无条件放行**——严重的仍须用户知情决策;放不放行由「影响严重度」决定,不由状态决定。
  - **影响严重度**:统一用 `blocker/major/minor`(与 schema、Codex verdict 同口径),不另立高/中/低。
  - **诚实约束**:`已达成一致` 只写已晋升到 `agreed`(Codex 已确认)的点;Claude 已回应(采纳修订或反驳)但未经 Codex 确认的一律进 `🔶 待复核确认`,不得混入 `✅`。

## 注意
- 只有真的无异议才输出 AGREE;不认同 Codex 就带理由反驳,而非投降。顺从式同意视为失败。
- 临时文件放系统临时目录,用完可留痕便于排查。
- 绝不让 Codex 写文件(脚本已固定 `-s read-only`)。
