import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, reduce, validateRound, validateState, canConverge, counts, renderUnresolved,
} from '../scripts/review-state.mjs';

// ---- reduce: 状态迁移 ----

test('reduce: 新 issue → open,保留 detail', () => {
  const s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', detail: 'why', severity: 'major' }] });
  assert.equal(s.round, 1);
  const p = s.points.find((x) => x.id === 'I1');
  assert.equal(p.state, 'open');
  assert.equal(p.detail, 'why', 'detail 必须保留(RS-P2-003)');
});

test('reduce: Claude 采纳 open → candidate,记 revision_summary', () => {
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { adopted: [{ id: 'I1', revision_summary: '加了校验' }] });
  const p = s.points.find((x) => x.id === 'I1');
  assert.equal(p.state, 'candidate');
  assert.equal(p.meta.revision_summary, '加了校验');
});

test('reduce: confirmed → 晋升 agreed;rejected → 退回 open', () => {
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }, { id: 'I2', title: 'u', severity: 'minor' }] });
  s = reduce(s, { adopted: ['I1', 'I2'] });
  s = reduce(s, { candidate_dispositions: [{ id: 'I1', disposition: 'confirmed' }, { id: 'I2', disposition: 'rejected' }], remaining_issues: [{ id: 'I2', title: 'u', severity: 'minor' }] });
  assert.equal(s.points.find((p) => p.id === 'I1').state, 'agreed');
  assert.equal(s.points.find((p) => p.id === 'I2').state, 'open');
});

test('reduce: disposition 只作用于 candidate(对 agreed/merged 不生效)', () => {
  let s = { round: 1, points: [{ id: 'M1', state: 'merged', merged_into: 'X', severity: 'major', title: 't' }] };
  s = reduce(s, { candidate_dispositions: [{ id: 'M1', disposition: 'confirmed' }] });
  assert.equal(s.points.find((p) => p.id === 'M1').state, 'merged', 'merged 是终态,disposition 不得复活它(RS-P2-001)');
});

test('reduce: agreed 被重新质疑 → open 并更新严重度', () => {
  let s = { round: 2, points: [{ id: 'I1', state: 'agreed', severity: 'minor', title: 't' }] };
  s = reduce(s, { remaining_issues: [{ id: 'I1', title: 't2', severity: 'blocker' }] });
  const p = s.points.find((x) => x.id === 'I1');
  assert.equal(p.state, 'open');
  assert.equal(p.severity, 'blocker');
});

test('reduce: 合并 → merged + merged_into + reciprocity', () => {
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 'a', severity: 'major' }, { id: 'I2', title: 'b', severity: 'minor' }] });
  s = reduce(s, { merges: [{ from: ['I2'], into: 'I1' }] });
  assert.equal(s.points.find((p) => p.id === 'I2').state, 'merged');
  assert.equal(s.points.find((p) => p.id === 'I2').merged_into, 'I1');
  assert.deepEqual(s.points.find((p) => p.id === 'I1').merged_from, ['I2']);
});

test('reduce: annotations 贴到 meta(供 §7 渲染)', () => {
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { annotations: [{ id: 'I1', claude_stance: 'A', codex_stance: 'B', status: '待裁决分歧', consequence: '会X', resolution_needed: '用户拍板' }] });
  const mm = s.points.find((p) => p.id === 'I1').meta;
  assert.equal(mm.status, '待裁决分歧');
  assert.equal(mm.consequence, '会X');
});

test('reduce: 纯函数,不改入参(含嵌套 merged_from)', () => {
  const s0 = { round: 1, points: [{ id: 'I1', state: 'open', severity: 'major', title: 't', merged_from: [] }] };
  const snap = JSON.stringify(s0);
  reduce(s0, { adopted: ['I1'], merges: [] });
  assert.equal(JSON.stringify(s0), snap, 'reduce 不得修改 prevState');
});

// ---- validateRound: 协议(reduce 前对 prevState 检查)----

const twoCand = { round: 2, points: [
  { id: 'C1', state: 'candidate', severity: 'major', title: 't1' },
  { id: 'C2', state: 'candidate', severity: 'minor', title: 't2' },
] };

test('validateRound: disposition 必须覆盖全部 prevCandidate', () => {
  const r = validateRound(twoCand, { candidate_dispositions: [{ id: 'C1', disposition: 'confirmed' }], remaining_issues: [] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /candidate C2 未被裁定/);
});

test('validateRound: disposition 不得引用未知/非 candidate id', () => {
  const r = validateRound(twoCand, {
    candidate_dispositions: [
      { id: 'C1', disposition: 'confirmed' }, { id: 'C2', disposition: 'rejected' },
      { id: 'CX', disposition: 'confirmed' },
    ],
    remaining_issues: [{ id: 'C2', title: 't2', severity: 'minor' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /disposition 引用未知 id: CX/);
});

test('validateRound: confirmed 却仍在 remaining_issues = 矛盾(RS-P2-001)', () => {
  const r = validateRound(twoCand, {
    candidate_dispositions: [{ id: 'C1', disposition: 'confirmed' }, { id: 'C2', disposition: 'rejected' }],
    remaining_issues: [{ id: 'C1', title: 't1', severity: 'major' }, { id: 'C2', title: 't2', severity: 'minor' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /矛盾:C1 被 confirmed 却仍出现在 remaining_issues/);
});

test('validateRound: rejected 必须在 remaining_issues 给出理由', () => {
  const r = validateRound(twoCand, {
    candidate_dispositions: [{ id: 'C1', disposition: 'confirmed' }, { id: 'C2', disposition: 'rejected' }],
    remaining_issues: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /C2 被 rejected 但未在 remaining_issues/);
});

test('validateRound: adopted 只能作用于 open', () => {
  const s = { round: 1, points: [{ id: 'A1', state: 'agreed', severity: 'major', title: 't' }] };
  const r = validateRound(s, { adopted: ['A1'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /adopted 只能作用于 open/);
});

test('validateRound: merge 来源/目标不得已是 merged', () => {
  const s = { round: 1, points: [
    { id: 'M1', state: 'merged', merged_into: 'X' },
    { id: 'I2', state: 'open', severity: 'major', title: 't' },
  ] };
  const r = validateRound(s, { merges: [{ from: ['M1'], into: 'I2' }] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /merge 来源 M1 已是 merged/);
});

test('validateRound: 干净一轮通过', () => {
  const r = validateRound(twoCand, {
    candidate_dispositions: [{ id: 'C1', disposition: 'confirmed' }, { id: 'C2', disposition: 'rejected' }],
    remaining_issues: [{ id: 'C2', title: 't2', severity: 'minor' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ---- validateState: 结构不变量 ----

test('validateState: 重复 id 报错', () => {
  const r = validateState({ round: 1, points: [{ id: 'I1', state: 'open' }, { id: 'I1', state: 'open' }] });
  assert.match(r.errors.join('\n'), /duplicate point id: I1/);
});

test('validateState: merge 环(A→B + B→A)被拒(RS-P2-002)', () => {
  const r = validateState({ round: 1, points: [
    { id: 'A', state: 'merged', merged_into: 'B', merged_from: ['B'] },
    { id: 'B', state: 'merged', merged_into: 'A', merged_from: ['A'] },
  ] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /目标须为活跃点|merged_into/);
});

test('validateState: 合并 reciprocity 缺失被拒', () => {
  const r = validateState({ round: 1, points: [
    { id: 'A', state: 'merged', merged_into: 'B' },
    { id: 'B', state: 'open', severity: 'major', title: 't' },
  ] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /reciprocity 缺失/);
});

test('validateState: 正常合并通过', () => {
  const r = validateState({ round: 1, points: [
    { id: 'A', state: 'merged', merged_into: 'B' },
    { id: 'B', state: 'open', severity: 'major', title: 't', merged_from: ['A'] },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ---- canConverge ----

test('canConverge: candidate 非空 → 不可收敛(防假 RESOLVED)', () => {
  const r = canConverge({ round: 3, points: [{ id: 'I1', state: 'candidate' }] }, 'AGREE', true);
  assert.equal(r.converged, false);
  assert.match(r.reasons.join('\n'), /candidate 未被确认/);
});

test('canConverge: 全 agreed/merged + 双 AGREE → 收敛', () => {
  const r = canConverge({ round: 3, points: [{ id: 'I1', state: 'agreed' }, { id: 'I2', state: 'merged', merged_into: 'I1' }] }, 'AGREE', true);
  assert.equal(r.converged, true);
});

// ---- render ----

test('renderUnresolved: 四段齐全 + ❌ 段含 §7 字段 + 📋 可定制', () => {
  const s = { round: 4, points: [
    { id: 'A1', state: 'agreed', title: '已定', severity: 'major' },
    { id: 'C1', state: 'candidate', title: '待确认', severity: 'blocker', meta: { revision_summary: '改了X' } },
    { id: 'O1', state: 'open', title: '仍分歧', detail: '细节', severity: 'major', meta: { claude_stance: 'a', codex_stance: 'b', status: '待裁决分歧', consequence: '会炸', resolution_needed: '用户定' } },
  ] };
  const txt = renderUnresolved(s, { reason: '到达 max-rounds', reviewed_scope: '全量', assumptions: ['x'], recommendation: '先修 O1' });
  assert.match(txt, /### ✅ 已达成一致[\s\S]*A1/);
  assert.match(txt, /### 🔶 待复核确认[\s\S]*C1[\s\S]*修订:改了X/);
  assert.match(txt, /### ❌ 仍未达成一致[\s\S]*O1[\s\S]*待裁决分歧[\s\S]*会炸[\s\S]*用户定/);
  assert.match(txt, /### 📋 给用户的裁决建议\n先修 O1/);
  const agreedSection = txt.split('### 🔶')[0];
  assert.ok(!agreedSection.includes('C1'), 'candidate 不得混入 ✅ 段');
});

test('counts: 各态计数', () => {
  assert.deepEqual(counts({ points: [{ state: 'open' }, { state: 'candidate' }, { state: 'agreed' }] }), { open: 1, candidate: 1, agreed: 1, merged: 0 });
});

// ---- RS-P2-001 修复:按中间态校验 adopted ----

test('validateRound: 同轮 rejected→重新采纳 合法(RS-P2-001)', () => {
  const prev = { round: 2, points: [{ id: 'C1', state: 'candidate', severity: 'major', title: 't' }] };
  const r = validateRound(prev, {
    candidate_dispositions: [{ id: 'C1', disposition: 'rejected' }],
    remaining_issues: [{ id: 'C1', title: 't', severity: 'major' }],
    adopted: ['C1'], // C1 本轮被 rejected→open,再被采纳→candidate,合法
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateRound: 采纳本轮新返回的 issue 合法(RS-P2-001)', () => {
  const r = validateRound(emptyState(), {
    remaining_issues: [{ id: 'N1', title: 'new', severity: 'major' }],
    adopted: ['N1'],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ---- RS-P2-002 修复:合并图(同批冲突 / 反向 reciprocity / parent 环)----

test('validateRound: 同批 A→B + A→C 被拒(A 已先被合并)', () => {
  const prev = { round: 1, points: [
    { id: 'A', state: 'open', severity: 'major', title: 'a' },
    { id: 'B', state: 'open', severity: 'major', title: 'b' },
    { id: 'C', state: 'open', severity: 'major', title: 'c' },
  ] };
  const r = validateRound(prev, { merges: [{ from: ['A'], into: 'B' }, { from: ['A'], into: 'C' }] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /merge 来源 A 已是 merged/);
});

test('reduce+validateState: A→B + B→C 链被 validateState 捕获(目标须活跃)', () => {
  let s = { round: 1, points: [
    { id: 'A', state: 'open', severity: 'major', title: 'a' },
    { id: 'B', state: 'open', severity: 'major', title: 'b' },
    { id: 'C', state: 'open', severity: 'major', title: 'c' },
  ] };
  s = reduce(s, { merges: [{ from: ['A'], into: 'B' }, { from: ['B'], into: 'C' }] });
  const r = validateState(s);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /目标须为活跃点/);
});

test('validateState: 陈旧 merged_from(反向 reciprocity)被拒', () => {
  const r = validateState({ round: 1, points: [
    { id: 'A', state: 'merged', merged_into: 'C' },
    { id: 'B', state: 'open', severity: 'major', title: 'b', merged_from: ['A'] }, // 陈旧:A 实际并入 C
    { id: 'C', state: 'open', severity: 'major', title: 'c', merged_from: ['A'] },
  ] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /反向 reciprocity 不符/);
});

test('validateState: parent 环(A↔B)被拒', () => {
  const r = validateState({ round: 1, points: [
    { id: 'A', state: 'open', parent_id: 'B' },
    { id: 'B', state: 'open', parent_id: 'A' },
  ] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /parent 环/);
});

// ---- RS-P2-003 修复:render 无占位 + pending ----

test('renderUnresolved: 无 recommendation 时派生建议(不打字面占位)', () => {
  const s = { round: 1, points: [{ id: 'O1', state: 'open', title: 't', severity: 'blocker' }] };
  const txt = renderUnresolved(s, {});
  assert.doesNotMatch(txt, /<按影响严重度/, '不得出现字面占位');
  assert.match(txt, /按影响严重度优先处理:\[O1\]/);
});

test('renderUnresolved: 🔶 段显示待确认点(pending)', () => {
  const s = { round: 1, points: [{ id: 'C1', state: 'candidate', title: 't', severity: 'major', meta: { pending: '还需确认X' } }] };
  assert.match(renderUnresolved(s, {}), /待确认:还需确认X/);
});

// ---- RS-P2-006 / RS-P2-002(dup) / RS-P2-007 ----

test('validateRound: remaining_issues 引用已 merged 点被拒(RS-P2-006)', () => {
  const prev = { round: 2, points: [
    { id: 'M1', state: 'merged', merged_into: 'K1' },
    { id: 'K1', state: 'open', severity: 'major', title: 'k', merged_from: ['M1'] },
  ] };
  const r = validateRound(prev, { remaining_issues: [{ id: 'M1', title: 'zombie', severity: 'major' }] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /已 merged(.|\n)*点 M1/);
});

test('validateRound: merge from 重复 id 被拒(RS-P2-002 minor)', () => {
  const prev = { round: 1, points: [
    { id: 'A', state: 'open', severity: 'major', title: 'a' },
    { id: 'B', state: 'open', severity: 'major', title: 'b' },
  ] };
  const r = validateRound(prev, { merges: [{ from: ['A', 'A'], into: 'B' }] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /merge from 含重复 id: A/);
});

test('validateState: merged_from 重复条目被拒(RS-P2-002 minor)', () => {
  const r = validateState({ round: 1, points: [
    { id: 'A', state: 'merged', merged_into: 'B' },
    { id: 'B', state: 'open', severity: 'major', title: 'b', merged_from: ['A', 'A'] },
  ] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /merged_from 含重复 id A/);
});

test('validateRound: annotation 未知 id / 重复 被拒(RS-P2-007)', () => {
  const prev = { round: 1, points: [{ id: 'O1', state: 'open', severity: 'major', title: 't' }] };
  const r1 = validateRound(prev, { annotations: [{ id: 'GHOST', status: '待裁决分歧' }] });
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join('\n'), /annotation 引用未知 id: GHOST/);
  const r2 = validateRound(prev, { annotations: [{ id: 'O1', status: 'x' }, { id: 'O1', consequence: 'y' }] });
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join('\n'), /重复 annotation: O1/);
});

test('validateRound: 合法 annotation 通过', () => {
  const prev = { round: 1, points: [{ id: 'O1', state: 'open', severity: 'major', title: 't' }] };
  const r = validateRound(prev, { annotations: [{ id: 'O1', status: '待裁决分歧', consequence: 'x' }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('reduce: 重新采纳清除上一次被拒的候选元数据(RS-P2-009)', () => {
  // I1: open → adopt(rev A) → candidate → rejected → open → re-adopt(无 rev)→ 不应残留 rev A
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { adopted: [{ id: 'I1', revision_summary: '修法A', pending: '待确认A' }] });
  s = reduce(s, { candidate_dispositions: [{ id: 'I1', disposition: 'rejected' }], remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { adopted: ['I1'] }); // 重新采纳,未带新 revision_summary
  const mm = s.points.find((p) => p.id === 'I1').meta || {};
  assert.equal(mm.revision_summary, undefined, '不得残留上次被拒的 revision_summary');
  assert.equal(mm.pending, undefined, '不得残留上次的 pending');
});

test('validateRound: remaining_issues / adopted 数组内重复 id 被拒(RS-P2-008)', () => {
  const r1 = validateRound(emptyState(), {
    remaining_issues: [{ id: 'I1', title: 'a', severity: 'major' }, { id: 'I1', title: 'b', severity: 'minor' }],
  });
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join('\n'), /remaining_issues 含重复 id: I1/);

  const prev = { round: 1, points: [{ id: 'O1', state: 'open', severity: 'major', title: 't' }] };
  const r2 = validateRound(prev, { remaining_issues: [{ id: 'O1', title: 't', severity: 'major' }], adopted: ['O1', 'O1'] });
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join('\n'), /adopted 含重复 id: O1/);
});
