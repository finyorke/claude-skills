import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'scripts', 'enforce-resolved-hook.mjs');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const KIND = 'cc-codex-review-audit-manifest';

function runHook(stdinObj) {
  try { return { code: 0, stdout: execFileSync('node', [HOOK], { input: JSON.stringify(stdinObj), encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status, stdout: String(e.stdout || '') }; }
}
function writeTranscript(dir, assistantTexts) {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, assistantTexts.map((t) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })).join('\n') + '\n');
  return p;
}
const co = (verdict, remaining_issues = [], candidate_dispositions = []) => JSON.stringify({
  verdict,
  remaining_issues: remaining_issues.map((it) => ({ id: it.id, title: it.title ?? 't', detail: it.detail ?? 'd', severity: it.severity ?? 'major' })),
  candidate_dispositions, rationale: '', truncated: false, reviewed_scope: '', assumptions: [],
});
// 哨兵独占结论最后一行(真 §7 结论的形态)
const concl = (manifestPath) => `✅ 收敛结论(状态:RESOLVED)\n商定结论……\n<<CCR-RESOLVED manifest="${manifestPath}">>`;

function writeManifest(dir, rounds, claudeAgree = true) {
  const mf = join(dir, 'manifest.json');
  writeFileSync(mf, JSON.stringify({ kind: KIND, claudeAgree, rounds }));
  return mf;
}
function convergedRounds(dir) {
  const f1 = join(dir, 'r1.json'); const c1 = co('CHANGES', [{ id: 'I1' }]); writeFileSync(f1, c1);
  const f2 = join(dir, 'r2.json'); const c2 = co('AGREE', [], [{ id: 'I1', disposition: 'confirmed' }]); writeFileSync(f2, c2);
  return [
    { round_index: 1, codex_out: f1, codex_out_sha256: sha(c1), claude_actions: { adopted: [{ id: 'I1', revision_summary: 'fix' }] } },
    { round_index: 2, codex_out: f2, codex_out_sha256: sha(c2), claude_actions: {} },
  ];
}

test('无哨兵 → 放行 exit 0(全局快路径)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  try { assert.equal(runHook({ transcript_path: writeTranscript(dir, ['普通回合,无结论标记', '又一条无关消息']) }).code, 0); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('哨兵(独占末行)+ 通过 manifest → 放行 exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  try {
    const mf = writeManifest(dir, convergedRounds(dir));
    const r = runHook({ transcript_path: writeTranscript(dir, [concl(mf)]) });
    assert.equal(r.code, 0, r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('哨兵 + 不通过 manifest(raw rejected)→ block exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  try {
    const f1 = join(dir, 'r1.json'); const c1 = co('CHANGES', [{ id: 'I1' }]); writeFileSync(f1, c1);
    const f2 = join(dir, 'r2.json'); const c2 = co('CHANGES', [{ id: 'I1' }], [{ id: 'I1', disposition: 'rejected' }]); writeFileSync(f2, c2);
    const mf = writeManifest(dir, [
      { round_index: 1, codex_out: f1, codex_out_sha256: sha(c1), claude_actions: { adopted: [{ id: 'I1', revision_summary: 'x' }] } },
      { round_index: 2, codex_out: f2, codex_out_sha256: sha(c2), claude_actions: {} },
    ]);
    const r = runHook({ transcript_path: writeTranscript(dir, [concl(mf)]) });
    assert.equal(r.code, 2);
    const o = JSON.parse(r.stdout.trim());
    assert.equal(o.decision, 'block');
    assert.match(o.reason, /独立重审未通过/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('哨兵 + manifest 缺失 → block exit 2(说了 RESOLVED 却无审计证据)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  try {
    const r = runHook({ transcript_path: writeTranscript(dir, [concl(join(dir, 'nope.json'))]) });
    assert.equal(r.code, 2);
    assert.match(JSON.parse(r.stdout.trim()).reason, /读不到|解析不了|manifest/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('哨兵 + manifest sha 不符 → block exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  try {
    const f1 = join(dir, 'r1.json'); writeFileSync(f1, co('AGREE', [], []));
    const mf = writeManifest(dir, [{ round_index: 1, codex_out: f1, codex_out_sha256: 'a'.repeat(64), claude_actions: {} }]);
    const r = runHook({ transcript_path: writeTranscript(dir, [concl(mf)]) });
    assert.equal(r.code, 2);
    assert.match(JSON.parse(r.stdout.trim()).reason, /证据无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('哨兵 + manifest 无 kind 标记 → block exit 2(指向非本工具 manifest)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  try {
    const mf = join(dir, 'm.json'); writeFileSync(mf, JSON.stringify({ claudeAgree: true, rounds: convergedRounds(dir) })); // 无 kind
    const r = runHook({ transcript_path: writeTranscript(dir, [concl(mf)]) });
    assert.equal(r.code, 2);
    assert.match(JSON.parse(r.stdout.trim()).reason, /kind/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 修 I1:降误拦——散文引用 / 代码块示例 / 非末行哨兵 都不触发 ----
test('修I1: 哨兵在代码块(```)里(开发讨论示例)→ 放行,不误拦', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  try {
    const text = '我们讨论一下 hook:\n```\n<<CCR-RESOLVED manifest="/tmp/example.json">>\n```\n这只是示例。';
    assert.equal(runHook({ transcript_path: writeTranscript(dir, [text]) }).code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('修I1: 哨兵在散文中间(非末行整行)→ 放行,不误拦', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  try {
    const text = '哨兵格式是 <<CCR-RESOLVED manifest="/tmp/x.json">> ,我接着说别的。\n最后这行是普通收尾。';
    assert.equal(runHook({ transcript_path: writeTranscript(dir, [text]) }).code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧哨兵在更早消息、最后一条 assistant 无哨兵 → 放行(不误拦后续无关回合)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  try {
    const tp = writeTranscript(dir, [concl(join(dir, 'gone.json')), '后续完全无关的一次对话回合,普通收尾']);
    assert.equal(runHook({ transcript_path: tp }).code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('infra fail-open:transcript 路径不存在 → 放行 exit 0', () => {
  assert.equal(runHook({ transcript_path: '/no/such/transcript.jsonl' }).code, 0);
});

test('infra fail-open:stdin 非 JSON → 放行 exit 0', () => {
  try { execFileSync('node', [HOOK], { input: '{bad', encoding: 'utf8' }); }
  catch (e) { assert.fail('不应非零退出:' + e.status); }
});
