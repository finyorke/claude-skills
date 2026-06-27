# 决策日志(decisions-log)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Codex 补上跨轮上下文——把 do/review 过程定下的决策/约束(软知识)落盘到被操作项目的 `.cc-codex-review/decisions.{jsonl,md}`,每轮经 `--repo` 带给 Codex。

**Architecture:** 新增确定性脚本 `decisions-log.mjs`(纯函数 + 薄 CLI + 单测,沿用 review-state/verify-codex-session 风格):纯函数做 id 分配/状态机/校验/渲染,CLI 层做文件 IO。do.md/review.md 收尾经 Codex 确认后调 CLI 落盘。

**Tech Stack:** Node.js ESM、`node:test`、`node:fs`。无第三方依赖。

参考 spec:`cc-codex-review/docs/specs/2026-06-27-decision-log-design.md`。

---

## File Structure

- Create: `cc-codex-review/scripts/decisions-log.mjs` —— 纯函数(`nextId`/`applyOps`/`validate`/`renderMarkdown`)+ CLI(`read`/`upsert`/`render`/`validate`)。
- Create: `cc-codex-review/tests/decisions-log.test.mjs` —— 单测。
- Modify: `cc-codex-review/commands/do.md` —— 开头 read 基线、收尾经 Codex 确认后 upsert。
- Modify: `cc-codex-review/commands/review.md` —— 同上 + UNRESOLVED 三段映射。
- Modify: `cc-codex-review/DESIGN.md` —— §12 加条目。
- Modify: `cc-codex-review/README.md` —— 底层保障加一句。
- Modify: `cc-codex-review/.claude-plugin/plugin.json` —— 版本 → 0.12.0。

约定:所有命令在仓库根 `/Users/fun/D/Projects/claude-skills` 下运行;测试用 `node --test cc-codex-review/tests/*.test.mjs`。

---

### Task 1: 纯函数 `nextId` + `applyOps`(append / set-status)

**Files:**
- Create: `cc-codex-review/scripts/decisions-log.mjs`
- Test: `cc-codex-review/tests/decisions-log.test.mjs`

- [ ] **Step 1: 写失败测试**

写入 `cc-codex-review/tests/decisions-log.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextId, applyOps } from '../scripts/decisions-log.mjs';

test('nextId: 空→D1;连续→下一个;有缺口取 max+1', () => {
  assert.equal(nextId([]), 'D1');
  assert.equal(nextId([{ id: 'D1' }, { id: 'D2' }]), 'D3');
  assert.equal(nextId([{ id: 'D1' }, { id: 'D5' }]), 'D6');
});

test('applyOps append: 自动分配 id、保留字段、ts 取自 op', () => {
  const out = applyOps([], [{ op: 'append', ts: '2026-06-27T00:00:00Z', entry: { status: 'decided', statement: 'X', rationale: 'why', source: 'do' } }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'D1');
  assert.equal(out[0].statement, 'X');
  assert.equal(out[0].ts, '2026-06-27T00:00:00Z');
});

test('applyOps set-status: 翻转已存在条目', () => {
  const start = [{ id: 'D1', status: 'open', statement: 'X', source: 'do', ts: 't' }];
  const out = applyOps(start, [{ op: 'set-status', id: 'D1', status: 'decided' }]);
  assert.equal(out[0].status, 'decided');
});

test('applyOps set-status: 未知 id 抛错', () => {
  assert.throws(() => applyOps([], [{ op: 'set-status', id: 'D9', status: 'decided' }]), /未知 id/);
});

test('applyOps: 不改原数组(纯函数)', () => {
  const start = [{ id: 'D1', status: 'open', statement: 'X' }];
  applyOps(start, [{ op: 'set-status', id: 'D1', status: 'decided' }]);
  assert.equal(start[0].status, 'open');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test cc-codex-review/tests/decisions-log.test.mjs`
Expected: FAIL（`Cannot find module ... decisions-log.mjs`）

- [ ] **Step 3: 写最小实现**

写入 `cc-codex-review/scripts/decisions-log.mjs`:

```js
#!/usr/bin/env node
// decisions-log.mjs — 决策日志:把 do/review 定下的决策/约束(软知识)落盘,供 Codex 经 --repo 跨轮读取。
// 见 docs/specs/2026-06-27-decision-log-design.md。纯函数(无 IO)+ 薄 CLI(读写 .cc-codex-review/decisions.{jsonl,md})。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STATUSES = new Set(['decided', 'open']);
const SEV = new Set(['blocker', 'major', 'minor']);

// 取下一个空闲 id（D<max+1>）。
export function nextId(entries) {
  let max = 0;
  for (const e of entries) {
    const m = /^D(\d+)$/.exec((e && e.id) || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `D${max + 1}`;
}

// ops: [{op:'append', ts, entry:{status,statement,rationale?,positions?,severity?,source,supersedes?}}]
//    | [{op:'set-status', id, status}]
// 纯函数:不改入参,返回新数组。
export function applyOps(entries, ops) {
  const out = entries.map((e) => ({ ...e }));
  for (const op of ops || []) {
    if (op.op === 'append') {
      out.push({ id: nextId(out), ...op.entry, ts: op.ts });
    } else if (op.op === 'set-status') {
      const e = out.find((x) => x.id === op.id);
      if (!e) throw new Error(`set-status: 未知 id ${op.id}`);
      e.status = op.status;
    } else {
      throw new Error(`未知 op ${op.op}`);
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test cc-codex-review/tests/decisions-log.test.mjs`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add cc-codex-review/scripts/decisions-log.mjs cc-codex-review/tests/decisions-log.test.mjs
git commit -m "feat(cc-codex-review): decisions-log 纯函数 nextId+applyOps(决策日志,#decision-log)"
```

---

### Task 2: 纯函数 `validate`

**Files:**
- Modify: `cc-codex-review/scripts/decisions-log.mjs`
- Test: `cc-codex-review/tests/decisions-log.test.mjs`

- [ ] **Step 1: 写失败测试(追加到测试文件)**

在 import 行追加 `validate`:把第一行改为
`import { nextId, applyOps, validate } from '../scripts/decisions-log.mjs';`
并追加:

```js
const okDecided = { id: 'D1', status: 'decided', statement: 'X', rationale: 'why', source: 'do', ts: 't' };
const okOpen = { id: 'D2', status: 'open', statement: 'Y', positions: { claude: 'a', codex: 'b' }, severity: 'major', source: 'review', ts: 't' };

test('validate: 合法 decided+open → ok', () => {
  assert.deepEqual(validate([okDecided, okOpen]), { ok: true });
});

test('validate: 重复 id → 报错', () => {
  const v = validate([okDecided, { ...okDecided }]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /重复 id/.test(e)));
});

test('validate: 坏 id 格式 → 报错', () => {
  const v = validate([{ ...okDecided, id: 'X1' }]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /坏 id/.test(e)));
});

test('validate: decided 缺 rationale → 报错', () => {
  const v = validate([{ ...okDecided, rationale: '' }]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /需 rationale/.test(e)));
});

test('validate: open 缺 positions/severity → 报错', () => {
  const v1 = validate([{ ...okOpen, positions: { claude: 'a' } }]);
  assert.equal(v1.ok, false);
  const v2 = validate([{ ...okOpen, severity: 'huge' }]);
  assert.equal(v2.ok, false);
});

test('validate: 坏 status → 报错', () => {
  const v = validate([{ ...okDecided, status: 'maybe' }]);
  assert.equal(v.ok, false);
});

test('validate: supersedes 悬空 → 报错', () => {
  const v = validate([{ ...okDecided, supersedes: ['D9'] }]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /悬空/.test(e)));
});

test('validate: supersedes 指向存在 id → ok', () => {
  const v = validate([okOpen, { ...okDecided, id: 'D3', supersedes: ['D2'] }]);
  assert.equal(v.ok, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test cc-codex-review/tests/decisions-log.test.mjs`
Expected: FAIL（`validate is not a function`）

- [ ] **Step 3: 写实现(追加到 decisions-log.mjs,在 applyOps 之后)**

```js
// 校验整组 entries 的结构不变量;返回 {ok:true} 或 {ok:false, errors:[...]}。
export function validate(entries) {
  const errors = [];
  const ids = new Set(entries.map((e) => e && e.id));
  const seen = new Set();
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || !/^D\d+$/.test(e.id)) { errors.push(`坏 id: ${JSON.stringify(e && e.id)}`); continue; }
    if (seen.has(e.id)) errors.push(`重复 id: ${e.id}`);
    seen.add(e.id);
    if (!STATUSES.has(e.status)) errors.push(`${e.id}: 坏 status ${e.status}`);
    if (!e.statement || typeof e.statement !== 'string') errors.push(`${e.id}: statement 缺失`);
    if (e.status === 'decided' && !e.rationale) errors.push(`${e.id}: decided 需 rationale`);
    if (e.status === 'open') {
      if (!e.positions || !e.positions.claude || !e.positions.codex) errors.push(`${e.id}: open 需 positions.claude/codex`);
      if (!SEV.has(e.severity)) errors.push(`${e.id}: open 需合法 severity`);
    }
    if (Array.isArray(e.supersedes)) for (const s of e.supersedes) if (!ids.has(s)) errors.push(`${e.id}: supersedes 悬空 ${s}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test cc-codex-review/tests/decisions-log.test.mjs`
Expected: PASS（13 tests）

- [ ] **Step 5: 提交**

```bash
git add cc-codex-review/scripts/decisions-log.mjs cc-codex-review/tests/decisions-log.test.mjs
git commit -m "feat(cc-codex-review): decisions-log validate(结构不变量)"
```

---

### Task 3: 纯函数 `renderMarkdown`

**Files:**
- Modify: `cc-codex-review/scripts/decisions-log.mjs`
- Test: `cc-codex-review/tests/decisions-log.test.mjs`

- [ ] **Step 1: 写失败测试(追加)**

import 行加 `renderMarkdown`:
`import { nextId, applyOps, validate, renderMarkdown } from '../scripts/decisions-log.mjs';`
追加:

```js
test('renderMarkdown: 两段、字段齐全', () => {
  const md = renderMarkdown([okDecided, okOpen]);
  assert.match(md, /## ✅ 已定决策\/约束/);
  assert.match(md, /\[D1\] X — 理由:why  \(do · t\)/);
  assert.match(md, /## ❌ 未决(开放分歧)/);
  assert.match(md, /\[D2\] Y · 严重度:major · Claude:a \/ Codex:b/);
});

test('renderMarkdown: 空 → 两段都给占位', () => {
  const md = renderMarkdown([]);
  assert.match(md, /## ✅ 已定决策\/约束\n（暂无）/);
  assert.match(md, /## ❌ 未决(开放分歧)\n（暂无）/);
});

test('renderMarkdown: decided 带 supersedes 时标注', () => {
  const md = renderMarkdown([{ ...okDecided, id: 'D3', supersedes: ['D1'] }]);
  assert.match(md, /取代 D1/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test cc-codex-review/tests/decisions-log.test.mjs`
Expected: FAIL（`renderMarkdown is not a function`）

- [ ] **Step 3: 写实现(追加到 decisions-log.mjs,在 validate 之后)**

```js
// 从 entries 渲染 decisions.md(Codex 实际读这个)。
export function renderMarkdown(entries) {
  const decided = entries.filter((e) => e.status === 'decided');
  const open = entries.filter((e) => e.status === 'open');
  const L = [];
  L.push('# 决策日志(cc-codex-review · 自动维护)');
  L.push('> 每轮 do/review 收敛后追加。DECIDED=双方已确认的基线;OPEN=仍未谈拢。供 Codex 跨轮读取。');
  L.push('');
  L.push('## ✅ 已定决策/约束');
  if (decided.length === 0) L.push('（暂无）');
  for (const e of decided) {
    const sup = Array.isArray(e.supersedes) && e.supersedes.length ? ` · 取代 ${e.supersedes.join(',')}` : '';
    L.push(`- [${e.id}] ${e.statement} — 理由:${e.rationale}  (${e.source} · ${e.ts})${sup}`);
  }
  L.push('');
  L.push('## ❌ 未决(开放分歧)');
  if (open.length === 0) L.push('（暂无）');
  for (const e of open) {
    L.push(`- [${e.id}] ${e.statement} · 严重度:${e.severity} · Claude:${e.positions.claude} / Codex:${e.positions.codex}  (${e.source} · ${e.ts})`);
  }
  L.push('');
  return L.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test cc-codex-review/tests/decisions-log.test.mjs`
Expected: PASS（16 tests）

- [ ] **Step 5: 提交**

```bash
git add cc-codex-review/scripts/decisions-log.mjs cc-codex-review/tests/decisions-log.test.mjs
git commit -m "feat(cc-codex-review): decisions-log renderMarkdown(两段视图)"
```

---

### Task 4: CLI(`read` / `upsert` / `render` / `validate`,带 IO)

**Files:**
- Modify: `cc-codex-review/scripts/decisions-log.mjs`
- Test: `cc-codex-review/tests/decisions-log.test.mjs`

- [ ] **Step 1: 写失败测试(追加)**

在测试文件顶部 import 区追加:

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync as rf, writeFileSync as wf, mkdirSync as md } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pj, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/decisions-log.mjs');
function cli(cmd, inp) {
  return JSON.parse(execFileSync('node', [SCRIPT, cmd], { input: JSON.stringify(inp), encoding: 'utf8' }).trim());
}
function freshRepo() { return mkdtempSync(pj(tmpdir(), 'declog-')); }
```

追加测试:

```js
test('CLI read: 无文件 → 空 entries', () => {
  const r = cli('read', { repo: freshRepo() });
  assert.deepEqual(r, { ok: true, entries: [] });
});

test('CLI upsert: append 后 jsonl+md 落盘、read 往返一致', () => {
  const repo = freshRepo();
  const r = cli('upsert', { repo, ops: [{ op: 'append', entry: { status: 'decided', statement: 'X', rationale: 'why', source: 'do' } }] });
  assert.equal(r.ok, true);
  assert.equal(r.entries[0].id, 'D1');
  assert.ok(r.entries[0].ts, 'CLI 应自动盖 ts');
  const back = cli('read', { repo });
  assert.equal(back.entries[0].statement, 'X');
  const mdTxt = rf(pj(repo, '.cc-codex-review', 'decisions.md'), 'utf8');
  assert.match(mdTxt, /\[D1\] X/);
});

test('CLI upsert: set-status 翻转 open→decided', () => {
  const repo = freshRepo();
  cli('upsert', { repo, ops: [{ op: 'append', entry: { status: 'open', statement: 'Y', positions: { claude: 'a', codex: 'b' }, severity: 'major', source: 'do' } }] });
  const r = cli('upsert', { repo, ops: [{ op: 'set-status', id: 'D1', status: 'decided' }, { op: 'append', entry: { status: 'decided', statement: 'note', rationale: 'r', source: 'do' } }] });
  // 翻成 decided 后缺 rationale 应被 validate 拦下吗?——open→decided 需补 rationale:见 Step 3 约定
  assert.equal(r.ok, false); // 缺 rationale
});

test('CLI upsert: 校验失败 → 非零退出且不写', () => {
  const repo = freshRepo();
  assert.throws(() => execFileSync('node', [SCRIPT, 'upsert'], { input: JSON.stringify({ repo, ops: [{ op: 'append', entry: { status: 'decided', statement: 'X', source: 'do' } }] }), encoding: 'utf8' }), (e) => {
    assert.equal(e.status, 2);
    assert.equal(JSON.parse(e.stdout.trim()).error, 'invalid');
    return true;
  });
  // 不应留下文件
  const back = cli('read', { repo });
  assert.deepEqual(back.entries, []);
});

test('CLI: 损坏 jsonl → corrupt_jsonl', () => {
  const repo = freshRepo();
  md(pj(repo, '.cc-codex-review'), { recursive: true });
  wf(pj(repo, '.cc-codex-review', 'decisions.jsonl'), 'not json\n');
  assert.throws(() => execFileSync('node', [SCRIPT, 'read'], { input: JSON.stringify({ repo }), encoding: 'utf8' }), (e) => {
    assert.equal(JSON.parse(e.stdout.trim()).error, 'corrupt_jsonl');
    return true;
  });
});

test('CLI render: 从现有 jsonl 重渲染 md', () => {
  const repo = freshRepo();
  cli('upsert', { repo, ops: [{ op: 'append', entry: { status: 'decided', statement: 'X', rationale: 'why', source: 'do' } }] });
  const r = cli('render', { repo });
  assert.equal(r.ok, true);
  assert.match(rf(r.path, 'utf8'), /\[D1\] X/);
});
```

> 说明:`set-status` 把 open 翻成 decided 时,该条若无 `rationale` 会被 `validate` 拦下(decided 必填 rationale)。所以调用方(do/review)翻转时应在**同一个 upsert**里用一条 `append`+`supersedes` 或先补 rationale。为简化本期:**set-status 仅用于把已带 rationale 的条目在状态间切换;open→decided 若需补 rationale,改用 append 一条新 decided 并 `supersedes` 旧 open**。上面第 3 个测试即固化"裸翻转缺 rationale 会被拦"的行为。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test cc-codex-review/tests/decisions-log.test.mjs`
Expected: FAIL（CLI 子命令未实现,stdout 非预期 JSON）

- [ ] **Step 3: 写实现(追加到 decisions-log.mjs 末尾)**

```js
// ---- CLI(IO 层)----
function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
function paths(repo) { const dir = join(repo || '.', '.cc-codex-review'); return { dir, jsonl: join(dir, 'decisions.jsonl'), md: join(dir, 'decisions.md') }; }
function loadEntries(jsonl) {
  if (!existsSync(jsonl)) return [];
  const out = [];
  for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
    const t = line.trim(); if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { throw new Error('corrupt_jsonl'); }
    out.push(o);
  }
  return out;
}
function emit(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function fail(error, detail) { emit({ ok: false, error, detail }); process.exit(2); }

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const cmd = process.argv[2];
  const raw = await readStdin();
  let inp; try { inp = raw.trim() ? JSON.parse(raw) : {}; } catch { fail('bad_json', 'stdin 非合法 JSON'); }
  const p = paths(inp.repo);
  let entries;
  try { entries = loadEntries(p.jsonl); } catch (e) { fail('corrupt_jsonl', String(e.message)); }
  if (cmd === 'read') {
    emit({ ok: true, entries });
  } else if (cmd === 'render') {
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.md, renderMarkdown(entries));
    emit({ ok: true, path: p.md });
  } else if (cmd === 'validate') {
    const v = validate(entries);
    emit(v); if (!v.ok) process.exit(2);
  } else if (cmd === 'upsert') {
    const ops = (inp.ops || []).map((o) => (o.op === 'append' ? { ...o, ts: o.ts || new Date().toISOString() } : o));
    let next;
    try { next = applyOps(entries, ops); } catch (e) { fail('bad_op', String(e.message)); }
    const v = validate(next);
    if (!v.ok) { emit({ ok: false, error: 'invalid', errors: v.errors }); process.exit(2); }
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.jsonl, next.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(p.md, renderMarkdown(next));
    emit({ ok: true, entries: next });
  } else {
    fail('bad_cmd', `未知子命令 ${cmd}`);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test cc-codex-review/tests/decisions-log.test.mjs`
Expected: PASS（22 tests）

- [ ] **Step 5: 跑全量回归**

Run: `node --test cc-codex-review/tests/*.test.mjs`
Expected: PASS（原 164 + 新 22 = 186,全绿)

- [ ] **Step 6: 提交**

```bash
git add cc-codex-review/scripts/decisions-log.mjs cc-codex-review/tests/decisions-log.test.mjs
git commit -m "feat(cc-codex-review): decisions-log CLI(read/upsert/render/validate + IO)"
```

---

### Task 5: 接进 do.md

**Files:**
- Modify: `cc-codex-review/commands/do.md`

- [ ] **Step 1: §1 解析后加"载入决策日志基线"**

在 do.md §1 末尾(开头回显那段之后)加一句:

```markdown
- **载入决策日志基线**:若生效 repo 非 `none`,开始时调
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/decisions-log.mjs" read`(stdin `{"repo":"<生效repo>"}`)读 `.cc-codex-review/decisions.jsonl`,把已有「已定决策/约束 + 未决项」作为本轮**已知基线**纳入考量(Codex 也会经 `--repo` 读到 `.cc-codex-review/decisions.md`)。文件不存在=空基线,正常继续。
```

- [ ] **Step 2: §7 产出后加"写回决策日志"小节**

在 do.md §7 「Codex 调用核对(软信号)」段之后追加:

```markdown
**写回决策日志(给 Codex 的跨轮基线,见 `docs/specs/2026-06-27-decision-log-design.md`)**:本轮收尾时——
- 整理本轮 entry:**已定**(双方 AGREE 的决策/约束 → `status:decided` + `rationale`)、**未决**(仍分歧 → `status:open` + `positions.claude/codex` + `severity`)。🔶 待复核(你已回应、Codex 未确认)**先不写**,等下轮定。
- **先让 Codex 确认记录无误**:把这些拟写入条目放进**本轮最后一个 packet**,请 Codex 确认「decided 确实达成、open 立场记对了」(不是让它对内容表态)。
- 确认后调 `node "${CLAUDE_PLUGIN_ROOT}/scripts/decisions-log.mjs" upsert`,stdin `{"repo":"<生效repo>","ops":[...]}`:新决策/未决用 `{op:"append",entry:{...}}`;某 `open` 本轮谈拢→优先 `append` 一条新 `decided` 并 `supersedes:[旧id]`(裸 set-status 翻 decided 会因缺 rationale 被拦)。脚本会写 jsonl + 重渲染 `decisions.md`。
- **生效 repo 为 `none`(不适用 do,do 总有 repo)或脚本报错**:把错误如实告诉用户,不阻断主产出。
- **不自动 `git commit`**;可提示用户"决策已记到 `.cc-codex-review/decisions.md`,需要的话自行提交"。
```

- [ ] **Step 3: 校验 markdown 无破坏**

Run: `node -e "require('fs').readFileSync('cc-codex-review/commands/do.md','utf8')"`
Expected: 无报错(文件可读)。人工扫一眼两处插入位置正确。

- [ ] **Step 4: 提交**

```bash
git add cc-codex-review/commands/do.md
git commit -m "feat(cc-codex-review): do.md 接入决策日志(开头载入基线 + 收尾经 Codex 确认后写回)"
```

---

### Task 6: 接进 review.md

**Files:**
- Modify: `cc-codex-review/commands/review.md`

- [ ] **Step 1: §2 收集材料处加"载入决策日志基线"**

在 review.md §2 末尾加:

```markdown
- **载入决策日志基线**:若生效 repo 非 `none`,调
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/decisions-log.mjs" read`(stdin `{"repo":"<生效repo>"}`)读已有决策/未决项作为本轮已知基线(Codex 经 `--repo` 读到 `.cc-codex-review/decisions.md`)。`--repo none`→跳过。文件不存在=空基线。
```

- [ ] **Step 2: §7 输出后加"写回决策日志"小节**

在 review.md §7「Codex 调用核对(软信号)」段之后追加:

```markdown
**写回决策日志(见 `docs/specs/2026-06-27-decision-log-design.md`)**:收尾时把本轮结论落进 `.cc-codex-review/decisions.{jsonl,md}`,供后续轮 Codex 经 `--repo` 读到——
- **UNRESOLVED 三段映射**:✅ 已达成→`{op:"append",entry:{status:"decided",rationale,...}}`;❌ 仍未达成→`{op:"append",entry:{status:"open",positions:{claude,codex},severity,...}}`;🔶 待复核**先不写**。RESOLVED(双 AGREE)则把商定结论作 `decided` 写入。
- **先让 Codex 确认记录无误**(放进本轮最后一个 packet:decided 确实达成、open 立场记对了),确认后调 `node "${CLAUDE_PLUGIN_ROOT}/scripts/decisions-log.mjs" upsert`(stdin `{"repo":"<生效repo>","ops":[...]}`)。
- **`--repo none` → 跳过写回**(纯文本评审,无 repo);脚本报错则如实告诉用户、不阻断结论。
- **不自动 `git commit`**;可提示用户决策已记录、自行提交。
```

- [ ] **Step 3: 校验 markdown 可读**

Run: `node -e "require('fs').readFileSync('cc-codex-review/commands/review.md','utf8')"`
Expected: 无报错。人工扫一眼两处插入。

- [ ] **Step 4: 提交**

```bash
git add cc-codex-review/commands/review.md
git commit -m "feat(cc-codex-review): review.md 接入决策日志(载入基线 + UNRESOLVED 三段映射写回)"
```

---

### Task 7: DESIGN / README / 版本 + 最终回归

**Files:**
- Modify: `cc-codex-review/DESIGN.md`
- Modify: `cc-codex-review/README.md`
- Modify: `cc-codex-review/.claude-plugin/plugin.json`

- [ ] **Step 1: DESIGN §12 加条目**

在 DESIGN.md §12 末尾(最后一条之后)追加:

```markdown
- **决策日志(decisions-log,v0.12.0)**:连续多轮 do/review 时 Codex 跨轮丢上下文(独立进程、每轮只见 packet+`--repo`、跨命令零记忆)。把过程定下的**决策/约束(软知识)**落盘到被操作项目的 `.cc-codex-review/decisions.{jsonl,md}`,经 `--repo` 每轮带给 Codex。新增 `scripts/decisions-log.mjs`(纯函数 nextId/applyOps/validate/renderMarkdown + CLI read/upsert/render/validate,纯函数无 IO、CLI 管文件)。entry 带 `decided/open` 状态、可 `supersedes` 演进;收尾经 Codex 确认「记录无误」再写。**非 Claude 记忆补丁**(Claude 上下文由 Claude Code 原生维护)——是给 Codex 的稳定基线;诚实边界:日志仍 Claude 写,靠 Codex 确认+用户审+git diff 取信,收尾写入是 prompt 级软约束。spec:`docs/specs/2026-06-27-decision-log-design.md`。
```

- [ ] **Step 2: README 底层保障加一句**

在 README.md「底层保障」区(verify-codex-session 那条之后)加:

```markdown
- **决策日志(跨轮上下文)**:`do`/`review` 把过程定下的决策/约束记到被操作项目的 `.cc-codex-review/decisions.md`,连续多轮时让 Codex 经 `--repo` 读到稳定基线(`decisions-log.mjs`)。
```

- [ ] **Step 3: 版本 → 0.12.0**

把 `cc-codex-review/.claude-plugin/plugin.json` 的 `"version": "0.11.1"` 改为 `"version": "0.12.0"`。

- [ ] **Step 4: 最终全量回归**

Run: `node --test cc-codex-review/tests/*.test.mjs`
Expected: PASS（186 全绿)

- [ ] **Step 5: 提交**

```bash
git add cc-codex-review/DESIGN.md cc-codex-review/README.md cc-codex-review/.claude-plugin/plugin.json
git commit -m "docs(cc-codex-review): 决策日志接入 DESIGN/README + v0.12.0"
```

---

## 完成后

- 自测真机一遍:在某 repo 跑 `decisions-log.mjs upsert` 造几条,确认 `.cc-codex-review/decisions.md` 渲染正确、`read` 往返一致。
- 发布(需用户确认):推送 + kk 那台 marketplace `git pull` + `/plugin` 更新 + `/reload-plugins`;可选 tag v0.12.0。
- 真实场景验证:在连续多轮 do/review 里观察 Codex 是否真的读到 `decisions.md` 基线、收尾写回是否被 Codex 确认。
