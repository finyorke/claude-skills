import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, reduce, validate, canConverge, counts, renderUnresolved,
} from '../scripts/review-state.mjs';

// ---- reduce: 状态迁移 ----

test('reduce: 新 issue → open', () => {
  const s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  assert.equal(s.round, 1);
  assert.equal(s.points.find((p) => p.id === 'I1').state, 'open');
});

test('reduce: Claude 采纳 open → candidate', () => {
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { adopted: ['I1'] });
  assert.equal(s.points.find((p) => p.id === 'I1').state, 'candidate');
});

test('reduce: Codex confirmed → candidate 晋升 agreed', () => {
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { adopted: ['I1'] });
  s = reduce(s, { candidate_dispositions: [{ id: 'I1', disposition: 'confirmed' }] });
  assert.equal(s.points.find((p) => p.id === 'I1').state, 'agreed');
});

test('reduce: Codex rejected → candidate 退回 open', () => {
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { adopted: ['I1'] });
  s = reduce(s, { candidate_dispositions: [{ id: 'I1', disposition: 'rejected' }] });
  assert.equal(s.points.find((p) => p.id === 'I1').state, 'open');
});

test('reduce: agreed 被重新质疑(重现于 remaining_issues)→ open', () => {
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { adopted: ['I1'] });
  s = reduce(s, { candidate_dispositions: [{ id: 'I1', disposition: 'confirmed' }] });
  assert.equal(s.points.find((p) => p.id === 'I1').state, 'agreed');
  s = reduce(s, { remaining_issues: [{ id: 'I1', title: 't again', severity: 'blocker' }] });
  const p = s.points.find((x) => x.id === 'I1');
  assert.equal(p.state, 'open');
  assert.equal(p.severity, 'blocker', '重新质疑应更新严重度');
});

test('reduce: 合并 → merged + merged_into,from 不再独立', () => {
  let s = reduce(emptyState(), {
    remaining_issues: [{ id: 'I1', title: 'a', severity: 'major' }, { id: 'I2', title: 'b', severity: 'minor' }],
  });
  s = reduce(s, { merges: [{ from: ['I2'], into: 'I1' }] });
  const i2 = s.points.find((p) => p.id === 'I2');
  const i1 = s.points.find((p) => p.id === 'I1');
  assert.equal(i2.state, 'merged');
  assert.equal(i2.merged_into, 'I1');
  assert.deepEqual(i1.merged_from, ['I2']);
});

test('reduce: 不改入参(纯函数)', () => {
  const s0 = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  const snap = JSON.stringify(s0);
  reduce(s0, { adopted: ['I1'] });
  assert.equal(JSON.stringify(s0), snap, 'reduce 不得修改传入的 prevState');
});

// ---- validate: 不变量 + disposition 协议 ----

test('validate: disposition 必须覆盖本轮全部 sentCandidate', () => {
  const s = { round: 2, points: [{ id: 'C1', state: 'candidate', severity: 'major' }, { id: 'C2', state: 'candidate', severity: 'minor' }] };
  const r = validate(s, { sentCandidateIds: ['C1', 'C2'], dispositions: [{ id: 'C1', disposition: 'confirmed' }] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /C2 未被 Codex 裁定/);
});

test('validate: disposition 不得引用非本轮 candidate id', () => {
  const s = { round: 2, points: [{ id: 'C1', state: 'candidate', severity: 'major' }] };
  const r = validate(s, { sentCandidateIds: ['C1'], dispositions: [{ id: 'C1', disposition: 'confirmed' }, { id: 'CX', disposition: 'confirmed' }] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /非本轮 candidate id: CX/);
});

test('validate: 重复 id 报错', () => {
  const s = { round: 1, points: [{ id: 'I1', state: 'open', severity: 'major' }, { id: 'I1', state: 'open', severity: 'minor' }] };
  const r = validate(s, {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /duplicate point id: I1/);
});

test('validate: merged 缺 merged_into 报错', () => {
  const s = { round: 1, points: [{ id: 'I1', state: 'merged' }] };
  const r = validate(s, {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /merged point I1 missing merged_into/);
});

test('validate: 干净状态通过', () => {
  const s = { round: 2, points: [{ id: 'I1', state: 'agreed', severity: 'major' }] };
  const r = validate(s, { sentCandidateIds: [], dispositions: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

// ---- canConverge: 收敛闸门 ----

test('canConverge: candidate 非空 → 不可收敛(防假 RESOLVED)', () => {
  const s = { round: 3, points: [{ id: 'I1', state: 'candidate' }] };
  const r = canConverge(s, 'AGREE', true);
  assert.equal(r.converged, false);
  assert.match(r.reasons.join('\n'), /candidate 未被确认/);
});

test('canConverge: 全 agreed + 双 AGREE → 收敛', () => {
  const s = { round: 3, points: [{ id: 'I1', state: 'agreed' }, { id: 'I2', state: 'merged', merged_into: 'I1' }] };
  const r = canConverge(s, 'AGREE', true);
  assert.equal(r.converged, true);
  assert.deepEqual(r.reasons, []);
});

test('canConverge: open 分歧仍在 → 不可收敛', () => {
  const s = { round: 3, points: [{ id: 'I1', state: 'open' }] };
  assert.equal(canConverge(s, 'AGREE', true).converged, false);
});

// ---- render ----

test('renderUnresolved: 四段齐全,candidate 落 🔶 且带来源严重度', () => {
  const s = { round: 4, points: [
    { id: 'A1', state: 'agreed', title: '已定', severity: 'major' },
    { id: 'C1', state: 'candidate', title: '待确认', severity: 'blocker' },
    { id: 'O1', state: 'open', title: '仍分歧', severity: 'major' },
  ] };
  const txt = renderUnresolved(s, { reason: '到达 max-rounds', reviewed_scope: '全量', assumptions: ['x'] });
  assert.match(txt, /### ✅ 已达成一致[\s\S]*A1/);
  assert.match(txt, /### 🔶 待复核确认[\s\S]*C1[\s\S]*来源严重度:blocker/);
  assert.match(txt, /### ❌ 仍未达成一致[\s\S]*O1/);
  assert.match(txt, /### 📋 给用户的裁决建议/);
  // candidate 不得出现在 ✅ 段
  const agreedSection = txt.split('### 🔶')[0];
  assert.ok(!agreedSection.includes('C1'), 'candidate 不得混入 ✅ 段');
});

test('counts: 各态计数', () => {
  const s = { round: 1, points: [{ id: 'a', state: 'open' }, { id: 'b', state: 'candidate' }, { id: 'c', state: 'agreed' }] };
  assert.deepEqual(counts(s), { open: 1, candidate: 1, agreed: 1, merged: 0 });
});
