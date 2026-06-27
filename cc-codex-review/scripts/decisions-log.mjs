#!/usr/bin/env node
// decisions-log.mjs — 决策日志:把 do/review 定下的决策/约束(软知识)落盘,供 Codex 经 --repo 跨轮读取。
// 见 docs/specs/2026-06-27-decision-log-design.md。纯函数(无 IO)+ 薄 CLI(读写 .cc-codex-review/decisions.{jsonl,md})。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STATUSES = new Set(['decided', 'open']);
const SEV = new Set(['blocker', 'major', 'minor']);

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
//    | [{op:'set-status', id, status}]
// 纯函数:不改入参,返回新数组。
export function applyOps(entries, ops) {
  const out = entries.map((e) => ({ ...e }));
  for (const op of ops || []) {
    if (op.op === 'append') {
      out.push({ id: nextId(out), ...op.entry, ts: op.ts });
    } else if (op.op === 'set-status') {
      const e = out.find((x) => x.id === op.id);
      if (!e) throw new Error(`set-status: 未知 id ${op.id}`);
      e.status = op.status;
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
    if (!e.statement || typeof e.statement !== 'string') errors.push(`${e.id}: statement 缺失`);
    if (e.status === 'decided' && !e.rationale) errors.push(`${e.id}: decided 需 rationale`);
    if (e.status === 'open') {
      if (!e.positions || !e.positions.claude || !e.positions.codex) errors.push(`${e.id}: open 需 positions.claude/codex`);
      if (!SEV.has(e.severity)) errors.push(`${e.id}: open 需合法 severity`);
    }
    if (Array.isArray(e.supersedes)) for (const s of e.supersedes) if (!ids.has(s)) errors.push(`${e.id}: supersedes 悬空 ${s}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// 从 entries 渲染 decisions.md(Codex 实际读这个)。
export function renderMarkdown(entries) {
  const decided = entries.filter((e) => e.status === 'decided');
  const open = entries.filter((e) => e.status === 'open');
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
