# 设计 spec:决策日志(decisions-log)—— 给 Codex 稳定的跨轮上下文基线

- 日期:2026-06-27
- 状态:**brainstorm 已批准,待用户审 spec**
- 关联:DESIGN §12;commands/do.md、commands/review.md;新增 scripts/decisions-log.mjs

## 1. 问题

连续多轮使用 `do` / `review` 时,**Codex 拿不到应有的跨轮上下文**。机制根因(纯插件层,见 DESIGN「上下文模型」):

- Codex 是独立进程,每轮只能看到 **当轮 packet** + `--repo` 可读的磁盘文件,**看不到** Claude↔用户对话。
- 每条 `/do`、`/review` 开**全新 Codex 线程、零跨轮记忆**(命令内多轮靠 `--resume`,跨命令则全新)。
- 因此凡是「**对话里定下、但没落盘**」的软知识(已定决策、约束、被否决的备选、仍未谈拢的分歧),Codex 默认丢失。

注意区分:**Claude 自己的跨轮上下文由 Claude Code 原生维护、不缺**(短期无损;仅长会话 compaction 时退化)。本设计**不是**为救 Claude 的记忆,而是给 **Codex** 一份稳定、独立、可检视、不随每轮 packet 取舍漂移的基线。

## 2. 抓手

把「软知识」**强制落盘到被操作项目的 repo**,让 Codex 每轮经 `--repo` 直接读到——磁盘是插件唯一可靠的跨轮通道。落盘内容仅限**决策/约束日志**(HOW 类软知识),不重复已在代码/已在 `extract-reqs` 需求文档(WHAT)里的东西。

## 3. 设计

### 3.1 文件(位于 `--repo` 根下的 `.cc-codex-review/`)

- `.cc-codex-review/decisions.jsonl` —— 结构化数据,一行一条 entry(append 友好、git 可 diff)。
- `.cc-codex-review/decisions.md` —— 由脚本从 jsonl **渲染**的可读视图,**Codex 实际读的是它**(也供用户/git 审阅)。

### 3.2 entry 结构(jsonl 每行一个 JSON)

```json
{
  "id": "D1",
  "status": "decided" | "open",
  "statement": "<决策/约束;或未决问题>",
  "rationale": "<为何(decided 用)>",
  "positions": { "claude": "<…>", "codex": "<…>" },   // open 用
  "severity": "blocker" | "major" | "minor",            // open 用(复用 verdict 口径)
  "source": "do" | "review",
  "ts": "<ISO 时间>",
  "supersedes": ["D0"]                                   // 可选:本条取代了旧决策
}
```

- **id 全局唯一、跨轮稳定**:`append` 时由脚本自动分配下一个空闲 `D<n>`(避免 Claude 撞号);`set-status`/`upsert` 按已存在 id 引用。
- **状态语义**:`decided` = 当轮双方 AGREE 且 Codex 确认;`open` = 仍未谈拢(到顶/停滞/被打断),带双方立场 + 严重度。
- **可演进**:某 `open` 在后续轮谈拢 → `set-status` 翻成 `decided`(不堆重复条)。决策被推翻 → 新 entry 用 `supersedes` 指向旧 id。

### 3.3 脚本 `scripts/decisions-log.mjs`(纯函数 + 薄 CLI + 单测,沿用现有风格)

- **纯函数(无 IO,可测)**:
  - `applyOps(entries, ops)`:施加 append(自动分配 id)/ set-status / supersede,返回新 entries。
  - `validate(entries)`:id 唯一、`status` 枚举、按状态必填(decided 需 rationale;open 需 positions+severity)、`supersedes` 不悬空(指向存在的 id)。
  - `renderMarkdown(entries)`:渲染 `decisions.md`(分「✅ 已定」「❌ 未决」两段)。
- **CLI(负责 IO,读写上述两文件)**:`read`(返回当前 entries,供 Claude 载入基线)、`upsert`(应用 ops + 写 jsonl + 重渲染 md)、`render`、`validate`。**实现修订**:`set-status` 不做独立子命令,而作为 `upsert` 的一种 op(`{op:"set-status",id,status}`)——单一写入口=单次校验 + 原子写,优于多入口。stdin JSON → stdout JSON,与其它脚本一致;坏输入(损坏 jsonl、撞号、缺字段)**显式报错并非零退出**,不带病写。

### 3.4 渲染格式(decisions.md,Codex 读这个)

```
# 决策日志(cc-codex-review · 自动维护)
> 每轮 do/review 收敛后追加。DECIDED=双方已确认的基线;OPEN=仍未谈拢。供 Codex 跨轮读取。

## ✅ 已定决策/约束
- [D1] <statement> — 理由:<rationale>  (do · 2026-06-27)

## ❌ 未决(开放分歧)
- [D3] <statement> · 严重度:major · Claude:<…> / Codex:<…>  (review · 2026-06-27)
```

### 3.5 接进 do.md / review.md

- **开头**:调 `read` 载入当前日志作本轮基线(Codex 同时经 `--repo` 读到 `decisions.md`)。
- **收尾**:Claude 把本轮 entry(已定 + 未决)放进**最后一个 packet**;Codex 确认「**记录如实反映刚才状态**」(decided=确实达成、open=立场记对了——**不是**让 Codex 对内容表态同意)→ 确认后 Claude 调 `upsert` 落盘 + 重渲染。
- **review 的 UNRESOLVED 三段映射**:✅ 已达成→`decided`;❌ 仍未达成→`open`;🔶 待复核(Claude 已回应、Codex 未确认)**先不落**,等下轮定。

### 3.6 边界

- 首次运行自动建 `.cc-codex-review/` 目录与空文件。
- `review --repo none`(纯文本评审,无 repo 可写)→ **跳过日志**(不报错)。
- **不自动 `git commit`**(不擅动用户仓库);是否提交由用户决定,do/review 收尾可提示一句。
- 写入由 Claude 驱动(Codex 只读),故日志**仍是 Claude 写的**——Codex 的确认 + 用户可审阅 + git 可 diff 是其可信度来源,**非完全独立**;但持久、可检视、不逐轮漂移,显著优于临时 packet 取舍。

## 4. 验收标准

- `applyOps`:append 自动分配唯一递增 id;set-status 翻 open→decided;supersede 记录关系。单测覆盖。
- `validate`:撞号 / 坏状态 / 缺必填 / 悬空 supersedes → 各报对应错误。单测覆盖。
- `renderMarkdown`:decided/open 分两段、字段齐全、空日志给占位。单测覆盖。
- CLI:`upsert` 后 jsonl 与 md 一致、`read` 往返一致;坏输入非零退出。单测覆盖。
- do.md / review.md:收尾按 3.5 写入并经 Codex 确认;`--repo none` 跳过;UNRESOLVED 三段按 3.5 映射。

## 5. 不做(YAGNI)

- 不做完整运行设计/状态镜像(路线 B)、不做对话要点镜像(路线 C)——只记决策/约束软知识。
- 不扩展/破坏 review-state 的「纯函数无 IO」不变量(路线 3 已否);decisions-log 是独立脚本。
- 不做跨轮 Codex 线程续用(另一条可选改进,与本设计正交,本期不做)。
- 不自动提交、不解析/校验决策与代码的对应关系。

## 6. 诚实边界

这给 Codex 补上「磁盘可靠跨轮通道」里的软知识,使连续 do/review 时它不再丢「已定/未决」上下文。但:① 日志由 Claude 写,可信度靠 Codex 确认 + 用户审 + git diff,非独立来源;② 只覆盖落盘的软知识,Claude 若收尾不写、或写不全,仍会漏(收尾写入是 prompt 级软约束);③ 不替代 spec/DESIGN——是更细粒度、自动维护的决策流水。
