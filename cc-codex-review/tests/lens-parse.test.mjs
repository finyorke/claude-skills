import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLens, LENS_PRESETS } from '../scripts/lens-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/lens-parse.mjs');

// ---- 纯函数(对应 §10 验收 ⑯⑰⑱)----

test('⑯ 无 lens flag → effective_lens=null(通用评审)', () => {
  assert.deepEqual(parseLens(['评审', 'metrics.mjs']), { ok: true, effective_lens: null });
  assert.deepEqual(parseLens([]), { ok: true, effective_lens: null });
});

test('⑰ --lens omission ≡ --omission-check', () => {
  assert.deepEqual(parseLens(['--lens', 'omission']), { ok: true, effective_lens: 'omission' });
  assert.deepEqual(parseLens(['--omission-check']), { ok: true, effective_lens: 'omission' });
});

test('各预设镜头正确归一', () => {
  for (const l of LENS_PRESETS) assert.deepEqual(parseLens(['--lens', l]), { ok: true, effective_lens: l });
});

test('--lens omission + --omission-check(一致)→ 不报错,归一 omission', () => {
  assert.deepEqual(parseLens(['--lens', 'omission', '--omission-check']), { ok: true, effective_lens: 'omission' });
});

test('⑱ 未知 name → lens_unknown', () => {
  const r = parseLens(['--lens', 'foobar']);
  assert.equal(r.ok, false); assert.equal(r.error, 'lens_unknown');
});

test('⑱ --lens 与 --omission-check 不一致 → lens_conflict', () => {
  const r = parseLens(['--lens', 'security', '--omission-check']);
  assert.equal(r.ok, false); assert.equal(r.error, 'lens_conflict');
});

test('⑱ --lens 缺 name(末尾)→ lens_missing_name', () => {
  const r = parseLens(['--lens']);
  assert.equal(r.ok, false); assert.equal(r.error, 'lens_missing_name');
});

test('⑱ --lens 紧跟另一个 flag → 缺 name(不把 flag 误当 name)', () => {
  const r = parseLens(['--lens', '--dry-run']);
  assert.equal(r.ok, false); assert.equal(r.error, 'lens_missing_name');
});

test('⑱ 重复 --lens → lens_duplicate(单次单镜头;不一致与相同值都拒)', () => {
  assert.equal(parseLens(['--lens', 'security', '--lens', 'omission']).error, 'lens_duplicate');
  assert.equal(parseLens(['--lens', 'security', '--lens', 'security']).error, 'lens_duplicate');
});

test('从混合 args 中正确提取 lens(忽略 --repo/--max-rounds 等其它 flag)', () => {
  assert.deepEqual(parseLens(['--repo', '/x', '--lens', 'security', '--max-rounds', '3', '审代码']),
    { ok: true, effective_lens: 'security' });
});

test('防御:非数组输入 → bad_input(不抛异常)', () => {
  assert.equal(parseLens(null).error, 'bad_input');
  assert.equal(parseLens('--lens security').error, 'bad_input');
  assert.equal(parseLens(undefined).error, 'bad_input');
});

// ---- CLI(stdin JSON → stdout JSON)----

function cliOk(argv) {
  const out = execFileSync('node', [SCRIPT], { input: JSON.stringify({ argv }), encoding: 'utf8' });
  return JSON.parse(out.trim());
}
// CLI 在 ok:false 时 exit 2 → execFileSync 抛,但 JSON 仍在 e.stdout
function cliErr(argv, rawInput) {
  try {
    execFileSync('node', [SCRIPT], { input: rawInput ?? JSON.stringify({ argv }), encoding: 'utf8' });
    throw new Error('应以 exit 2 退出');
  } catch (e) { return JSON.parse((e.stdout || '').trim()); }
}

test('CLI: stdin {argv} → effective_lens', () => {
  assert.deepEqual(cliOk(['--lens', 'requirements']), { ok: true, effective_lens: 'requirements' });
  assert.deepEqual(cliOk([]), { ok: true, effective_lens: null });
});

test('CLI: 参数错误也输出 JSON 且 exit 2', () => {
  const r = cliErr(['--lens', 'xxx']);
  assert.equal(r.ok, false); assert.equal(r.error, 'lens_unknown');
});

test('CLI: stdin 非法 JSON → bad_json', () => {
  const r = cliErr(null, '{not json');
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_json');
});

// LP-CLI-INPUT: CLI 对自身 {argv:[...]} 契约 fail-closed(不用 || [] 吞成无镜头)
test('CLI: 缺失 argv 字段({}) → bad_input(fail-closed,不静默当无镜头)', () => {
  const r = cliErr(null, '{}');
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_input');
});

test('CLI: 完全空 stdin → bad_input(同上)', () => {
  const r = cliErr(null, '');
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_input');
});

test('CLI: argv 为 null → bad_input', () => {
  const r = cliErr(null, JSON.stringify({ argv: null }));
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_input');
});

test('CLI: 显式空数组 {argv:[]} → 合法无镜头(区分于"缺失")', () => {
  assert.deepEqual(cliOk([]), { ok: true, effective_lens: null });
});
