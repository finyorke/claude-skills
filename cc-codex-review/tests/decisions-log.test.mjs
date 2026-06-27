import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextId, applyOps, validate, renderMarkdown } from '../scripts/decisions-log.mjs';
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

test('applyOps append: 忽略 caller 传入的 entry.id,强制自动 id(防撞号绕过)', () => {
  const out = applyOps([{ id: 'D1', status: 'decided', statement: 'a', rationale: 'r' }], [{ op: 'append', ts: 't', entry: { id: 'D99', status: 'decided', statement: 'X', rationale: 'why', source: 'do' } }]);
  assert.equal(out[1].id, 'D2'); // 自动分配,非 caller 的 D99
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

test('renderMarkdown: 两段、字段齐全', () => {
  const md = renderMarkdown([okDecided, okOpen]);
  assert.match(md, /## ✅ 已定决策\/约束/);
  assert.match(md, /\[D1\] X — 理由:why  \(do · t\)/);
  assert.match(md, /## ❌ 未决\(开放分歧\)/);
  assert.match(md, /\[D2\] Y · 严重度:major · Claude:a \/ Codex:b/);
});

test('renderMarkdown: 空 → 两段都给占位', () => {
  const md = renderMarkdown([]);
  assert.match(md, /## ✅ 已定决策\/约束\n（暂无）/);
  assert.match(md, /## ❌ 未决\(开放分歧\)\n（暂无）/);
});

test('renderMarkdown: decided 带 supersedes 时标注', () => {
  const md = renderMarkdown([{ ...okDecided, id: 'D3', supersedes: ['D1'] }]);
  assert.match(md, /取代 D1/);
});

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

test('CLI upsert: 裸 set-status 把 open 翻 decided 缺 rationale → 校验拦下(非零退出)', () => {
  const repo = freshRepo();
  cli('upsert', { repo, ops: [{ op: 'append', entry: { status: 'open', statement: 'Y', positions: { claude: 'a', codex: 'b' }, severity: 'major', source: 'do' } }] });
  assert.throws(() => execFileSync('node', [SCRIPT, 'upsert'], { input: JSON.stringify({ repo, ops: [{ op: 'set-status', id: 'D1', status: 'decided' }] }), encoding: 'utf8' }), (e) => {
    assert.equal(e.status, 2);
    assert.equal(JSON.parse(e.stdout.trim()).error, 'invalid');
    return true;
  });
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
