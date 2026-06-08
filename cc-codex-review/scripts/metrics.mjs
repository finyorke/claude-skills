#!/usr/bin/env node
// metrics.mjs — 互审 dogfood 度量(路线图 P1,见 DESIGN §12)。无状态纯函数。
//
// 目的:逐轮记录"轮次耗在何处"的可解释指标,跨 ≥3 个真实任务取样,用数据(而非直觉)驱动后续优先级。
// 设计(经互审锁定):
//   - **互斥主类**(每条本轮 Codex 提的 issue 恰好归一类,由 id 是否在 prevState 出现过**确定性判定**):
//       new   = 此前未见的 id
//       repeat= prevState 已有的 id
//   - **正交标签**(0+,需 Claude 语义判断,经 round 传入;计数时只取与主类的交集,防误标膨胀):
//       revision_induced ⊆ new   (因上一轮修订才出现的新问题)
//       stuck            ⊆ repeat (内容连续≥2 轮实质未变)
//   - **confirmed/rejected** 单独计数(来自 candidate_dispositions,是"确认"不是 issue)。
//   - **wall_clock_ms** 由 codex-round.mjs 每轮输出 = 本轮**交付**墙钟(含 bad_verdict 重试);成本 = 各轮之和。
//     codex-round 另输出 `attempts`(>1 即发生过重试),用于观察重试开销而不污染总成本口径。
import { pathToFileURL } from 'node:url';

// 纯函数:给定上一轮 state + 本轮 round(codex 输出 + Claude 的标签)→ 本轮度量记录。
// round 额外可带:revision_induced:[id], stuck:[id], wall_clock_ms:number
export function roundMetrics(prevState, round, opts = {}) {
  const prevIds = new Set((prevState.points || []).map((p) => p.id));
  const issues = round.remaining_issues || [];
  // 按 id 去重 + 丢弃缺/空 id —— new/repeat 用 id **集合**语义,重复 id 不得双计(修 MTR-ID-001)。
  const issueIds = [...new Set(issues.map((it) => it && it.id).filter((id) => typeof id === 'string' && id))];
  const newIds = issueIds.filter((id) => !prevIds.has(id));
  const repeatIds = issueIds.filter((id) => prevIds.has(id));
  const ri = new Set(round.revision_induced || []);
  const st = new Set(round.stuck || []);
  const disp = round.candidate_dispositions || [];
  // 数值域约束(修 MTR-NUM-001):wall 须有限非负、attempts 须整数≥1,否则归 null,杜绝 NaN/负/Inf 被当"已采集"而产假 total。
  const finiteNonNeg = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const posInt = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null);
  const wall = finiteNonNeg(opts.wall_clock_ms ?? round.wall_clock_ms);
  const attempts = posInt(opts.attempts ?? round.attempts);
  return {
    round: (prevState.round || 0) + 1,
    new: newIds.length,
    revision_induced: newIds.filter((id) => ri.has(id)).length, // 只计 new∩标签
    repeat: repeatIds.length,
    stuck: repeatIds.filter((id) => st.has(id)).length,          // 只计 repeat∩标签
    confirmed: disp.filter((d) => d.disposition === 'confirmed').length,
    rejected: disp.filter((d) => d.disposition === 'rejected').length,
    wall_clock_ms: wall, // 已约束为有限非负或 null
    attempts, // 已约束为整数≥1 或 null;来自 codex-round,>1 即本轮发生过重试
  };
}

// 纯函数:跨轮聚合。total_wall_clock_ms 仅当每轮都有计时才给(否则 null,不假装)。
export function aggregate(records = []) {
  const sum = (k) => records.reduce((a, r) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0);
  // 完整性判据收紧:wall 须有限非负、attempts 须整数≥1,否则不汇总(修 MTR-NUM-001:NaN 不得被当已计时而产假 total)。
  const allTimed = records.length > 0 && records.every((r) => Number.isFinite(r.wall_clock_ms) && r.wall_clock_ms >= 0);
  const allAttempts = records.length > 0 && records.every((r) => Number.isInteger(r.attempts) && r.attempts >= 1);
  return {
    rounds: records.length,
    new: sum('new'),
    revision_induced: sum('revision_induced'),
    repeat: sum('repeat'),
    stuck: sum('stuck'),
    confirmed: sum('confirmed'),
    rejected: sum('rejected'),
    total_wall_clock_ms: allTimed ? sum('wall_clock_ms') : null,
    // 与 total_wall_clock_ms 同口径:attempts 不全则 null,不静默把缺失当"未重试"而低估(修 RTRY-001)。
    retried_rounds: allAttempts ? records.filter((r) => r.attempts > 1).length : null,
  };
}

// 跨多个任务(每个任务一份 records 数组)聚合,供"≥3 任务取样"。
export function aggregateTasks(taskRecordLists = []) {
  const per = taskRecordLists.map((rs) => aggregate(rs));
  const sum = (k) => per.reduce((a, x) => a + (x[k] || 0), 0);
  const allTimed = per.length > 0 && per.every((x) => typeof x.total_wall_clock_ms === 'number');
  return {
    tasks: per.length,
    rounds: sum('rounds'),
    new: sum('new'), revision_induced: sum('revision_induced'),
    repeat: sum('repeat'), stuck: sum('stuck'),
    confirmed: sum('confirmed'), rejected: sum('rejected'),
    total_wall_clock_ms: allTimed ? sum('total_wall_clock_ms') : null,
    retried_rounds: per.length > 0 && per.every((x) => typeof x.retried_rounds === 'number') ? sum('retried_rounds') : null,
    avg_rounds_per_task: per.length ? sum('rounds') / per.length : null, // 0 任务无均值 → null,不伪装成"测得的 0"(修 MET-TASK-001)
  };
}

// 薄 CLI:round-metrics {prevState, round, wall_clock_ms} / aggregate {records} / aggregate-tasks {tasks}
function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const cmd = process.argv[2];
  const raw = await readStdin();
  const inp = raw.trim() ? JSON.parse(raw) : {};
  let out;
  if (cmd === 'round-metrics') out = roundMetrics(inp.prevState || { round: 0, points: [] }, inp.round || {}, { wall_clock_ms: inp.wall_clock_ms, attempts: inp.attempts });
  else if (cmd === 'aggregate') out = aggregate(inp.records || []);
  else if (cmd === 'aggregate-tasks') out = aggregateTasks(inp.tasks || []);
  else { process.stderr.write(`unknown cmd: ${cmd}\n`); process.exit(2); }
  process.stdout.write(JSON.stringify(out) + '\n');
}
