# 会话交接 — cc-codex-review 真实 dogfood 观测(进行中)

> 写给 compact 之后的我。目标:无缝接上"观察 kk_notify 真实执行插件、找改进点"这件正在做的事。

## 0. 一句话现状
cc-codex-review 插件已迭代到 **v0.12.1**(已推 main + 部署到本机当前会话)。**当前任务:用 kk_notify 项目做真实 dogfood**——用户在 **kk_notify 的 Claude session** 里逐 phase 跑 `/cc-codex-review:review`,**我在本(claude-skills)session 读 kk_notify 的 transcript,观察插件实际执行过程、找可提升点**。一次一个 phase:用户跑 → 我读记录分析 →(必要时改插件)→ 下一个。

## 1. 当前任务(最重要,进行中)

### 工作流(注意:不是我驱动,是观察)
- **用户**在 kk_notify session 执行 `/cc-codex-review:review`(那边的 Claude 真实跑插件)。
- **我**读 kk_notify session 的 jsonl transcript,检查:
  1. 插件协议是否被正确执行:组评审包 → 逐轮 codex-round → review-state 记账(validate-round→reduce→validate-state→converge)→ 终止判定 → §7 输出 → **决策日志写回** → verify 软信号;
  2. 0.12.x 新功能在真实会话里顺不顺:**默认 `--repo .`**、**决策日志载入/写回**(`.cc-codex-review/decisions.{jsonl,md}`)、**verify-codex-session**(thread_id 核对 + paths);
  3. 哪一步让执行的 Claude 卡壳 / 绕路 / 漏做 = **插件要改的地方**。

### 已发出的 P1 输入(用户已在 kk_notify 跑起来,跑完会回来说)
```
/cc-codex-review:review 评审博主荐股 Phase 1(数据底座+名录,合并提交 e85b5f8)的实现质量,重点看:4 张表的核心约束是否真落实(还是只在应用层)、dedup 的 NULL 边界、名录内存索引的并发/原子性、manual 端点的越权面
```

### 怎么读 kk_notify 的 transcript
- 路径:`~/.claude/projects/-Users-fun-D-Projects-service-deploy-kk-notify/*.jsonl`(**最大的那个**是主 session)。
- 抽取技巧:node 解析 jsonl,过滤 `type` ∈ {user,assistant},打印 assistant 的 text + tool_use(尤其 Bash 里调 `codex-round`/`review-state`/`verify-codex-session`/`decisions-log` 的命令)+ tool_result 里含 `thread_id`/`verdict`/`converged`/`verified` 的行。用 `grep -n "你要执行一次「Claude × Codex"` 定位 review 调用起点。
- 之前用同法分析过那次 `do` 执行,挖出 verify-CLI 只吃 stdin 的 bug + 漏 `--repo`——同样套路。

### kk_notify 各 phase → merge 提交(界定范围用)
项目在 `/Users/fun/D/Projects/service_deploy/kk_notify`(git,backend 有 tests)。
P1=`e85b5f8` / P2=`fa145fb` / 回链=`cac2903` / P3=`6ecff85` / P4=`b498f5f` / P5=`8d9a2ed` / 自动AI+AC=`dfbd478` / key屏蔽=`cb3701e`。

### 我自己 dry-run P1 的交叉参考(供与用户真实执行对比)
我在本会话自己当驱动跑过 P1(`codex-round --repo kk`),Codex `CHANGES` 6 条,我评估 **5 真 1 假**:
- **真**:① `blogger_record` 两条核心不变式(code/sector 至少一、stance/operation 至少一)只在 `create_record` 应用层挡、**无 DB CHECK**(major);② dedup 来源契约(manual 须 NULL、rule/ai 须非 NULL)同样只应用层(major);③ `InstrumentIndex.rebuild` 非原子(三 dict + AC 分开赋值,并发读混代,HEAD 仍在,minor~major);④ 全量导入不把"本次缺失的旧名录"置 inactive(退市股永久 active,minor);⑤ manual 端点缺 HTTP 层跨用户负路径测试(minor)。
- **假(scope artifact)**:每日 16:30 cron——P1 提交里没有,但 Phase 3 的 `88787ff` 已加(HEAD 有 `refresh_instruments_job` @scheduler.py:530)。
- **监测要点(可能的插件改进)**:按"单 phase 提交"界定范围 → Codex 把**后续 phase 才补的东西报成"缺失"**(假问题)。观察用户真实执行时 kk 的 Claude 是否也踩;**可能要改 review 协议**:对历史提交评审时提示"标注/排除后续已补的项",或建议改审当前 HEAD 状态。

## 2. 插件现状(cc-codex-review v0.12.1)
- 位置:`/Users/fun/D/Projects/claude-skills/cc-codex-review/`。marketplace 克隆:`~/.claude/plugins/marketplaces/fun-plugins/`(HTTPS clone of finyorke/claude-skills);运行缓存:`~/.claude/plugins/cache/fun-plugins/cc-codex-review/<ver>/`。
- **三命令**:`do`(协作执行,Claude 动手+Codex 只读把关)、`review`(收敛互审)、`extract-reqs`(需求提取)。
- **脚本**(纯函数+CLI+单测,**全量 191 绿**):`codex-round` / `review-state` / `metrics` / `experiment` / `lens-parse` / `verify-codex-session` / **`decisions-log`(新)**。测试:`node --test cc-codex-review/tests/*.test.mjs`。
- **只读铁律 CR-SEC-001**:fresh `-s read-only`;resume `-c sandbox_mode="read-only"` + `approval_policy="never"` + `--ignore-rules`。
- **verify 软信号**:`verify-codex-session.mjs` 核对 thread_id 真有 rollout(`~/.codex/sessions`),返回 `verified/missing/paths`;**不挡收敛**(机制可绕、真强制需 hook)。CLI 兼收位置参数 + stdin JSON。
- **决策日志**(v0.12.0/.1):`decisions-log.mjs` 把 do/review 定下的决策/约束落盘 `.cc-codex-review/decisions.{jsonl,md}`(被操作项目里),经 `--repo` 给 Codex 当**跨轮基线**。entry 有 `decided/open` 状态;open 谈拢→`set-status` 带 rationale 原地翻;被 supersede 的条目渲染时隐藏。收尾经 Codex 确认后 `upsert`。
- **默认 `--repo .`**(v0.11.1):do/review 不给 `--repo` 默认当前目录;review 纯文本评审用 `--repo none` 退出。

## 3. 本次会话已完成(已全部推 main,最新 `bd936ad`)
- verify-codex-session:返回 rollout 路径(方案 B)+ CLI 位置参数/坏输入显式报错。
- do/review 默认 `--repo .`。
- **决策日志全功能**:brainstorm→spec(`docs/specs/2026-06-27-decision-log-design.md`)→plan(`docs/plans/2026-06-27-decision-log.md`)→subagent-driven 实现→真机 `/review` 2 轮收敛(Codex 抓 I1/I2/I3 真问题,已修)→合并推送。
- 未打 tag(用户明确说不用)。

## 4. 部署 / 推送备忘
- **推送**:`GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_finyorke -o IdentitiesOnly=yes" git push git@github.com:finyorke/claude-skills.git HEAD:main`(SSH 别名 github-finyorke 可能不解析,见 memory)。
- **部署到本机**:`git -C ~/.claude/plugins/marketplaces/fun-plugins pull` → 用户 `/plugin` 更新 + `/reload-plugins`。

## 5. backlog(都卡外部输入 / 暂缓)
- #8 correctness/requirements 镜头验证(需真实任务)
- #13 ≥3 配对任务 A/B + 跨任务 aggregate(本次 dogfood 顺带产样本)
- #14 真人盲评(需真人)
- #10 full-P4 并行聚合(主动暂缓,高门槛)

## 6. 用户偏好(memory 已存,务必遵守)
- **汇报要短、挑重点**,别长表格/多段/术语堆砌。
- 要**对抗式 dogfood + 独立/盲核**再提交;**诚实的负面结果有价值**(别粉饰)。
- push 用 `id_ed25519_finyorke` key + github.com URL。

## 7. 下一步(compact 后立即做)
等用户说"P1 跑完了"→ 读 kk_notify transcript 里这次 review 的执行段 → 按 §1 三项检查输出"插件改进点" → 跟用户确认要不要改 → 改完继续 P2(输入同式,换 phase 名+提交号)。
