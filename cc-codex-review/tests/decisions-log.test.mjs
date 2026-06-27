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
