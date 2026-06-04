# cc-codex-review — Claude × Codex 收敛互审插件 设计文档

- 日期: 2026-06-02
- 状态: 设计已批准 (待写实现计划)
- 归属市场: `fun-plugins` (`finyorke/claude-skills`)

## 1. 目标

提供一个通用能力:**Claude 与 Codex 围绕某项工作循环互审,直到双方达成一致(AGREE)。**

### 核心抽象

> Claude(当前会话)对某项工作形成主张;Codex 对抗式复核该主张;两方迭代修订,直到都 AGREE;输出收敛后的结论。

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
                          [--model <m>] [--max-rounds <n>] <评审指令>
```

- 全部 flag 可选。**位置参数 = 评审指令**(例:"看一下这份计划,有什么意见,能不能进入下一步")。
- **被审材料**(0 / 1 / 多份)由 Claude 从当前对话(用户粘贴的)+ 指令中提到的文件收集。
- `--repo <dir>`:Codex 以该目录为工作根、只读运行,可用 `git log/diff`、读文件。
- `--diff <file|->`:把一份 diff 作为文本放进评审包(「不接仓库、只看 diff」场景);`-` 表示读用户粘贴的 diff 块。
- `--plan <file>`:任务目标 / 规格文件路径;不给则用对话里的目标,或 Claude 问用户一次。
- `--model <m>`:传给 `codex -m`;不给用 codex 默认。
- `--max-rounds <n>`:硬上限轮数(精确控制)。

### 硬上限优先级

`--max-rounds` flag > 指令自然语言("最多 5 轮"由 Claude 解析) > 默认无硬上限。

## 4. 互审循环协议 (Claude 遵循)

1. **Claude 形成初版主张**:基于 指令 + 被审材料 + 目标(+ repo/diff),写出判断 —— 结论(通过 / 返工 / 阻止)+ 理由 + 具体修改建议。
2. **组装评审包**(结构化文本,见 §5)。
3. **调用 Codex**(见 §6),Codex 返回结构化 verdict JSON。
4. **Claude 处理 Codex 的回应**:
   - 若 `CHANGES`:Claude 对**每条 issue** 要么**采纳并修订主张**,要么**带理由反驳**;更新主张;给出本轮自己的 verdict。
   - 若 `AGREE`:Claude 检查自己是否也已无异议。
   - **每轮打印一行进度**:`第 N 轮 · Codex=CHANGES · 剩 3 issue(1 blocker) · Claude=持异议`,让用户能看着进度决定是否打断(无硬上限时这是人工兜底的前提)。
5. **双 AGREE 闸门**:**仅当 `Codex.verdict == AGREE` 且 Claude 主动确认无异议**才结束循环。
6. **终止条件**(任一):
   - 双 AGREE → 收敛成功。
   - 达到硬上限(若设)→ 未收敛,交人工裁决。
   - **停滞检测**:某轮 Claude 主张 + Codex 的 issue 与上一轮**实质无变化**(同样未决分歧原地重复)→ 暂停,交人工裁决。
   - 用户手动打断(当前会话是交互式,人即兜底)。
7. **输出**:收敛后 Claude 打印 `✅ 收敛结论` 块:商定的结论 + 后续行动的具体建议。未收敛时打印双方最后立场 + 卡点列表。

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

仅**第 1 轮**发送上述完整评审包;第 2 轮起借助 `resume`(§6)只发增量(对上轮各 issue 的逐条回应 + 修订后的「Claude 当前主张」)。

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

- `-s read-only`:只读沙箱 —— Codex 能读文件、跑 git,但**绝不能写**(复核专用,安全)。**仅 fresh 轮传**;`codex exec resume` 不接受 `-s`,沙箱从原 session 继承。
- `--cd <repo>`:`--repo` 给定时设为工作根。**仅 fresh 轮传**;resume 不接受 `--cd`,工作目录从原 session 继承。
- `--skip-git-repo-check`:**两种轮次都传**(exec 与 exec resume 都接受)。这样非 git 的 `--repo` 目录也能跑(退化为文本评审),与 §8 一致。
- `--output-schema` + `-o`:Codex 输出结构化 verdict,AGREE 判定可靠(不靠字符串匹配)。`-o` 写入最终消息文件,便于捕获。**每次调用前都会先删除该文件**,避免读到上一轮残留 → 假成功。
- `-m <model>`:`--model` 给定时传入。
- 失败(跑了但没产出合法 verdict)时,`bad_verdict` 结果带 `codex_exit` + `stdout_tail`/`stderr_tail`(codex 把 API 级错误写进 stdout 的 `error`/`turn.failed` 事件,不在 stderr),便于排查。

### 跨轮记忆:resume by id(防不收敛 + 防串会话)

Codex 是对抗式的、又默认无硬上限,若每轮失忆重读,可能反复重提已被说服的点而**永不收敛**。故循环内让 Codex 保持立场记忆:

- **第 1 轮**:fresh `codex exec --json ...`,发送完整评审包。从 stdout **第一行** `{"type":"thread.started","thread_id":"<UUID>"}` 解析并保存 `thread_id`(不可用 `--ephemeral`,否则无法 resume)。
- **第 2 轮起**:`codex exec resume <thread_id> ...` 按 **id** 续接,只发**增量**(Claude 对上轮 issue 的逐条回应 + 修订后的主张),不必重发整包,省 token。⚠️ **resume 的 flag 集与 fresh 不同**:`exec resume` 接受 `--json`/`--output-schema`/`-o`/`-m`/`--skip-git-repo-check`,但**不接受 `-s`/`--cd`**(实测 0.135.0:传了报 `unexpected argument` 退出 2)。故 resume 轮必须省去 `-s`/`--cd`(沙箱与 cwd 从原 session 继承)。`buildCodexArgs` 已据此分支,`tests/codex-round.test.mjs` 有回归守护(mock 在 resume 下拒绝 `-s`/`--cd`)。
- **必须按 id,不能用 `--last`**(已实证,codex-cli 0.135.0):`resume --last` = 取**当前 cwd 下最近一条记录的 session**,它**只按 cwd 过滤、不区分 exec 与交互(`codex-tui`)会话**。我们的循环 `--cd <repo>` 跑在项目目录,用户若同时在同一目录手动开了 `codex`,`--last` 会**串到用户的交互会话**;本机还有 `codex-image-gen` 等也在调 codex。故只用捕获到的 `thread_id`。
- **id 捕获用 stdout in-band 解析**,不靠"找 `~/.codex/sessions` 下最新文件"——后者有并发写竞态,等于另一种 `--last` 陷阱。

### verdict schema

> ⚠️ codex 的 `--output-schema` 走 OpenAI 结构化输出的 **strict 模式**:每个 object 必须 `additionalProperties:false`,且 `required` 必须**列出 properties 的全部键**(实测 codex-cli 0.135.0:否则 `invalid_json_schema` 报错、turn.failed、退出 1、不写 verdict 文件)。故全部字段(含 `remaining_issues`、`severity`、`truncated`、`reviewed_scope`、`assumptions`)都在 `required` 中(AGREE 时 `remaining_issues` 为空数组)。`tests/verdict-schema.test.mjs` 对此做了 hermetic 守护。
>
> `truncated`/`reviewed_scope`/`assumptions` 用于防「截断范围下的误导性 AGREE」:Codex 若只看到部分材料须置 `truncated=true` 并写明范围;命令在收敛输出时会据此标注「非完整签核」。

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "remaining_issues", "rationale", "truncated", "reviewed_scope", "assumptions"],
  "properties": {
    "verdict": { "type": "string", "enum": ["AGREE", "CHANGES"] },
    "remaining_issues": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "detail", "severity"],
        "properties": {
          "title": { "type": "string" },
          "detail": { "type": "string" },
          "severity": { "type": "string", "enum": ["blocker", "major", "minor"] }
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
  schemas/verdict.schema.json        # verdict 结构化输出 schema(strict 模式)
  tests/                            # codex-round 单测 + 假 codex + schema strict 守护
  README.md / DESIGN.md / PLAN.md   # 文档
```

根 `marketplace.json` 的 `plugins` 数组追加:

```json
{ "name": "cc-codex-review", "source": "./cc-codex-review",
  "description": "Claude × Codex 收敛互审 — 两方迭代复核直到双方 AGREE" }
```

- 调用名:插件命令为 `/<插件名>:<命令名>`,即 `/cc-codex-review:review`(实现时验证能否省略命名空间)。
- 安装:`claude plugin marketplace add finyorke/claude-skills` → `claude plugin install cc-codex-review@fun-plugins`。
- 推送:走副账号 `finyorke`(SSH 别名 `github-finyorke` / `id_ed25519_finyorke`);当前 remote 为 HTTPS,push 前需处理鉴权。仅在用户明确要求时提交 / 推送;`main` 为默认分支,提交前先开分支。

## 10. 测试

LLM 循环难做单元测试,采用:

- **dry-run 模式**:打印组装好的评审包 + 将要执行的 `codex exec` 命令,但不真正调用。
- **冒烟测试**:对一个 trivial 仓库跑一轮,验证 verdict JSON 解析、AGREE/CHANGES 分支、停滞检测触发。
- 测试深度按用户需求伸缩。

## 11. 开放点与实测结论(codex-cli 0.135.0)

已实测确认(冒烟见 README / Task 7):
- ✅ **`thread_id` 捕获**:`codex exec --json` stdout 首行 `thread.started.thread_id` 为非空 UUID,in-band 拿到,可用于 resume。
- ✅ **`--json` + `--output-schema` + `-o` 共存**:三者并列可正常工作,verdict 通过 `-o` 落盘;前提是 schema 满足 strict 模式(见 §6 ⚠️)。最初的非 strict schema 会让 codex 报 `invalid_json_schema` 并退出 1、不写文件——已修复并加 `verdict-schema.test.mjs` 守护。
- ⚠️ codex 把 API 级错误写进 **stdout 的 `{"type":"error"}` / `turn.failed` 事件**(不是 stderr),且进程退出码为 1。脚本将这类「跑了但没产出合法 verdict」归为 `bad_verdict` 并带 `codex_exit`。

- ✅ **`exec resume` 的 flag 集**(自评 dogfood 实测发现并修复):`codex exec resume` **不接受 `-s`/`--cd`**(传了报 `unexpected argument` 退出 2),最初实现照搬 fresh flag 导致**多轮 resume 在真机 100% 失败**——单测因 mock 接受任意参数而漏检。已修:resume 轮省去 `-s`/`--cd`(沙箱/cwd 从原 session 继承),`--output-schema`/`-o`/`--json`/`-m`/`--skip-git-repo-check` 保留;mock 改为在 resume 下拒绝 `-s`/`--cd` 做回归守护。

- ✅ **多轮 resume 端到端**(真·多轮 dogfood 实测):round 1 fresh 抓 `thread_id` → round 2 `exec resume <id>` 成功(exit 0),且 Codex **保留了第 1 轮上下文**并接上第 2 轮增量;`--output-schema` 在 resume 轮语义级生效(`truncated`/`reviewed_scope`/`assumptions` 正确填充)。即 resume 不只是参数被接受,而是真按 schema 产出 verdict。

仍待实测:
- 插件 command 的实际调用名(`/cc-codex-review:review` 能否省略命名空间)—— 需安装后在 Claude Code 里确认。
- 大材料的分块评审策略尚为「摘要 + truncated 标注」,未实现自动分块。
