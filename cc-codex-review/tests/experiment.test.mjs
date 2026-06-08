import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRuns, armSummary, compare, decide } from '../scripts/experiment.mjs';

// 合法 run 工厂:issues 非空时带 effective_basis;墙钟始终有值。
function mkRun(task, over = {}) {
  return {
    task, arm: 'A', budget: 6, converged: true, rounds: 3, wall_clock_ms: 1000,
    issues: [{ id: task + 'i', effective: true }], effective_basis: 'rubric',
    unnecessary_revisions: 0, ...over,
  };
}

test('validateRuns: 严格拒绝畸形记录(P3-EXP-001/005)', () => {
  assert.equal(validateRuns([mkRun('T1')], 'A').length, 0);
  // converged 非严格布尔
  assert.match(validateRuns([mkRun('T1', { converged: 'false' })], 'A').join(), /converged 须为严格布尔/);
  // budget 缺失
  assert.match(validateRuns([mkRun('T1', { budget: undefined })], 'A').join(), /budget 须为非负整数/);
  // rounds 非整数
  assert.match(validateRuns([mkRun('T1', { rounds: 2.5 })], 'A').join(), /rounds 须为非负整数/);
  // issue.effective 非严格布尔
  assert.match(validateRuns([mkRun('T1', { issues: [{ id: 'x', effective: 'yes' }], effective_basis: 'rubric' })], 'A').join(), /effective 须为严格布尔/);
  // issue id 重复
  assert.match(validateRuns([mkRun('T1', { issues: [{ id: 'd', effective: true }, { id: 'd', effective: false }], effective_basis: 'rubric' })], 'A').join(), /id 重复/);
  // issues 非空却无 effective_basis(P3-EXP-005)
  assert.match(validateRuns([mkRun('T1', { effective_basis: undefined })], 'A').join(), /effective_basis/);
  // issues 为空则无需 effective_basis
  assert.equal(validateRuns([mkRun('T1', { issues: [], effective_basis: undefined })], 'A').length, 0);
  // 负墙钟不可能(P3-EXP-001 轮2)
  assert.match(validateRuns([mkRun('T1', { wall_clock_ms: -5 })], 'A').join(), /wall_clock_ms 须为非负/);
  // unnecessary_revisions 必填,缺失即非法(否则被折算为 0 误导裁决)
  assert.match(validateRuns([mkRun('T1', { unnecessary_revisions: undefined })], 'A').join(), /unnecessary_revisions 须为非负整数/);
  // 非数组 runs
  assert.match(validateRuns(null, 'A').join(), /runs 非数组/);
});

test('compare: 非数组输入 → paired=false 而非抛异常(P3-EXP-001 轮2)', () => {
  const c = compare(null, [mkRun('T1', { arm: 'B' })]);
  assert.equal(c.paired, false);
  assert.match(c.errors.join(), /runs 非数组/);
});

test('compare: 畸形数组元素(null)不抛异常 → paired=false(P3-EXP-001 轮3)', () => {
  const c = compare([null], [null]);
  assert.equal(c.paired, false);
  assert.match(c.errors.join(), /非对象/);
});

test('validateRuns: 错臂 / rounds>budget 被拒(P3-EXP-001 轮3)', () => {
  assert.match(validateRuns([mkRun('T1', { arm: 'B' })], 'A').join(), /arm 须为 'A'/); // 错臂
  assert.match(validateRuns([mkRun('T1', { budget: 4, rounds: 5 })], 'A').join(), /超过 budget/); // rounds>budget
  // budget=0(无上限)不触发 rounds 上限
  assert.equal(validateRuns([mkRun('T1', { budget: 0, rounds: 9 })], 'A').length, 0);
});

test('decide: 非法 minWallClockRel(-1 或 0)→ inconclusive(P3-EXP-007 轮3/轮4)', () => {
  const A = [mkRun('T1', { wall_clock_ms: 1000 }), mkRun('T2', { wall_clock_ms: 1000 }), mkRun('T3', { wall_clock_ms: 1000 })];
  const B = [mkRun('T1', { arm: 'B', wall_clock_ms: 1100 }), mkRun('T2', { arm: 'B', wall_clock_ms: 1100 }), mkRun('T3', { arm: 'B', wall_clock_ms: 1100 })];
  assert.match(decide(compare(A, B), { minWallClockRel: -1 }).reasons.join(), /minWallClockRel 非法/);
  // rel=0 同样非法:否则墙钟持平会被判"显著下降"
  assert.equal(decide(compare(A, B), { minWallClockRel: 0 }).verdict, 'inconclusive');
});

test('decide: 零墙钟基线(A=0)、B 墙钟上升即使轮数降也不采纳(P3-EXP-007 轮4)', () => {
  const A = [mkRun('T1', { rounds: 4, wall_clock_ms: 0 }), mkRun('T2', { rounds: 4, wall_clock_ms: 0 }), mkRun('T3', { rounds: 4, wall_clock_ms: 0 })];
  const B = [mkRun('T1', { arm: 'B', rounds: 2, wall_clock_ms: 100 }), mkRun('T2', { arm: 'B', rounds: 2, wall_clock_ms: 100 }), mkRun('T3', { arm: 'B', rounds: 2, wall_clock_ms: 100 })];
  const v = decide(compare(A, B)); // 轮数降是改善,但墙钟从 0 升到正数是回退 → 互有增减
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reasons.join(), /墙钟显著上升/);
});

test('decide: B 缺 unnecessary_revisions 不再被判"减少"而误采纳(P3-EXP-001 轮2)', () => {
  const A = [mkRun('T1', { rounds: 4, wall_clock_ms: 2000, unnecessary_revisions: 1 }), mkRun('T2', { rounds: 4, wall_clock_ms: 2000 }), mkRun('T3', { rounds: 4, wall_clock_ms: 2000 })];
  const B = [mkRun('T1', { arm: 'B', rounds: 2, wall_clock_ms: 1000, unnecessary_revisions: undefined }), mkRun('T2', { arm: 'B', rounds: 2, wall_clock_ms: 1000 }), mkRun('T3', { arm: 'B', rounds: 2, wall_clock_ms: 1000 })];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'inconclusive'); // 校验失败 → 不采纳
  assert.match(v.reasons.join(), /配对无效/);
});

test('armSummary: 收敛率/有效issue/噪音/墙钟汇总', () => {
  const s = armSummary([
    mkRun('T1', { rounds: 2, wall_clock_ms: 1000, issues: [{ id: 'I1', effective: true }, { id: 'I2', effective: false }], unnecessary_revisions: 1 }),
    mkRun('T2', { converged: false, rounds: 6, wall_clock_ms: 3000, issues: [{ id: 'J1', effective: true }] }),
  ]);
  assert.equal(s.tasks, 2);
  assert.equal(s.unconverged_rate, 0.5);
  assert.equal(s.effective_issues, 2);
  assert.equal(s.total_issues, 3);
  assert.equal(s.noise, 1);
  assert.equal(s.noise_rate, 1 / 3);
  assert.equal(s.unnecessary_revisions, 1);
  assert.equal(s.avg_rounds, 4);
  assert.equal(s.total_wall_clock_ms, 4000);
});

test('armSummary: 任一 run 缺计时 → total_wall_clock_ms=null', () => {
  const s = armSummary([mkRun('T1', { wall_clock_ms: 1000 }), mkRun('T2', { wall_clock_ms: null })]);
  assert.equal(s.total_wall_clock_ms, null);
});

test('compare: 配对有效时 paired=true,delta=B−A', () => {
  const c = compare(
    [mkRun('T1', { rounds: 4, wall_clock_ms: 2000 })],
    [mkRun('T1', { arm: 'B', rounds: 2, wall_clock_ms: 1000, issues: [{ id: 'b', effective: true }] })],
  );
  assert.equal(c.paired, true);
  assert.equal(c.delta.avg_rounds, -2);
  assert.equal(c.delta.total_wall_clock_ms, -1000);
  assert.equal(c.delta.effective_issues, 0);
});

test('compare: 未配对 / 重复 id → paired=false', () => {
  assert.equal(compare([mkRun('T1')], [mkRun('T2', { arm: 'B' })]).paired, false);
  const dup = compare([mkRun('T1'), mkRun('T1')], [mkRun('T1', { arm: 'B' })]);
  assert.equal(dup.paired, false);
  assert.match(dup.errors.join(), /重复 task id/);
});

test('compare: 预算快照不统一 → paired=false(P3-EXP-003)', () => {
  const c = compare(
    [mkRun('T1', { budget: 6 }), mkRun('T2', { budget: 4 })],
    [mkRun('T1', { arm: 'B', budget: 6 }), mkRun('T2', { arm: 'B', budget: 4 })],
  );
  assert.equal(c.paired, false);
  assert.match(c.errors.join(), /预算快照不统一/);
});

test('decide: 配对不足 minTasks → inconclusive', () => {
  const v = decide(compare([mkRun('T1'), mkRun('T2')], [mkRun('T1', { arm: 'B', rounds: 2 }), mkRun('T2', { arm: 'B', rounds: 2 })]));
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reasons.join(), /样本不足/);
});

test('decide: 墙钟未知 → inconclusive(P3-EXP-004)', () => {
  const A = [mkRun('T1'), mkRun('T2'), mkRun('T3')];
  const B = [mkRun('T1', { arm: 'B', rounds: 1, wall_clock_ms: null }), mkRun('T2', { arm: 'B', rounds: 1 }), mkRun('T3', { arm: 'B', rounds: 1 })];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reasons.join(), /墙钟未知/);
});

test('decide: 两臂均无有效 issue → inconclusive(P3-EXP-007)', () => {
  const z = (t, arm, over) => mkRun(t, { arm, issues: [], effective_basis: undefined, ...over });
  const A = [z('T1', 'A'), z('T2', 'A'), z('T3', 'A')];
  const B = [z('T1', 'B', { rounds: 1, wall_clock_ms: 1 }), z('T2', 'B', { rounds: 1 }), z('T3', 'B', { rounds: 1 })];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reasons.join(), /无有效 issue/);
});

test('decide: 质量优先 — B 少找有效 issue → keep_A', () => {
  const A = [mkRun('T1'), mkRun('T2'), mkRun('T3')];
  const B = [
    mkRun('T1', { arm: 'B', rounds: 1, wall_clock_ms: 100 }),
    mkRun('T2', { arm: 'B', rounds: 1, wall_clock_ms: 100, issues: [], effective_basis: undefined }),
    mkRun('T3', { arm: 'B', rounds: 1, wall_clock_ms: 100 }),
  ];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'keep_A');
  assert.equal(v.quality_ok, false);
});

test('decide: 质量优先 — B 绝对噪音增多 → keep_A(P3-EXP-002,即便噪音率被稀释)', () => {
  // A: 每任务 1 有效;B: T1 加 2 噪音但也加有效 → noise_rate 可能不升,但绝对 noise 升
  const A = [mkRun('T1'), mkRun('T2'), mkRun('T3')];
  const B = [
    mkRun('T1', { arm: 'B', issues: [{ id: 'a', effective: true }, { id: 'a2', effective: true }, { id: 'n1', effective: false }, { id: 'n2', effective: false }] }),
    mkRun('T2', { arm: 'B' }),
    mkRun('T3', { arm: 'B' }),
  ];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'keep_A');
  assert.match(v.reasons.join(), /绝对噪音增多/);
});

test('decide: 质量优先 — A 无噪音、B 新增纯噪音 → keep_A(P3-EXP-002 null 口径)', () => {
  const A = [mkRun('T1'), mkRun('T2'), mkRun('T3')]; // noise=0
  const B = [
    mkRun('T1', { arm: 'B', issues: [{ id: 'a', effective: true }, { id: 'n', effective: false }] }),
    mkRun('T2', { arm: 'B' }), mkRun('T3', { arm: 'B' }),
  ];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'keep_A');
  assert.match(v.reasons.join(), /绝对噪音增多/);
});

test('decide: 质量优先 — 未收敛率升高即使更快也 keep_A', () => {
  const A = [mkRun('T1'), mkRun('T2'), mkRun('T3')];
  const B = [
    mkRun('T1', { arm: 'B', rounds: 1, wall_clock_ms: 100, converged: false }),
    mkRun('T2', { arm: 'B', rounds: 1, wall_clock_ms: 100 }),
    mkRun('T3', { arm: 'B', rounds: 1, wall_clock_ms: 100 }),
  ];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'keep_A');
  assert.match(v.reasons.join(), /未收敛率升高/);
});

test('decide: 质量优先 — 不必要修订增多 → keep_A(P3-EXP-008)', () => {
  const A = [mkRun('T1'), mkRun('T2'), mkRun('T3')];
  const B = [
    mkRun('T1', { arm: 'B', rounds: 1, wall_clock_ms: 100, unnecessary_revisions: 2 }),
    mkRun('T2', { arm: 'B', rounds: 1, wall_clock_ms: 100 }),
    mkRun('T3', { arm: 'B', rounds: 1, wall_clock_ms: 100 }),
  ];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'keep_A');
  assert.match(v.reasons.join(), /不必要修订增多/);
});

test('decide: 质量不回退 + 成本实质更优 → adopt_B', () => {
  const A = [mkRun('T1', { rounds: 4, wall_clock_ms: 2000 }), mkRun('T2', { rounds: 4, wall_clock_ms: 2000 }), mkRun('T3', { rounds: 4, wall_clock_ms: 2000 })];
  const B = [mkRun('T1', { arm: 'B', rounds: 2, wall_clock_ms: 1000 }), mkRun('T2', { arm: 'B', rounds: 2, wall_clock_ms: 1000 }), mkRun('T3', { arm: 'B', rounds: 2, wall_clock_ms: 1000 })];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'adopt_B');
  assert.equal(v.quality_ok, true);
});

test('decide: 未收敛率下降即可驱动 adopt_B(P3-EXP-006,不再误称无差异)', () => {
  const A = [mkRun('T1', { converged: false }), mkRun('T2'), mkRun('T3')]; // 1 未收敛
  const B = [mkRun('T1', { arm: 'B' }), mkRun('T2', { arm: 'B' }), mkRun('T3', { arm: 'B' })]; // 全收敛,其余一致
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'adopt_B');
  assert.match(v.reasons.join(), /未收敛率下降/);
});

test('decide: 仅 1ms 墙钟差(<5%)且轮数持平 → inconclusive(P3-EXP-007 阈值)', () => {
  const A = [mkRun('T1', { wall_clock_ms: 1000 }), mkRun('T2', { wall_clock_ms: 1000 }), mkRun('T3', { wall_clock_ms: 1000 })];
  const B = [mkRun('T1', { arm: 'B', wall_clock_ms: 1000 }), mkRun('T2', { arm: 'B', wall_clock_ms: 1000 }), mkRun('T3', { arm: 'B', wall_clock_ms: 999 })];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reasons.join(), /无实质净改善/);
});

test('decide: 质量不回退但成本互有增减 → inconclusive(诚实报告)', () => {
  // B 轮数降但墙钟显著升
  const A = [mkRun('T1', { rounds: 4, wall_clock_ms: 1000 }), mkRun('T2', { rounds: 4, wall_clock_ms: 1000 }), mkRun('T3', { rounds: 4, wall_clock_ms: 1000 })];
  const B = [mkRun('T1', { arm: 'B', rounds: 2, wall_clock_ms: 2000 }), mkRun('T2', { arm: 'B', rounds: 2, wall_clock_ms: 2000 }), mkRun('T3', { arm: 'B', rounds: 2, wall_clock_ms: 2000 })];
  const v = decide(compare(A, B));
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reasons.join(), /互有增减/);
});
