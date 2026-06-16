# 强制真用 Codex(会话核对 + 收敛门禁)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 按任务执行(建议 inline,Task 5 验收依赖真机 codex sessions)。步骤用 `- [ ]` 跟踪。

**Goal:** 让 `review`/`do` 的"调了 Codex"可被核实——新增 `verify-codex-session.mjs`(查 `~/.codex/sessions` 核对 thread_id),`review-state.converge` 加"verified≥1 才许 RESOLVED"门禁,review/do 收尾必附 thread_id+核对结果。

**Architecture:** 确定性逻辑进 `scripts/` + 单测(verify-codex-session、converge 门禁);协议在 commands 的 prompt。

**Tech Stack:** Node(fs readdirSync recursive)+ node:test;复用现有 review-state 协议。

依据 spec:@cc-codex-review/docs/specs/2026-06-19-codex-session-enforcement-design.md。

---

### Task 1: `scripts/verify-codex-session.mjs` + 单测(TDD)

**Files:** Create: `cc-codex-review/scripts/verify-codex-session.mjs` · `cc-codex-review/tests/verify-codex-session.test.mjs`

- [ ] **Step 1: 写失败测试** `tests/verify-codex-session.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySessions } from '../scripts/verify-codex-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/verify-codex-session.mjs');
const UUID = '019ecfa7-a9d6-7261-8a73-14f52339f0af';

function fixtureHome(withSession) {
  const home = mkdtempSync(join(tmpdir(), 'codexhome-'));
  if (withSession) {
    const d = join(home, 'sessions', '2026', '06', '19');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `rollout-2026-06-19T16-58-52-${UUID}.jsonl`), '{}\n');
  }
  return home;
}

test('真实存在的 thread_id → verified', () => {
  const r = verifySessions([UUID], { codexHome: fixtureHome(true) });
  assert.deepEqual(r.verified, [UUID]);
  assert.deepEqual(r.missing, []);
});

test('不存在的 thread_id → missing', () => {
  const r = verifySessions(['019e0000-0000-7000-8000-000000000abc'], { codexHome: fixtureHome(true) });
  assert.equal(r.verified.length, 0);
  assert.equal(r.missing.length, 1);
});

test('非 UUID(含路径遍历尝试)→ missing,不参与匹配', () => {
  const r = verifySessions(['../../etc/passwd', 'not-a-uuid'], { codexHome: fixtureHome(true) });
  assert.deepEqual(r.verified, []);
  assert.equal(r.missing.length, 2);
});

test('sessions 目录不存在 → 全 missing,不抛', () => {
  const r = verifySessions([UUID], { codexHome: mkdtempSync(join(tmpdir(), 'empty-')) });
  assert.deepEqual(r.missing, [UUID]);
});

test('非数组输入 → bad_input', () => {
  assert.equal(verifySessions(null).ok, false);
});

test('CLI: stdin {threadIds,codexHome} → JSON', () => {
  const home = fixtureHome(true);
  const out = execFileSync('node', [SCRIPT], { input: JSON.stringify({ threadIds: [UUID], codexHome: home }), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim()).verified, [UUID]);
});
```

- [ ] **Step 2: 跑测试看失败** `node --test cc-codex-review/tests/verify-codex-session.test.mjs`(Expected: FAIL,模块不存在)

- [ ] **Step 3: 写实现** `scripts/verify-codex-session.mjs`

```javascript
#!/usr/bin/env node
// verify-codex-session.mjs — 核对 codex thread_id 是否真有会话记录(防 review/do 假互审,见 DESIGN §12)。
// codex exec 每次在 $CODEX_HOME/sessions/年/月/日/rollout-<时间>-<thread_id>.jsonl 留记录。
// 只核对**文件存在性**(不解析内容):thread_id 能找到对应 .jsonl = verified。
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const isUuid = (s) => typeof s === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);

// 纯函数:{ok, verified:[...], missing:[...]}。安全:非 UUID 直接 missing,绝不拿去匹配文件名(防遍历/注入)。
export function verifySessions(threadIds, opts = {}) {
  if (!Array.isArray(threadIds)) return { ok: false, error: 'bad_input', detail: 'threadIds 须为数组' };
  const root = opts.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
  const sessionsDir = join(root, 'sessions');
  let files = [];
  try {
    if (existsSync(sessionsDir)) files = readdirSync(sessionsDir, { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.jsonl'));
  } catch { files = []; }
  const verified = [], missing = [];
  for (const id of threadIds) {
    if (isUuid(id) && files.some((f) => f.includes(id))) verified.push(id);
    else missing.push(id);
  }
  return { ok: true, verified, missing };
}

function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const raw = await readStdin();
  let inp; try { inp = raw.trim() ? JSON.parse(raw) : {}; } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'bad_json' }) + '\n'); process.exit(2); }
  const out = verifySessions(inp.threadIds || [], { codexHome: inp.codexHome });
  process.stdout.write(JSON.stringify(out) + '\n');
  if (!out.ok) process.exit(2);
}
```

- [ ] **Step 4: 跑测试看通过** `node --test cc-codex-review/tests/verify-codex-session.test.mjs`(Expected: PASS)
- [ ] **Step 5: 提交** `git add cc-codex-review/scripts/verify-codex-session.mjs cc-codex-review/tests/verify-codex-session.test.mjs && git commit -m "feat(cc-codex-review): verify-codex-session — 核对 thread_id 真有会话记录(防假互审)"`

---

### Task 2: `review-state.converge` 加 verified 门禁 + 单测

**Files:** Modify: `cc-codex-review/scripts/review-state.mjs`(converge/canConverge)· `cc-codex-review/tests/review-state.test.mjs`

- [ ] **Step 1: 先读现状** —— 读 `scripts/review-state.mjs` 里 `canConverge`/`converge` 的签名与返回结构(它已是 fail-closed:open/candidate 非空、claudeAgree!==true 即拒)。门禁要**加一个输入** `verifiedCodexRounds`(整数,调用方先跑 Task 1 得到 verified 数),`< 1` 即拒收敛。

- [ ] **Step 2: 写失败测试**(追加到 `tests/review-state.test.mjs`;用该文件已有的 converge 调用风格构造一个"其它条件都满足"的 state)

```javascript
test('converge 门禁:verifiedCodexRounds<1 → 拒 RESOLVED(防假互审)', () => {
  // 构造一个 open/candidate 均空、claudeAgree=true、codexVerdict=AGREE 的可收敛 state
  const okState = { round: 1, points: [] };
  const base = { state: okState, codexVerdict: 'AGREE', claudeAgree: true };
  // verified=0 → 拒
  const r0 = converge({ ...base, verifiedCodexRounds: 0 });
  assert.equal(r0.canConverge, false);
  // verified>=1 → 允许
  const r1 = converge({ ...base, verifiedCodexRounds: 1 });
  assert.equal(r1.canConverge, true);
});
```
(若 `converge` 当前签名/字段名不同,按 Step 1 读到的实际接口对齐——保持"verified<1 拒、>=1 允许"的断言意图。)

- [ ] **Step 3: 跑测试看失败**;**Step 4: 在 converge 加门禁**——读入 `verifiedCodexRounds`(默认 0,fail-closed),在现有"open/candidate 空 + claudeAgree" 判定基础上 `&& verifiedCodexRounds >= 1`;`< 1` 时返回 `canConverge:false` + reason `未经核实的 Codex 互审(verified codex 轮=0)`。CLI 的 converge 入口同步读该字段。

- [ ] **Step 5: 跑全测 + 提交** `node --test cc-codex-review/tests/*.test.mjs` → 全绿;`git commit -m "feat(cc-codex-review): converge 加门禁——verified codex 轮<1 拒 RESOLVED(防假互审)"`

---

### Task 3: review.md / do.md 协议接入

**Files:** Modify: `cc-codex-review/commands/review.md`(§6/§7)· `cc-codex-review/commands/do.md`(§6/§7)

- [ ] **Step 1: review.md** —— §6 每轮记下 codex-round 返回的 `thread_id`;**收敛前必须**把所有 thread_id 作 `{threadIds:[...]}` 喂 `${CLAUDE_PLUGIN_ROOT}/scripts/verify-codex-session.mjs`,把得到的 `verified.length` 作为 `verifiedCodexRounds` 传给 `converge`(承接 Task 2 门禁)。§7 输出**必须附**:本次 codex `thread_id` 列表 + `verified/missing`;若 `missing` 非空或 verified=0 → 结论顶部标 **「⚠️ 未经真实 Codex 互审核实,结论不可信」** 且不得判 RESOLVED。

- [ ] **Step 2: do.md** —— §6 复核轮同样记 thread_id;§4 方案对抗轮的 thread_id 一并纳入;收尾按上同核对 + §7 附结果 + 同样的"不可信"标注规则。

- [ ] **Step 3: 提交** `git add cc-codex-review/commands/review.md cc-codex-review/commands/do.md && git commit -m "feat(cc-codex-review): review/do 收尾必核对 codex thread_id 并附证据(承接门禁)"`

---

### Task 4: DESIGN / README / 版本(v0.11.0)

- [ ] DESIGN §3 列出 `scripts/verify-codex-session.mjs`;§12 加一条(强制真用 Codex:会话核对+收敛门禁,诚实边界=非100%、hook 后续)。
- [ ] README「底层保障」补一句:review/do 结论附 codex thread_id,可在 `~/.codex/sessions` 核对真调用。
- [ ] `.claude-plugin/plugin.json` 0.10.0 → 0.11.0。
- [ ] `node --test cc-codex-review/tests/*.test.mjs` 全绿;`git commit -m "docs(cc-codex-review): v0.11.0 — 会话核对/门禁接入 DESIGN/README + 版本"`

---

### Task 5: 实跑验收 + 自审(inline)

- [ ] **Step 1:** 真机:跑一次小 `review`(真调 Codex),拿到 thread_id,喂 verify-codex-session → 应 `verified`;且该 thread_id 能在 `~/.codex/sessions` 找到对应 `.jsonl`。
- [ ] **Step 2:** 反例:编一个假 UUID 喂 verify-codex-session → 应 `missing`(证明假互审会被抓)。
- [ ] **Step 3:** 对抗自审:用 `review` 审本批改动(verify-codex-session + converge 门禁 + 协议)是否忠实 spec、门禁会不会被绕过、安全(路径遍历)无误;按收敛结果修。
- [ ] **Step 4:** 验收结论记 DESIGN §12,提交。

---

### Task 6: 发布

- [ ] 推送(finyorke key);`claude plugin marketplace update` + `plugin update`(→0.11.0);验证缓存含 verify-codex-session.mjs;打 tag `cc-codex-review--v0.11.0` 并推;提示重启;标 #23 completed。

---

## 自审(对照 spec)
- spec §3.1 verify 脚本(查 sessions/UUID 安全/CLI)→ Task 1 ✓
- spec §3.2 converge 门禁(verified≥1)→ Task 2 ✓
- spec §3.3 review/do 协议(记 thread_id/收尾核对/§7 附证据/不可信标注)→ Task 3 ✓
- spec §3.4 范围(只 review/do,不碰 extract-reqs)→ Task 3 仅改 review/do ✓
- spec §4 诚实边界 + §6 不做 hook → Task 4 §12 记录 ✓
- spec §5 验收(verified/missing/门禁/安全)→ Task 1/2 单测 + Task 5 实跑 ✓
- 占位符:无;verify-codex-session 完整代码给出;converge 门禁因需对接现有接口,Task 2 Step 1 明确"先读现状"+ 保留断言意图(非占位,是依赖现有代码的真实做法)。
