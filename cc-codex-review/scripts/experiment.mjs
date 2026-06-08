#!/usr/bin/env node
// experiment.mjs — P3「首轮遗漏检查」A/B 对照实验脚手架(见 DESIGN §12)。无状态纯函数。
//
// 目的:用配对实验(而非直觉)判断「arm B = 首轮追加一次遗漏检查」相对「arm A = 现行协议」
//       是否在**不牺牲质量**的前提下减少轮数/成本。质量优先:绝不用少找到的有效 issue、更高
//       的噪音/未收敛率、或更多不必要修订去换速度。
//
// 数据模型(每个"任务×臂"一条 run 记录;issues 的 effective 由**盲评/固定 rubric 终局复核**给出,
// 而非"被采纳即算有效"——effective_basis 显式记录该判定来源,使结论可审计):
//   {
//     task: 'T1',            // 任务 id(A/B 必须配对:同一 task 两臂各一条)
//     arm: 'A' | 'B',
//     budget: 6,            // 该次运行的 max-rounds 预算(一次裁决内**所有** run 必须相等)
//     converged: true,      // RESOLVED=true / UNRESOLVED=false(必须纳入 UNRESOLVED 样本)
//     rounds: 3,            // 实际轮数(取自 metrics.aggregate.rounds)
//     wall_clock_ms: 1234,  // 取自 metrics.aggregate.total_wall_clock_ms(缺则 null)
//     issues: [{ id:'I1', effective:true }, ...], // 本次共提的 issue + rubric 判定
//     effective_basis: 'blind' | 'rubric', // issues 非空时必填:effective 的判定来源(审计用)
//     unnecessary_revisions: 0, // 反向质量指标:事后 rubric 认为本不必要的修订数
//   }
import { pathToFileURL } from 'node:url';

const isBool = (v) => v === true || v === false;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => isNum(v) && Number.isInteger(v);

// 纯函数:严格校验一臂的 run 记录,返回错误数组(空=合法)。
// 拒绝畸形/未完成记录,杜绝 "false" 字符串当 true、缺字段当 0/空 等隐患(P3-EXP-001/005)。
export function validateRuns(runs = [], arm = '?') {
  const errors = [];
  if (!Array.isArray(runs)) return [`arm ${arm}: runs 非数组`];
  runs.forEach((r, i) => {
    const at = `arm ${arm} run#${i}(task=${r && r.task})`;
    if (!r || typeof r !== 'object') { errors.push(`${at}: 非对象`); return; }
    if (typeof r.task !== 'string' || !r.task) errors.push(`${at}: task 须为非空字符串`);
    if (r.arm !== arm) errors.push(`${at}: arm 须为 '${arm}'(与所属臂一致,审计字段)`); // 防错臂记录(P3-EXP-001 轮3)
    if (!isInt(r.budget) || r.budget < 0) errors.push(`${at}: budget 须为非负整数`);
    if (!isBool(r.converged)) errors.push(`${at}: converged 须为严格布尔`);
    if (!isInt(r.rounds) || r.rounds < 0) errors.push(`${at}: rounds 须为非负整数`);
    // budget>0 表示硬上限(budget=0 = --max-rounds 0 无上限,不设此约束),rounds 不应超过它(P3-EXP-001 轮3)
    if (isInt(r.budget) && r.budget > 0 && isInt(r.rounds) && r.rounds > r.budget)
      errors.push(`${at}: rounds(${r.rounds})超过 budget(${r.budget})`);
    if (r.wall_clock_ms != null && (!isNum(r.wall_clock_ms) || r.wall_clock_ms < 0))
      errors.push(`${at}: wall_clock_ms 须为非负 number 或 null`); // 负墙钟不可能(P3-EXP-001)
    if (!isInt(r.unnecessary_revisions) || r.unnecessary_revisions < 0)
      errors.push(`${at}: unnecessary_revisions 须为非负整数(裁决输入,不可缺失/折算为 0)`); // 必填(P3-EXP-001)
    if (!Array.isArray(r.issues)) { errors.push(`${at}: issues 须为数组`); return; }
    const ids = new Set();
    r.issues.forEach((it, j) => {
      if (!it || typeof it !== 'object') { errors.push(`${at}.issues[${j}]: 非对象`); return; }
      if (typeof it.id !== 'string' || !it.id) errors.push(`${at}.issues[${j}]: id 须为非空字符串`);
      else if (ids.has(it.id)) errors.push(`${at}.issues[${j}]: id 重复 (${it.id})`);
      else ids.add(it.id);
      if (!isBool(it.effective)) errors.push(`${at}.issues[${j}]: effective 须为严格布尔`);
    });
    if (r.issues.length > 0 && r.effective_basis !== 'blind' && r.effective_basis !== 'rubric')
      errors.push(`${at}: issues 非空时 effective_basis 须为 'blind' 或 'rubric'(有效性须经终局复核,不可由"被采纳"推定)`);
  });
  return errors;
}

// 纯函数:把某一臂跨任务的 run 汇总。
export function armSummary(runs = []) {
  const rs = Array.isArray(runs) ? runs : []; // 对畸形/非数组输入安全(compare 在 paired=false 时仍调它)
  const n = rs.length;
  const sum = (f) => rs.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  const issues = rs.flatMap((r) => (r && r.issues) || []);
  const total_issues = issues.length;
  const effective = issues.filter((i) => i && i.effective === true).length;
  const unconverged = rs.filter((r) => !(r && r.converged)).length;
  const allTimed = n > 0 && rs.every((r) => typeof (r && r.wall_clock_ms) === 'number');
  return {
    tasks: n,
    converged: rs.filter((r) => r && r.converged).length,
    unconverged,
    unconverged_rate: n ? unconverged / n : null,
    effective_issues: effective,
    total_issues,
    noise: total_issues - effective,
    noise_rate: total_issues ? (total_issues - effective) / total_issues : null,
    unnecessary_revisions: sum((r) => r && r.unnecessary_revisions),
    rounds: sum((r) => r && r.rounds),
    avg_rounds: n ? sum((r) => r && r.rounds) / n : null,
    total_wall_clock_ms: allTimed ? sum((r) => r && r.wall_clock_ms) : null,
  };
}

// 纯函数:校验 + 配对 + 两臂汇总 + 差值(B − A)。
// 配对要求(任一不满足 → paired=false,decide 据此 inconclusive):
//   ① 两臂记录均合法(validateRuns);② 臂内 task 不重复;③ 两臂 task 集合相等;
//   ④ **一次裁决内所有 run 预算统一**(相同预算快照,P3-EXP-003)。
export function compare(A = [], B = []) {
  const errors = [...validateRuns(A, 'A'), ...validateRuns(B, 'B')];
  const aArr = Array.isArray(A) ? A : []; // 非数组输入须 paired=false,不得在下方 map 时抛异常(P3-EXP-001)
  const bArr = Array.isArray(B) ? B : [];
  const key = (r) => (r && typeof r === 'object' ? r.task : undefined); // 畸形元素不抛(P3-EXP-001 轮3)
  const byA = new Map(aArr.map((r) => [key(r), r]));
  const byB = new Map(bArr.map((r) => [key(r), r]));
  if (aArr.length !== byA.size) errors.push('arm A 存在重复 task id');
  if (bArr.length !== byB.size) errors.push('arm B 存在重复 task id');
  const tasksA = [...byA.keys()].sort();
  const tasksB = [...byB.keys()].sort();
  if (JSON.stringify(tasksA) !== JSON.stringify(tasksB))
    errors.push(`任务未配对:A=[${tasksA.join(',')}] B=[${tasksB.join(',')}]`);
  const budgets = new Set([...aArr, ...bArr].map((r) => r && r.budget).filter((b) => b != null));
  if (budgets.size > 1) errors.push(`预算快照不统一(须同预算比较):{${[...budgets].join(',')}}`);

  const sa = armSummary(aArr);
  const sb = armSummary(bArr);
  const d = (k) => (typeof sa[k] === 'number' && typeof sb[k] === 'number' ? sb[k] - sa[k] : null);
  return {
    paired: errors.length === 0,
    errors,
    A: sa,
    B: sb,
    delta: { // B − A:effective 越大越好;noise/noise_rate/unconverged_rate/rounds/wall/unnecessary 越小越好
      effective_issues: d('effective_issues'),
      noise: d('noise'),
      noise_rate: d('noise_rate'),
      unconverged_rate: d('unconverged_rate'),
      rounds: d('rounds'),
      avg_rounds: d('avg_rounds'),
      total_wall_clock_ms: d('total_wall_clock_ms'),
      unnecessary_revisions: d('unnecessary_revisions'),
    },
  };
}

// 纯函数:质量优先决策规则。verdict ∈ { adopt_B, keep_A, inconclusive }
// opts: minTasks(默认 3,呼应"≥3 真实任务")· minWallClockRel(默认 0.05:墙钟须变化≥5% 才计入)
// 守门(任一 → inconclusive,样本/数据不足以下结论):
//   - 配对无效;配对任务 < minTasks;
//   - 任一臂墙钟未知(Σwall-clock 是必比维度,"未知"≠"不更差",P3-EXP-004);
//   - 两臂有效 issue 均为 0(质量门无检测力,P3-EXP-007)。
// 质量门(B 在任一质量维度回退即 keep_A,不拿质量换速度):
//   有效 issue 减少 / 绝对噪音增多 / 噪音率升高 / 未收敛率升高 / 不必要修订增多
//   (P3-EXP-002 用绝对 noise、P3-EXP-008 不必要修订计为质量)。
// 采纳:质量不回退,且 B 在某维度**实质更优**(含未收敛率下降,P3-EXP-006)、且无任一维度更差 → adopt_B;
//       否则 inconclusive(诚实报告无净改善,而非谎称"无差异")。
export function decide(cmp, opts = {}) {
  const minTasks = opts.minTasks ?? 3;
  const rel = opts.minWallClockRel ?? 0.05;
  const out = (verdict, reasons, quality_ok = null) => ({ verdict, reasons, quality_ok });
  // 守 opts 合法性:防非法阈值制造错误采纳(P3-EXP-007 轮3,如 rel=-1 使墙钟上升被判下降)
  if (!Number.isInteger(minTasks) || minTasks < 1) return out('inconclusive', ['minTasks 非法(须为正整数)']);
  if (!(typeof rel === 'number' && rel > 0 && rel <= 1)) return out('inconclusive', ['minWallClockRel 非法(须 ∈ (0,1])']); // 须>0:rel=0 会把持平误判为改善(P3-EXP-007 轮4)
  if (!cmp.paired) return out('inconclusive', ['配对无效:' + cmp.errors.join('; ')]);
  if (cmp.A.tasks < minTasks) return out('inconclusive', [`配对任务仅 ${cmp.A.tasks} < ${minTasks},样本不足`]);
  if (cmp.A.total_wall_clock_ms == null || cmp.B.total_wall_clock_ms == null)
    return out('inconclusive', ['墙钟未知,无法判定成本是否不更差(Σwall-clock 为必比维度)']);
  if (cmp.A.effective_issues === 0 && cmp.B.effective_issues === 0)
    return out('inconclusive', ['两臂均无有效 issue,质量门无检测力,样本不支撑结论']);

  // 质量门:任一回退 → keep_A
  const qreg = [];
  if (cmp.B.effective_issues < cmp.A.effective_issues) qreg.push(`B 少找到 ${cmp.A.effective_issues - cmp.B.effective_issues} 个有效 issue`);
  if (cmp.B.noise > cmp.A.noise) qreg.push(`B 绝对噪音增多 ${cmp.B.noise - cmp.A.noise}`);
  if (cmp.A.noise_rate != null && cmp.B.noise_rate != null && cmp.B.noise_rate > cmp.A.noise_rate)
    qreg.push(`B 噪音率升高 ${((cmp.B.noise_rate - cmp.A.noise_rate) * 100).toFixed(1)}pp`);
  if (cmp.A.unconverged_rate != null && cmp.B.unconverged_rate != null && cmp.B.unconverged_rate > cmp.A.unconverged_rate)
    qreg.push(`B 未收敛率升高 ${((cmp.B.unconverged_rate - cmp.A.unconverged_rate) * 100).toFixed(1)}pp`);
  if (cmp.B.unnecessary_revisions > cmp.A.unnecessary_revisions) qreg.push(`B 不必要修订增多 ${cmp.B.unnecessary_revisions - cmp.A.unnecessary_revisions}`);
  if (qreg.length) return out('keep_A', ['质量优先:' + qreg.join('; ')], false);

  // 改善 / 回退(质量已确保不回退,这里捕捉成本维度回退 + 任意维度的实质改善)
  const improvements = [], regressions = [];
  if (cmp.B.effective_issues > cmp.A.effective_issues) improvements.push('有效 issue 增多');
  if (cmp.B.noise < cmp.A.noise) improvements.push('噪音减少');
  if (cmp.A.unconverged_rate != null && cmp.B.unconverged_rate != null && cmp.B.unconverged_rate < cmp.A.unconverged_rate)
    improvements.push('未收敛率下降');
  if (cmp.B.unnecessary_revisions < cmp.A.unnecessary_revisions) improvements.push('不必要修订减少');
  // 轮数用整数总和(避免 avg 抖动);墙钟须变化≥minWallClockRel 才计入(避免 1ms 触发,P3-EXP-007)
  if (cmp.B.rounds < cmp.A.rounds) improvements.push('总轮数下降');
  else if (cmp.B.rounds > cmp.A.rounds) regressions.push('总轮数上升');
  // 墙钟:零基线安全的相对差(base=max(wcA,1) 避免除零;wcA=0、B>0 时计回退,P3-EXP-007 轮4)
  const wcA = cmp.A.total_wall_clock_ms, wcB = cmp.B.total_wall_clock_ms;
  const drop = (wcA - wcB) / Math.max(wcA, 1); // >0 表示 B 更快
  if (drop >= rel) improvements.push('墙钟显著下降');
  else if (-drop >= rel) regressions.push('墙钟显著上升');

  if (improvements.length && !regressions.length)
    return out('adopt_B', [`质量未回退,且实质更优:${improvements.join('、')}`], true);
  if (regressions.length)
    return out('inconclusive', [`质量未回退,但成本互有增减(更优:${improvements.join('、') || '无'};更差:${regressions.join('、')})`], true);
  return out('inconclusive', ['质量未回退,但无实质净改善(各维度持平或差异低于阈值)'], true);
}

// 薄 CLI:validate {runs,arm} / arm-summary {runs} / compare {A,B} / decide {A,B,minTasks?,minWallClockRel?}
function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const cmd = process.argv[2];
  const raw = await readStdin();
  const inp = raw.trim() ? JSON.parse(raw) : {};
  let out;
  if (cmd === 'validate') out = { errors: validateRuns(inp.runs || [], inp.arm || '?') };
  else if (cmd === 'arm-summary') out = armSummary(inp.runs || []);
  else if (cmd === 'compare') out = compare(inp.A || [], inp.B || []);
  else if (cmd === 'decide') out = decide(compare(inp.A || [], inp.B || []), { minTasks: inp.minTasks, minWallClockRel: inp.minWallClockRel });
  else { process.stderr.write(`unknown cmd: ${cmd}\n`); process.exit(2); }
  process.stdout.write(JSON.stringify(out) + '\n');
}
