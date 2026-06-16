# 设计 spec:强制真用 Codex(会话核对 + 收敛门禁)

- 日期:2026-06-19
- 状态:**已实现,但实现时降级**——见下「实现修订」
- 关联:DESIGN §12;@cc-codex-review/scripts/review-state.mjs、commands/review.md、commands/do.md

> **⚠️ 实现修订(2026-06-19,自举核对后):收敛门禁 → 软信号**
> 本 spec 原设计的 §3.2 **收敛硬门禁**(`verifiedCodexRounds < 1` 拒 RESOLVED)在自举核对中被推翻:实测 **codex 偶发不落盘 rollout**(当前版本通常落、历史记录多在,但某些后台调用没落、resume 亦报 no-rollout;排除磁盘/权限,根因未定)。硬门禁会**错杀真互审**(真调了 Codex 却因没落盘被判 verified=0、拒 RESOLVED)。故**降级为软信号**:`verify-codex-session` 仍跑、结果仍附 §7,但 **`missing` ≠ 假互审**——不挡收敛、不判不可信,仅提示人工留意;`verified` 是"真调了 Codex"的证据。`converge` 不再接受 `verifiedCodexRounds` 参数。下文 §3.2/§3.3/§4/§5 保留原设计供溯源,以本修订为准。

## 1. 问题
`review` / `do` 是 **prompt 级软约束**——只是叮嘱 Claude 去调 Codex 互审,没有任何东西**强制或验证**。Claude 可能(图省事或上下文紧张时)**自己 review、跳过真正的 Codex 调用**,却把结论说得像互审过。这架空了工具的核心价值(两个不同 AI 互审)。

## 2. 抓手(不可伪造的真痕迹)
codex 每次 `codex exec` 都在 `$CODEX_HOME/sessions/年/月/日/rollout-<时间>-<thread_id>.jsonl` 留完整会话记录,**文件名直接带 thread_id**(已实测验证)。codex-round.mjs 返回 codex 给的真 thread_id(UUIDv7)。Claude **编不出**一个"真存在于 sessions 里"的 thread_id → 用它核对"是否真调了 Codex"。

## 3. 设计

### 3.1 新脚本 `scripts/verify-codex-session.mjs`(纯函数 + 薄 CLI + 单测)
- 导出 `verifySessions(threadIds, opts)`:对每个 thread_id,在 sessions 根(`opts.codexHome || $CODEX_HOME || ~/.codex` 下的 `sessions/`)**递归查找文件名匹配 `*-<thread_id>.jsonl`** 的记录,存在 = verified。
- **安全**:thread_id 必须是合法 UUID(复用 codex-round 的 `isValidThreadId` 正则);非 UUID 直接判 missing、**不参与文件名匹配**(防路径遍历/注入)。
- 返回 `{ ok:true, verified:[...], missing:[...] }`;CLI 走 stdin JSON `{threadIds:[...], codexHome?}` → stdout JSON(与其它脚本一致)。
- 只核对**文件存在性**,不解析 session 内容(YAGNI)。

### 3.2 收敛门禁(`review-state.mjs` 的 `converge`/`canConverge`)
- 新增要求:**本次 verified 的 codex thread_id 数 ≥ 1** 才允许 `RESOLVED`;为 0 → 拒绝收敛(fail-closed,挡"没真调 Codex 却判 RESOLVED")。
- review-state 是纯函数、不碰 IO:`converge` 接收一个 `verifiedCodexRounds`(整数,由调用方先跑 §3.1 得到)作为门禁输入;`< 1` 即拒。真实性靠"调用方必须真跑 verify-codex-session"(协议)+ 用户可独立复核。

### 3.3 协议(`review.md` / `do.md`)
- 每轮 codex-round 返回的 `thread_id` 累积记录。
- **收尾前必须调 `verify-codex-session`** 核对所有 thread_id。
- §7 输出**必须附**:本次 codex `thread_id` 列表 + 核对结果(`verified` / `missing`)。
- 若 `missing` 非空、或一个 verified 都没有 → 结论顶部显式标 **「⚠️ 未经真实 Codex 互审核实,结论不可信」**,且不得判 RESOLVED(§3.2 门禁)。

### 3.4 范围
只约束"**声称用了 Codex**"的 `review` / `do`。`extract-reqs`(纯 Claude 从对话提取需求、本就不调 Codex)**不涉及**。

## 4. 诚实边界
这让"假互审"**可被一键核对、造假成本很高**(要伪造就得在 `~/.codex/sessions` 造出带合法 UUID 的假记录文件)。但因为整个流程仍是 **Claude 驱动**,**不是 100% 强制**——Claude 仍可能不调 verify、或不附结果、**或塞一个历史真 thread_id 冒充本轮**(verify 只证 thread_id 在 codex 历史存在过、不证本次新跑)。故对外措辞应是"**提高假互审成本、使其可被核对**",而非"杜绝/防住"。**真正的硬强制需 Claude Code hook(harness 层)**,留作后续(C 档,本 spec 不做)。

## 5. 验收标准
- `verifySessions`:真实存在的 thread_id → verified;不存在的 / 非 UUID → missing;空输入 → 空 verified;用 fixture sessions 目录单测。
- `converge`:`verifiedCodexRounds=0` → 拒 RESOLVED;`≥1` 且其余条件满足 → 允许。单测覆盖。
- review/do 收尾按 §3.3 附 thread_id + 核对结果;missing/全无时标"不可信"且不收敛。

## 6. 不做(YAGNI)
- 不做 hook 硬拦(后续 C 档);
- 不解析 session 内容、不校验 session 与本次 packet 的对应关系(只核对 thread_id 文件存在);
- 不改 codex-round 的调用方式。
