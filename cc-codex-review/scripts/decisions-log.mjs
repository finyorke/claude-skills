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
