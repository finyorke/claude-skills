import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUND = resolve(HERE, '../scripts/codex-round.mjs');
const MOCK = resolve(HERE, 'fixtures/mock-codex.mjs');
const SCHEMA = resolve(HERE, '../schemas/verdict.schema.json');

// 跑一轮 codex-round,注入 mock 作为 CODEX_BIN,返回解析后的结果 JSON
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

test('fresh round: no --repo => passes --skip-git-repo-check, never --last', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const argvLog = join(dir, 'argv.log');
  execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_ARGV_LOG: argvLog },
  });
  const argv = JSON.parse(readFileSync(argvLog, 'utf8').trim().split('\n')[0]);
  assert.ok(argv.includes('--skip-git-repo-check'), 'should skip git repo check when no --repo');
  assert.ok(argv.includes('exec'));
  assert.ok(!argv.includes('--last'), 'must never use --last');
});

test('fresh round: --repo => passes --cd <dir>, not --skip-git-repo-check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const argvLog = join(dir, 'argv.log');
  execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out, '--repo', '/some/repo'], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_ARGV_LOG: argvLog },
  });
  const argv = JSON.parse(readFileSync(argvLog, 'utf8').trim().split('\n')[0]);
  const i = argv.indexOf('--cd');
  assert.ok(i >= 0 && argv[i + 1] === '/some/repo', 'should pass --cd <repo>');
  assert.ok(!argv.includes('--skip-git-repo-check'));
});

test('resume round: passes `exec resume <id>` and never --last', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const argvLog = join(dir, 'argv.log');
  const TID = '019e2222-bbbb-7000-8000-0000000def01';
  execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out, '--resume', TID], {
    input: 'DELTA', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_ARGV_LOG: argvLog },
  });
  const argv = JSON.parse(readFileSync(argvLog, 'utf8').trim().split('\n')[0]);
  const i = argv.indexOf('resume');
  assert.ok(i >= 0, 'should call exec resume');
  assert.equal(argv[0], 'exec');
  assert.equal(argv[i + 1], TID, 'resume must be followed by the captured thread id');
  assert.ok(!argv.includes('--last'), 'must never use --last');
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
