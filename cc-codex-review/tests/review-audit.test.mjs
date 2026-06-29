import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { auditRounds, loadRounds } from '../scripts/review-audit.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'review-audit.mjs');
const sha = (s) => createHash('sha256').update(s).digest('hex');

// round 工厂:Codex 字段 + Claude 动作。补全 issue 项的精确键集(id/title/detail/severity),使 co() 产出合法 verdict 结构。
const co = (verdict, remaining_issues = [], candidate_dispositions = []) => ({
  verdict,
  remaining_issues: remaining_issues.map((it) => ({ id: it.id, title: it.title ?? 't', detail: it.detail ?? 'd', severity: it.severity ?? 'major' })),
  candidate_dispositions,
  rationale: '', truncated: false, reviewed_scope: '', assumptions: [],
});

// ---- 正常收敛:r1 CHANGES(I1)+Claude 采纳 → r2 AGREE 确认 I1 ----
test('auditRounds: 正常两轮收敛 → audited_converged=true', () => {
  const rounds = [
    { codexOutput: co('CHANGES', [{ id: 'I1', severity: 'major', title: 't' }]), claudeActions: { adopted: [{ id: 'I1', revision_summary: 'fix' }] } },
    { codexOutput: co('AGREE', [], [{ id: 'I1', disposition: 'confirmed' }]), claudeActions: {} },
  ];
  const r = auditRounds(rounds, true);
  assert.equal(r.ok, true);
  assert.equal(r.audited_converged, true, JSON.stringify(r.reasons));
});

// ---- 核心:文件显示未收敛 → 审计据 raw 揪出(即便驱动方声称收敛)----
test('auditRounds 揪出假收敛:raw 末轮 rejected → I1 回 open,不收敛', () => {
  const rounds = [
    { codexOutput: co('CHANGES', [{ id: 'I1', severity: 'major', title: 't' }]), claudeActions: { adopted: [{ id: 'I1', revision_summary: 'fix' }] } },
    { codexOutput: co('CHANGES', [{ id: 'I1', severity: 'major', title: 't' }], [{ id: 'I1', disposition: 'rejected' }]), claudeActions: {} },
  ];
  const r = auditRounds(rounds, true); // 驱动方声称同意,但 raw 是 rejected
  assert.equal(r.audited_converged, false);
});

test('auditRounds 揪出隐藏分歧:raw 末轮 AGREE 但夹带未处理新 issue I2 → 仍 open', () => {
  const rounds = [
    { codexOutput: co('CHANGES', [{ id: 'I1', severity: 'major', title: 't' }]), claudeActions: { adopted: [{ id: 'I1', revision_summary: 'fix' }] } },
    { codexOutput: co('AGREE', [{ id: 'I2', severity: 'major', title: 'new' }], [{ id: 'I1', disposition: 'confirmed' }]), claudeActions: {} },
  ];
  const r = auditRounds(rounds, true);
  assert.equal(r.audited_converged, false); // I2 新 open
});

test('auditRounds: CONFIRM-ECHO(末轮 AGREE 确认 I1 又回显 I1)仍判收敛', () => {
  const rounds = [
    { codexOutput: co('CHANGES', [{ id: 'I1', severity: 'major', title: 't' }]), claudeActions: { adopted: [{ id: 'I1', revision_summary: 'fix' }] } },
    { codexOutput: co('AGREE', [{ id: 'I1', severity: 'major', title: 't' }], [{ id: 'I1', disposition: 'confirmed' }]), claudeActions: {} },
  ];
  assert.equal(auditRounds(rounds, true).audited_converged, true);
});

test('auditRounds: claudeAgree 非 true → 不收敛(严格布尔)', () => {
  const rounds = [{ codexOutput: co('AGREE', [], []), claudeActions: {} }];
  assert.equal(auditRounds(rounds, false).audited_converged, false);
  assert.equal(auditRounds(rounds, 'true').audited_converged, false);
});

test('auditRounds: 空 rounds → fail-closed 不收敛', () => {
  const r = auditRounds([], true);
  assert.equal(r.ok, false);
  assert.equal(r.audited_converged, false);
});

test('auditRounds: 坏 codexOutput → fail-closed', () => {
  assert.equal(auditRounds([{ codexOutput: null, claudeActions: {} }], true).audited_converged, false);
});

test('auditRounds 修I1: schema 非法 raw(缺数组)→ fail-closed,不当空数组审过', () => {
  const r = auditRounds([{ codexOutput: { verdict: 'AGREE' }, claudeActions: {} }], true); // 缺 remaining_issues 等
  assert.equal(r.ok, false);
  assert.equal(r.audited_converged, false);
  assert.match((r.failures || []).join(' '), /verdict 结构/);
});

// ---- loadRounds:sha256 / 文件 IO ----
test('loadRounds: sha256 匹配 → 正常加载;不匹配 → 抛(防篡改/串文件)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const f = join(dir, 'r1.json');
    const content = JSON.stringify(co('AGREE', [], []));
    writeFileSync(f, content);
    const ok = loadRounds({ rounds: [{ round_index: 1, codex_out: f, codex_out_sha256: sha(content) }] });
    assert.equal(ok[0].codexOutput.verdict, 'AGREE');
    assert.throws(() => loadRounds({ rounds: [{ round_index: 1, codex_out: f, codex_out_sha256: 'a'.repeat(64) }] }), /sha256 不符/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadRounds: 缺文件 / 缺路径 → 抛(fail-closed)', () => {
  assert.throws(() => loadRounds({ rounds: [{ round_index: 1, codex_out: '/no/such/file.json', codex_out_sha256: 'a'.repeat(64) }] }), /读不到/);
  assert.throws(() => loadRounds({ rounds: [{ round_index: 1 }] }), /缺 codex_out/);
});

test('loadRounds 修I2: sha256 缺失/坏格式 → 抛(必填,不可选)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const f = join(dir, 'r1.json'); writeFileSync(f, JSON.stringify(co('AGREE', [], [])));
    assert.throws(() => loadRounds({ rounds: [{ round_index: 1, codex_out: f }] }), /codex_out_sha256/);
    assert.throws(() => loadRounds({ rounds: [{ round_index: 1, codex_out: f, codex_out_sha256: 'xyz' }] }), /codex_out_sha256/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadRounds 修I1(整体复核): codex_out 非普通文件(目录)→ 抛(拒读 FIFO/特殊文件防阻塞)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    assert.throws(() => loadRounds({ rounds: [{ round_index: 1, codex_out: dir, codex_out_sha256: 'a'.repeat(64) }] }), /不是普通文件/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadRounds 修I3: round_index 不连续/缺失 → 抛(防 manifest 内部抽轮/乱序)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const f = join(dir, 'r.json'); const c = JSON.stringify(co('AGREE', [], [])); writeFileSync(f, c); const h = sha(c);
    assert.throws(() => loadRounds({ rounds: [{ codex_out: f, codex_out_sha256: h }] }), /round_index 须为 1/);
    assert.throws(() => loadRounds({ rounds: [
      { round_index: 1, codex_out: f, codex_out_sha256: h },
      { round_index: 3, codex_out: f, codex_out_sha256: h }, // 跳号
    ] }), /round_index 须为 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- CLI ----
test('CLI: manifest 重放收敛 → audited_converged true、退出 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const f1 = join(dir, 'r1.json'); const c1 = JSON.stringify(co('CHANGES', [{ id: 'I1', severity: 'major', title: 't' }]));
    const f2 = join(dir, 'r2.json'); const c2 = JSON.stringify(co('AGREE', [], [{ id: 'I1', disposition: 'confirmed' }]));
    writeFileSync(f1, c1); writeFileSync(f2, c2);
    const manifest = { claudeAgree: true, rounds: [
      { round_index: 1, codex_out: f1, codex_out_sha256: sha(c1), claude_actions: { adopted: [{ id: 'I1', revision_summary: 'fix' }] } },
      { round_index: 2, codex_out: f2, codex_out_sha256: sha(c2), claude_actions: {} },
    ] };
    const out = JSON.parse(execFileSync('node', [SCRIPT], { input: JSON.stringify(manifest), encoding: 'utf8' }).trim());
    assert.equal(out.audited_converged, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: 假收敛(raw rejected)→ audited_converged false、退出 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const f1 = join(dir, 'r1.json'); const c1 = JSON.stringify(co('CHANGES', [{ id: 'I1', severity: 'major', title: 't' }]));
    const f2 = join(dir, 'r2.json'); const c2 = JSON.stringify(co('CHANGES', [{ id: 'I1', severity: 'major', title: 't' }], [{ id: 'I1', disposition: 'rejected' }]));
    writeFileSync(f1, c1); writeFileSync(f2, c2);
    const manifest = { claudeAgree: true, rounds: [
      { round_index: 1, codex_out: f1, codex_out_sha256: sha(c1), claude_actions: { adopted: [{ id: 'I1', revision_summary: 'fix' }] } },
      { round_index: 2, codex_out: f2, codex_out_sha256: sha(c2), claude_actions: {} },
    ] };
    assert.throws(() => execFileSync('node', [SCRIPT], { input: JSON.stringify(manifest), encoding: 'utf8' }), (e) => {
      const out = JSON.parse(String(e.stdout).trim());
      assert.equal(out.audited_converged, false); return true; // 退出 1
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: claudeAgree 非布尔 → bad_claudeAgree 退出 2', () => {
  assert.throws(() => execFileSync('node', [SCRIPT], { input: JSON.stringify({ rounds: [] }), encoding: 'utf8' }), (e) => {
    assert.match(String(e.stdout), /bad_claudeAgree/); return true;
  });
});
