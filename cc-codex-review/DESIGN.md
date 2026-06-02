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
  -s read-only \
  [--cd <repo>] [--skip-git-repo-check] \
  [-m <model>] \
  --output-schema <verdict.schema.json> \
  -o <last.json> \
  "<对抗复核指令>"  < packet.txt
```

- `-s read-only`:只读沙箱 —— Codex 能读文件、跑 git,但**绝不能写**(复核专用,安全)。
- `--cd <repo>`:`--repo` 给定时设为工作根;否则加 `--skip-git-repo-check` 并在 cwd 跑(纯文本 / diff 评审)。
- `--output-schema` + `-o`:Codex 输出结构化 verdict,AGREE 判定可靠(不靠字符串匹配)。`-o` 写入最终消息文件,便于捕获。
- `-m <model>`:`--model` 给定时传入。

### 跨轮记忆:resume by id(防不收敛 + 防串会话)

Codex 是对抗式的、又默认无硬上限,若每轮失忆重读,可能反复重提已被说服的点而**永不收敛**。故循环内让 Codex 保持立场记忆:

- **第 1 轮**:fresh `codex exec --json ...`,发送完整评审包。从 stdout **第一行** `{"type":"thread.started","thread_id":"<UUID>"}` 解析并保存 `thread_id`(不可用 `--ephemeral`,否则无法 resume)。
- **第 2 轮起**:`codex exec resume <thread_id> ...` 按 **id** 续接,只发**增量**(Claude 对上轮 issue 的逐条回应 + 修订后的主张),不必重发整包,省 token。
- **必须按 id,不能用 `--last`**(已实证,codex-cli 0.135.0):`resume --last` = 取**当前 cwd 下最近一条记录的 session**,它**只按 cwd 过滤、不区分 exec 与交互(`codex-tui`)会话**。我们的循环 `--cd <repo>` 跑在项目目录,用户若同时在同一目录手动开了 `codex`,`--last` 会**串到用户的交互会话**;本机还有 `codex-image-gen` 等也在调 codex。故只用捕获到的 `thread_id`。
- **id 捕获用 stdout in-band 解析**,不靠"找 `~/.codex/sessions` 下最新文件"——后者有并发写竞态,等于另一种 `--last` 陷阱。

### verdict schema (草案)

```json
{
  "type": "object",
  "required": ["verdict", "rationale"],
  "properties": {
    "verdict": { "type": "string", "enum": ["AGREE", "CHANGES"] },
    "remaining_issues": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["title", "detail"],
        "properties": {
          "title": { "type": "string" },
          "detail": { "type": "string" },
          "severity": { "type": "string", "enum": ["blocker", "major", "minor"] }
        }
      }
    },
    "rationale": { "type": "string" }
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
- `--repo` 指向非 git 仓库 → 退化为文本评审 + 警告(或 `--skip-git-repo-check`)。
- Codex 输出不合 schema → 重试一次;再失败则原样呈现给用户。
- 对话里找不到待审材料、也没传任何输入 → Claude **问用户**评审什么(不瞎猜)。
- 评审包过大 → Claude 摘要 + 显式说明截断(§5)。

## 9. 打包与安装

布局(加进 `finyorke/claude-skills` 仓库):

```
cc-codex-review/
  .claude-plugin/plugin.json        # name, version, description, author
  commands/review.md                # 命令体 = Claude 执行的互审协议
  schemas/verdict.schema.json        # verdict 结构化输出 schema (可选,或内联生成)
  DESIGN.md                          # 本设计文档
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

## 11. 待实现时验证的开放点

- 插件 command 的实际调用名(`/cc-codex-review:review` 能否简化)。
- `codex exec --output-schema` 在当前 codex 版本的行为是否稳定;不稳则回退到纯文本 "VERDICT: AGREE/CHANGES" 约定 + 解析。
- 评审包经 stdin 传入与 prompt 参数的组合行为(stdin 作 `<stdin>` 块附加)。
- **`--json` 与 `--output-schema` / `-o` 的共存**:首轮要同时用 `--json`(拿 `thread_id`)和 `--output-schema` + `-o`(拿结构化 verdict)。已知三者命令行可并列;待确认 `--json` 模式下最终 verdict 仍能通过 `-o` 落盘(或改为直接从 `--json` 流的末条 `item.completed.agent_message` 解析)。
- **`resume <thread_id>` 是否完整保留 `--output-schema` / 沙箱设置**:resume 续接时需重新带上 `-s read-only --output-schema ...`;待确认这些 flag 在 resume 子命令下行为一致。
- **降级**:若任一环节(id 捕获 / resume)在实测中不稳,降级为「每轮 fresh、整包重发、无 resume」并向用户告警「对抗式 + 无硬上限下可能不收敛,建议设 `--max-rounds`」。
