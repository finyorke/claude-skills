import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
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
    MOCK_VERDICT: JSON.stringify({ verdict: 'AGREE', remaining_issues: [], candidate_dispositions: [], rationale: 'ok', truncated: false, reviewed_scope: 'ok', assumptions: [] }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.thread_id, '019e1111-aaaa-7000-8000-000000000abc');
  assert.equal(res.verdict, 'AGREE');
  assert.deepEqual(res.remaining_issues, []);
  assert.equal(res.attempts, 1, '一次成功 attempts=1');
  // 证据字段(review-audit ① 用):out_path + 64 hex sha256
  assert.equal(typeof res.out_path, 'string');
  assert.match(res.out_sha256 || '', /^[0-9a-f]{64}$/, 'out_sha256 应为 64 位 hex');
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

test('resume round: `exec resume <id>` re-asserts read-only via -c, NO -s/--cd, never --last (#6, CR-SEC-001)', () => {
  const TID = '019e2222-bbbb-7000-8000-0000000def01';
  const argv = captureArgv(['--resume', TID, '--repo', '/some/repo']);
  assert.equal(argv[0], 'exec');
  const ri = argv.indexOf('resume');
  assert.ok(ri >= 0, 'should call exec resume');
  assert.equal(argv[ri + 1], TID, 'resume must be followed by the captured thread id');
  assert.ok(!argv.includes('-s'), 'resume must NOT pass -s (exec resume rejects it with exit 2)');
  assert.ok(!argv.includes('--cd'), 'resume must NOT pass --cd (exec resume rejects it with exit 2)');
  // CR-SEC-001: 实测 resume 不继承 fresh 的 read-only(回落到默认可写沙箱,能写 /tmp),
  // 必须用 -c sandbox_mode="read-only" 显式重申只读,否则第 2+ 轮 Codex 可写文件、违反只读不变量。
  const ci = argv.indexOf('-c');
  assert.ok(ci >= 0, 'resume MUST pass -c to re-assert the sandbox (read-only not inherited)');
  assert.ok(argv.includes('sandbox_mode="read-only"'), 'resume MUST enforce read-only via config override (CR-SEC-001)');
  assert.ok(argv.includes('approval_policy="never"'), 'resume MUST disable approval escalation (CR-SEC-CONFIG-SIDECHANNELS)');
  assert.ok(argv.includes('--ignore-rules'), 'resume MUST ignore ambient execpolicy .rules (CR-SEC-CONFIG-SIDECHANNELS)');
  assert.ok(!argv.includes('--last'), 'must never use --last');
});

test('fresh round: -s read-only + approval_policy=never + --ignore-rules, no sandbox_mode override (CR-SEC-001/CONFIG-SIDECHANNELS)', () => {
  const argv = captureArgv([]);
  const si = argv.indexOf('-s');
  assert.ok(si >= 0 && argv[si + 1] === 'read-only', 'fresh enforces read-only via -s');
  assert.ok(!argv.includes('sandbox_mode="read-only"'), 'fresh must not use the resume-only sandbox_mode override');
  assert.ok(argv.includes('approval_policy="never"'), 'fresh MUST also disable approval escalation');
  assert.ok(argv.includes('--ignore-rules'), 'fresh MUST ignore ambient execpolicy .rules');
});

// 像 runRound,但容忍非零退出码(arg 错误用 exit 2;JSON 仍打到 stdout,bash 侧照常可读)。
function runRoundExpectArgError(extraArgs, input, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  let stdout;
  try {
    stdout = execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out, ...extraArgs],
      { input, encoding: 'utf8', env: { ...process.env, CODEX_BIN: MOCK, ...env } });
  } catch (e) { stdout = e.stdout || ''; }
  return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
}

test('resume id injection: non-UUID --resume is rejected (bad_resume), never spawned (CR-SEC-RESUME-OPTION-INJECTION)', () => {
  for (const bad of ['--last', '--foo', 'not-a-uuid', '019e2222', '../../etc/passwd']) {
    const res = runRoundExpectArgError(['--resume', bad], 'DELTA', {
      MOCK_VERDICT: JSON.stringify({ verdict: 'AGREE', remaining_issues: [], candidate_dispositions: [], rationale: 'x', truncated: false, reviewed_scope: 's', assumptions: [] }),
    });
    assert.equal(res.ok, false, `must reject non-UUID resume: ${bad}`);
    assert.equal(res.error, 'bad_resume', `must flag bad_resume for: ${bad}`);
  }
});

test('resume missing value: `--resume` with no value fails closed (bad_resume), not a silent fresh round (CR-ARG-RESUME-MISSING)', () => {
  const res = runRoundExpectArgError(['--resume'], 'PACKET', {
    MOCK_VERDICT: JSON.stringify({ verdict: 'AGREE', remaining_issues: [], candidate_dispositions: [], rationale: 'x', truncated: false, reviewed_scope: 's', assumptions: [] }),
  });
  assert.equal(res.ok, false, 'missing --resume value must not silently run fresh');
  assert.equal(res.error, 'bad_resume');
});

test('resume id injection: a valid UUID --resume is accepted', () => {
  const res = runRound(['--resume', '019eab2c-1662-79d2-a398-3b5f05122c8e'], 'DELTA', {
    MOCK_VERDICT: JSON.stringify({ verdict: 'CHANGES', remaining_issues: [], candidate_dispositions: [], rationale: 'ok', truncated: false, reviewed_scope: 's', assumptions: [] }),
  });
  assert.equal(res.ok, true, 'valid UUID resume must be accepted');
});

test('--raw: 接受任意合法 JSON 放进 result(do 出方案用,不套 verdict 校验)', () => {
  const planJson = JSON.stringify({ plan: 'P', steps: ['s1'], assumptions: [], risks: [] });
  const res = runRound(['--raw'], 'TASK', { MOCK_VERDICT: planJson });
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, { plan: 'P', steps: ['s1'], assumptions: [], risks: [] });
  assert.equal(res.verdict, undefined, 'raw 模式不输出 verdict 字段');
});

test('不带 --raw:非 verdict 结构 JSON → bad_verdict(回归保护)', () => {
  const res = runRound([], 'TASK', { MOCK_VERDICT: JSON.stringify({ plan: 'P', steps: [], assumptions: [], risks: [] }) });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'bad_verdict');
});

test('resume round: actually succeeds against realistic mock (#6 regression)', () => {
  // realistic mock rejects -s/--cd under resume with exit 2; this only passes if the
  // script omits them on resume.
  const res = runRound(['--resume', '019e2222-bbbb-7000-8000-0000000def01'], 'DELTA', {
    MOCK_VERDICT: JSON.stringify({ verdict: 'CHANGES', remaining_issues: [], candidate_dispositions: [], rationale: 'more', truncated: false, reviewed_scope: 's', assumptions: [] }),
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
    MOCK_VERDICT: JSON.stringify({ verdict: 'CHANGES', remaining_issues: [{ id: 'I1', title: 't', detail: 'd', severity: 'major' }], candidate_dispositions: [], rationale: 'r', truncated: false, reviewed_scope: 's', assumptions: [] }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'CHANGES');
  assert.equal(res.remaining_issues.length, 1);
  assert.equal(res.attempts, 2, 'wall_clock 含重试;attempts=2 让重试开销可观察');
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
      verdict: 'AGREE', remaining_issues: [], candidate_dispositions: [], rationale: 'ok',
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
      rationale: 'r', truncated: false, reviewed_scope: 's', assumptions: [],
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.remaining_issues[0].id, 'I1', 'issue id must survive');
  assert.deepEqual(res.candidate_dispositions, [
    { id: 'C1', disposition: 'confirmed' },
    { id: 'C2', disposition: 'rejected' },
  ], 'candidate_dispositions must pass through, not be dropped');
});

test('RS-P0-BOUNDARY: 缺 required 数组字段(如 candidate_dispositions)→ bad_verdict,不静默默认', () => {
  const res = runRound([], 'PACKET', {
    MOCK_VERDICT: JSON.stringify({ verdict: 'AGREE', remaining_issues: [], rationale: 'ok' }), // 缺 candidate_dispositions / assumptions
  });
  assert.equal(res.ok, false, '不合协议的 verdict 不得报成功');
  assert.equal(res.error, 'bad_verdict');
});

test('RS-P0-EXTRA: 含额外字段(additionalProperties)→ bad_verdict', () => {
  const res = runRound([], 'PACKET', {
    MOCK_VERDICT: JSON.stringify({
      verdict: 'AGREE', remaining_issues: [], candidate_dispositions: [], rationale: 'ok',
      truncated: false, reviewed_scope: 's', assumptions: [], EXTRA: 'nope',
    }),
  });
  assert.equal(res.ok, false, '额外顶层字段应被拒(schema 是 additionalProperties:false)');
  assert.equal(res.error, 'bad_verdict');
});

// ---- v0.8.2 codex-round 加固(CR-* bugs)----

test('CR-UNAUTH-STDOUT: auth 失败只在 stdout 事件里也判 codex_unavailable(不误报 bad_verdict)', () => {
  const res = runRound([], 'PACKET', { MOCK_AUTH_STDOUT: '1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'codex_unavailable');
});

test('CR-CLOCK-MONOTONIC: wall_clock_ms 为非负数(单调时钟,与 experiment.mjs 非负约束一致)', () => {
  const res = runRound([], 'PACKET', {
    MOCK_VERDICT: JSON.stringify({ verdict: 'AGREE', remaining_issues: [], candidate_dispositions: [], rationale: 'ok', truncated: false, reviewed_scope: 's', assumptions: [] }),
  });
  assert.equal(res.ok, true);
  assert.equal(typeof res.wall_clock_ms, 'number');
  assert.ok(res.wall_clock_ms >= 0, 'wall_clock_ms 不得为负');
});

test('CR-OUT-OWNERSHIP: --out 指向目录(不可写/不可删)不崩溃,仍输出一行结果 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const outDir = join(dir, 'out-as-dir');
  mkdirSync(outDir); // --out 是个目录 → unlink/read 会抛,脚本须吞掉并协议化
  const stdout = execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', outDir], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_VERDICT: JSON.stringify({ verdict: 'AGREE', remaining_issues: [], candidate_dispositions: [], rationale: 'ok', truncated: false, reviewed_scope: 's', assumptions: [] }) },
  });
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  const res = JSON.parse(line); // 必须可解析(契约:始终一行结果 JSON)
  assert.equal(res.ok, false, '不可读/写的 out → 无有效产出 → ok:false,而非抛 Node stack');
});

test('CR-UNAVAILABLE-127-WRAPPER: status127 + command-not-found → codex_unavailable', () => {
  const res = runRound([], 'PACKET', { MOCK_MISSING_127: '1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'codex_unavailable');
});

test('CR-UNAUTH-STDOUT-SCOPE: agent_message 含 unauthorized 但无 auth 错误事件 → bad_verdict(不误判 unavailable)', () => {
  const res = runRound([], 'PACKET', { MOCK_SCOPE_PROBE: '1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'bad_verdict', 'content 里的 unauthorized 不得被当 auth 失败');
});

test('CR-OUT-UNLINK-STALE: 不可删的旧 out + 本轮未写 → 不得当陈旧产物报成功', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  writeFileSync(out, JSON.stringify({ verdict: 'AGREE', remaining_issues: [], candidate_dispositions: [], rationale: 'STALE', truncated: false, reviewed_scope: 's', assumptions: [] }));
  chmodSync(dir, 0o555); // 父目录只读 → unlink(out) 失败,旧文件留存
  try {
    const stdout = execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out], {
      input: 'PACKET', encoding: 'utf8',
      env: { ...process.env, CODEX_BIN: MOCK, MOCK_NO_WRITE: '1' },
    });
    const res = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(res.ok, false, '不可删的旧合法 verdict 不得被当本轮成功');
    assert.equal(res.error, 'bad_verdict');
  } finally { chmodSync(dir, 0o755); }
});
