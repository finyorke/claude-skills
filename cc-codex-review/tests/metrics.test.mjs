import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundMetrics, aggregate, aggregateTasks } from '../scripts/metrics.mjs';

test('roundMetrics: new/repeat 由 id 是否在 prevState 确定性判定', () => {
  const prev = { round: 1, points: [{ id: 'I1', state: 'open' }] };
  const m = roundMetrics(prev, {
    remaining_issues: [
      { id: 'I1', title: 't', detail: 'd', severity: 'major' }, // repeat(prev 有)
      { id: 'I2', title: 't', detail: 'd', severity: 'minor' }, // new
    ],
    candidate_dispositions: [],
  }, { wall_clock_ms: 1234 });
  assert.equal(m.round, 2);
  assert.equal(m.new, 1);
  assert.equal(m.repeat, 1);
  assert.equal(m.wall_clock_ms, 1234);
});

test('roundMetrics: revision_induced 只计 new∩标签,stuck 只计 repeat∩标签(防误标膨胀)', () => {
  const prev = { round: 1, points: [{ id: 'R1', state: 'open' }] };
  const m = roundMetrics(prev, {
    remaining_issues: [
      { id: 'N1', title: 't', detail: 'd', severity: 'major' }, // new
      { id: 'R1', title: 't', detail: 'd', severity: 'major' }, // repeat
    ],
    candidate_dispositions: [],
    revision_induced: ['N1', 'R1'], // R1 是 repeat,不应计入 revision_induced
    stuck: ['R1', 'N1'],            // N1 是 new,不应计入 stuck
  });
  assert.equal(m.revision_induced, 1, '只 N1 计入(R1 是 repeat 被排除)');
  assert.equal(m.stuck, 1, '只 R1 计入(N1 是 new 被排除)');
});

test('roundMetrics: confirmed/rejected 来自 candidate_dispositions', () => {
  const m = roundMetrics({ round: 2, points: [] }, {
    remaining_issues: [],
    candidate_dispositions: [
      { id: 'C1', disposition: 'confirmed' },
      { id: 'C2', disposition: 'rejected' },
      { id: 'C3', disposition: 'confirmed' },
    ],
  });
  assert.equal(m.confirmed, 2);
  assert.equal(m.rejected, 1);
});

test('aggregate: 求和;全有计时才给 total_wall_clock_ms', () => {
  const a1 = aggregate([
    { round: 1, new: 3, revision_induced: 0, repeat: 0, stuck: 0, confirmed: 0, rejected: 0, wall_clock_ms: 1000 },
    { round: 2, new: 1, revision_induced: 1, repeat: 2, stuck: 1, confirmed: 2, rejected: 1, wall_clock_ms: 2000 },
  ]);
  assert.equal(a1.rounds, 2);
  assert.equal(a1.new, 4);
  assert.equal(a1.repeat, 2);
  assert.equal(a1.confirmed, 2);
  assert.equal(a1.total_wall_clock_ms, 3000);
  // 任一轮缺计时 → total 为 null(不假装)
  const a2 = aggregate([
    { round: 1, new: 1, wall_clock_ms: 1000 },
    { round: 2, new: 1, wall_clock_ms: null },
  ]);
  assert.equal(a2.total_wall_clock_ms, null);
});

test('roundMetrics+aggregate: attempts 贯通,retried_rounds 计发生过重试的轮数', () => {
  const m1 = roundMetrics({ round: 0, points: [] }, { remaining_issues: [], candidate_dispositions: [] }, { wall_clock_ms: 100, attempts: 2 });
  assert.equal(m1.attempts, 2, 'attempts 必须进入度量记录(不被丢弃)');
  const a = aggregate([
    { round: 1, attempts: 1, wall_clock_ms: 100 },
    { round: 2, attempts: 2, wall_clock_ms: 200 }, // 这轮重试过
  ]);
  assert.equal(a.retried_rounds, 1);
});

test('RTRY-001: attempts 不全时 retried_rounds=null(不把缺失当未重试而低估)', () => {
  const a = aggregate([
    { round: 1, attempts: 1, wall_clock_ms: 100 },
    { round: 2, attempts: null, wall_clock_ms: 200 }, // 缺 attempts
  ]);
  assert.equal(a.retried_rounds, null, '部分缺 attempts → null,与 total_wall_clock_ms 同口径');
});

test('aggregateTasks: 跨任务聚合 + 平均轮数', () => {
  const t1 = [{ round: 1, new: 2, wall_clock_ms: 1000 }, { round: 2, new: 0, confirmed: 2, wall_clock_ms: 1000 }];
  const t2 = [{ round: 1, new: 3, wall_clock_ms: 500 }];
  const a = aggregateTasks([t1, t2]);
  assert.equal(a.tasks, 2);
  assert.equal(a.rounds, 3);
  assert.equal(a.new, 5);
  assert.equal(a.total_wall_clock_ms, 2500);
  assert.equal(a.avg_rounds_per_task, 1.5);
});

// ---- v0.8.3 metrics 加固 ----
test('MTR-NUM-001: NaN/负 wall、attempts=0 → null;aggregate 不产假 total', () => {
  assert.equal(roundMetrics({ round: 0, points: [] }, { remaining_issues: [], candidate_dispositions: [] }, { wall_clock_ms: NaN }).wall_clock_ms, null);
  assert.equal(roundMetrics({ round: 0, points: [] }, { remaining_issues: [], candidate_dispositions: [] }, { wall_clock_ms: -5 }).wall_clock_ms, null);
  assert.equal(roundMetrics({ round: 0, points: [] }, { remaining_issues: [], candidate_dispositions: [] }, { attempts: 0 }).attempts, null);
  const a = aggregate([{ round: 1, wall_clock_ms: NaN }, { round: 2, wall_clock_ms: 100 }]);
  assert.equal(a.total_wall_clock_ms, null, 'NaN 不得被当已计时而产假 total');
});

test('MTR-ID-001: remaining_issues 重复/空 id 不双计', () => {
  const m = roundMetrics({ round: 1, points: [] }, {
    remaining_issues: [{ id: 'I1', title: 't', detail: 'd', severity: 'major' }, { id: 'I1', title: 't', detail: 'd', severity: 'major' }, { id: '', title: 'x', detail: 'y', severity: 'minor' }],
    candidate_dispositions: [],
  });
  assert.equal(m.new, 1, '重复 id 去重、空 id 丢弃 → 只 1 个 new');
});

test('MET-TASK-001: aggregateTasks([]) avg_rounds_per_task=null(0 任务无均值)', () => {
  assert.equal(aggregateTasks([]).avg_rounds_per_task, null);
});
