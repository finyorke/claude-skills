# cc-codex-review — Claude × Codex 收敛互审插件 设计文档

- 日期: 2026-06-02
- 状态: 设计已批准 (待写实现计划)
- 归属市场: `fun-plugins` (`finyorke/claude-skills`)

## 1. 目标

提供一个通用能力:**Claude 与 Codex 围绕某项工作循环互审,收敛于双方达成一致(AGREE);未收敛(到顶/停滞)则产出结构化 UNRESOLVED 交人工裁决。**

### 核心抽象

> Claude(当前会话)对某项工作形成主张;Codex 对抗式复核该主张;两方迭代修订,收敛于都 AGREE 则输出结论,未收敛则到顶/停滞产出 UNRESOLVED。

这是一个**通用的「Claude × Codex 收敛互审」协议**,不关心被审材料从哪来——它可以是一份计划、一段代码 diff、某个执行结果、一份草案或提案。

插件的价值在于**固化互审协议**(AGREE 契约、Codex 调用方式、停滞检测、对抗框架),而**不固化输入约定**——被审材料由 Claude 从指令 + 当前对话临场组装成「评审包」。因此「有 / 无代码仓库」「单份 / 多份材料 / 无材料」都无需特判。

### 典型用法场景(举例,非定义)

下列场景共用同一套互审协议,区别只在「被审材料」与「评审指令」不同。插件本身不假设任何特定工作流。

1. **跨会话结果把关(中转复核)**
   用户在另一个会话里执行任务、把执行结果贴进当前 Claude 会话。用本命令让 Claude 与 Codex 反复推敲「该结果是否达标、能否进入下一步」,收敛后据此指导后续执行。插件不假设这样的外部会话存在。

2. **新任务的需求节点门禁(milestone gating)**
   Claude 从头实现一个新任务,在每个需求节点 / 里程碑停下来,调本命令让 Codex 复核「当前实现是否完整覆盖了该节点的需求、有没有遗漏的边界、是否潜藏 bug」。双方 AGREE 才进入下一节点 —— 把「需求不完整 / 实现有 bug」挡在早期,而不是攒到最后。

3. **修 bug 时的互审**
   修复缺陷的过程中,Claude 提出「根因诊断 + 修复方案」,Codex 对抗式质疑:根因找对了吗?这个修法会不会引入回归?有没有更小 / 更稳的改法?边界用例覆盖了吗?两方迭代到对「诊断 + 修复」都 AGREE,再落地。

4. **实现前的方案 / 计划评审**
   写代码之前,Claude 先产出设计 / 实现计划,用本命令让 Codex 在动工前对抗式审一遍 —— 路径选型、取舍、假设是否成立。早期分歧在计划阶段消化,避免返工。

5. **提交 / diff 前的签核**
   一段改动提交前,Claude 给出自评结论,Codex 复核 `--diff` 或 `--repo` 工作区改动,双方 AGREE 视为「可以提交」的二人复核门禁。

### 非目标 (YAGNI)

- 不编排外部会话、不替用户在多个会话间中转。本插件只负责「当前 Claude × Codex」这一段互审。
- 不做跨轮 / 跨会话的有状态编排器(多版本追踪、收敛历史持久化)。一次互审循环内,Codex 通过 `resume` 保持跨轮记忆(见 §6),但循环结束即弃,不跨命令调用持久化。
- 不让 Codex 改代码(复核专用,只读)。

## 2. 角色与机制

- **Claude** = 当前 Claude Code 会话,互审循环的**驱动方 / 主张方**。「修订主张」本质是 Claude 的智能判断,纯脚本做不了,故必须由 Claude 驱动循环。
- **Codex** = 通过 `codex exec` 调用,对抗式**复核方**,只读。
- 交付物 = 一个 Claude Code 插件,提供一个 **command**(命令体即 Claude 执行的互审协议)。

### 为什么是 command 而非 skill

触发形态是 `/cc-codex-review "<提示词>"`,提示词作为参数传入。command 才有 `$ARGUMENTS`;skill 不吃位置参数。与已安装的 openai codex 插件(`commands/review.md` → `/codex:review`)形态一致。

### 为什么用 `codex exec` 而非 `/codex:review`

`/codex:review`、`/codex:adversarial-review` 都基于 **git diff** 做代码审查,审的是代码改动,不适配「复核一段主张(任意文本)」。`codex exec` 是非交互、文本进文本出的通用原语,正适合喂自定义「评审包」。

## 3. 命令接口

```
/cc-codex-review[:review] [--repo <dir>] [--diff <file|->] [--plan <file>] \
                          [--model <m>] [--max-rounds <n>] [--lens <name>] <评审指令>
```

- 全部 flag 可选。**位置参数 = 评审指令**(例:"看一下这份计划,有什么意见,能不能进入下一步")。
- **被审材料**(0 / 1 / 多份)由 Claude 从当前对话(用户粘贴的)+ 指令中提到的文件收集。
- `--repo <dir>`:Codex 以该目录为工作根、只读运行,可用 `git log/diff`、读文件。
- `--diff <file|->`:把一份 diff 作为文本放进评审包(「不接仓库、只看 diff」场景);`-` 表示读用户粘贴的 diff 块。
- `--plan <file>`:任务目标 / 规格文件路径;不给则用对话里的目标,或 Claude 问用户一次。
- `--model <m>`:传给 `codex -m`;不给用 codex 默认。
- `--max-rounds <n>`:硬上限轮数(精确控制);`--max-rounds 0` 显式表示不设上限。
- `--lens <name>`(P4 scope-down,见 §12):可选焦点镜头,单次单镜头、opt-in、复用全部现有协议。`omission`(已验证)/ `security`/`correctness`/`requirements`(实验性)。`--omission-check` 为 `--lens omission` 别名。镜头=通用评审+额外侧重,AGREE 仍是全面签核。

**配套命令 `extract-reqs`(需求提取,v0.9.0,见 §12 / `docs/specs/2026-06-12-extract-reqs-design.md`)**:`/cc-codex-review:extract-reqs [界定指令] [--out <path>]` —— 从当前会话提取**经用户背书的需求(纯 WHAT)**,按"是否经用户背书"分三档(纳入①用户直述 / ②Claude 提议+用户明确同意 · 待定③未表态 · 排除④Claude 单方设计)+ fail-closed 硬规则(②无用户明确同意原话→降级③)+ 用户确认,产出「用户认证需求」文件;再 `review --plan <该文件>` 即以**用户认证需求**(而非 Claude 单方转述)为评审基准。`[界定指令]` 可选,缺省时主动归纳范围、多块/模糊先问。

**配套命令 `do`(协作执行,v0.10.0,见 §12 / `docs/specs/2026-06-19-collaborative-commands-design.md`)**:`/cc-codex-review:do <任务> [--repo <dir>] [--max-rounds <n>]` —— 你给任务(问答/动手,如「建 111.txt」「做个人主页」),Claude 动手做、Codex 只读协作把关;**复杂任务**双方各自独立出方案→对抗到统一(默认 3 轮,消除锚定),**琐碎任务**直接做+复核。Codex 全程只读、动手只由 Claude。

### 硬上限优先级

`--max-rounds` flag > 指令自然语言("最多 5 轮"由 Claude 解析) > **内置默认上限 `5`**。

**为何要内置默认(而非默认无上限)**:对抗式复核中 Codex 常不会自然让步,而停滞检测靠模型判断、未必可靠——它每轮挖出*新*问题就不算停滞。dogfood 实测见过 4 轮每轮都提出真·新 issue、停滞检测从不触发的情形;若无默认上限,这类深度分歧会无限循环、空烧 Codex 调用。原则:**有界是默认,放开(`--max-rounds 0`)是显式 opt-in**。门禁场景切勿用 `0`。

**默认 `5` 的定位与归一化**:`5` 是**调用预算 / 成本天花板,不是"收敛充分"阈值**——到顶 UNRESOLVED 只表示"用完预算仍未双 AGREE",不代表问题已穷尽(故裁决建议提示可调高继续)。归一化:`max` 须非负整数,否则报参数错误;**仅 flag `--max-rounds 0`** → `effective_max=null`(无限),自然语言"0 轮"视为非法;到顶判定统一用 `effective_max`。详见 `commands/review.md` §1。

## 4. 互审循环协议 (Claude 遵循)

1. **Claude 形成初版主张**:基于 指令 + 被审材料 + 目标(+ repo/diff),写出判断 —— 结论(通过 / 返工 / 阻止)+ 理由 + 具体修改建议。
2. **组装评审包**(结构化文本,见 §5)。
3. **调用 Codex**(见 §6),Codex 返回结构化 verdict JSON。
4. **Claude 处理 Codex 的回应**:
   - 若 `CHANGES`:Claude 对**每条 issue** 要么**采纳并修订主张**,要么**带理由反驳**;更新主张;给出本轮自己的 verdict。
   - 若 `AGREE`:Claude 检查自己是否也已无异议。
   - **每轮打印一行进度**:`第 N 轮 · Codex=CHANGES · 剩 3 issue(1 blocker) · Claude=持异议`,让用户能看着进度决定是否打断(无硬上限时这是人工兜底的前提)。
5. **双 AGREE 闸门**:**仅当 `Codex.verdict == AGREE` 且 Claude 主动确认无异议 且 candidate 与 open 均空**才结束循环。晋升**一律靠结构化 `candidate_dispositions` 的逐条 `confirmed`,verdict=AGREE 本身不隐式确认任何 candidate**(协议要求 Codex 每轮覆盖全部未决 candidate 的 disposition,故 AGREE 时它们必已被逐条 confirmed)。任一 candidate 未被 confirmed(rejected 或未覆盖)→ 不得收敛,杜绝假收敛。
6. **终止条件**(任一):
   - 双 AGREE → 收敛成功。
   - 达到硬上限(默认 5,可由 `--max-rounds` 调整;`0`=不设)→ 未收敛,交人工裁决。
   - **停滞检测**:某轮 Claude 主张 + Codex 的 issue 与上一轮**实质无变化**(同样未决分歧原地重复)→ 暂停,交人工裁决。
   - 用户手动打断(当前会话是交互式,人即兜底)。
   - 循环中 Claude 维护两级共识与状态机:`❌`──(Claude **采纳修订 adopted 或 带理由反驳 rebutted**)──▶`🔶 candidate`──(Codex confirmed)──▶`✅ agreed`;`🔶`──(Codex rejected)──▶`❌`;`✅`──(Codex 重新质疑)──▶`❌`(对峙,**非**退回 candidate);point──(合并)──▶`merged`(终态)。"消失/沉默"不构成迁移。供未收敛时如实展示收敛成果,且不把未确认的当定论。
7. **输出**:收敛后 Claude 打印 `✅ 收敛结论` 块:商定的结论 + 后续行动的具体建议。
   未收敛时打印**结构化 UNRESOLVED 块**,顶部标注「评审范围(reviewed_scope)+ 关键假设(assumptions)」,最后一轮 `truncated=true` 时加非完整签核警告;主体含四段:
   - `✅ 已达成一致`:`agreed`(Codex 已确认)清单。
   - `🔶 待复核确认`:`candidate`(Claude 已回应:修订或反驳、Codex 未确认)清单 —— 既非定论也非对峙分歧。
   - `❌ 仍未达成一致`:每条卡点用**两个正交维度**标注 —— `状态`[固有局限 | 待补工作 | 待裁决分歧] + `影响严重度`[blocker | major | minor,复用 verdict 口径],外加影响后果 + 解决需要。
   - `📋 裁决建议`:按影响严重度排序;到顶时提示「到顶 ≠ 问题已穷尽,可调高 `--max-rounds` 继续」。
   目的:让用户区分"地基已牢只差几处"与"全程在吵",并判断每条卡点的轻重缓急。诚实约束:`✅` 只列 Codex 已确认的点,Claude 已回应未确认的进 `🔶`。

## 5. 评审包结构

Claude 组装如下文本,经 stdin 喂给 `codex exec`:

```
## 任务目标
<目标 / 规格文件内容,或文件引用,或对话里的目标>

## 待审材料
<被审材料;可多段标注来源;或 "见下方 git diff / 代码上下文">

## 代码上下文
<二选一:
 - 指示 Codex 在工作根运行 git log -n / git diff 自行查看;或
 - 内联 diff 文本(--diff 模式)>

## Claude 当前主张
<Claude 的判断 + 理由 + 修改建议>

## 你的职责
<对抗式复核指令 + AGREE 契约,见 §7>
```

过大时 Claude 摘要材料,并**显式说明截断了什么**(不静默截断)。

仅**第 1 轮**发送上述完整评审包;第 2 轮起借助 `resume`(§6)只发增量。增量含三部分:① 对上轮各 issue 的逐条回应;② 修订后的「Claude 当前主张」;③ **所有仍未确认的 `candidate`(带稳定 id)+ 逐条请 Codex 确认/拒绝**(candidate 随每轮增量持续携带,直到被明确确认、拒绝或撤销,确保「晋升须明确确认」可落地)。

## 6. Codex 调用细节

```bash
codex exec \
  --json \
  -s read-only \
  [--cd <repo>] [--skip-git-repo-check] \
  [-m <model>] \
  --output-schema <verdict.schema.json> \
  -o <last.json> \
  "<对抗复核指令>"  < packet.txt
```

- `-s read-only`:只读沙箱 —— Codex 能读文件、跑 git,但其**模型生成的命令绝不能写**(复核专用,安全;"绝不能写"的精确范围见下「只读不变量的精确范围与信任边界」)。fresh 轮用 `-s read-only`;`codex exec resume` 不接受 `-s`。⚠️ **实测(0.135.0):resume 并不继承 fresh 的 read-only,会回落到默认可写沙箱**(CR-SEC-001,§12),故 resume 必须用 `-c sandbox_mode="read-only"` 显式重申只读 —— 否则第 2+ 轮 Codex 可写文件,违反"绝不能写"的硬不变量。
- `--cd <repo>`:`--repo` 给定时设为工作根。**仅 fresh 轮传**;resume 不接受 `--cd`,工作目录从原 session 继承(cwd 继承未单独实测;**沙箱则不继承**,见 §12 CR-SEC-001)。
- **只读不变量的精确范围与信任边界(规范性,CR-SEC-CONFIG-SIDECHANNELS)**:本文档/本工具中所有 "Codex 只读 / 绝不能写文件" 的表述,**一律特指 Codex 模型生成的命令(shell / `apply_patch`)经沙箱治理的写操作**;下面是该不变量的**完整范围声明**,其它各处的简写均以此为准、不另作更宽的承诺。
  - **沙箱治理范围内(强制只读,已实测)**:Codex 模型生成的 shell / `apply_patch` 写。本工具在**两轮**调用都强制三道闸:
    1. **OS 沙箱**:fresh `-s read-only` / resume `-c sandbox_mode="read-only"`(实测写入阻断;且实测 CLI flag **覆盖**用户 config.toml 的 `sandbox_mode`,即对宿主 config 具权威性)。
    2. **`-c approval_policy="never"`**:关掉"审批升级写路径"——read-only 下被拒的写命令若 approval 允许升级,理论上可被批准后无沙箱重试落盘;实测(0.135.0 非交互 exec)即便 `on-failure` 升级也"unavailable",但显式 `never` 使保证不依赖用户 config 默认/未来变更。
    3. **`--ignore-rules`**:不加载用户/项目 execpolicy `.rules`。官方语义中 rule `decision="allow"` 可让命令"免提示、在沙箱外运行";作为只读复核方,绝不应让宿主 ambient `.rules` 放宽复核牢笼,故忽略全部 `.rules`,令 `-s read-only` 成为唯一权威上界。(诚实标注:默认安装无 `.rules`、实测写入本就被阻断;构造 allow-rule 复现逃逸所需的 `.rules` 格式未在本机现成可得,故**未实测逃逸本身**,改以"忽略 ambient rules"防御性关闭该问题——无论 allow 是否真能逾越 `-s`,本工具调用下该路径都不可达。)
  - **沙箱治理范围外(显式信任边界,非本工具收紧)**:用户自有 `~/.codex/config.toml` 配置的 MCP server / hooks / apps 等"副作用工具"——它们不经命令沙箱治理。按设计视为**用户可信**(在用户本机、由用户自行配置、其安全责任归用户);本工具**有意不**用 `--ignore-user-config`(会破坏 auth 与模型默认配置);`approval_policy` 则**已显式锁为 `never`**(见上,杜绝升级写路径)。**若用户自行配置了具备写能力的 MCP/hooks/apps,该写能力不在本不变量保证内**。
  - **不在保证内、本工具也不主张的**:Codex 的网络访问按 codex 自身默认治理(本工具不声称网络隔离);harness(本脚本)对其自身 `--out` 临时产物的写/删属设计内行为,`--out` 为可信内部参数(见 CR-SEC-OUT-PATH,非"Codex 写文件"事件)。
  - 一句话:**对 Codex 自身命令执行的 "绝不能写" = 在上述范围内完整且两轮一致;范围外项均为已声明的信任边界,不被本不变量覆盖。**
- `--skip-git-repo-check`:**两种轮次都传**(exec 与 exec resume 都接受)。这样非 git 的 `--repo` 目录也能跑(退化为文本评审),与 §8 一致。
- `--output-schema` + `-o`:Codex 输出结构化 verdict,AGREE 判定可靠(不靠字符串匹配)。`-o` 写入最终消息文件,便于捕获。**每次调用前都会先删除该文件**,避免读到上一轮残留 → 假成功。
- `-m <model>`:`--model` 给定时传入。
- 失败(跑了但没产出合法 verdict)时,`bad_verdict` 结果带 `codex_exit` + `stdout_tail`/`stderr_tail`(codex 把 API 级错误写进 stdout 的 `error`/`turn.failed` 事件,不在 stderr),便于排查。

### 跨轮记忆:resume by id(防不收敛 + 防串会话)

Codex 是对抗式的,若每轮失忆重读,可能反复重提已被说服的点而**永不收敛**(尤其 `--max-rounds 0` 放开上限时)。故循环内让 Codex 保持立场记忆:

- **第 1 轮**:fresh `codex exec --json ...`,发送完整评审包。从 stdout **第一行** `{"type":"thread.started","thread_id":"<UUID>"}` 解析并保存 `thread_id`(不可用 `--ephemeral`,否则无法 resume)。
- **第 2 轮起**:`codex exec resume <thread_id> ...` 按 **id** 续接,只发**增量**(逐条回应 + 修订后主张 + 携带未确认 candidate,见 §5),不必重发整包,省 token。⚠️ **resume 的 flag 集与 fresh 不同**:`exec resume` 接受 `--json`/`--output-schema`/`-o`/`-m`/`--skip-git-repo-check`,但**不接受 `-s`/`--cd`**(实测 0.135.0:传了报 `unexpected argument` 退出 2)。故 resume 轮省去 `-s`/`--cd`;但 ⚠️ **沙箱并不从 session 继承**(实测会回落到可写沙箱,CR-SEC-001/§12),故 resume 必须改用 `-c sandbox_mode="read-only"` 显式重申只读(cwd 仍从 session 继承,未单独实测)。`buildCodexArgs` 已据此分支,`tests/codex-round.test.mjs` 有回归守护(mock 在 resume 下拒绝 `-s`/`--cd`;并断言 resume argv 含只读 override)。
- **必须按 id,不能用 `--last`**(已实证,codex-cli 0.135.0):`resume --last` = 取**当前 cwd 下最近一条记录的 session**,它**只按 cwd 过滤、不区分 exec 与交互(`codex-tui`)会话**。我们的循环 `--cd <repo>` 跑在项目目录,用户若同时在同一目录手动开了 `codex`,`--last` 会**串到用户的交互会话**;本机还有 `codex-image-gen` 等也在调 codex。故只用捕获到的 `thread_id`。
- **id 捕获用 stdout in-band 解析**,不靠"找 `~/.codex/sessions` 下最新文件"——后者有并发写竞态,等于另一种 `--last` 陷阱。

### verdict schema

> ⚠️ codex 的 `--output-schema` 走 OpenAI 结构化输出的 **strict 模式**:每个 object 必须 `additionalProperties:false`,且 `required` 必须**列出 properties 的全部键**(实测 codex-cli 0.135.0:否则 `invalid_json_schema` 报错、turn.failed、退出 1、不写 verdict 文件)。故全部字段都在 `required` 中(AGREE 时 `remaining_issues` 为空数组)。`tests/verdict-schema.test.mjs` 对此做了 hermetic 守护。
>
> `truncated`/`reviewed_scope`/`assumptions` 用于防「截断范围下的误导性 AGREE」:Codex 若只看到部分材料须置 `truncated=true` 并写明范围;命令在收敛输出时会据此标注「非完整签核」。
>
> **P0(v0.4.0 起,§12)**:`remaining_issues[].id` 给每条 issue 一个**稳定 point_id**;`candidate_dispositions[] = {id, disposition: confirmed|rejected}` 让 Codex 对增量里 Claude 列出的每个 candidate 结构化裁定(首轮空数组),使 candidate→agreed 晋升不再靠从自由文本 `rationale` 猜。**注意:`state`(open/candidate/agreed/merged)与血缘(parent/merged)是 Claude 侧账本(由 P2 `review-state.mjs` 维护),不进 Codex 输出 schema**——Codex 不拥有状态,只输出 id 与对 candidate 的裁定事件。

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "remaining_issues", "candidate_dispositions", "rationale", "truncated", "reviewed_scope", "assumptions"],
  "properties": {
    "verdict": { "type": "string", "enum": ["AGREE", "CHANGES"] },
    "remaining_issues": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "title", "detail", "severity"],
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "detail": { "type": "string" },
          "severity": { "type": "string", "enum": ["blocker", "major", "minor"] }
        }
      }
    },
    "candidate_dispositions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "disposition"],
        "properties": {
          "id": { "type": "string" },
          "disposition": { "type": "string", "enum": ["confirmed", "rejected"] }
        }
      }
    },
    "rationale": { "type": "string" },
    "truncated": { "type": "boolean" },
    "reviewed_scope": { "type": "string" },
    "assumptions": { "type": "array", "items": { "type": "string" } }
  }
}
```

## 7. AGREE 契约 (防假收敛 / 防顺从)

- **Codex 侧**(写进评审包的「你的职责」):明确设为对抗者 —— "**对照任务目标复核这份工作本身**(实现 / diff / 结果 / 计划),并评估 Claude 的结论是否成立;Claude 的主张只是一个输入,不要默认它对。有任何实质疑虑就给 CHANGES;不要为了收敛而同意。优先质疑实现路径、设计取舍、假设是否成立、需求是否完整、有无潜藏 bug,而不仅是表面缺陷。"
  - (审「工作」而非只审「Claude 的文字」,对场景 2 需求门禁、场景 3 修 bug 尤其关键。)
- **Claude 侧**(写进命令协议):"只有真的无异议才输出 AGREE;不认同 Codex 就带理由反驳,而非投降。顺从式同意视为失败。"
- 两侧**独立**达到 AGREE 才停 → 防单边盖章。

### 固有局限(已知,接受)

Claude 既是**驱动方**又是**收敛裁判**,还由它组装喂给 Codex 的评审包、并代为报告"双方 AGREE"。原理上 Claude 可能软化自己的主张去骗取 Codex 同意,或过早宣布自己 AGREE。缓解手段 = 上面的 AGREE 契约 + Codex 的独立对抗立场 + 每轮进度对用户可见;但在「单驱动方」架构下无法根除。接受此局限;若未来要根除,需独立的第三方裁判进程(超出本插件范围)。

## 8. 错误处理

- Codex 缺失 / 未登录 → 检测到后提示用户运行 `/codex:setup`,停止。
- `--repo` 指向非 git 仓库 → 因总是带 `--skip-git-repo-check`(§6),不会被 codex 的 repo 检查挡掉,自然退化为文本/文件评审。
- Codex 输出不合 schema / 跑了但没写 verdict → 重试一次;再失败则 `bad_verdict`,附 `codex_exit` + `stdout_tail`/`stderr_tail` 供排查。
- 对话里找不到待审材料、也没传任何输入 → Claude **问用户**评审什么(不瞎猜)。
- 评审包过大 → Claude 摘要 + 显式说明截断(§5)。

## 9. 打包与安装

布局(加进 `finyorke/claude-skills` 仓库):

```
cc-codex-review/
  .claude-plugin/plugin.json        # name, version, description, author
  commands/review.md                # 命令体 = Claude 执行的互审协议
  scripts/codex-round.mjs           # 单轮 Codex 调用原语(确定性,可单测)
  scripts/review-state.mjs          # 共识账本无状态 reducer/validator/render(P2,§12)
  scripts/metrics.mjs               # dogfood 逐轮/跨任务度量(P1,§12)
  schemas/verdict.schema.json        # verdict 结构化输出 schema(strict 模式)
  tests/                            # codex-round / review-state 单测 + 假 codex + schema strict 守护
  README.md / DESIGN.md             # 文档(PLAN.md 已于 v0.3.0 移除,历史见 git log)
```

根 `marketplace.json` 的 `plugins` 数组追加:

```json
{ "name": "cc-codex-review", "source": "./cc-codex-review",
  "description": "Claude × Codex 收敛互审 — 两方迭代复核,收敛于双方 AGREE,否则到顶/停滞产出 UNRESOLVED" }
```

- 调用名:插件命令为 `/<插件名>:<命令名>`,即 `/cc-codex-review:review`(实现时验证能否省略命名空间)。
- 安装:`claude plugin marketplace add finyorke/claude-skills` → `claude plugin install cc-codex-review@fun-plugins`。
- 推送:走副账号 `finyorke`(SSH 别名 `github-finyorke` / `id_ed25519_finyorke`);当前 remote 为 HTTPS,push 前需处理鉴权。仅在用户明确要求时提交 / 推送;`main` 为默认分支,提交前先开分支。

## 10. 测试

LLM 循环难做单元测试,采用:

- **dry-run 模式**:打印组装好的评审包 + 将要执行的 `codex exec` 命令,但不真正调用。
- **冒烟测试**:对一个 trivial 仓库跑一轮,验证 verdict JSON 解析、AGREE/CHANGES 分支、停滞检测触发。
- 测试深度按用户需求伸缩。

### prompt 级行为手动验收清单

循环是 prompt 驱动,无自动化测试位;以下场景**人工**验收(改动 `commands/review.md` 后过一遍):

- **max-rounds 解析**(均可用 `--dry-run` 眼检:它会回显 `effective_max` 及其来源,见 `commands/review.md` §5):① 不带 flag/不提轮数 → 默认 `effective_max=5`;② `--max-rounds 3` → 3;③ 指令含"最多 6 轮"无 flag → 6;④ flag 与自然语言并存 → flag 优先;⑤ `--max-rounds 0` → 无上限(仅靠停滞 + 人工);⑥ 非法值(负数 / 非整数 / 自然语言"0 轮")→ 报参数错误并停,**不**静默回退默认。
- **candidate 生命周期**:⑦ Claude 采纳修订(adopted)**或带理由反驳(rebutted)**→ 进 `candidate`,**不**进 `agreed`;⑧ 下一轮 Codex 在 `candidate_dispositions` 对该 id 给 `confirmed` → 晋升 `agreed`(反驳被 confirmed=Codex 接受反驳,该点了结);⑨ issue 仅"这轮没出现"而无 confirmed → **不**晋升;⑩ 已晋升 `agreed` 点被重新质疑 → 退回 `❌`(非退回 candidate);⑩b 晋升只认逐条 `confirmed`,`verdict=AGREE` 不隐式确认;收敛要求 candidate 与 open 均空。
- **UNRESOLVED 输出**:⑪ 四段齐全(✅/🔶/❌/📋),`candidate` 落在 🔶 而非 ✅;⑫ 顶部含 reviewed_scope + assumptions;⑬ 最后一轮 truncated → 加非完整签核警告;⑭ 每条卡点同时有「状态」与「影响严重度」两维;⑮ 最后一轮刚采纳的修订 → 落 🔶「待复核确认」,不混入 ✅,也不重复进 ❌。
- **`--lens` 镜头(§1/§4.5)**:⑯ 无 `--lens` → 通用评审,不注入镜头、§7 不标注;⑰ `--lens omission` 与 `--omission-check` 行为完全等价(归一为 `effective_lens=omission`),dry-run 回显 `effective_lens`;⑱ 未知 name / `--lens`+`--omission-check` 冲突 / `--lens` 缺 name → 报参数错误;⑲ 持续型镜头(security/correctness/requirements)每轮增量重述「## 焦点镜头」头(非仅靠 resume);⑳ 对纯文字/提案材料套 security/correctness → 剔除代码专属项,完全不匹配 → 报错;㉑ **声明侧重角度非空时**(`effective_lens` 非空,**或执行者据评审指令隐性侧重了某视角**,LENS-DECLARE)§7 输出顶部声明 `本次侧重:<角度>(额外侧重,非缩小签核)`,且 AGREE 仍为全面签核——**声明义务绑定"实际侧重"而非 flag**(v0.8.9)。**注(v0.8.10)**:⑯⑰⑱ 的**确定性部分**(flag→effective_lens、别名归一、未知/冲突/缺名/重复报错)已抽成 `scripts/lens-parse.mjs` 纯函数 + 单测、由 review.md §1 调用,**不再纯靠手动验收**;⑲⑳㉑ 仍为 prompt 行为(语义判断),保留手动验收。

## 11. 开放点与实测结论(codex-cli 0.135.0)

已实测确认(冒烟见 README):
- ✅ **`thread_id` 捕获**:`codex exec --json` stdout 首行 `thread.started.thread_id` 为非空 UUID,in-band 拿到,可用于 resume。
- ✅ **`--json` + `--output-schema` + `-o` 共存**:三者并列可正常工作,verdict 通过 `-o` 落盘;前提是 schema 满足 strict 模式(见 §6 ⚠️)。最初的非 strict schema 会让 codex 报 `invalid_json_schema` 并退出 1、不写文件——已修复并加 `verdict-schema.test.mjs` 守护。
- ⚠️ codex 把 API 级错误写进 **stdout 的 `{"type":"error"}` / `turn.failed` 事件**(不是 stderr),且进程退出码为 1。脚本将这类「跑了但没产出合法 verdict」归为 `bad_verdict` 并带 `codex_exit`。

- ✅ **`exec resume` 的 flag 集**(自评 dogfood 实测发现并修复):`codex exec resume` **不接受 `-s`/`--cd`**(传了报 `unexpected argument` 退出 2),最初实现照搬 fresh flag 导致**多轮 resume 在真机 100% 失败**——单测因 mock 接受任意参数而漏检。已修:resume 轮省去 `-s`/`--cd`(cwd 从原 session 继承;**沙箱不继承——后由 CR-SEC-001/v0.8.7 改用 `-c sandbox_mode="read-only"` 重申**),`--output-schema`/`-o`/`--json`/`-m`/`--skip-git-repo-check` 保留;mock 改为在 resume 下拒绝 `-s`/`--cd` 做回归守护。

- ✅ **多轮 resume 端到端**(真·多轮 dogfood 实测):round 1 fresh 抓 `thread_id` → round 2 `exec resume <id>` 成功(exit 0),且 Codex **保留了第 1 轮上下文**并接上第 2 轮增量;`--output-schema` 在 resume 轮语义级生效(`truncated`/`reviewed_scope`/`assumptions` 正确填充)。即 resume 不只是参数被接受,而是真按 schema 产出 verdict。

仍待实测:
- 插件 command 的实际调用名(`/cc-codex-review:review` 能否省略命名空间)—— 需安装后在 Claude Code 里确认。
- 大材料的分块评审策略尚为「摘要 + truncated 标注」,未实现自动分块。

## 12. 效果提升路线图(经 Claude×Codex 互审收敛)

> 进度:**P0 ✅(v0.4.0)、P2 ✅(v0.5.0/v0.5.1/v0.6.0);P1 🟡 instrumentation 已实现(v0.7.0),首份真机数据已落盘(experiments/p1-cr-sec-dogfood.json,取自 v0.8.8 安全 dogfood 6 轮;wall 部分缺、其余完整);P3 ✅ 脚手架(v0.8.0)+ A/B 实验(盲评,budget-6 共 4 任务含非代码 + budget-2 UNRESOLVED 样本):omission-check 高召回但精度优先 decide=keep_A,代码评审不宜默认开、但推荐用于提案/设计文档评审;P4 决策门 → scope-down:`--lens <name>` 单镜头功能已落地(实验性,仅 omission 验证),并行聚合版 full-P4 继续暂缓;v0.8.7 修复 CR-SEC-001(resume 只读沙箱逃逸,实测发现);v0.8.8 用 `--lens security` 对抗式 dogfood 该修复、6 轮收敛,补 4 处安全加固(resume 注入校验/缺值 fail-closed/approval=never/--ignore-rules)并**定性验证 security 镜头有强检测力**(correctness/requirements 仍未验证);v0.8.9 #11 lens 手动验收(规格 6/6 过)发现并修执行层透明缺口 → LENS-DECLARE:声明义务绑定"实际侧重"而非 flag(隐性侧重也须 §7 声明);v0.8.10 lens 解析脚本化(lens-parse.mjs + 单测,补 #11 暴露的"唯一未脚本化逻辑"短板,147 绿)**。优先级与语义经对抗式互审锁定。

- **P0 结构化协议(P2 的前置)— ✅ 已实现(v0.4.0)**:`verdict.schema.json` 已加 `remaining_issues[].id`(稳定 point_id)+ `candidate_dispositions[] = {id, disposition: confirmed|rejected}`(**事件**,非状态,首轮空数组);`codex-round.mjs` 已透传这两个字段(冒烟曾发现并修复其被 cherry-pick 丢弃;并收紧:缺 required 数组字段 → `bad_verdict` 不静默默认);`review.md` 已指示 Codex 产出 id/dispositions 并据此晋升;`rejected` 的点用同一 id 留在 remaining_issues。真机两轮 dogfood 验证 confirmed/rejected + id 跨轮稳定。
  - `state ∈ {open, candidate, agreed, merged}`(持久)、合并血缘 `merged_from/merged_into`、覆盖/未知ID/状态机不变量校验属 **Claude 侧账本**,由 P2 `review-state.mjs` 维护,**不进 Codex 输出 schema**(Codex 不拥有状态)。
  - **范围说明**:`parent_id`(拆分谱系)无实际用例、无 reduce 写入路径,已按 YAGNI 剔除(仅保留 merge 血缘)。id 跨轮稳定由 prompt 约束 + 数组内去重保障,未做强制的跨会话稳定性校验。
  - 状态迁移(P2 reducer 实现):`open`─(adopted 采纳 / rebutted 反驳)→`candidate`─(Codex confirmed)→`agreed`;`candidate`─(Codex rejected)→`open`;`agreed`─(重新质疑)→`open`;point─(合并)→`merged`(终态)。**反驳路径(RS-P2-OPEN)**:Claude 反驳的 open issue 也进 candidate 待 Codex 裁定,confirmed=接受反驳→agreed,使"反驳成功"的点能了结、循环可收敛。
- **P1 dogfood 度量(数据驱动后续优先级)— 🟡 instrumentation 已实现(v0.7.0),数据采集待真机**:`scripts/metrics.mjs`(`roundMetrics`/`aggregate`/`aggregateTasks` + CLI)实现——每轮 `new|repeat` 由 id 是否在 prevState 出现**确定性判定**,正交标签 `revision_induced`(⊆new)/`stuck`(⊆repeat)由 Claude 据实标注且只计交集(防误标膨胀),`confirmed/rejected` 单独计数;`codex-round.mjs` 每轮输出 `wall_clock_ms`(成本=各轮之和,全轮有计时才汇总);review.md §6 已挂"每轮记度量"。**⏳ 待办**:用真 `/cc-codex-review:review` 跑 ≥3 个真实任务采集可信数据(必须经真实循环,不能手工驱动,否则测的是"Claude 手动"而非插件——见 RS-INT-001)。
- **P2 `review-state.mjs`(无状态纯函数,守 §1/§2)— ✅ 已实现(v0.5.0)**:导出 `reduce`(上一轮 state + 语义决策 adopted/dispositions/merges → 新 state,纯函数不改入参)/`validate`(id 唯一、合并完整性、disposition 覆盖与未知 id)/`canConverge`(candidate 非空即拒,防假 RESOLVED)/`renderUnresolved`(四段块)/`counts`,并配薄 CLI(stdin JSON → stdout JSON)。**接收 codex-round.mjs 的结构化结果、不重复解析 stdout、不持久化、不驱动循环**;状态机全部迁移由它据传入语义决策施加。单测覆盖全部迁移/不变量/收敛/渲染;review.md §6 已将其设为**每轮必经管线**(见下「集成已闭合」)。**补齐了 P0 留给 P2 的 state + 合并血缘 + validator**(`parent_id` 拆分谱系按 YAGNI 不做,见 P0 范围说明)。v0.5.1 经 Codex 代码互审 6 轮、修复 9 个边界 bug(RS-P2-001..009:validator 拆 validateRound/validateState 按中间态校验、合并图链/环/双向 reciprocity/去重、merged 终态 zombie issue、annotation/数组 id 校验、候选元数据跨采纳清除、CLI pathToFileURL)。随后一次「完成度」互审又补:**反驳路径(RS-P2-OPEN,见上)**、`rebutted` 输入与校验、§6 取消"AGREE 隐式确认"改为一律靠结构化 disposition、codex-round 收紧 boundary、§12 状态修订、parent_id 剔除。review-state 单测增至约 40 条。
  - **集成已闭合**:review.md §6 改为**每轮必经管线 `validate-round → reduce → validate-state → converge`**(不再"可委托"、不再散文手工记账);真机 E2E 已跑通——两轮真 codex 输出经 review-state CLI 驱动:采纳/反驳→candidate、Codex 裁定 confirmed/rejected→agreed/回 open、converge 闸门正确(rejected 回流后拒收敛);并加 hermetic 集成测试(canned verdict 跑完整管线 + "AGREE 但 candidate 未覆盖→拒收敛"),可重放。review-state 单测约 46 条(全套 56)。
  - **v0.8.1 收敛完整性加固(Codex 互审 4 轮收敛,修 P3 实验发现的两条假收敛 bug)**:① **RS-P2-010**(blocker):`validateRound` 的 merge 检查现禁止把未决点(open/candidate)合入已 `agreed` 目标——否则该未决分歧随 merged 终态从计数消失、`canConverge` 放行 → 假收敛。② **RS-P2-013**(merge 假收敛的 CLI/函数面):`canConverge` 改 `claudeAgree !== true` 严格判定(杜绝 `'false'`→true);CLI 加 JSON try/catch、`reduce`/`validate-round` 须显式 `prevState.points`(首轮显式传 emptyState,防漏传清空历史)、`converge` 须显式 `state.points` + 布尔 `claudeAgree`;**`canConverge` 全程 fail-closed**——缺失/非数组 points 或 `validateState` 非法(未知 state、坏合并图)一律拒收敛,不依赖调用方先跑 validate-state。review.md §6 同步"每次 CLI 调用显式传 state"约定。全套单测 98 绿。
- **P3 首轮遗漏检查实验 — 🟡 脚手架已实现(v0.8.0),实验数据待采**:第 1 轮追加**一次**"针对当前证据与目标的遗漏检查"(**不**预判投机二阶问题、**不**输出 completeness 自评分)。A/B:同任务等额轮数预算配对运行、**纳入 UNRESOLVED 样本**、未收敛率作门禁指标、相同预算快照统一比较(converged/有效issue/噪音/Σwall-clock);"有效 issue" 须经**盲评或固定 rubric 终局复核**(仅"被采纳"不算),并记反向指标"不必要修订"。质量优先决策规则。
  - **已实现**:① `commands/review.md` 加 `--omission-check` 开关(默认关=arm A 现行行为不变;开=arm B,**仅第 1 轮**在 packet 末尾追加一条遗漏检查指令,§4.5,硬约束"只基于当前证据/不投机二阶/不输出 completeness 评分";不改收敛判定/状态机/度量口径/§7 输出)。② `scripts/experiment.mjs`(无状态纯函数 + CLI):`validateRuns`(严格数据契约)/`armSummary`/`compare`(配对校验 + 统一预算快照 + delta=B−A)/`decide`(**质量优先三层**:守门 inconclusive〔配对无效/样本<minTasks/墙钟未知/双臂零有效〕→ 质量门 keep_A〔有效 issue 减少/绝对噪音增多/噪音率升高/未收敛率升高/不必要修订增多〕→ 改善判定 adopt_B〔质量不回退且某维度实质更优,含未收敛率下降独立驱动、墙钟 rel∈(0,1] 阈值、整数轮数〕)。`effective_basis` 审计字段防"被采纳"冒充有效。
  - **dogfood(Codex 互审 5 轮收敛 RESOLVED)**:除 8 个初始 issue(EXP-001..008:绝对噪音口径、统一预算、墙钟 null 守门、审计字段、未收敛率正向决策、零质量信号守门、不必要修订计质量、输入校验)外,经**两次反驳 C1 / 两次反驳 EXP-007** 逼出输入契约全部漏洞(负墙钟、缺 unnecessary_revisions、非数组、畸形数组元素、错臂、rounds>budget、rel=0 误判持平、零墙钟基线)。experiment 单测 24 条,全套 88 绿。
  - **首批实验结果(3 任务配对 A/B,数据见 `experiments/p3-runs.json`)**:经真 codex-round 循环跑了 T1=codex-round.mjs、T2=metrics.mjs、T3=review-state.mjs,各 arm A(对照)/B(--omission-check)。`experiment.mjs decide` → **`inconclusive`:质量未回退但成本互有增减(更优:有效 issue 增多;更差:总轮数上升、墙钟显著上升)**。明细:A 共 8 effective issue / B 共 16(**+100%**,含 T3 一个 A 完全没发现的 **blocker**:merge 绕过未决确认→假收敛);两臂**噪音均 0**(B 的遗漏检查硬约束防投机有效);两臂全部收敛、unnecessary_revisions 均 0;B 成本 +1 轮、墙钟 +52%(747s→1134s)。
    - **结论(初版,非盲)**:decide=inconclusive,遗漏检查像是"深度杠杆、非减轮杠杆"。**但此读数已被下方盲评复核推翻——见 🔬。**
    - **🔬 盲评复核(更新结论,数据见 `experiments/p3-blind-rescore.json`)**:攻掉头号方法学缺陷(单 Claude 既驱动又当 effective 裁判)。把 24 条 issue 去标识打乱、交独立子 agent 按固定 rubric 盲评,重算 → **`decide=keep_A`(strict pooled 与 fairness-adjusted 两种解读一致)**。即:① 非盲单裁判把**全部** issue 判 effective(noise=0),**系统性高估 B**;② 独立盲评发现真噪音存在且更集中在 B(alias 无触发、链式 merge 排序 nit、retry 主题过度细分);③ 即便公平性校正(B 召回更高:13 vs 7 真 bug),B 仍带更多绝对噪音 → 质量优先规则(不拿噪音换数量)选对照组 A。**修正定性:omission-check 是【高召回-高噪音】模式(召回/精度权衡),插件默认质量优先规则把它判向控制组,不宜默认开启。** 最大教训:**单裁判非盲是 material 偏差源,双 agent 分离驱动/裁判的真盲评是 P3 结论可信的前提**;样本仍小(n=3、全代码),结论按此打折。
  - **🔬 真盲评扩样(第二批,数据见 `experiments/p3-extension.json`)**:用双 agent 盲评流程补两类缺口——**非代码任务**(T4 提案评审)+ **UNRESOLVED 样本**(T5 决策提案,budget=2)。结果:① budget-6 快照扩到 **4 任务(含非代码)**、盲评后 `decide=keep_A` **仍成立**(B 绝对噪音 +2);但更细的画面是 **B 一致更高召回**(4 任务 26 vs 15 有效 issue,多 73%,含 A 漏掉的 T3 blocker 与 T4 提案的聚合/冲突/状态/收敛空白),keep_A 由插件**精度优先/零噪音容忍**的绝对噪音闸门驱动 = **召回/精度权衡**,非"B 无价值"。② **任务类型重要**:**非代码提案评审上 omission-check 几乎无真噪音、价值明显更高**(设计文档的空白正是其靶心);代码评审上才出现噪音。③ **UNRESOLVED(T5,budget 2)**:两臂都到顶不收敛 → 遗漏检查增加"发现"而非"收敛速度",紧预算下无助收敛。**修订建议:omission-check 不宜代码评审默认开,但值得作为「提案/设计文档评审」或「需高召回深挖」场景的推荐开关。** 样本仍小(代码 3 + 非代码 1 + UNRESOLVED 1)。
  - **副产品:P3 真审挖出的真实 bug 修复进度(均 Codex 互审到双 AGREE)**:
    - ✅ **v0.8.1 收敛完整性**(review-state.mjs):RS-P2-010 merge 假收敛、RS-P2-013 CLI/canConverge fail-closed(详见上方 P2 条目)。
    - ✅ **v0.8.2 codex-round.mjs 加固**:CR-CLOCK-MONOTONIC(hrtime 单调计时,wall 非负)、CR-UNAVAILABLE(ENOENT/127+command-not-found/stderr-auth 即时判 + stdout 错误事件后置判,去裸 127 误判)、CR-THREAD-ATTEMPT(thread_id 仅取成功尝试)、CR-OUT-OWNERSHIP(--out 不可删/不可读/目录型不崩溃、不读陈旧产物、main 顶层兜底一行 JSON)、CR-RETRY-DIAG(spawn_error 诊断)。
    - ✅ **v0.8.3 review-state 余项 + metrics 加固**(Codex 互审 3 轮收敛):review-state——RS-P2-011 validateRound 事件**形状契约**(数组/元素形状 + remaining_issues 的 title/detail/severity 类型,severity 用 `Object.hasOwn` 防原型绕过;adopted/rebutted/annotations 元数据约束为 string,既消除别名又杜绝不可克隆值)、RS-P2-012 validateState 缺 id/活跃点孤儿 merged_into/非对象点 fail-closed、RS-P2-014 meta 深拷贝(structuredClone)、RS-P2-015 链式 merge 前置拒、RS-P2-016 空串覆盖、RS-P2-017 render 措辞;metrics——MTR-NUM 数值域(有限非负 wall/整数≥1 attempts)、MTR-ID id 集合语义去重、MET-TASK 空任务 avg→null。全套 118 绿。
    - ✅ **v0.8.4 MET-ERR-001**(Codex 互审 2 轮收敛):aggregate/aggregateTasks 加 `expectedRounds`(已开始轮数)+ `complete` 标志,**fail-closed**——某轮 bad_verdict/unavailable 中断致 `records.length < expectedRounds`、或非法/不一致 expectedRounds(非非负整数、records≠expected、跨任务数组非等长)→ `complete:false` 且 `total_wall_clock_ms`/`retried_rounds` 归 null,不拿残缺记录伪装完整成本;review.md §6 指示汇总时传入已开始轮数。**至此 P3 实验真审发现的 bug 全部修复(v0.8.1~v0.8.4)。**
- **P4 多视角复核 — 决策门 → scope-down(v0.8.6,Codex 互审收敛)**:
  - **决策门结论**:原"并行 N lens + 聚合引擎"愿景**继续暂缓**——T4 提案评审暴露 13 条空白(聚合/去重/冲突裁决/每镜头 candidate 状态/收敛语义/成本 4x 上限/兼容…),且 P3 数据未证其价值、`独立 thread ≠ 独立视角`(同模型同 packet 结果相关)。这些 13 条 checklist 留作 full-P4 未来 spec。
  - **改做最小可行形态 `--lens <name>`**:把 `--omission-check` 泛化为可选**单镜头**(omission/security/correctness/requirements),**单次、opt-in、复用全部现有协议**——一次只有一个镜头、产出并入同一 `remaining_issues`,故根上不出现聚合/跨lens状态/收敛重定义(避开全部 4 个 blocker)。镜头 = "通用评审 + 额外侧重",**AGREE 仍是全面签核**(LENS-SCOPE)。
  - **证据边界**:**仅 `omission` 经 P3 验证**;security/correctness/requirements 为外推的**实验性**预设、未实测(且与默认 rubric 有重叠)。多镜头 = 多次独立调用,**结论不可组合**(那才是 full-P4)。
  - **协议要点(经 dogfood 闭合)**:effective_lens 归一(`--omission-check`≡`--lens omission`,冲突/未知/缺名报错)、镜头按材料模式过滤越界项(完全不匹配→报错)、持续镜头每轮增量重述、§7 输出标注镜头(provenance)、experiment run 带 `lens` 字段、成本表述去掉"1x"(无强制 fan-out、单镜头仍可能略增轮/墙钟)。

- **CR-SEC-001 resume 只读沙箱逃逸(v0.8.7,实测发现并修复)**:验证"实验性镜头"(#7)时,审查 security 镜头的目标面(codex-round.mjs 的子进程/沙箱处理)发现一处**真实安全漏洞**——`codex exec resume` **不继承** fresh 轮的 `-s read-only`,实测会回落到默认可写沙箱(能写 `/tmp` 等)。原代码注释断言"resume 从原 session 继承沙箱",**实测证伪**:受控探针(fresh read-only 写入被阻断 → resume 同一 thread 写入**成功**,Codex 自报"The write succeeded")。这意味着此前**每次评审的第 2+ 轮 Codex 都不在只读模式**,违反"Codex 绝不能写文件"的硬不变量。**修复**:resume 不接受 `-s`,改用 `-c sandbox_mode="read-only"` 配置覆盖显式重申只读(实测 round3/round4 写入被阻断、exit 0 无 unexpected-argument;TOML 引号形式与字面量回退形式均验证)。加单测断言 resume argv 含该 override、fresh 不含。
- **CR-SEC 加固组 + #7 security 镜头验证(v0.8.8,用本工具 `--lens security` 对抗式 dogfood CR-SEC-001 修复,Codex 互审 6 轮收敛 RESOLVED)**:按 #7「对抗式 dogfood 验证修复」路径,用**真实评审循环 + `--lens security`** 复核 v0.8.7 修复本身,并以**修复后的** codex-round.mjs 驱动循环(故第 2+ 轮 resume 自身即活体验证只读路径)。6 轮收敛,security 镜头挖出 **5 条我自评漏掉的真问题** + 1 条我正确反驳:
  - **CR-SEC-RESUME-OPTION-INJECTION(major,采纳)**:`--resume` 值未校验,`--resume --last` 等会被 codex 当作选项解析、绕过按 id 隔离。修:`isValidThreadId` 严格 UUID 校验,非法即 `bad_resume`/exit 2,绝不传给 codex。
  - **CR-ARG-RESUME-MISSING(minor,采纳)**:`--resume` **缺值**时 `a.resume=undefined`,旧 `!= null` 守卫跳过校验 → 静默退化成 fresh 轮(fail-open)。修:改严格 `!== null`,缺值 → fail-closed `bad_resume`。
  - **CR-SEC-CONFIG-SIDECHANNELS(major,采纳要点 + 收窄主张)**:read-only 之外仍有两条模型命令写路径——① **审批升级**:加 `-c approval_policy="never"`(实测非交互 exec 下升级本就 unavailable,但显式锁定不依赖用户 config);② **execpolicy `allow` 规则**(官方语义:免提示、沙箱外运行):加 `--ignore-rules`(fresh/resume 均接受),令 `-s read-only` 成唯一权威上界。并实测确认 **CLI `-s` 覆盖用户 config.toml 的 sandbox_mode**。范围外仅余**用户自配 MCP/hooks/apps**(codex 外的独立工具),已显式记为信任边界(见上「只读不变量的精确范围与信任边界」)。诚实标注:execpolicy 逃逸**未实测复现**(`.rules` 格式不现成),改以"忽略 ambient rules"防御性关闭。
  - **CR-DOC-INHERIT(minor,采纳)**:DESIGN 三处仍称"沙箱从 session 继承"已更正。
  - **CR-SEC-OUT-PATH(major,反驳,Codex confirmed)**:`--out` 是 skill 设定的**可信内部参数**(指向临时文件),harness 写/删自身产物非"Codex 写文件"事件、非外部输入 → 不在威胁面内。Codex 接受反驳。
  - **#7 结论(security 镜头)**:`--lens security` 在真实安全面代码上有**强检测力**——6 轮持续挖出我自评漏掉的、逐层深入的真问题(resume 注入 → fail-open → 审批升级 → execpolicy 规则),直到双 AGREE。这是**定性验证**(非 experiment.mjs 配对 A/B:本仓库已硬化、缺每类潜在问题的新鲜素材,质量门 A/B 多半 inconclusive)。`correctness`/`requirements` 仍**未验证**,保持 experimental 标记。
- **LENS-DECLARE 声明义务绑定"实际侧重"(v0.8.9,#11 lens 手动验收发现)**:#11 逐项验收 §10 ⑯-㉑ 时,规格 6/6 自洽,但发现一处**执行层透明性缺口**:原 §7 标注义务只在 `effective_lens` 非空(显式 `--lens`)时触发;而执行者**即便没给 `--lens`,也可能根据评审指令自然语言隐性侧重某视角**(如指令说"重点看安全"),此时旧规则**不要求声明**→ 用户可能把"隐性带角度"的评审误读为中立全面。修复:把声明义务从绑定 **flag** 改为绑定 **实际侧重角度**(LENS-DECLARE):只要本次有声明侧重角度(显式 `--lens` *或* 据指令的隐性侧重),§7 必须顶部声明「本次侧重:<角度>(通过=全面签核,非仅该视角)」。边界:**镜头机制(注入/每轮重述/收敛/度量/experiment `lens`)仍只由 `--lens` flag 触发**,隐性侧重只触发声明义务。改 review.md §1(新增 LENS-DECLARE 原则)+ §7 两处标注规则 + DESIGN §10 ㉑。
- **lens 解析脚本化 + 单测(v0.8.10,#15;补 #11 暴露的短板)**:#11 验收暴露 lens 是本项目唯一还纯靠 prompt 散文、只能手动验收的关键逻辑(codex-round/review-state/metrics/experiment 都已脚本化+测)。把**确定性部分**抽成 `scripts/lens-parse.mjs` 纯函数 `parseLens(argv)`(+ 薄 CLI stdin JSON→stdout JSON,与其它脚本一致):flag→`effective_lens`、`--omission-check`≡`--lens omission` 归一、`lens_unknown`/`lens_conflict`/`lens_missing_name`/`lens_duplicate` 报错;review.md §1 改为调它(`ok:false` 即报参数错误并停)。**判断型规则(⑲ 每轮重述、⑳ 材料过滤、㉑/LENS-DECLARE 声明)仍留 prompt**(需语义判断)。新增 `tests/lens-parse.test.mjs` 18 例(覆盖 ⑯⑰⑱ + CLI + 防御 + LP-CLI-INPUT fail-closed),全套 **147/147 绿**。收益:⑰⑱ 从手动验收升级为自动回归保护,补齐"关键逻辑皆脚本化+测"的一致性。自审 dogfood 第 1 轮发现 LP-CLI-INPUT(CLI 用 `|| []` 把缺失 argv 吞成无镜头)→ 改为 fail-closed(缺失/null argv → bad_input;`{argv:[]}` 显式空仍合法),Codex 2 轮确认。

- **评审独立性泄漏点 + 需求提取 extract-reqs(**v0.9.0 已实现** prompt 命令 `commands/extract-reqs.md`;#16 brainstorm 产出)**:#16 从"并行多视角"探起,经用户连环追问**收敛到更根本的问题**——「评审的输入与裁决都经作者(Claude)一手过滤」。识别三个**独立性泄漏点**:① **需求**:Codex 看不到用户真需求,只看 Claude 单方转述(转述损耗 + 私货夹带,可使评审无法发现"方向跑偏");② **结论锚定**:Claude 把"结论+理由"塞进评审包,带偏 Codex 首判(A·反锚定);③ **兼裁判**:Claude 既驱动 review 又判收敛(运动员兼裁判)。三方角色厘清:用户=需求权威、Claude=实现者+驱动者、Codex=独立 reviewer。**首个落地设计 = `extract-reqs`**(MVP,独立命令):从当前会话提取**经用户背书的需求(纯 WHAT)**,按"是否经用户背书"分三档(纳入①用户直述/②Claude 提议+用户明确同意 · 待定③未表态 · 排除④Claude 单方设计)+ **fail-closed 硬规则**(②无用户明确同意原话→降级③)+ 用户确认,产出"用户认证需求"供 `review --plan`。spec:`docs/specs/2026-06-12-extract-reqs-design.md`。相关后续(未做):A 反锚定(藏 Claude 结论让 Codex 独立首判,当前窗口场景下"我那侧首判信息量低、独立视角全在 Codex")、兼裁判中立性。**实现验收(v0.9.0)**:实跑(拿本会话 extract-reqs 讨论自身作素材)spec §8 全 PASS——四档分档正确,且「WHAT/HOW 分离」因无用户单独同意原话被**正确降级③**(fail-closed 硬规则实证);Codex 自审 `commands/extract-reqs.md` 2 轮收敛 RESOLVED,修 I1(description "三档"→"四档")+ I2(补"语义可能误分类、确认非橡皮图章、无自动校验靠用户把关"的诚实局限提示)。**v0.9.1**:闭环 dogfood(经 skill 入口 `extract-reqs`→`review --plan` 审 lens 脚本化 #15)发现并修 2 点——§5 加**同源自证警示**(概括授权如"按你推荐的做"/需求与实现同源时,review 对"方向对不对"防自证力弱,须提示用户补独立验收标准)+ §6 加"已知局限"段;§1 去掉 `$ARGUMENTS` 反引号(无参数不再渲染空 inline-code)。Codex 自审 2 轮收敛。**附:此闭环本身验证了两命令经 skill 正式入口工作正常,且暴露 extract-reqs 的适用边界——强场景=用户有独立原创需求,弱场景="按你推荐的做"型同源任务。**

- **协作执行命令 `do` + 三功能厘清(v0.10.0)**:补"给任务让两 AI 协作做掉"的入口(用户洞察:之前 review+extract-reqs 缺这个主入口)。三命令成流水线:`do`(做之中——Claude 动手 / Codex 只读把关;**复杂任务双方各自独立出方案→对抗到统一**消除锚定、琐碎任务直接做+复核;不自动越权,动手只 Claude)、`review`(做之后审)、`extract-reqs`(中间固化需求)。同时 review 默认轮数 5→3(质量优先,非为收敛而跑)、extract-reqs 加 `--depth`(看最近 n 轮)、新增 `schemas/plan.schema.json`(Codex 出方案的 strict 结构化输出)。spec:`docs/specs/2026-06-19-collaborative-commands-design.md`。

- **强制真用 Codex(会话核对 + 收敛门禁,v0.11.0,#23)**:用户洞察——review/do 是 prompt 软约束,Claude 可能自审跳过 Codex、假装互审。利用 codex 在 `~/.codex/sessions/…/rollout-…-<thread_id>.jsonl` 留的**不可伪造记录**(文件名带 thread_id):① 新增 `scripts/verify-codex-session.mjs`(查 sessions 核对 thread_id;非 UUID 直接 missing 防路径遍历);② `review-state.converge` 加门禁——`verifiedCodexRounds < 1` 拒 RESOLVED(CLI fail-closed,函数级第4参省略=兼容旧调用);③ review/do 收尾必调 verify-codex-session、§7 附 thread_id+verified/missing,未核实标「⚠️ 不可信」且不收敛。**诚实边界**:Claude 驱动 → 非 100% 强制(仍可不调 verify),真硬强制需 Claude Code hook(后续 C 档,本期不做)。spec:`docs/specs/2026-06-19-codex-session-enforcement-design.md`。

依赖:P0 是 P2 前置;P0/P1 可并行;P3 独立。
