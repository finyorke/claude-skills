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
  // 注:merged 点须互易(I1.merged_from 含 I2),否则 fail-closed 闸门(RS-P2-013-R2)会因结构非法拒收敛。
  const r = canConverge({ round: 3, points: [{ id: 'I1', state: 'agreed', merged_from: ['I2'] }, { id: 'I2', state: 'merged', merged_into: 'I1' }] }, 'AGREE', true);
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

// ---- RS-INT-001 / RS-PIPE-ROUND:完整管线集成,**一轮一次完整管线**(每个 Codex 轮 = 一次 reduce,
// 把该轮 Codex 输出 + Claude 对它的回应合并进同一 round),每轮跑 validate-round→reduce→validate-state→converge。
function runRoundPipeline(prev, round, codexVerdict, claudeAgree) {
  const vr = validateRound(prev, round);
  assert.equal(vr.ok, true, `validate-round: ${JSON.stringify(vr.errors)}`);
  const next = reduce(prev, round);
  assert.equal(validateState(next).ok, true, `validate-state: ${JSON.stringify(validateState(next).errors)}`);
  return { next, conv: canConverge(next, codexVerdict, claudeAgree) };
}
test('集成:两轮各跑一次完整管线,round 计数正确且收敛闸门正确', () => {
  // 第 1 轮 = Codex 出 2 issue(I1/I2)+ Claude 当轮回应(采纳 I1 / 反驳 I2)。
  const round1 = {
    remaining_issues: [
      { id: 'I1', title: 'a', detail: 'da', severity: 'major' },
      { id: 'I2', title: 'b', detail: 'db', severity: 'minor' },
    ],
    candidate_dispositions: [],
    adopted: [{ id: 'I1', revision_summary: '改A' }],
    rebutted: [{ id: 'I2', rebuttal: '不成立' }],
  };
  let { next: s, conv } = runRoundPipeline(emptyState(), round1, 'CHANGES', false);
  assert.equal(s.round, 1);
  assert.deepEqual(counts(s), { open: 0, candidate: 2, agreed: 0, merged: 0 });
  assert.equal(conv.converged, false);

  // 第 2 轮 = Codex 对两个 candidate 全 confirmed + AGREE,Claude 无新回应。
  const round2 = {
    remaining_issues: [], candidate_dispositions: [
      { id: 'I1', disposition: 'confirmed' }, { id: 'I2', disposition: 'confirmed' },
    ],
  };
  ({ next: s, conv } = runRoundPipeline(s, round2, 'AGREE', true));
  assert.equal(s.round, 2, '两个 Codex 轮 = round 计数 2(每轮一次 reduce)');
  assert.deepEqual(counts(s), { open: 0, candidate: 0, agreed: 2, merged: 0 });
  assert.equal(conv.converged, true, '全 agreed + 双 AGREE → 收敛');
});

test('集成:Codex AGREE 但仍有未确认 candidate → validate-round 报覆盖缺失,不得收敛', () => {
  const s = { round: 2, points: [
    { id: 'C1', state: 'candidate', severity: 'major', title: 't1' },
    { id: 'C2', state: 'candidate', severity: 'minor', title: 't2' },
  ] };
  // codex 给 AGREE 却只确认了 C1(漏 C2)→ 协议异常
  const r = { verdict: 'AGREE', remaining_issues: [], candidate_dispositions: [{ id: 'C1', disposition: 'confirmed' }] };
  const vr = validateRound(s, r);
  assert.equal(vr.ok, false);
  assert.match(vr.errors.join('\n'), /candidate C2 未被裁定/);
  // 即便误施加,reduce 后 C2 仍 candidate → converge 拒(无隐式确认)
  const s2 = reduce(s, r);
  assert.equal(canConverge(s2, 'AGREE', true).converged, false);
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

test('RS-P2-OPEN: 反驳成功路径能收敛(open→rebut→candidate→confirmed→agreed)', () => {
  // 1) Codex 提 I1;2) Claude 反驳(不采纳)→ candidate(rebuttal);3) Codex 接受反驳 confirmed → agreed。
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  assert.equal(s.points.find((p) => p.id === 'I1').state, 'open');
  s = reduce(s, { rebutted: [{ id: 'I1', rebuttal: '该顾虑不成立因为X' }] });
  const cand = s.points.find((p) => p.id === 'I1');
  assert.equal(cand.state, 'candidate');
  assert.equal(cand.meta.response_type, 'rebuttal');
  // 反驳的 candidate 也要被 Codex 裁定
  const vr = validateRound(s, { candidate_dispositions: [{ id: 'I1', disposition: 'confirmed' }] });
  assert.equal(vr.ok, true, JSON.stringify(vr.errors));
  s = reduce(s, { candidate_dispositions: [{ id: 'I1', disposition: 'confirmed' }] });
  assert.equal(s.points.find((p) => p.id === 'I1').state, 'agreed', '反驳被接受 → agreed(可收敛)');
  assert.equal(canConverge(s, 'AGREE', true).converged, true, '反驳成功后应能收敛(修 RS-P2-OPEN)');
});

test('RS-P2-META: 反驳被拒后改为采纳,清除旧 rebuttal', () => {
  let s = reduce(emptyState(), { remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { rebutted: [{ id: 'I1', rebuttal: '旧反驳' }] });
  s = reduce(s, { candidate_dispositions: [{ id: 'I1', disposition: 'rejected' }], remaining_issues: [{ id: 'I1', title: 't', severity: 'major' }] });
  s = reduce(s, { adopted: [{ id: 'I1', revision_summary: '新修订' }] });
  const mm = s.points.find((p) => p.id === 'I1').meta;
  assert.equal(mm.response_type, 'revision');
  assert.equal(mm.revision_summary, '新修订');
  assert.equal(mm.rebuttal, undefined, '旧 rebuttal 必须被清除(RS-P2-META)');
});

test('validateRound: rebutted 只能作用于 open,且不得与 adopted 同 id', () => {
  const prev = { round: 1, points: [{ id: 'C1', state: 'candidate', severity: 'major', title: 't' }] };
  const r1 = validateRound(prev, {
    candidate_dispositions: [{ id: 'C1', disposition: 'confirmed' }],
    rebutted: ['C1'], // C1 在中间态(disp 后)是 agreed,非 open
  });
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join('\n'), /rebutted 只能作用于 open/);
  const prev2 = { round: 1, points: [{ id: 'O1', state: 'open', severity: 'major', title: 't' }] };
  const r2 = validateRound(prev2, { adopted: ['O1'], rebutted: ['O1'] });
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join('\n'), /不能同轮既 adopted 又 rebutted/);
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

// ---- v0.8.1 加固:收敛完整性(RS-P2-010 merge 假收敛 / RS-P2-013 CLI+canConverge)----
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const RS_CLI = fileURLToPath(new URL('../scripts/review-state.mjs', import.meta.url));
function rsCli(cmd, inp) {
  const r = spawnSync(process.execPath, [RS_CLI, cmd], { input: JSON.stringify(inp), encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null };
}

test('RS-P2-010: 不能把 open/candidate 合入已 agreed 目标(防 merge 假收敛)', () => {
  const prev = { round: 2, points: [
    { id: 'A1', state: 'agreed', severity: 'major', title: 'a' },
    { id: 'O1', state: 'open', severity: 'major', title: 'o' },
    { id: 'C1', state: 'candidate', severity: 'major', title: 'c' },
  ] };
  const openIntoAgreed = validateRound(prev, { remaining_issues: [], candidate_dispositions: [{ id: 'C1', disposition: 'confirmed' }], merges: [{ from: ['O1'], into: 'A1' }] });
  assert.equal(openIntoAgreed.ok, false);
  assert.match(openIntoAgreed.errors.join('\n'), /不能把未决点 O1.*合入已 agreed/);
});

test('RS-P2-010: candidate 合入 agreed 同样被拒', () => {
  const prev = { round: 2, points: [
    { id: 'A1', state: 'agreed', severity: 'major', title: 'a' },
    { id: 'C1', state: 'candidate', severity: 'major', title: 'c' },
  ] };
  // 本轮先把 C1 留作未裁定会触发覆盖错误,这里单测 merge 守门:给 C1 一个 confirmed 使其在中间态成 agreed 前——
  // 但 merge 在 dispositions 之后的中间态检查,故用一个不被 disposition 改动的 candidate 更直接:
  const prev2 = { round: 2, points: [
    { id: 'A1', state: 'agreed', severity: 'major', title: 'a' },
    { id: 'C2', state: 'candidate', severity: 'major', title: 'c2' },
  ] };
  const r = validateRound(prev2, { remaining_issues: [{ id: 'C2', title: 'c2', severity: 'major' }], candidate_dispositions: [{ id: 'C2', disposition: 'rejected' }], merges: [{ from: ['C2'], into: 'A1' }] });
  // C2 被 rejected → 中间态回 open → open 合入 agreed,仍应被拒
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /不能把未决点 C2.*合入已 agreed/);
});

test('RS-P2-010: open 合入 open / agreed 合入 agreed 合法', () => {
  const prevOO = { round: 2, points: [
    { id: 'O1', state: 'open', severity: 'major', title: 'o1' },
    { id: 'O2', state: 'open', severity: 'major', title: 'o2' },
  ] };
  assert.equal(validateRound(prevOO, { remaining_issues: [], merges: [{ from: ['O1'], into: 'O2' }] }).ok, true);
  const prevAA = { round: 2, points: [
    { id: 'A1', state: 'agreed', severity: 'major', title: 'a1' },
    { id: 'A2', state: 'agreed', severity: 'major', title: 'a2' },
  ] };
  assert.equal(validateRound(prevAA, { remaining_issues: [], merges: [{ from: ['A1'], into: 'A2' }] }).ok, true);
});

test('RS-P2-013: canConverge 仅严格 true 算同意(字符串/真值非 true 不收敛)', () => {
  const st = { round: 3, points: [{ id: 'I1', state: 'agreed' }] };
  assert.equal(canConverge(st, 'AGREE', true).converged, true);
  assert.equal(canConverge(st, 'AGREE', 'false').converged, false, "字符串 'false' 不得被当同意");
  assert.equal(canConverge(st, 'AGREE', 1).converged, false);
  assert.equal(canConverge(st, 'AGREE', undefined).converged, false);
});

test('RS-P2-013: CLI converge 缺 state → missing_state(不对空账本判收敛)', () => {
  const r = rsCli('converge', { codexVerdict: 'AGREE', claudeAgree: true });
  assert.equal(r.out.error, 'missing_state');
});

test('RS-P2-013: CLI converge claudeAgree 非布尔 → bad_claudeAgree', () => {
  const r = rsCli('converge', { state: { round: 1, points: [] }, codexVerdict: 'AGREE', claudeAgree: 'false' });
  assert.equal(r.out.error, 'bad_claudeAgree');
});

test('RS-P2-013: CLI 坏 JSON → bad_json(不抛 Node stack)', () => {
  const r = spawnSync(process.execPath, [RS_CLI, 'reduce'], { input: '{not json', encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.error, 'bad_json');
});

test('RS-P2-013-R1: CLI reduce/validate-round 缺 prevState → missing_prevstate(防漏传清空历史)', () => {
  const r1 = rsCli('reduce', { round: { remaining_issues: [] } }); // 无 prevState
  assert.equal(r1.out.error, 'missing_prevstate');
  const r2 = rsCli('validate-round', { round: { remaining_issues: [] } });
  assert.equal(r2.out.error, 'missing_prevstate');
  // 首轮显式传 emptyState → 正常工作
  const ok = rsCli('reduce', { prevState: { round: 0, points: [] }, round: { remaining_issues: [{ id: 'I1', title: 't', detail: 'd', severity: 'major' }] } });
  assert.equal(ok.out.round, 1);
  assert.equal(ok.out.points.length, 1);
});

test('RS-P2-013-R2: canConverge 对畸形/未知 state 的点 fail-closed(不假收敛)', () => {
  const bogus = { round: 3, points: [{ id: 'I1', state: 'bogus' }] };
  const r = canConverge(bogus, 'AGREE', true);
  assert.equal(r.converged, false, '未知 state 不得被漏掉而假收敛');
  assert.match(r.reasons.join('\n'), /结构非法/);
  // CLI 同样 fail-closed
  const c = rsCli('converge', { state: bogus, codexVerdict: 'AGREE', claudeAgree: true });
  assert.equal(c.out.converged, false);
});

test('RS-P2-013-R3: canConverge 函数对缺/非数组 points fail-closed(与 CLI 一致)', () => {
  assert.equal(canConverge({ round: 1 }, 'AGREE', true).converged, false);
  assert.equal(canConverge({ round: 1, points: null }, 'AGREE', true).converged, false);
  assert.match(canConverge({ round: 1 }, 'AGREE', true).reasons.join('\n'), /points 缺失或非数组/);
  // 正常显式空账本(真无 issue)仍可收敛
  assert.equal(canConverge({ round: 1, points: [] }, 'AGREE', true).converged, true);
});
