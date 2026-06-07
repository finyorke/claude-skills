#!/usr/bin/env node
// 单轮 Codex 复核原语:stdin=评审包,stdout=一行结果 JSON。纯确定性,无循环。
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';

function parseArgs(argv) {
  const a = { repo: null, model: null, resume: null, schema: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--repo') a.repo = argv[++i];
    else if (x === '--model') a.model = argv[++i];
    else if (x === '--resume') a.resume = argv[++i];
    else if (x === '--schema') a.schema = argv[++i];
    else if (x === '--out') a.out = argv[++i];
  }
  return a;
}

function buildCodexArgs(a) {
  const args = ['exec'];
  if (a.resume) args.push('resume', a.resume);
  args.push('--json', '--output-schema', a.schema, '-o', a.out);
  // 沙箱与工作目录:fresh 时显式设置。`codex exec resume` 不接受 -s/--cd
  // (实测 0.135.0 报 "unexpected argument" 退出 2);resume 从原 session 继承,故略过。
  if (!a.resume) {
    args.push('-s', 'read-only');
    if (a.repo) args.push('--cd', a.repo);
  }
  // 两种模式都接受 --skip-git-repo-check;总是加上,使非 git 目录的 --repo 也能用(文本评审)。
  args.push('--skip-git-repo-check');
  if (a.model) args.push('-m', a.model);
  args.push('-'); // 从 stdin 读 prompt
  return args;
}

function extractThreadId(stdout) {
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === 'thread.started' && ev.thread_id) return ev.thread_id;
    } catch {}
  }
  return null;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// schema 是 strict、required 覆盖全部字段。合规的 verdict 必须满足完整结构(缺/类型错即协议异常,
// 见 RS-P0-BOUNDARY):枚举 verdict、三个数组(含 item 形状)、rationale/reviewed_scope 字符串、truncated 布尔。
const SEV = new Set(['blocker', 'major', 'minor']);
const V_KEYS = ['verdict', 'remaining_issues', 'candidate_dispositions', 'rationale', 'truncated', 'reviewed_scope', 'assumptions'];
const ISSUE_KEYS = ['id', 'title', 'detail', 'severity'];
const DISP_KEYS = ['id', 'disposition'];
// 精确键集:对应 schema 的 additionalProperties:false——不多不少(修 RS-P0-EXTRA)。
function exactKeys(o, keys) {
  if (!o || typeof o !== 'object') return false;
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(o, x));
}
function isValidVerdict(v) {
  if (!exactKeys(v, V_KEYS)) return false;
  if (v.verdict !== 'AGREE' && v.verdict !== 'CHANGES') return false;
  if (typeof v.rationale !== 'string' || typeof v.reviewed_scope !== 'string' || typeof v.truncated !== 'boolean') return false;
  if (!Array.isArray(v.assumptions) || !v.assumptions.every((x) => typeof x === 'string')) return false;
  if (!Array.isArray(v.remaining_issues) || !v.remaining_issues.every((it) =>
    exactKeys(it, ISSUE_KEYS) && typeof it.id === 'string' && typeof it.title === 'string' && typeof it.detail === 'string' && SEV.has(it.severity))) return false;
  if (!Array.isArray(v.candidate_dispositions) || !v.candidate_dispositions.every((d) =>
    exactKeys(d, DISP_KEYS) && typeof d.id === 'string' && (d.disposition === 'confirmed' || d.disposition === 'rejected'))) return false;
  return true;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.schema || !a.out) {
    emit({ ok: false, error: 'usage', detail: '--schema and --out are required' });
    process.exit(2);
  }
  const bin = process.env.CODEX_BIN || 'codex';
  const input = readFileSync(0, 'utf8'); // stdin 评审包

  const codexArgs = buildCodexArgs(a);
  let threadId = null, verdict = null, rawMsg = '';
  let lastStatus = null, lastStdout = '', lastStderr = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    // 每次尝试前都清掉旧的 verdict 文件,防止读到上一轮/上次尝试的残留导致假成功。
    if (existsSync(a.out)) unlinkSync(a.out);
    const res = spawnSync(bin, codexArgs, {
      input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });

    // codex 缺失或未登录 → 提示用户 /codex:setup(不重试)
    const errText = (res.stderr || '') + (res.error ? String(res.error.message || res.error) : '');
    const unavailable =
      (res.error && res.error.code === 'ENOENT') ||
      res.status === 127 ||
      /not logged in|not authenticated|please run .*login|unauthor/i.test(errText);
    if (unavailable) {
      emit({ ok: false, error: 'codex_unavailable', detail: errText.trim() || 'codex not found or not authenticated' });
      process.exit(0);
    }
    lastStatus = res.status;
    lastStdout = res.stdout || '';
    lastStderr = res.stderr || '';

    threadId = extractThreadId(res.stdout) || threadId;

    if (existsSync(a.out)) {
      rawMsg = readFileSync(a.out, 'utf8').trim();
      try { verdict = JSON.parse(rawMsg); } catch { verdict = null; }
    }
    if (isValidVerdict(verdict)) break;
  }

  // schema 是 strict、required 覆盖全部字段;若解析出的 verdict 缺这些 required 结构(枚举错、
  // remaining_issues / candidate_dispositions / assumptions 非数组),说明产出不合协议——
  // 视为 bad_verdict 而非静默默认成空,避免把协议异常报成功(修 RS-P0-BOUNDARY)。
  if (!isValidVerdict(verdict)) {
    emit({
      ok: false, error: 'bad_verdict', thread_id: threadId, raw_message: rawMsg,
      codex_exit: lastStatus,
      stdout_tail: lastStdout.slice(-2000),
      stderr_tail: lastStderr.slice(-1000),
    });
    process.exit(0);
  }

  emit({
    ok: true,
    thread_id: threadId,
    verdict: verdict.verdict,
    remaining_issues: verdict.remaining_issues,
    candidate_dispositions: verdict.candidate_dispositions,
    rationale: verdict.rationale || '',
    truncated: !!verdict.truncated,
    reviewed_scope: verdict.reviewed_scope || '',
    assumptions: verdict.assumptions,
  });
}

main();
