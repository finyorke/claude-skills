#!/usr/bin/env node
// decisions-log.mjs — 决策日志:把 do/review 定下的决策/约束(软知识)落盘,供 Codex 经 --repo 跨轮读取。
// 见 docs/specs/2026-06-27-decision-log-design.md。纯函数(无 IO)+ 薄 CLI(读写 .cc-codex-review/decisions.{jsonl,md})。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// decided=双方已确认的活跃约束(即便已实现仍须遵守、保持可见);open=未决分歧;
// closed=**已退役**的决策——不再适用(功能被删 / 被并入更大规则),从活跃基线隐藏、仅留 jsonl 历史。
// 注意:closed 仅用于"不再是活跃约束";**已实现但仍生效的约束保持 decided**(隐藏会致后续回归)。
const STATUSES = new Set(['decided', 'open', 'closed']);
const SEV = new Set(['blocker', 'major', 'minor']);
const SOURCES = new Set(['do', 'review']);

// 取下一个空闲 id（D<max+1>）。
export function nextId(entries) {
  let max = 0;
  for (const e of entries) {
    const m = /^D(\d+)$/.exec((e && e.id) || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `D${max + 1}`;
}

// ops: [{op:'append', ts, entry:{status,statement,rationale?,positions?,severity?,source,supersedes?}}]
//    | [{op:'set-status', id, status, rationale?, positions?, severity?}]  // 原地演进(如 open 谈拢→decided,带 rationale)
// 纯函数:不改入参,返回新数组。
export function applyOps(entries, ops) {
  const out = entries.map((e) => ({ ...e }));
  for (const op of ops || []) {
    if (op.op === 'append') {
      // id/ts 放在展开之后:始终用脚本自动分配的 id,忽略 caller 传入的 entry.id(守"自动分配防撞号"不变量)。
      out.push({ ...op.entry, id: nextId(out), ts: op.ts });
    } else if (op.op === 'set-status') {
      const e = out.find((x) => x.id === op.id);
      if (!e) throw new Error(`set-status: 未知 id ${op.id}`);
      // closed 须带**本次新退役理由**:否则会沿用原 decided 的 rationale 静默通过,把旧决策理由冒充成退役理由(修 I1,v0.12.6 自审 dogfood 发现)。
      if (op.status === 'closed' && !(typeof op.rationale === 'string' && op.rationale.trim())) throw new Error(`set-status closed: 须带非空退役理由 rationale(不沿用原决策理由)`);
      e.status = op.status;
      // 原地演进:可随状态翻转一并补字段(I1——open 谈拢→decided 须带 rationale,否则 validate 拦;closed 须带退役理由)。
      for (const k of ['rationale', 'positions', 'severity']) if (op[k] !== undefined) e[k] = op[k];
      // 翻成 decided/closed 后,open 专属字段(positions/severity)不再适用,清掉保持 entry 干净。
      if (op.status === 'decided' || op.status === 'closed') { delete e.positions; delete e.severity; }
    } else {
      throw new Error(`未知 op ${op.op}`);
    }
  }
  return out;
}

// 校验整组 entries 的结构不变量;返回 {ok:true} 或 {ok:false, errors:[...]}。
export function validate(entries) {
  const errors = [];
  const ids = new Set(entries.map((e) => e && e.id));
  const seen = new Set();
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || !/^D\d+$/.test(e.id)) { errors.push(`坏 id: ${JSON.stringify(e && e.id)}`); continue; }
    if (seen.has(e.id)) errors.push(`重复 id: ${e.id}`);
    seen.add(e.id);
    if (!STATUSES.has(e.status)) errors.push(`${e.id}: 坏 status ${e.status}`);
    if (!SOURCES.has(e.source)) errors.push(`${e.id}: 坏 source ${JSON.stringify(e.source)}`);
    if (!e.ts || typeof e.ts !== 'string') errors.push(`${e.id}: ts 缺失`);
    if (!e.statement || typeof e.statement !== 'string') errors.push(`${e.id}: statement 缺失`);
    if ((e.status === 'decided' || e.status === 'closed') && !e.rationale) errors.push(`${e.id}: ${e.status} 需 rationale`);
    if (e.status === 'open') {
      if (!e.positions || !e.positions.claude || !e.positions.codex) errors.push(`${e.id}: open 需 positions.claude/codex`);
      if (!SEV.has(e.severity)) errors.push(`${e.id}: open 需合法 severity`);
    }
    if (Array.isArray(e.supersedes)) for (const s of e.supersedes) if (!ids.has(s)) errors.push(`${e.id}: supersedes 悬空 ${s}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// 从 entries 渲染 decisions.md(Codex 实际读这个)。
// 从活跃两段隐藏:① 被其它 entry supersede 的(I2:被替换);② status=closed 的(已退役、不再适用)。
// 二者都只从渲染隐藏、历史仍在 jsonl;末尾给一行退役计数,保持活跃基线聚焦(膨胀治理,v0.12.6)。
export function renderMarkdown(entries) {
  const superseded = new Set(entries.flatMap((e) => (Array.isArray(e.supersedes) ? e.supersedes : [])));
  const isHidden = (e) => superseded.has(e.id) || e.status === 'closed';
  const active = entries.filter((e) => !isHidden(e));
  const hiddenCount = entries.filter(isHidden).length;
  const decided = active.filter((e) => e.status === 'decided');
  const open = active.filter((e) => e.status === 'open');
  const L = [];
  L.push('# 决策日志(cc-codex-review · 自动维护)');
  L.push('> 每轮 do/review 收敛后追加。DECIDED=双方已确认的基线;OPEN=仍未谈拢。供 Codex 跨轮读取。');
  L.push('');
  L.push('## ✅ 已定决策/约束');
  if (decided.length === 0) L.push('（暂无）');
  for (const e of decided) {
    const sup = Array.isArray(e.supersedes) && e.supersedes.length ? ` · 取代 ${e.supersedes.join(',')}` : '';
    L.push(`- [${e.id}] ${e.statement} — 理由:${e.rationale}  (${e.source} · ${e.ts})${sup}`);
  }
  L.push('');
  L.push('## ❌ 未决(开放分歧)');
  if (open.length === 0) L.push('（暂无）');
  for (const e of open) {
    L.push(`- [${e.id}] ${e.statement} · 严重度:${e.severity} · Claude:${e.positions.claude} / Codex:${e.positions.codex}  (${e.source} · ${e.ts})`);
  }
  L.push('');
  if (hiddenCount) L.push(`> 另有 ${hiddenCount} 条已退役(closed)/被取代(superseded),从活跃基线隐藏,历史见 decisions.jsonl。`);
  L.push('');
  return L.join('\n');
}

// ---- CLI(IO 层)----
function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
function paths(repo) { const dir = join(repo || '.', '.cc-codex-review'); return { dir, jsonl: join(dir, 'decisions.jsonl'), md: join(dir, 'decisions.md') }; }
function loadEntries(jsonl) {
  if (!existsSync(jsonl)) return [];
  const out = [];
  for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
    const t = line.trim(); if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { throw new Error('corrupt_jsonl'); }
    out.push(o);
  }
  return out;
}
function emit(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function fail(error, detail) { emit({ ok: false, error, detail }); process.exit(2); }

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const cmd = process.argv[2];
  const raw = await readStdin();
  let inp; try { inp = raw.trim() ? JSON.parse(raw) : {}; } catch { fail('bad_json', 'stdin 非合法 JSON'); }
  const p = paths(inp.repo);
  let entries;
  try { entries = loadEntries(p.jsonl); } catch (e) { fail('corrupt_jsonl', String(e.message)); }
  if (cmd === 'read') {
    emit({ ok: true, entries });
  } else if (cmd === 'render') {
    const v = validate(entries); // I3:render 也先校验,坏 jsonl 不渲成垃圾 md
    if (!v.ok) { emit({ ok: false, error: 'invalid', errors: v.errors }); process.exit(2); }
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.md, renderMarkdown(entries));
    emit({ ok: true, path: p.md });
  } else if (cmd === 'validate') {
    const v = validate(entries);
    emit(v); if (!v.ok) process.exit(2);
  } else if (cmd === 'upsert') {
    const ops = (inp.ops || []).map((o) => (o.op === 'append' ? { ...o, ts: o.ts || new Date().toISOString() } : o));
    let next;
    try { next = applyOps(entries, ops); } catch (e) { fail('bad_op', String(e.message)); }
    const v = validate(next);
    if (!v.ok) { emit({ ok: false, error: 'invalid', errors: v.errors }); process.exit(2); }
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.jsonl, next.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(p.md, renderMarkdown(next));
    emit({ ok: true, entries: next });
  } else {
    fail('bad_cmd', `未知子命令 ${cmd}`);
  }
}
