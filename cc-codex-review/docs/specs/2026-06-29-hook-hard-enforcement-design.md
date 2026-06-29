# 设计 spec:② Hook 硬强制收敛诚实性

- 日期:2026-06-29
- 状态:brainstorm 已对齐(方案 B,用户批准"直接做")
- 关联:DESIGN §12 ①(review-audit 独立重放,v0.13.0)、commands/review.md|do.md、scripts/review-audit.mjs
- 目标:用 **Claude Code Stop hook** 把"未经诚实收敛审计不得宣布 RESOLVED"从①的**缓解**升级为**回合级硬门禁**,缩小"运动员兼裁判"泄漏。

## 1. 问题与可行性边界(brainstorm 结论)

①(review-audit)能独立重放核验收敛,但**仍在 Claude 流程内、可被跳过**(Claude 不跑审计、直接文本写 RESOLVED 即逃逸)。要"硬",须借 Claude Code hook。

经 claude-code-guide 核实的**硬事实**:
- Hook **拦不了纯文本**——Claude 输出的 "RESOLVED" 不是工具调用,无 hook 因它触发。可拦的只有工具调用(PreToolUse deny)和**回合结束**(Stop hook `decision:block` 强制不让停 + 注入反馈)。
- **插件可自带 hook**(`<plugin>/hooks/hooks.json`),装上即自动生效、无需用户配置。
- Hook stdin 含 `transcript_path`/`session_id`/`cwd`,**能读会话 transcript**。

**已定决策(brainstorm)**:① 落点=**Stop hook 兜底**(回合结束时校验,不靠 Claude 主动调工具);② 范围=**插件自带、默认全局**;③ 判定=**精确优先·认哨兵**(只对"出现哨兵却无通过审计"block,几乎不误伤无关回合);④ 强度=**方案 B:hook 自己重跑 review-audit**(不信任何"已通过"声明,亲自从 raw Codex 产出独立重放)。

## 2. 架构(方案 B)

```
review 收敛 → 写 audit manifest 到临时文件 → §7 打印哨兵 <<CCR-RESOLVED manifest="…">>
                                                            │
回合结束 → Stop hook(插件自带,全局)──读 transcript──┐
  无哨兵 → exit 0(放行,非受控回合)                    │
  有哨兵 → 取 manifest 路径 → import review-audit 重放 ──┤
       audited_converged=true  → exit 0(放行 RESOLVED)
       false/证据无效/manifest 缺失 → exit 2 + {decision:block, reason} → 强制不让停
  hook 自身跑不起来(node 缺/transcript 不可读)→ exit 0(对全局 hook 基础设施失败 fail-open,不卡死用户整个 Claude Code)
```

## 3. 组件

### 3.1 哨兵(sentinel)
- review **当且仅当**宣布 RESOLVED 时,在 §7 输出一行机器可读哨兵:
  `<<CCR-RESOLVED manifest="<manifest 绝对路径>">>`
- 不收敛(UNRESOLVED)**不输出**哨兵。

### 3.2 audit manifest(落盘)
- review 在 §6 审计通过后,把 manifest 写到临时文件(如 `${TMPDIR}/cc-codex-review/manifest-<时间或随机>.json`)。
- 形状沿用 `review-audit.loadRounds` 所吃,外加 `kind` 标记:`{kind:"cc-codex-review-audit-manifest", claudeAgree:bool, rounds:[{round_index, codex_out, codex_out_sha256, claude_actions}]}`(只含 Claude 动作 + 每轮 raw `--out` 路径/哈希)。`kind` 供 hook 确认哨兵指向的确是本工具 manifest(修自审 I1 防误拦)。

### 3.3 Stop hook 脚本 `scripts/enforce-resolved-hook.mjs`
- 读 stdin JSON(`transcript_path`/`session_id`/`cwd`)。
- 读 `transcript_path`(jsonl),取**最后一条 assistant 消息**文本;**剥除代码块(```…```)后,仅当最后一行整行就是** `<<CCR-RESOLVED manifest="…">>` 才算受控(修自审 I1 防误拦:散文引用/代码块示例/非末行哨兵都不触发——开发讨论里粘哨兵不会误 block)。
- 无哨兵 → 打印 `{}`、exit 0(放行;**全局快路径**:绝大多数回合在此返回)。
- 有哨兵 → 取 manifest 路径,`import { loadRounds, auditRounds } from './review-audit.mjs'` 重放(并先校 `manifest.kind`):
  - `audited_converged===true` → exit 0 放行。
  - 否则(not converged / loadRounds 抛 evidence_invalid / manifest 读不到/坏 JSON)→ **exit 2 + stdout `{"decision":"block","reason":"<detail>"}`** 强制不让停,提示"独立重审未通过,请修正后重跑或改结论为 UNRESOLVED 并撤下哨兵"。
- **基础设施失败 fail-open**:hook 脚本自身异常(读 transcript 失败、import 失败)→ exit 0(不 block)。**判据:能跑出审计结论才 block;跑不起来不 block**——避免全局 hook 把用户整个 Claude Code 卡死。
- 性能:无哨兵即返回,只做一次 transcript 读 + 一次 grep,开销极小。

### 3.4 hooks/hooks.json
```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/enforce-resolved-hook.mjs\"" } ] } ] } }
```
(SubagentStop 同理可加;MVP 先 Stop。)

### 3.5 review.md / do.md §7
- RESOLVED 分支:§6 审计通过后 → 写 manifest 临时文件 → 打印哨兵。审计未过 → 不打印哨兵、走 UNRESOLVED。
- **do.md 不接入**:do **不宣布 RESOLVED**(只返回成果 + Codex 复核),无哨兵可 gate,故 ② **只覆盖 review 的 RESOLVED 声明**;do 的收敛诚实性靠 ①(review-audit 可用)但不经本 hook 强制。不强行给 do 塞哨兵(避免虚称已接入)。

## 4. 诚实边界(必须在 DESIGN 写明,不夸大)

② 是**显著提高门槛、非 bulletproof**。残余:
- **不出哨兵 + 散文写 RESOLVED → 逃逸**(命令 prompt 要求出哨兵,跳过=主动违规;hook 只认哨兵故无法拦)。
- **指向旧的通过 manifest 重放**:若旧 raw `--out` 文件仍在且哈希匹配,重审会过——未绑定到"本次评审材料"(临时文件易失可缓解,非根除)。
- **manifest 漏报末尾轮**(①的受信边界残余仍在;round_index 只挡内部抽轮)。
- **基础设施 fail-open**:故意弄坏 hook 环境可逃逸(为不卡死全局而接受)。
- 伪造通过需**连 raw Codex 落盘一起骗**(难,但理论可能)。

净效果:从"随手就能假 RESOLVED"变成"必须主动造假(撤哨兵/伪造 hash 匹配的 raw 产出/弄坏 hook 环境)"。常见/偷懒路径被回合级硬门挡住。彻底闭合需运行时外部 runner / 真盲审,门槛更高、本期不做。

## 5. 验收

- `enforce-resolved-hook.mjs`:无哨兵→exit0;哨兵+通过 manifest→exit0;哨兵+不通过(raw rejected)→exit2+block;哨兵+manifest 缺失/坏→exit2;transcript 不可读→exit0(infra fail-open);哨兵解析正确取 manifest 路径。单测覆盖。
- review.md:RESOLVED 出哨兵 + 写 manifest(含 kind);UNRESOLVED 不出哨兵。**do.md 不接入**(do 不宣布 RESOLVED、无哨兵可 gate)。
- 不破坏现有 review-audit/review-state 纯函数边界(hook import 复用,不改其逻辑)。

## 6. 不做(YAGNI / 后续)
- SubagentStop 暂可跟 Stop 同脚本;PreToolUse 终结工具门(A 路线)不做。
- do §4 分歧轮门禁、把哨兵绑定到本次材料指纹、外部 runner 硬强制、真盲审 agent —— 后续。
