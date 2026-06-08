#!/usr/bin/env node
// review-state.mjs — 互审「共识账本」的无状态纯函数 helper(路线图 P2,见 DESIGN §12)。
//
// 职责边界(守 DESIGN §1/§2):
//   - 只做 reduce / validate / render 三类确定性的事。
//   - **吃 codex-round.mjs 的结构化结果**(verdict + remaining_issues[].{id,detail} + candidate_dispositions),
//     绝不自己跑/解析 codex stdout。
//   - **无状态**:每次调用把上一轮 state 传进来、新 state 传出去;不跨命令持久化到磁盘。
//   - **不驱动循环、不做语义判断**:"采纳/反驳/合并/分歧标注"由 Claude(command)每轮显式传入。
//
// point = 一个实质要点,按稳定 id 跟踪;state ∈ open | candidate | agreed | merged。
// 状态迁移(由本模块据传入语义决策施加,顺序见 reduce):
//   open ──(adopted)──▶ candidate ──(disposition confirmed)──▶ agreed
//   candidate ──(disposition rejected)──▶ open ; agreed ──(重现于 remaining_issues)──▶ open
//   point ──(merges)──▶ merged(终态,记 merged_into)
import { pathToFileURL } from 'node:url';

export const STATES = ['open', 'candidate', 'agreed', 'merged'];
const DISPOSITIONS = ['confirmed', 'rejected'];
const SEV_RANK = { blocker: 0, major: 1, minor: 2 };

export function emptyState() { return { round: 0, points: [] }; }

function indexById(points) { const m = new Map(); for (const p of points) m.set(p.id, p); return m; }
function normAdopted(adopted) { return (adopted || []).map((a) => (typeof a === 'string' ? { id: a } : a)); }
function clonePoint(p) {
  // meta 深拷贝:避免 nextState 与 prevState/round 共享嵌套引用而反向污染入参(修 RS-P2-014)。
  return { ...p, merged_from: p.merged_from ? [...p.merged_from] : undefined, meta: p.meta ? structuredClone(p.meta) : undefined };
}
function cloneMap(prevState) { return indexById((prevState.points || []).map(clonePoint)); }

// ---- 可复用的步进施加器(对 Map 原地操作;reduce 与 validateRound 共享,避免逻辑漂移)----
function applyDispositions(m, dispositions = []) {
  for (const d of dispositions) {
    const p = m.get(d.id);
    if (!p || p.state !== 'candidate') continue; // 非 candidate/未知 → 协议错误由 validateRound 兜底
    if (d.disposition === 'confirmed') p.state = 'agreed';
    else if (d.disposition === 'rejected') p.state = 'open';
  }
}
function applyIssues(m, issues = []) {
  for (const it of issues) {
    const p = m.get(it.id);
    if (!p) m.set(it.id, { id: it.id, state: 'open', severity: it.severity || 'major', title: it.title || '', detail: it.detail || '' });
    // 用字段存在性更新(修 RS-P2-016):schema 允许空串,Codex 给 title:""/detail:"" 须能清除旧文案,不能因 falsy 被跳过而残留过期理由。
    else { if (it.severity) p.severity = it.severity; if ('title' in it) p.title = it.title; if ('detail' in it) p.detail = it.detail; if (p.state === 'agreed') p.state = 'open'; }
  }
}
function freshCandidateMeta(p, extra = {}) {
  const meta = { ...(p.meta || {}) };
  delete meta.revision_summary; delete meta.pending; delete meta.response_type; delete meta.rebuttal; // 清除上一次采纳/反驳遗留的候选元数据(修 RS-P2-009 / RS-P2-META)
  return { ...meta, ...extra };
}
function applyAdopted(m, adopted = []) {
  for (const a of normAdopted(adopted)) {
    const p = m.get(a.id);
    if (p && p.state === 'open') {
      p.state = 'candidate';
      const extra = { response_type: 'revision' };
      if (a.revision_summary) extra.revision_summary = a.revision_summary;
      if (a.pending) extra.pending = a.pending;
      p.meta = freshCandidateMeta(p, structuredClone(extra)); // 深拷贝:revision_summary/pending 若为对象不与 round 入参共享别名(修 RS-P2-014-ADOPTED-REBUTTED-ALIAS)
    }
  }
}
// Claude 反驳一个 open issue(不采纳)→ 也进 candidate,等 Codex 裁定:
// confirmed = Codex 接受反驳(该点了结)→ agreed;rejected = Codex 重申 → 回 open(修 RS-P2-OPEN)。
function applyRebutted(m, rebutted = []) {
  for (const a of normAdopted(rebutted)) {
    const p = m.get(a.id);
    if (p && p.state === 'open') {
      p.state = 'candidate';
      const extra = { response_type: 'rebuttal' };
      if (a.rebuttal) extra.rebuttal = a.rebuttal;
      p.meta = freshCandidateMeta(p, structuredClone(extra)); // 深拷贝:rebuttal 若为对象不与 round 入参共享别名(修 RS-P2-014-ADOPTED-REBUTTED-ALIAS)
    }
  }
}
function applyMerges(m, merges = []) {
  for (const mg of merges) {
    const into = m.get(mg.into);
    if (!into) continue;
    into.merged_from = [...(into.merged_from || []), ...(mg.from || [])];
    for (const fid of mg.from || []) { const fp = m.get(fid); if (fp) { fp.state = 'merged'; fp.merged_into = mg.into; } }
  }
}
function applyAnnotations(m, annotations = []) {
  // 深拷贝 annotation 字段值,避免对象/数组值在 nextState 与 round 入参间共享别名(修 RS-P2-014)。
  for (const an of annotations) { const p = m.get(an.id); if (!p) continue; const { id, ...f } = an; p.meta = { ...(p.meta || {}), ...structuredClone(f) }; }
}

// 纯函数:上一轮 state + 本轮输入 → 新 state(不改入参)。
// round = { verdict, remaining_issues:[{id,title,detail,severity}], candidate_dispositions:[{id,disposition}],
//           adopted:[id|{id,revision_summary,pending}], merges:[{from:[id],into}], annotations:[{id,...metaFields}] }
export function reduce(prevState, round) {
  const m = cloneMap(prevState);
  const r = round || {};
  applyDispositions(m, r.candidate_dispositions);
  applyIssues(m, r.remaining_issues);
  applyAdopted(m, r.adopted);
  applyRebutted(m, r.rebutted);
  applyMerges(m, r.merges);
  applyAnnotations(m, r.annotations);
  return { round: (prevState.round || 0) + 1, points: [...m.values()] };
}

// 纯函数:校验本轮事件是否合协议。**按 reduce 的施加顺序在中间态上检查**(修 RS-P2-001)。
export function validateRound(prevState, round) {
  const errors = [];
  const r = round || {};

  // 事件数据契约(修 RS-P2-011):先校验形状,**形状非法即提前返回**,避免下游 .id/.from 迭代抛 TypeError(如 adopted:[null]、merges.from 为字符串被当可迭代)。
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const shape = [];
  for (const [v, name] of [[r.remaining_issues, 'remaining_issues'], [r.candidate_dispositions, 'candidate_dispositions'], [r.adopted, 'adopted'], [r.rebutted, 'rebutted'], [r.merges, 'merges'], [r.annotations, 'annotations']])
    if (v != null && !Array.isArray(v)) shape.push(`${name} 须为数组`);
  for (const [arr, name] of [[r.adopted, 'adopted'], [r.rebutted, 'rebutted']])
    if (Array.isArray(arr)) for (const a of arr) if (!(typeof a === 'string' ? a : (isObj(a) && typeof a.id === 'string' && a.id))) shape.push(`${name} 元素须为非空 id 字符串或 {id,...}`);
  if (Array.isArray(r.remaining_issues)) for (const it of r.remaining_issues) {
    if (!isObj(it) || typeof it.id !== 'string' || !it.id) { shape.push('remaining_issues 元素须为含非空 string id 的对象'); continue; }
    // 字段类型契约(修 RS-P2-011-PARTIAL-ISSUE-SHAPE):present 即须合法,否则 reduce 会写入非法 point。
    if ('title' in it && typeof it.title !== 'string') shape.push(`remaining_issues ${it.id}: title 须为 string`);
    if ('detail' in it && typeof it.detail !== 'string') shape.push(`remaining_issues ${it.id}: detail 须为 string`);
    if ('severity' in it && (typeof it.severity !== 'string' || !Object.hasOwn(SEV_RANK, it.severity))) shape.push(`remaining_issues ${it.id}: severity 须为 blocker|major|minor`); // 用 hasOwn 防原型属性(toString/__proto__)绕过(修 RS-P2-011-PARTIAL severity)
  }
  // adopted/rebutted/annotations 的元数据须为 string(本就是供 §7 渲染的文本):非 string 既无意义,又会让 structuredClone 抛 DataCloneError(修 RS-P2-014-UNCLONEABLE-META)。
  for (const [arr, name] of [[r.adopted, 'adopted'], [r.rebutted, 'rebutted']])
    if (Array.isArray(arr)) for (const a of arr) if (isObj(a)) for (const k of ['revision_summary', 'pending', 'rebuttal']) if (k in a && typeof a[k] !== 'string') shape.push(`${name} ${a.id}: ${k} 须为 string`);
  if (Array.isArray(r.annotations)) for (const an of r.annotations) if (isObj(an)) for (const [k, v] of Object.entries(an)) if (k !== 'id' && typeof v !== 'string') shape.push(`annotation ${an.id}: 字段 ${k} 须为 string`);
  if (Array.isArray(r.candidate_dispositions)) for (const d of r.candidate_dispositions) if (!isObj(d) || typeof d.id !== 'string' || !d.id) shape.push('candidate_dispositions 元素须为含非空 string id 的对象');
  if (Array.isArray(r.merges)) for (const mg of r.merges) if (!isObj(mg) || !Array.isArray(mg.from) || typeof mg.into !== 'string' || !mg.into || !mg.from.every((x) => typeof x === 'string' && x)) shape.push('merges 元素须为 {from:[非空id...], into:非空id}');
  if (Array.isArray(r.annotations)) for (const an of r.annotations) if (!isObj(an) || typeof an.id !== 'string' || !an.id) shape.push('annotations 元素须为含非空 string id 的对象');
  if (shape.length) return { ok: false, errors: shape };

  const prev = cloneMap(prevState);
  const prevCandidates = [...prev.values()].filter((p) => p.state === 'candidate').map((p) => p.id);
  const disp = r.candidate_dispositions || [];
  const issueIds = new Set((r.remaining_issues || []).map((it) => it.id));

  // 数组内 id 唯一:Map 入账会把同 id 不同 issue 合并(修 RS-P2-008)。adopted 去重在下方 (b) 与 open 检查合并处理(避免重复报错,修 RS-P2-DUPERR)。
  const riSeen = new Set();
  for (const it of r.remaining_issues || []) { if (riSeen.has(it.id)) errors.push(`remaining_issues 含重复 id: ${it.id}`); riSeen.add(it.id); }

  // (a) disposition 协议:覆盖 prevCandidate、只引用 prevCandidate、无重复、值合法、矛盾。
  const dispSet = new Set();
  for (const d of disp) {
    if (dispSet.has(d.id)) errors.push(`重复 disposition: ${d.id}`);
    dispSet.add(d.id);
    const p = prev.get(d.id);
    if (!p) errors.push(`disposition 引用未知 id: ${d.id}`);
    else if (p.state !== 'candidate') errors.push(`disposition 引用非 candidate(state=${p.state}) 的 id: ${d.id}`);
    if (!DISPOSITIONS.includes(d.disposition)) errors.push(`disposition ${d.id}: 非法值 '${d.disposition}'`);
    if (d.disposition === 'confirmed' && issueIds.has(d.id)) errors.push(`矛盾:${d.id} 被 confirmed 却仍出现在 remaining_issues`);
    if (d.disposition === 'rejected' && !issueIds.has(d.id)) errors.push(`${d.id} 被 rejected 但未在 remaining_issues 给出仍存在的理由`);
  }
  for (const cid of prevCandidates) if (!dispSet.has(cid)) errors.push(`candidate ${cid} 未被裁定(disposition 须覆盖本轮全部 candidate)`);

  // (b) 在 dispositions+issues 之后的中间态上检查 adopted(修 RS-P2-001:允许同轮 rejected→重采纳、采纳本轮新 issue)。
  const mid = cloneMap(prevState);
  applyDispositions(mid, disp);
  applyIssues(mid, r.remaining_issues);
  const adoptedIds = normAdopted(r.adopted).map((a) => a.id);
  const adSeen2 = new Set();
  for (const a of normAdopted(r.adopted)) {
    if (adSeen2.has(a.id)) errors.push(`adopted 含重复 id: ${a.id}`);
    adSeen2.add(a.id);
    const p = mid.get(a.id);
    if (!p) errors.push(`adopted 引用未知 id: ${a.id}`);
    else if (p.state !== 'open') errors.push(`adopted 只能作用于 open,但 ${a.id} 在本轮中间态 state=${p.state}`);
  }
  applyAdopted(mid, r.adopted);

  // (b2) rebutted(Claude 反驳)也作用于 open,且不得与 adopted 同 id(修 RS-P2-OPEN)。
  const adoptedSet = new Set(adoptedIds);
  const rbSeen = new Set();
  for (const a of normAdopted(r.rebutted)) {
    if (rbSeen.has(a.id)) errors.push(`rebutted 含重复 id: ${a.id}`);
    rbSeen.add(a.id);
    if (adoptedSet.has(a.id)) errors.push(`同一 id 不能同轮既 adopted 又 rebutted: ${a.id}`);
    const p = mid.get(a.id);
    if (!p) errors.push(`rebutted 引用未知 id: ${a.id}`);
    else if (p.state !== 'open') errors.push(`rebutted 只能作用于 open,但 ${a.id} 在本轮中间态 state=${p.state}`);
  }
  applyRebutted(mid, r.rebutted);

  // (c) 在 adopted/rebutted 之后的中间态上**逐个**检查 merges(修 RS-P2-002:同批 A→B+B→C、A→B+A→C 都能被抓)。
  for (const mg of r.merges || []) {
    const into = mid.get(mg.into);
    if (!into) errors.push(`merge into 未知 id: ${mg.into}`);
    else if (into.state === 'merged') errors.push(`merge 目标 ${mg.into} 已是 merged(终态/被本批先合并)`);
    for (const fid of mg.from || []) {
      const fp = mid.get(fid);
      if (!fp) errors.push(`merge from 未知 id: ${fid}`);
      else if (fp.state === 'merged') errors.push(`merge 来源 ${fid} 已是 merged(终态/被本批先合并),不可重复合并`);
      // RS-P2-015:来源自身已是合并目标(有 merged_from)→ 再被合并会形成 A→B→C 链;应直接合到最终目标,在 reduce 前拒。
      else if (fp.merged_from && fp.merged_from.length) errors.push(`merge 来源 ${fid} 自身已吸收了其它点(merged_from 非空),再被合并会形成链;请直接合并到最终目标`);
      // RS-P2-010:不得把未决点(open/candidate)合入已 agreed 的目标——否则该未决分歧随 merged 终态从
      // open/candidate 计数消失,canConverge 据此放行 → 假收敛。要合入 agreed,来源也须已 agreed。
      else if (into && into.state === 'agreed' && fp.state !== 'agreed')
        errors.push(`merge: 不能把未决点 ${fid}(state=${fp.state})合入已 agreed 的 ${mg.into}(会使未决分歧凭空消失→假收敛)`);
      if (fid === mg.into) errors.push(`merge from 与 into 相同: ${fid}`);
    }
    const fromSeen = new Set();
    for (const fid of mg.from || []) { if (fromSeen.has(fid)) errors.push(`merge from 含重复 id: ${fid}`); fromSeen.add(fid); } // 修 RS-P2-002(minor)
    applyMerges(mid, [mg]); // 逐个施加,使后续 merge 看到更新后的态
  }

  // remaining_issues 不得引用已 merged(终态)的点——否则会被静默更新却不渲染,issue 凭空消失(修 RS-P2-006)。
  for (const it of r.remaining_issues || []) {
    const p = prev.get(it.id);
    if (p && p.state === 'merged') errors.push(`remaining_issues 引用了已 merged(终态)点 ${it.id};应引用其活跃目标或换新 id`);
  }

  // annotations:id 必须存在(于施加完 merges 的中间态)且不重复——typo 会静默丢失 §7 元数据(修 RS-P2-007)。
  const annSeen = new Set();
  for (const an of r.annotations || []) {
    if (annSeen.has(an.id)) errors.push(`重复 annotation: ${an.id}`);
    annSeen.add(an.id);
    if (!mid.get(an.id)) errors.push(`annotation 引用未知 id: ${an.id}`);
  }

  return { ok: errors.length === 0, errors };
}

// 纯函数:state 结构不变量(id 唯一、合法 state、合并图双向 reciprocity 且目标为活跃点)。
export function validateState(state) {
  const errors = [];
  const rawPoints = state.points || [];
  // 先剔除非对象点元素(null 等),避免下方读 p.id 抛 TypeError(修 RS-P2-012-NONOBJECT-POINT-THROW)。
  const points = [];
  for (const p of rawPoints) { if (!p || typeof p !== 'object') errors.push('point 须为对象'); else points.push(p); }
  const ids = new Set();
  for (const p of points) {
    if (typeof p.id !== 'string' || !p.id) errors.push('point 缺少非空 string id'); // 修 RS-P2-012
    if (ids.has(p.id)) errors.push(`duplicate point id: ${p.id}`); ids.add(p.id);
  }
  const byId = indexById(points);

  for (const p of points) {
    if (!STATES.includes(p.state)) errors.push(`point ${p.id}: invalid state '${p.state}'`);
    // 活跃点(非 merged)不应携带 merged_into——否则是孤儿/陈旧字段,合并图语义被破坏(修 RS-P2-012)。
    if (p.state !== 'merged' && p.merged_into) errors.push(`活跃点 ${p.id}(state=${p.state})不应带 merged_into(${p.merged_into})`);
    if (p.state === 'merged') {
      if (!p.merged_into) errors.push(`merged point ${p.id} missing merged_into`);
      else if (p.merged_into === p.id) errors.push(`point ${p.id} merged_into itself`);
      else {
        const tgt = byId.get(p.merged_into);
        if (!tgt) errors.push(`point ${p.id} merged_into unknown id ${p.merged_into}`);
        else if (tgt.state === 'merged') errors.push(`point ${p.id} merged_into ${p.merged_into},但后者也是 merged(目标须为活跃点;杜绝链/环)`);
        else if (!(tgt.merged_from || []).includes(p.id)) errors.push(`合并 reciprocity 缺失:${p.merged_into}.merged_from 未包含 ${p.id}`);
      }
    }
    // 反向 reciprocity:merged_from 里每个 id 必须确实 merged 到本点(修 RS-P2-002:A→B+A→C 留下 B.merged_from 陈旧)。
    const mfSeen = new Set();
    for (const fid of p.merged_from || []) {
      if (mfSeen.has(fid)) errors.push(`${p.id}.merged_from 含重复 id ${fid}`); // 修 RS-P2-002(minor)
      mfSeen.add(fid);
      const fp = byId.get(fid);
      if (!fp) errors.push(`point ${p.id}.merged_from 含未知 id ${fid}`);
      else if (fp.state !== 'merged' || fp.merged_into !== p.id) errors.push(`反向 reciprocity 不符:${p.id}.merged_from 含 ${fid},但 ${fid} 并未 merged 到 ${p.id}`);
    }
  }
  // 注:parent_id(拆分谱系)无 reduce 写入路径、实际未被使用,已按 YAGNI 剔除其校验(见 DESIGN §12)。
  // 合并谱系由 merged_into/merged_from 表达并校验。
  return { ok: errors.length === 0, errors };
}

export const validate = validateState; // 向后兼容别名(结构校验)

export function canConverge(state, codexVerdict, claudeAgree) {
  // RS-P2-013-R3:导出函数本身也是收敛闸门,须与 CLI 同等 fail-closed —— 缺失/非数组 points 不得被当空账本放行。
  if (!state || !Array.isArray(state.points)) return { converged: false, reasons: ['state.points 缺失或非数组(fail-closed 拒收敛)'] };
  const pts = state.points || [];
  const open = pts.filter((p) => p.state === 'open').length;
  const cand = pts.filter((p) => p.state === 'candidate').length;
  const reasons = [];
  // RS-P2-013-R2:收敛闸门 fail-closed —— 结构非法(含未知 state、坏合并图)一律拒收敛,不依赖调用方先跑 validate-state;
  // 否则状态为 'bogus' 等未知值的点不计入 open/candidate,会被静默漏掉而假收敛。
  const vs = validateState(state);
  if (!vs.ok) reasons.push(`state 结构非法(fail-closed 拒收敛): ${vs.errors.join('; ')}`);
  if (codexVerdict !== 'AGREE') reasons.push('Codex 未 AGREE');
  if (claudeAgree !== true) reasons.push('Claude 仍持异议'); // RS-P2-013:仅严格布尔 true 算同意(杜绝 'false'/真值非 true 误判为同意→假收敛)
  if (cand > 0) reasons.push(`仍有 ${cand} 个 candidate 未被确认(收敛时须为空)`);
  if (open > 0) reasons.push(`仍有 ${open} 个 open 分歧`);
  return { converged: reasons.length === 0, reasons };
}

export function counts(state) {
  const c = { open: 0, candidate: 0, agreed: 0, merged: 0 };
  for (const p of state.points || []) c[p.state] = (c[p.state] || 0) + 1;
  return c;
}

export function renderProgress(round, codexVerdict, blockers, claudeStance) {
  return `第 ${round} 轮 · Codex=${codexVerdict} · 剩 ${blockers.k} issue(${blockers.b} blocker) · Claude=${claudeStance}`;
}

function defaultRecommendation(open) {
  if (!open.length) return '无未决分歧;待复核确认项(🔶)需用户/下一轮确认后即可定论。';
  const ordered = [...open].sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));
  return `按影响严重度优先处理:${ordered.map((p) => `[${p.id}](${p.severity})`).join(' → ')}。到顶≠问题已穷尽,可调高 --max-rounds 继续。`;
}

// 渲染四段 UNRESOLVED 块(供 review.md §7)。meta={reason,reviewed_scope,assumptions,truncated,recommendation}
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
  L.push(agreed.length ? agreed.map((p) => `- [${p.id}] ${p.title}`).join('\n') : '无——当前没有已达成一致(agreed)的要点'); // 只陈述当前快照,不声称"自始至终"(曾 agreed 后被重新质疑会退回 open,修 RS-P2-017)
  L.push('');
  L.push('### 🔶 待复核确认(Claude 已回应:修订或反驳,Codex 尚未确认 —— 不算定论)');
  L.push(candidate.length
    ? candidate.map((p) => {
        const mm = p.meta || {};
        const kind = mm.response_type === 'rebuttal' ? '反驳' : (mm.response_type === 'revision' ? '修订' : '待确认');
        const body = mm.rebuttal ? ` · 反驳:${mm.rebuttal}` : (mm.revision_summary ? ` · 修订:${mm.revision_summary}` : '');
        const pend = mm.pending ? ` · 待确认:${mm.pending}` : '';
        return `- [${p.id}] ${p.title}(${kind} · 来源严重度:${p.severity}${body}${pend})`;
      }).join('\n')
    : '无');
  L.push('');
  L.push('### ❌ 仍未达成一致');
  if (open.length) {
    for (const p of open) {
      const mm = p.meta || {};
      L.push(`- 卡点 [${p.id}]:${p.title}${p.detail ? ` —— ${p.detail}` : ''}`);
      L.push(`  · Claude 立场 / Codex 立场:${mm.claude_stance || '—'} / ${mm.codex_stance || '—'}`);
      L.push(`  · 状态(解决路径):${mm.status || '—'}  ·  影响严重度:${p.severity || '—'}`);
      L.push(`  · 影响后果:${mm.consequence || '—'}  ·  解决需要:${mm.resolution_needed || '—'}`);
    }
  } else { L.push('无'); }
  L.push('');
  L.push('### 📋 给用户的裁决建议');
  L.push(meta.recommendation || defaultRecommendation(open)); // 无 recommendation 时派生,不再打字面占位(修 RS-P2-003)
  return L.join('\n');
}

// 薄 CLI:reduce / validate-round / validate-state / converge / counts / render-unresolved
function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const cmd = process.argv[2];
  const raw = await readStdin();
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let inp;
  try { inp = raw.trim() ? JSON.parse(raw) : {}; }
  catch (e) { emit({ ok: false, error: 'bad_json', detail: String(e.message || e) }); process.exit(2); } // RS-P2-013:坏 stdin → 协议化错误,不抛 Node stack
  let out;
  try {
    // RS-P2-013-R1:reduce/validate-round 须显式 prevState.points——漏传会静默清空历史、产出空账本,再喂 converge 即假收敛。
    // 首轮由调用方显式传 emptyState()({round:0,points:[]}),使"漏传"始终是错误而非默认放行。
    if (cmd === 'reduce' || cmd === 'validate-round') {
      if (!inp.prevState || !Array.isArray(inp.prevState.points)) { emit({ ok: false, error: 'missing_prevstate', detail: cmd + ' 需显式 prevState.points;首轮传 {round:0,points:[]}(防漏传清空历史→假收敛)' }); process.exit(2); }
      out = cmd === 'reduce' ? reduce(inp.prevState, inp.round || {}) : validateRound(inp.prevState, inp.round || {});
    }
    else if (cmd === 'validate-state') out = validateState(inp.state || emptyState());
    else if (cmd === 'converge') {
      // RS-P2-013:converge 必须拿到显式 state.points——绝不对缺省空账本判收敛(否则缺 state 即假收敛)。
      if (!inp.state || !Array.isArray(inp.state.points)) { emit({ ok: false, error: 'missing_state', detail: 'converge 需显式 state.points;拒绝对缺省空账本判收敛(防假收敛)' }); process.exit(2); }
      if (typeof inp.claudeAgree !== 'boolean') { emit({ ok: false, error: 'bad_claudeAgree', detail: "claudeAgree 须为布尔 true/false(收到 " + JSON.stringify(inp.claudeAgree) + ")" }); process.exit(2); }
      out = canConverge(inp.state, inp.codexVerdict, inp.claudeAgree);
    }
    else if (cmd === 'counts') out = counts(inp.state || emptyState());
    else if (cmd === 'render-unresolved') out = { text: renderUnresolved(inp.state || emptyState(), inp.meta || {}) };
    else { process.stderr.write(`unknown cmd: ${cmd}\n`); process.exit(2); }
  } catch (e) { emit({ ok: false, error: 'exception', detail: String(e.message || e) }); process.exit(1); }
  emit(out);
}
