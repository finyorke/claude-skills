import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextId, applyOps, validate } from '../scripts/decisions-log.mjs';

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
