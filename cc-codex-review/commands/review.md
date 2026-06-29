---
description: Claude 与 Codex 围绕某项工作循环互审,收敛于双方 AGREE,否则到顶/停滞产出 UNRESOLVED 裁决
argument-hint: '[--repo <dir>] [--diff <file|->] [--plan <file>] [--model <m>] [--max-rounds <n>] [--lens <name>] [--dry-run] <评审指令>'
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
- `--repo <dir>`:Codex 工作根(可读文件、跑 git)。**未给时默认当前目录 `.`**(使 Codex 默认能读本项目),显式给了用给的;§4 评审包与 §6 调用一律带上该生效 repo。若本次是**纯文本/提案评审、不想让 Codex 接触任何 repo**,显式传 `--repo none` 关闭(回到无 repo 的纯文本/diff 评审)。dry-run 回显里 `repo=<给定值|默认 .|none>`。
- `--diff <file|->`:一份 diff;`-` 表示从本对话里用户粘贴的 diff 块取。
- `--plan <file>`:任务目标/规格文件。
- `--model <m>`:传给 Codex 的模型。
- `--max-rounds <n>`:硬上限轮数;`--max-rounds 0` 显式表示**不设上限**(仅靠停滞检测 + 人工兜底)。
- `--lens <name>`:给本次评审套一个**焦点镜头**(默认无 = 通用评审)。**独立、单次、单镜头的 opt-in 功能,不是"P4 v1"、也不是综合签核**;复用全部现有协议(不改收敛/状态机/度量)。预设:
  · `omission` — 第 1 轮一次性"遗漏检查"(见 §4.5)。**已由 P3 实验验证**。
  · `security` / `correctness` / `requirements` — 每轮持续的专项焦点(见 §4.5)。**实验性、未经 P3 验证**(`correctness` 与默认代码 rubric、`requirements` 与「需求/计划门禁」模式有重叠);其增量价值/噪音/生命周期尚未实测,用前知此。
  - **归一化(解析阶段)交确定性脚本 `${CLAUDE_PLUGIN_ROOT}/scripts/lens-parse.mjs`**(纯函数,已单测,见其头注):把本次参数 token 数组作为 stdin JSON `{argv:[...]}` 喂它,取 `effective_lens`(string|null,无镜头=null)。若返回 `ok:false`,按 `error` **报参数错误并停止**(dry-run §5 同):`lens_unknown`(未知 name)/ `lens_conflict`(`--lens` 与 `--omission-check` 同时出现且不一致)/ `lens_missing_name`(`--lens` 缺 name)/ `lens_duplicate`(重复 `--lens`,单次单镜头)。`--omission-check` ≡ `--lens omission`(别名,一致时不报错、归一 omission)由该脚本处理。dry-run(§5)回显 `effective_lens`。**注**:脚本只做这部分确定性归一/报错;判断型规则(⑳ 材料模式过滤、⑲ 每轮重述、㉑/LENS-DECLARE 声明)仍由本 prompt 负责(见 §4.5/§7)。
  - **与材料模式叠加(§「适用模式与边界」优先)**:镜头只在**该材料类型允许的 rubric 内**重排优先级,**不得越界**——对纯文字/提案材料用 `security`/`correctness` 时**剔除代码专属项**(并发/竞态/反序列化/文件进程操作等),只保留对该材料成立的部分;若镜头与材料**完全**不匹配 → **报参数错误**(单一规则,不静默退化为通用评审)。
  - **签核 provenance + AGREE 语义(LENS-SCOPE)**:镜头是"**通用评审 + 额外侧重**",**不缩小签核范围**——双 AGREE 仍是**全面签核**(只是对该视角更用力,不排除其它显见问题)。§7 的声明义务见下「透明性原则(LENS-DECLARE)」。
  - **透明性原则:声明义务绑定"实际侧重"而非 flag(LENS-DECLARE)**:定义本次的**声明侧重角度**=任何使评审偏离"中立全面"的视角侧重,来源有二——① **显式**:`--lens`(= `effective_lens`,触发**完整镜头机制**:§4.5 注入、§6 每轮重述与 experiment `lens` 字段);② **隐性**:即便没给 `--lens`,你(执行者)根据**评审指令自然语言实际侧重了某视角**(如指令说"重点看安全性""审一下这段的安全")。**只要声明侧重角度非空(无论显式还是隐性),§7 结论就必须顶部声明**(格式见 §7),写明"本次额外侧重 X 视角;通过=全面签核,非仅该视角"。**目的:杜绝"隐性带了角度却不声明、被用户误读为中立全面评审"。** 边界:**镜头机制(注入/每轮重述/收敛判定/度量/experiment `lens` 字段)仍只由 `--lens` flag 触发**;隐性侧重**只触发 §7 声明义务**,不改其余协议(若隐性侧重重到需完整镜头机制,应改用显式 `--lens`)。
  - **用法建议(P4 scope-down;基于 P3 实验,**仅 `omission` 经验证**;小样本启发式,非定论)**:镜头是**召回↑ / 精度↓的权衡**——
    · ✅ `omission` 推荐用于**提案 / 设计文档 / 计划评审**(空白多、几乎不增噪音,实测多挖真实遗漏);
    · ⛔ **代码评审默认不套镜头**(omission 镜头在代码上实测会引入少量噪音);需要某专项深度时再点对应镜头(如审安全敏感代码用 `--lens security`,但它仍是实验性、价值未实测)。
    · ⚠️ **成本**:无强制 fan-out、单次调用沿用原预算;但单镜头本身可能比无镜头**略增轮/墙钟**(omission 实测 +52% 墙钟、+1 轮),且**别指望省轮或加速收敛**(它增加"发现"而非"收敛速度")。多镜头 = 多次独立调用,成本近似按次数增长,**各次结论不可组合**(无跨调用去重/冲突裁决/综合 AGREE——那是暂缓的 full-P4)。
  - 实验对照工具:`scripts/experiment.mjs`(无镜头 vs `omission` 镜头 的配对比较 + 质量优先 decide;仅 omission 有数据,其余镜头待实验)。run 记录可带 `lens` 字段以区分不同镜头的数据(LENS-PROVENANCE)。
- `--dry-run`:只组装并打印「评审包」+ 将要执行的命令,**不真正调用 Codex**,然后停止。

硬上限优先级:`--max-rounds` flag > 评审指令自然语言里出现的轮数("最多 5 轮"等) > **内置默认上限 `3`**(质量优先:要的是暴露真问题,不是为收敛而多跑;想深挖再加 flag)。
- **解析与归一化**:先得出 `max`(按上述优先级)。`max` 必须是**非负整数**;若解析出负数 / 非整数 / 无法识别的值 → **停止并报参数错误**,不要静默回退默认。再归一化出 `effective_max`:**仅当 `max` 来自 `--max-rounds 0`(flag)** → `effective_max=null`(无上限);否则 `effective_max=max`。**§6/§7 的「到顶」判定一律用 `effective_max`**(避免把 0 误当成"0 轮即终止")。
- **自然语言轮数**:仅当评审指令里出现**明确的"最多/上限 N 轮"(N≥1)**才采纳;模糊措辞("多审几轮")不改默认。**自然语言里的"0 轮"不被接受为"无限"**(反直觉)——"无上限"只能由 flag `--max-rounds 0` 显式表达;自然语言 0 视为非法 → 报参数错误。
- 设计原则:**有界是默认,放开是显式 opt-in**。对抗式复核里 Codex 常不会自然让步、停滞检测也可能不触发(它每轮挖出*新*问题就不算停滞),故默认必须有上限,否则可能无限循环、空烧 Codex 调用。
- **默认 `3` 的定位**:它是**调用预算 / 成本天花板,不是"已充分收敛"的阈值**(实测多数 1–3 轮即暴露质量大头)。到顶产出 UNRESOLVED 只代表"用完预算仍未双 AGREE",**不代表问题已穷尽**——下一轮可能仍在有效推进,故 UNRESOLVED 的裁决建议应据此提示"可调高 `--max-rounds` 继续"。
- 想多谈 → 调高 `--max-rounds`(如 `10`);想彻底放开 → 显式 `--max-rounds 0`(把"无上限"变成主动选择,而非默认)。
- 门禁 / 签核场景:可按需调整,但**切勿用 `--max-rounds 0`**;宁可到顶产出「UNRESOLVED」也不要无限循环。

## 2. 收集被审材料
- 从本对话中收集用户最近粘贴的材料(执行结果、代码片段、计划、提案等),可多段并标注来源。
- 若给了 `--plan <file>`,读取它;否则用对话里的目标;都没有就**问用户**目标是什么。
- 若给了 `--diff`,读取/取出该 diff 文本。
- 若没有明确的待审对象(无粘贴材料、无 `--diff`/`--plan`,评审指令也没指明要审本 repo 的哪块)→ **停下来问用户要评审什么**,不要猜(默认 `--repo .` 只是给了 Codex 读 repo 的能力,不代表知道要审什么)。
- **载入决策日志基线**:若生效 repo 非 `none`,调
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/decisions-log.mjs" read`(stdin `{"repo":"<生效repo>"}`)读已有决策/未决项作为本轮已知基线(Codex 经 `--repo` 读到 `.cc-codex-review/decisions.md`)。`--repo none`→跳过。文件不存在=空基线。

## 3. 形成你的初版主张
基于 评审指令 + 材料 + 目标(+ repo/diff),写出:结论(通过 / 返工 / 阻止)+ 理由 + 给后续的具体修改建议。

## 4. 组装评审包(写入临时文件 packet.txt)
**固定段(「## 你的职责」+ 全部 schema 字段要求 + 镜头注入)由脚本权威生成,逐字送达 Codex——别手写/复述/压缩职责段**(防固定指令在转述中丢字,见 DESIGN §12 v0.12.5)。你只提供变量段(任务目标 / 待审材料 / 代码上下文 / Claude 主张),用:
```bash
echo '{"taskGoal":"…","materials":"…(或留空=见代码上下文)","codeContext":"…(repo→指示 git 自查 / diff→内联 / 无)","claudeClaim":"…(§3 主张)","lens":"<omission 或 null>","round":1,"lensText":"<可选:focus 镜头经 §4.5 材料过滤后的焦点块全文;omission/无镜头则省略>"}' \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/packet-build.mjs" > /tmp/packet.txt
```
脚本输出即完整 packet.txt(变量段 + 权威「你的职责」+ 镜头注入)。**镜头注入交脚本的边界(LENS-MODE,§4.5)**:`lens:"omission"` 由脚本生成(通用、无材料过滤);**focus 镜头(security/correctness/requirements)含「材料模式过滤」判断,脚本不做**——你按 §4.5 组好(已剔除与材料不符的代码专属项的)焦点块,作为 `lensText` 字段传入脚本逐字放置;若镜头与材料**完全不匹配**→ 按 §1/§4.5 **报参数错误**(不静默退化、不传 `lens`)。生成后结构等价于:
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
- `candidate_dispositions`:针对**增量里 Claude 列出的每个 candidate(按其 id)**给出裁定 `{id, disposition}`,`disposition ∈ {confirmed(认可该修订、不再质疑), rejected(仍不接受)}`。**首轮无 candidate 时输出空数组 `[]`**;不得引用未在增量中出现的 id;每个被列出的 candidate 都要给一条(不可遗漏)。`rejected` 的点须同时在 `remaining_issues` 里(用同一 id)给出仍存在的理由;`confirmed` 的点表示已了结,**通常不必再列进 `remaining_issues`**(它是"仍未解决"清单、非回执清单;但若你仍回显已确认项也无妨——记账以 disposition 为准,confirmed 的回显会被当无害 echo 忽略,见 §6 CONFIRM-ECHO)。
- `truncated`:若你只看到了材料/改动的一部分(被摘要、截断、或仅 diff 片段),置 true。
- `reviewed_scope`:一句话说明你实际审了什么范围(如「仅 packet 内摘要,未读全量 diff」)。
- `assumptions`:你为得出结论而做的假设(如「假设测试通过」)。
- **范围 gate**:若 `truncated=true` 且被省略的部分对结论是必要证据,**不得给 AGREE**,应给 CHANGES 并说明需要补哪些证据。仅当你确无实质异议、且范围足以支撑结论时才给 AGREE。
```
材料过大时你(Claude)可摘要,但必须在包里**显式标注截断了什么**,并据实让 Codex 在 verdict 里置 `truncated`/`reviewed_scope`。

## 4.5 镜头注入(仅 `--lens <name>`;预设与用法判据见 §1)
**仅当 `effective_lens` 非空**(§1 归一化得出,含 `--omission-check` 别名 → `omission`):把该镜头的焦点指令注入「你的职责」。**为空则整段跳过**(通用评审)。镜头只**重排 Codex 的关注优先级**,**不改**收敛判定/状态机/度量口径/§7 输出——只影响喂给 Codex 的 packet 文本。**单次单镜头**(多镜头分多次调用)。注入按 `effective_lens` 分支(不直接看 flag 写法):
- `effective_lens=omission`(**仅第 1 轮、一次性**;其余轮不追加):
  ```
  ## 额外:首轮遗漏检查(本轮一次性)
  在常规复核之外,对照「任务目标」与「待审材料/代码上下文」做一次**遗漏检查**:列出当前主张或材料中
  **应被覆盖却缺失/未触及**的点(如未处理的输入域、未声明的前置条件、目标里要求却没落实的项)。
  **硬约束**:① 只基于**当前已在场的证据与目标**判断遗漏,**不要预判投机性的二阶/连锁问题**;
  ② **不要输出任何 completeness 自评分或百分比**;③ 发现的遗漏照常并入 `remaining_issues`(各带稳定 id)。
  ```
- `effective_lens ∈ {security, correctness, requirements}`(**每轮持续**,作为该轮复核的优先焦点,追加到「你的职责」末尾):
  ```
  ## 焦点镜头:<lens>
  本次评审请**优先**从「<lens>」视角审查,但**不得降低其它 rubric 的覆盖标准**(仍执行完整通用评审,只是额外侧重该视角;故 AGREE 仍是全面签核):
  · security:攻击面、输入信任与校验、鉴权/越权、机密泄露、注入/反序列化、不安全的文件/进程/网络操作。
  · correctness:逻辑正确性、边界/极端用例、错误与异常处理、并发/竞态、状态不变量。
  · requirements:是否覆盖「任务目标」/规格、缺失或不可验证的需求、未声明的依赖与前置。
  (只注入所选 lens 对应的那一条。)仍按 JSON Schema 输出全部字段;发现并入 `remaining_issues`(各带稳定 id)。
  ```
- **生命周期(LENS-LIFECYCLE)**:`omission` 仅第 1 轮一次;持续型镜头(security/correctness/requirements)须在**每轮增量(§6)里也重述「## 焦点镜头」头**,不能只依赖 resume 上下文带过。
- **材料模式过滤(LENS-MODE)**:注入前按 §「适用模式与边界」剔除与材料类型不符的项(如对提案材料剔除 security/correctness 里的并发/反序列化/文件进程等代码专属项);材料**完全**不匹配 → **报参数错误**(单一规则,不静默退化)。
- **AGREE 语义(LENS-SCOPE)**:镜头是"**通用评审 + 额外侧重**"——`不排除其它显见问题`,故双 AGREE 仍是**全面签核**(只是对该视角更用力),**不**缩小为"仅该视角通过"。§7 的镜头标注只是记录所用焦点,非降级签核范围。
- 设计意图(P4 scope-down,见 DESIGN §12):镜头 = 可选 rubric 焦点。**仅 `omission` 经 P3 验证**(换 rubric → 发现不同真问题,omission 镜头曾挖出默认视角漏掉的 blocker);security/correctness/requirements 为**由此外推的实验性预设、尚未实测**。并行多 lens + 聚合引擎(原 P4 愿景)因 4x 成本 + 聚合/冲突/状态/收敛未定义 + 价值未证而**继续暂缓**。

## 5. dry-run 短路
若有 `--dry-run`:依次打印 ① **参数解析回显**;② 组装好的 packet.txt 全文;③ 下一节将执行的 `codex-round.mjs` 命令行,然后**结束**,不调用 Codex。
- **参数解析回显**(使 §1 的解析对用户可眼检,而非只能信执行者)打印一行:
  `解析结果:effective_max=<n|null> (来源:flag/自然语言/默认) · max-rounds-raw=<原值> · repo=<…|无> · diff=<…|无> · plan=<…|无> · model=<…|默认> · effective_lens=<name|无>`
  - 归一化(§1)后回显 `effective_lens`(`--omission-check` 归一为 `omission`)。若 `--lens` 未知 name / `--lens`+`--omission-check` 冲突 / 镜头与材料完全不匹配 → dry-run **先打印解析错误并停止**:`解析错误:<原因>`。
  - `effective_max=null` 表示无上限(仅 `--max-rounds 0` 会得到);来源标明该值取自 `--max-rounds` flag、自然语言「最多 N 轮」还是内置默认 3。
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
  - **CONFIRM-ECHO 已下沉为脚本保证(v0.12.5,无需手动归一)**:Codex 在 AGREE 轮**常把已 `confirmed` 的点又回显进 `remaining_issues`**(措辞如"确认 major",意为确认而非重提)。这是 Codex 稳定习性,**但 `review-state.mjs` 现已原生容忍**——本轮被 `confirmed` 的 id 若同时出现在 `remaining_issues`,validate-round 不再判矛盾、reduce 当无害 echo 忽略(disposition 为准、该点保持 agreed 不被打回 open)。**故你可把 Codex 输出的 `remaining_issues` 原样喂 `validate-round`/`reduce`,不必再手动删除已确认项**。唯一例外:若 Codex 是**真的改判**(给 `disposition:rejected` 或明说"撤回确认/仍不接受"),那就按真异议处理(它本就该走 rejected + 留在 remaining_issues),非 echo。
  - `validate-round`(在 `reduce` **之前**,对上一轮 state 校验本轮事件协议):disposition 覆盖全部 candidate、不引用未知/非 candidate、confirmed/rejected 与 remaining_issues 一致、adopted 只作用于 open、merge 前置态。**有 error 就先停、按协议异常处理,别带病 reduce。**
  - `reduce`(`{prevState, round}`→新 state):把本轮语义决策(`adopted`/`rebutted`/`candidate_dispositions`/`merges`/`annotations`)施加为状态迁移。
  - `validate-state`(对 reduce 后的新 state):id 唯一、合并图双向 reciprocity 且目标为活跃点(无链/环)等结构不变量。
  - `converge`(`{state, codexVerdict, claudeAgree}`):收敛闸门——candidate / open 非空一律拒(防假 RESOLVED)。
  - `render-unresolved`(`{state, meta}`):出四段块。
  - state 只在本次循环内传递、不持久化(守 §1);语义决策与分歧标注(annotations)仍由你(Claude)给,脚本不自行判断(守 §2)。
  - **每次 CLI 调用都须显式传 state(防漏传清空历史→假收敛,RS-P2-013-R1)**:`reduce`/`validate-round` 必须带 `prevState.points`(**第 1 轮显式传 `{"round":0,"points":[]}`**,不可省略);`converge` 必须带 `state.points` 且 `claudeAgree` 为严格布尔。脚本对缺省/坏输入返回 `{ok:false,error:...}` 而非默认放行。
- **收敛诚实性独立审计(①「运动员兼裁判」缓解,`${CLAUDE_PLUGIN_ROOT}/scripts/review-audit.mjs`)**:`converge` 虽确定性,但它吃的是**你转述的**每轮 Codex 字段;为让"收敛是否诚实"可独立核验——
  - **每轮 codex-round 用独立 `--out` 文件**(如 `/tmp/cc-r1.json`、`/tmp/cc-r2.json`,**不要覆盖**),并从其成功输出记下 `out_path` + `out_sha256`。
  - 维护一份 **audit manifest**:`{claudeAgree:<bool>, rounds:[{round_index:<1-based 连续>, codex_out:"<rN.json 路径>", codex_out_sha256:"<该轮 64 hex 哈希,必填>", claude_actions:{adopted,rebutted,merges,annotations}}]}`——**manifest 只放你自己的动作,绝不放你转述的 Codex verdict/disposition/issues**(那些审计器只从 raw 文件读)。
  - **收敛前必过审计门**:把 manifest 喂 `review-audit`,仅当回 `audited_converged:true` 才可在 §7 宣布 RESOLVED;否则(`audited_converged:false` 或 `evidence_invalid`)**不得宣布 RESOLVED**,按未收敛/证据无效处理并把 `failures`/`reasons` 告诉用户。
  - **诚实边界**:这是**插件层、提高门槛**(把"信你转述"降为"从 Codex 真实产出独立重放"),非防恶意硬强制——你仍可跳过审计/篡改文件/在 final 谎称通过;真硬强制需 hook(后续档)。但默认流程跑了它,假收敛就需要主动造假而非随手发生。
- **每轮记 P1 度量(`${CLAUDE_PLUGIN_ROOT}/scripts/metrics.mjs`)**:reduce 之后调 `round-metrics`(传 `prevState` + 本轮 `round`〔含你给的语义标签 `revision_induced`/`stuck`〕+ codex-round 输出的 `wall_clock_ms` 与 `attempts`)得本轮记录;循环结束 `aggregate` 汇总(含 `retried_rounds`=发生过重试的轮数)。**汇总时传 `expectedRounds`=本次循环已开始(`round++` 到达)的轮数**:若某轮因 `bad_verdict`/`codex_unavailable` 中断而没产出度量记录,`records.length < expectedRounds` → `complete:false` 且 `total_wall_clock_ms`/`retried_rounds` 归 null,**不拿残缺记录伪装完整成本**(修 MET-ERR-001)。`new/repeat` 由 id 是否在 prevState 出现**确定性判定**;`revision_induced`(⊆new:因上轮修订才出现)/`stuck`(⊆repeat:连续≥2 轮实质未变)由你据实标注。用于"轮次耗在新发现 vs 确认 vs 反复"的数据化复盘(跨 ≥3 个真实任务用 `aggregate-tasks`,各任务 `expectedRounds` 对齐传入)。**若套了镜头**,在 experiment run 记录里带 `lens=<effective_lens>`(LENS-PROVENANCE),使不同镜头的数据可区分、可同镜头比较。
- **Codex 调用核对(软信号,`${CLAUDE_PLUGIN_ROOT}/scripts/verify-codex-session.mjs`)**:每轮 codex-round 返回的 `thread_id` 累积;收尾**尽量**把它们作 stdin `{threadIds:[...]}` 喂 verify-codex-session(查 `~/.codex/sessions`),把 `verified/missing` 附在 §7 供人工留意。**⚠️ 这是软信号、不是硬门禁**:`missing` **不挡收敛、不直接判不可信**——机制本就可绕(故不做硬门禁,见 DESIGN §12),真正的强制需 hook。但现版本 codex **落盘可靠**(早期一次 missing 系升级窗口瞬态),故 `missing` **值得人工当回事**:提示"未能从 session 核实,请人工留意";`verified` 是"真调了 Codex"的证据。
- **写回决策日志(见 `docs/specs/2026-06-27-decision-log-design.md`)**:收尾时把本轮结论落进 `.cc-codex-review/decisions.{jsonl,md}`,供后续轮 Codex 经 `--repo` 读到——
  - **entry 必填字段**(脚本会校验,缺则报 `坏 source`/`statement 缺失` 拒写):`source:"review"`、`statement:"<决策或分歧一句话>"`、`status`、`rationale`(decided 必填);**`id`/`ts` 由脚本自动分配,不要自己传**(传了也被忽略);严重度用 `severity` 字段、勿塞进 rationale 文本。
  - **UNRESOLVED 三段映射**:✅ 已达成→`{op:"append",entry:{source:"review",statement:"…",status:"decided",rationale:"…",severity:"major"}}`;❌ 仍未达成→`{op:"append",entry:{source:"review",statement:"…",status:"open",positions:{claude:"…",codex:"…"},severity:"major"}}`;🔶 待复核**先不写**。RESOLVED(双 AGREE)则把商定结论作 `decided` 写入。
  - **某条之前是 `open`、本轮谈拢了**:用 `{op:"set-status",id:旧open_id,status:"decided",rationale:"..."}` **原地翻**(带 rationale,不堆条);旧决策被不同新决策推翻→append + `supersedes:[旧id]`(旧条渲染时自动隐藏)。
  - **退役一条不再适用的决策**(功能删除 / 被并入更大规则,**无具体替换**):`{op:"set-status",id,status:"closed",rationale:"退役理由"}` → 从活跃基线隐藏、仅留 jsonl 历史。**注意**:`closed` 仅用于"不再是活跃约束";**已实现但仍须遵守的约束保持 `decided` 别 closed**(隐藏会让后续 Codex 看不到、可能回归)。
  - **先让 Codex 确认记录无误**(放进本轮最后一个 packet:decided 确实达成、open 立场记对了),确认后调 `node "${CLAUDE_PLUGIN_ROOT}/scripts/decisions-log.mjs" upsert`(stdin `{"repo":"<生效repo>","ops":[...]}`)。
  - **`--repo none` → 跳过写回**(纯文本评审,无 repo);脚本报错则如实告诉用户、不阻断结论。
  - **不自动 `git commit`**;可提示用户决策已记录、自行提交。

每轮:
1. `round++`。
2. 调用辅助脚本(第 1 轮 fresh,无 `--resume`;第 2 轮起带 `--resume <thread_id>`):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-round.mjs" \
     --schema "${CLAUDE_PLUGIN_ROOT}/schemas/verdict.schema.json" \
     --out "<本轮独立文件,如 /tmp/cc-r${round}.json;勿覆盖上一轮>" \
     [--repo <dir>] [--model <m>] [--resume <thread_id>] \
     < <packet 或增量文件>
   ```
   - 第 1 轮 stdin 喂完整 packet.txt;第 2 轮起只喂**增量**,增量须含:① 你对上轮每条 issue 的逐条回应;② 修订后的「Claude 当前主张」;③ **所有仍未确认的 `candidate`(带稳定 id)+ 逐条请 Codex 确认/拒绝** —— candidate 持续随每轮增量携带,直到被明确确认、拒绝或撤销;④ **若 `effective_lens` 是持续型镜头(security/correctness/requirements),重述 §4.5 的「## 焦点镜头」头**(不能只靠 resume 带过,LENS-LIFECYCLE)。
3. 解析脚本 stdout 的那行 JSON:
   - `error=codex_unavailable` → 告诉用户运行 `/codex:setup`,**停止**。
   - `error=bad_verdict` → 已重试仍失败;把 `raw_message` + `codex_exit` + `stdout_tail`/`stderr_tail`(含 codex 的 error/turn.failed 事件)给用户帮助排查,**停止**。
   - 成功:记下 `thread_id`、`verdict`、`remaining_issues`(含各条 `id`)、`candidate_dispositions`、`truncated`、`reviewed_scope`、`assumptions`、`wall_clock_ms`(本轮交付耗时,含重试)、`attempts`(尝试次数,>1 即有重试)、**`out_path` + `out_sha256`(供审计 manifest;见上「收敛诚实性独立审计」)**——wall_clock/attempts 供 P1 度量。同时把本轮一条 `{round_index:<本轮序号>, codex_out:<out_path>, codex_out_sha256:<out_sha256>, claude_actions:{adopted,rebutted,merges,annotations}}` 追加进 audit manifest(`round_index` 须 1-based 连续、`sha256` 必填)。
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
  **前置硬条件:必须先过 §6 的收敛诚实性独立审计**(`review-audit` 回 `audited_converged:true`)才能宣布 RESOLVED;并在结论里附一行 `独立重放审计:通过(N 轮,raw --out 重放)` 作可信佐证。审计未过则走下面的未收敛分支、不得宣布 RESOLVED。
  若最后一轮 `truncated=true`,**必须**在结论顶部加一行 `⚠️ 基于截断材料(reviewed_scope: ...),非完整签核`,避免被误读为全量通过。
  **若本次有声明侧重角度(`effective_lens` 非空,*或*你据评审指令实际侧重了某视角,见 §1 LENS-DECLARE),必须**在结论顶部加一行 `本次侧重:<角度>(额外侧重此视角;通过=全面签核,非仅该视角)`(**无显式 `--lens` 的隐性侧重也要声明**;LENS-DECLARE/LENS-SCOPE)。
  **尽量**在结论里附:本次 codex `thread_id` + verify-codex-session 的 `verified`/`missing`(软信号供人工核),并把 `paths` 里每个 verified id 的 **rollout 文件路径**一并列出(便于用户一键打开 codex 自留的完整对话记录)。**`missing` 不直接判不可信、不挡 RESOLVED**(机制可绕、不做硬门禁),但现版本 codex 落盘可靠,故 `missing` 值得人工当回事——提示"未能从 session 核实,请人工留意";`verified` 则佐证真调了 Codex。
- 未收敛(硬上限 / 停滞 / 用户打断):打印**结构化 UNRESOLVED 块**,供用户裁决。**必须既展示已达成的共识、也逐条标注未决分歧的类型与影响**,让用户能区分"地基已牢、只差几处"还是"全程在吵",并判断每条卡点要不要现在管:
  ```
  ⚠️ 未收敛(状态:UNRESOLVED · 原因:<到达 max-rounds / 停滞 / 用户打断>)
  <若本次有声明侧重角度(effective_lens 非空,*或*据指令的隐性侧重,见 §1 LENS-DECLARE):加一行 `本次侧重:<角度>(额外侧重此视角;不缩小签核范围,非仅该视角)`>
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
- 绝不让 Codex 通过**模型生成的命令(shell/apply_patch)**写文件:脚本全程强制只读 —— fresh 轮 `-s read-only`,resume 轮 `-c sandbox_mode="read-only"`(实测 resume **不继承** fresh 的只读、会回落到可写沙箱,故须显式重申;CR-SEC-001)。该"绝不能写"的精确范围与信任边界(用户自配 MCP/hooks/apps 不在沙箱治理内、属显式信任边界)见 DESIGN §「只读不变量的精确范围与信任边界」。
