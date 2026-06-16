import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySessions } from '../scripts/verify-codex-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/verify-codex-session.mjs');
const UUID = '019ecfa7-a9d6-7261-8a73-14f52339f0af';

function fixtureHome(withSession) {
  const home = mkdtempSync(join(tmpdir(), 'codexhome-'));
  if (withSession) {
    const d = join(home, 'sessions', '2026', '06', '19');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `rollout-2026-06-19T16-58-52-${UUID}.jsonl`), '{}\n');
  }
  return home;
}

test('真实存在的 thread_id → verified', () => {
  const r = verifySessions([UUID], { codexHome: fixtureHome(true) });
  assert.deepEqual(r.verified, [UUID]);
  assert.deepEqual(r.missing, []);
});

test('不存在的 thread_id → missing', () => {
  const r = verifySessions(['019e0000-0000-7000-8000-000000000abc'], { codexHome: fixtureHome(true) });
  assert.equal(r.verified.length, 0);
  assert.equal(r.missing.length, 1);
});

test('非 UUID(含路径遍历尝试)→ missing,不参与匹配', () => {
  const r = verifySessions(['../../etc/passwd', 'not-a-uuid'], { codexHome: fixtureHome(true) });
  assert.deepEqual(r.verified, []);
  assert.equal(r.missing.length, 2);
});

test('EN1: 仅完整尾 -<id>.jsonl 算 verified,含 id 子串的别的文件名不算', () => {
  const home = mkdtempSync(join(tmpdir(), 'codexhome-'));
  const d = join(home, 'sessions', '2026', '06', '19');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `rollout-x-${UUID}-extra.jsonl`), '{}\n'); // 含 UUID 子串,但结尾不是 -<UUID>.jsonl
  const r = verifySessions([UUID], { codexHome: home });
  assert.deepEqual(r.missing, [UUID], '子串/部分匹配不得算 verified');
});

test('sessions 目录不存在 → 全 missing,不抛', () => {
  const r = verifySessions([UUID], { codexHome: mkdtempSync(join(tmpdir(), 'empty-')) });
  assert.deepEqual(r.missing, [UUID]);
});

test('非数组输入 → bad_input', () => {
  assert.equal(verifySessions(null).ok, false);
});

test('CLI: stdin {threadIds,codexHome} → JSON', () => {
  const home = fixtureHome(true);
  const out = execFileSync('node', [SCRIPT], { input: JSON.stringify({ threadIds: [UUID], codexHome: home }), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim()).verified, [UUID]);
});
