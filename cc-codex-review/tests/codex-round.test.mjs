import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUND = resolve(HERE, '../scripts/codex-round.mjs');
const MOCK = resolve(HERE, 'fixtures/mock-codex.mjs');
const SCHEMA = resolve(HERE, '../schemas/verdict.schema.json');

// 跑一轮 codex-round,注入 mock 作为 CODEX_BIN,返回解析后的结果 JSON。
// 注:codex-round 设计为出错也以 exit 0 输出结果 JSON,故 execFileSync 不会抛。
function runRound(extraArgs, input, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const stdout = execFileSync(
    'node',
    [ROUND, '--schema', SCHEMA, '--out', out, ...extraArgs],
    { input, encoding: 'utf8', env: { ...process.env, CODEX_BIN: MOCK, ...env } }
  );
  const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

// 捕获传给 mock 的 argv(第一次调用)
function captureArgv(extraArgs, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const argvLog = join(dir, 'argv.log');
  execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out, ...extraArgs], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_ARGV_LOG: argvLog, ...env },
  });
  return JSON.parse(readFileSync(argvLog, 'utf8').trim().split('\n')[0]);
}

test('fresh round: returns ok with thread_id and AGREE verdict', () => {
  const res = runRound([], 'PACKET BODY', {
    MOCK_THREAD_ID: '019e1111-aaaa-7000-8000-000000000abc',
    MOCK_VERDICT: JSON.stringify({ verdict: 'AGREE', remaining_issues: [], rationale: 'ok' }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.thread_id, '019e1111-aaaa-7000-8000-000000000abc');
  assert.equal(res.verdict, 'AGREE');
  assert.deepEqual(res.remaining_issues, []);
});

test('fresh round: no --repo => -s read-only + --skip-git-repo-check, never --last', () => {
  const argv = captureArgv([]);
  assert.ok(argv.includes('exec'));
  const si = argv.indexOf('-s');
  assert.ok(si >= 0 && argv[si + 1] === 'read-only', 'fresh must set -s read-only');
  assert.ok(argv.includes('--skip-git-repo-check'), 'should skip git repo check');
  assert.ok(!argv.includes('--last'), 'must never use --last');
});

test('fresh round: --repo => --cd <dir> AND --skip-git-repo-check (#7 non-git ok)', () => {
  const argv = captureArgv(['--repo', '/some/repo']);
  const i = argv.indexOf('--cd');
  assert.ok(i >= 0 && argv[i + 1] === '/some/repo', 'should pass --cd <repo>');
  assert.ok(argv.includes('--skip-git-repo-check'), 'must also skip git check so non-git --repo works');
});

test('resume round: argv has `exec resume <id>`, NO -s, NO --cd, never --last (#6)', () => {
  const TID = '019e2222-bbbb-7000-8000-0000000def01';
  const argv = captureArgv(['--resume', TID, '--repo', '/some/repo']);
  assert.equal(argv[0], 'exec');
  const ri = argv.indexOf('resume');
  assert.ok(ri >= 0, 'should call exec resume');
  assert.equal(argv[ri + 1], TID, 'resume must be followed by the captured thread id');
  assert.ok(!argv.includes('-s'), 'resume must NOT pass -s (exec resume rejects it)');
  assert.ok(!argv.includes('--cd'), 'resume must NOT pass --cd (inherited from session)');
  assert.ok(!argv.includes('--last'), 'must never use --last');
});

test('resume round: actually succeeds against realistic mock (#6 regression)', () => {
  // realistic mock rejects -s/--cd under resume with exit 2; this only passes if the
  // script omits them on resume.
  const res = runRound(['--resume', '019e2222-bbbb-7000-8000-0000000def01'], 'DELTA', {
    MOCK_VERDICT: JSON.stringify({ verdict: 'CHANGES', remaining_issues: [], rationale: 'more' }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'CHANGES');
});

test('codex unavailable (auth fail): ok=false, error=codex_unavailable', () => {
  const res = runRound([], 'PACKET', { MOCK_FAIL: 'auth' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'codex_unavailable');
});

test('codex binary missing (ENOENT): ok=false, error=codex_unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const stdout = execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: '/nonexistent/codex-binary-xyz' },
  });
  const res = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'codex_unavailable');
});

test('bad verdict then good: retries once and succeeds', () => {
  const counter = join(mkdtempSync(join(tmpdir(), 'cc-round-')), 'counter');
  const res = runRound([], 'PACKET', {
    MOCK_BAD_OUTPUT: '1',
    MOCK_COUNTER: counter,
    MOCK_VERDICT: JSON.stringify({ verdict: 'CHANGES', remaining_issues: [{ title: 't', detail: 'd', severity: 'major' }], rationale: 'r' }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'CHANGES');
  assert.equal(res.remaining_issues.length, 1);
});

test('stale verdict file must NOT be read as success when codex fails to write (#1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  // 预置上一轮残留的 AGREE verdict
  writeFileSync(out, JSON.stringify({ verdict: 'AGREE', remaining_issues: [], rationale: 'STALE' }));
  // 本轮 codex 跑了但失败、未写 -o
  const stdout = execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_NO_WRITE: '1' },
  });
  const res = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
  assert.equal(res.ok, false, 'must not report success from stale file');
  assert.equal(res.error, 'bad_verdict');
});

test('bad_verdict surfaces stdout/stderr tails + exit code for diagnosis (#2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const stdout = execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_NO_WRITE: '1' },
  });
  const res = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
  assert.equal(res.error, 'bad_verdict');
  assert.equal(res.codex_exit, 1);
  assert.match(res.stdout_tail, /turn\.failed|invalid_request_error|error/, 'should include the codex error event');
});

test('truncated / reviewed_scope / assumptions pass through to result (#3)', () => {
  const res = runRound([], 'PACKET', {
    MOCK_VERDICT: JSON.stringify({
      verdict: 'AGREE', remaining_issues: [], rationale: 'ok',
      truncated: true, reviewed_scope: 'only first 200 lines', assumptions: ['tests pass'],
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  assert.equal(res.reviewed_scope, 'only first 200 lines');
  assert.deepEqual(res.assumptions, ['tests pass']);
});

test('P0: issue id + candidate_dispositions pass through (no field-drop)', () => {
  const res = runRound([], 'DELTA', {
    MOCK_VERDICT: JSON.stringify({
      verdict: 'CHANGES',
      remaining_issues: [{ id: 'I1', title: 't', detail: 'd', severity: 'major' }],
      candidate_dispositions: [
        { id: 'C1', disposition: 'confirmed' },
        { id: 'C2', disposition: 'rejected' },
      ],
      rationale: 'r',
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.remaining_issues[0].id, 'I1', 'issue id must survive');
  assert.deepEqual(res.candidate_dispositions, [
    { id: 'C1', disposition: 'confirmed' },
    { id: 'C2', disposition: 'rejected' },
  ], 'candidate_dispositions must pass through, not be dropped');
});

test('P0: candidate_dispositions defaults to [] when codex omits it', () => {
  const res = runRound([], 'PACKET', {
    MOCK_VERDICT: JSON.stringify({ verdict: 'AGREE', remaining_issues: [], rationale: 'ok' }),
  });
  assert.deepEqual(res.candidate_dispositions, []);
});
