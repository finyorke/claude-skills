#!/usr/bin/env node
// review-state.mjs — 互审「共识账本」的无状态纯函数 helper(路线图 P2,见 DESIGN §12)。
//
// 职责边界(守 DESIGN §1/§2):
//   - 只做 reduce / validate / render 三件确定性的事。
//   - **吃 codex-round.mjs 的结构化结果**(verdict + remaining_issues[].id + candidate_dispositions),
//     绝不自己跑/解析 codex stdout。
//   - **无状态**:每次调用把上一轮 state 传进来、新 state 传出去;不跨命令持久化到磁盘。
//   - **不驱动循环**:"采纳/反驳/合并"这类语义判断由 Claude(command)每轮显式传入,本模块不自行决定。
//
// point = 一个实质要点,按稳定 id 跟踪;state ∈ open | candidate | agreed | merged。
// 状态迁移(全部由本模块据传入的语义决策施加):
//   open ──(Claude 采纳修订: adopted)──▶ candidate
//   candidate ──(Codex disposition=confirmed)──▶ agreed
//   candidate ──(Codex disposition=rejected)──▶ open
//   agreed ──(Codex 重新质疑: 重新出现在 remaining_issues)──▶ open
//   point ──(合并: merges)──▶ merged(终态,记 merged_into;不再独立流转)

export const STATES = ['open', 'candidate', 'agreed', 'merged'];

export function emptyState() {
  return { round: 0, points: [] };
}

function indexById(points) {
  const m = new Map();
  for (const p of points) m.set(p.id, p);
  return m;
}

// 纯函数:给定上一轮 state + 本轮输入,算出新 state(不改入参)。
// round = {
//   verdict, remaining_issues:[{id,title,severity}], candidate_dispositions:[{id,disposition}],
//   adopted:[id...],            // 本轮 Claude 采纳并修订 → 进 candidate(应为当前 open 的点)
//   merges:[{from:[id...], into:id}]   // 可选:把 from 合并进 into
// }
export function reduce(prevState, round) {
  const m = indexById((prevState.points || []).map((p) => ({ ...p })));
  const r = round || {};
  const dispositions = r.candidate_dispositions || [];
  const issues = r.remaining_issues || [];
  const adopted = r.adopted || [];
  const merges = r.merges || [];

  // 1) 先施加 Codex 对上一轮 candidate 的裁定(事件)。
  for (const d of dispositions) {
    const p = m.get(d.id);
    if (!p) continue; // 未知 id 由 validate 兜底报错;reduce 不静默造点
    if (d.disposition === 'confirmed') p.state = 'agreed';
    else if (d.disposition === 'rejected') p.state = 'open';
  }

  // 2) 施加本轮 Codex 的 remaining_issues:新点入账(open);已 agreed 的点重新出现 = 被重新质疑 → open。
  for (const it of issues) {
    const p = m.get(it.id);
    if (!p) {
      m.set(it.id, { id: it.id, state: 'open', severity: it.severity || 'major', title: it.title || '' });
    } else {
      if (it.severity) p.severity = it.severity;
      if (it.title) p.title = it.title;
      if (p.state === 'agreed') p.state = 'open'; // 重新质疑
    }
  }

  // 3) 施加 Claude 本轮采纳(open → candidate)。
  for (const id of adopted) {
    const p = m.get(id);
    if (p && p.state === 'open') p.state = 'candidate';
  }

  // 4) 施加合并(终态 merged)。
  for (const mg of merges) {
    const into = m.get(mg.into);
    if (!into) continue;
    into.merged_from = [...(into.merged_from || []), ...(mg.from || [])];
    for (const fid of mg.from || []) {
      const fp = m.get(fid);
      if (fp) { fp.state = 'merged'; fp.merged_into = mg.into; }
    }
  }

  return { round: (prevState.round || 0) + 1, points: [...m.values()] };
}

// 纯函数:校验状态机不变量 + 本轮 disposition 协议。返回 {ok, errors:[...]}。
// ctx = { sentCandidateIds:[id...](本轮增量里 Claude 请 Codex 裁定的 candidate id),
//         dispositions:[{id,disposition}](本轮 Codex 实际给的) }
export function validate(state, ctx = {}) {
  const errors = [];
  const points = state.points || [];
  const ids = points.map((p) => p.id);

  // id 唯一
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`duplicate point id: ${id}`);
    seen.add(id);
  }
  // 合法 state + 合并完整性
  for (const p of points) {
    if (!STATES.includes(p.state)) errors.push(`point ${p.id}: invalid state '${p.state}'`);
    if (p.state === 'merged') {
      if (!p.merged_into) errors.push(`merged point ${p.id} missing merged_into`);
      else if (!seen.has(p.merged_into)) errors.push(`point ${p.id} merged_into unknown id ${p.merged_into}`);
      if (p.merged_into === p.id) errors.push(`point ${p.id} merged_into itself`);
    }
    if (p.parent_id && p.parent_id === p.id) errors.push(`point ${p.id} parent_id is itself`);
  }

  // disposition 协议:覆盖本轮全部 sentCandidate + 不引用未知/非本轮 id
  const sent = new Set(ctx.sentCandidateIds || []);
  const disp = ctx.dispositions || [];
  const dispIds = new Set(disp.map((d) => d.id));
  for (const id of sent) {
    if (!dispIds.has(id)) errors.push(`candidate ${id} 未被 Codex 裁定(disposition 须覆盖本轮全部 candidate)`);
  }
  for (const d of disp) {
    if (!sent.has(d.id)) errors.push(`disposition 引用了非本轮 candidate id: ${d.id}`);
    if (d.disposition !== 'confirmed' && d.disposition !== 'rejected') {
      errors.push(`disposition ${d.id}: 非法值 '${d.disposition}'`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// 纯函数:能否收敛(双 AGREE 闸门的状态侧)。candidate 非空一律不可收敛。
export function canConverge(state, codexVerdict, claudeAgree) {
  const pts = state.points || [];
  const open = pts.filter((p) => p.state === 'open').length;
  const cand = pts.filter((p) => p.state === 'candidate').length;
  const reasons = [];
  if (codexVerdict !== 'AGREE') reasons.push('Codex 未 AGREE');
  if (!claudeAgree) reasons.push('Claude 仍持异议');
  if (cand > 0) reasons.push(`仍有 ${cand} 个 candidate 未被确认(收敛时须为空)`);
  if (open > 0) reasons.push(`仍有 ${open} 个 open 分歧`);
  return { converged: reasons.length === 0, reasons };
}

export function counts(state) {
  const c = { open: 0, candidate: 0, agreed: 0, merged: 0 };
  for (const p of state.points || []) c[p.state] = (c[p.state] || 0) + 1;
  return c;
}

// 渲染:进度行。
export function renderProgress(round, codexVerdict, blockers, claudeStance) {
  return `第 ${round} 轮 · Codex=${codexVerdict} · 剩 ${blockers.k} issue(${blockers.b} blocker) · Claude=${claudeStance}`;
}

// 渲染:四段 UNRESOLVED 块(供 review.md §7)。meta = {reason, reviewed_scope, assumptions, truncated}。
export function renderUnresolved(state, meta = {}) {
  const pts = state.points || [];
  const by = (s) => pts.filter((p) => p.state === s);
  const agreed = by('agreed'), candidate = by('candidate'), open = by('open');
  const L = [];
  L.push(`⚠️ 未收敛(状态:UNRESOLVED · 原因:${meta.reason || '未指明'})`);
  L.push(`评审范围:${meta.reviewed_scope || '—'}  ·  关键假设:${(meta.assumptions || []).join('; ') || '—'}`);
  if (meta.truncated) L.push('⚠️ 基于截断材料,下列「已达成一致」均为非完整签核,人工裁决时须复核范围');
  L.push('');
  L.push('### ✅ 已达成一致(双方已确认,可视为已定结论)');
  L.push(agreed.length ? agreed.map((p) => `- [${p.id}] ${p.title}`).join('\n') : '无——双方自始至终未就任何要点达成一致');
  L.push('');
  L.push('### 🔶 待复核确认(Claude 已让步,Codex 尚未确认 —— 不算定论)');
  L.push(candidate.length ? candidate.map((p) => `- [${p.id}] ${p.title}(来源严重度:${p.severity})`).join('\n') : '无');
  L.push('');
  L.push('### ❌ 仍未达成一致');
  L.push(open.length ? open.map((p) => `- [${p.id}] ${p.title}(影响严重度:${p.severity})`).join('\n') : '无');
  L.push('');
  L.push('### 📋 给用户的裁决建议');
  L.push('<按影响严重度排序;到达 max-rounds 时提示「到顶≠问题已穷尽,可调高 --max-rounds 继续」>');
  return L.join('\n');
}

// 薄 CLI:review.md 可经 bash 调用。用法:
//   echo '{"prevState":{...},"round":{...}}'   | node review-state.mjs reduce
//   echo '{"state":{...},"ctx":{...}}'          | node review-state.mjs validate
//   echo '{"state":{...},"meta":{...}}'         | node review-state.mjs render-unresolved
//   echo '{"state":{...},"codexVerdict":"AGREE","claudeAgree":true}' | node review-state.mjs converge
function readStdin() {
  return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cmd = process.argv[2];
  const raw = await readStdin();
  const inp = raw.trim() ? JSON.parse(raw) : {};
  let out;
  if (cmd === 'reduce') out = reduce(inp.prevState || emptyState(), inp.round || {});
  else if (cmd === 'validate') out = validate(inp.state || emptyState(), inp.ctx || {});
  else if (cmd === 'converge') out = canConverge(inp.state || emptyState(), inp.codexVerdict, !!inp.claudeAgree);
  else if (cmd === 'counts') out = counts(inp.state || emptyState());
  else if (cmd === 'render-unresolved') out = { text: renderUnresolved(inp.state || emptyState(), inp.meta || {}) };
  else { process.stderr.write(`unknown cmd: ${cmd}\n`); process.exit(2); }
  process.stdout.write(JSON.stringify(out) + '\n');
}
