#!/usr/bin/env node
// 单轮 Codex 复核原语:stdin=评审包,stdout=一行结果 JSON。纯确定性,无循环。
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

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
  args.push('--json', '-s', 'read-only', '--output-schema', a.schema, '-o', a.out);
  if (a.repo) args.push('--cd', a.repo);
  else args.push('--skip-git-repo-check');
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

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.schema || !a.out) {
    emit({ ok: false, error: 'usage', detail: '--schema and --out are required' });
    process.exit(2);
  }
  const bin = process.env.CODEX_BIN || 'codex';
  const input = readFileSync(0, 'utf8'); // stdin 评审包

  const res = spawnSync(bin, buildCodexArgs(a), {
    input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });

  // codex 缺失或未登录 → 提示用户 /codex:setup
  const errText = (res.stderr || '') + (res.error ? String(res.error.message || res.error) : '');
  const unavailable =
    (res.error && res.error.code === 'ENOENT') ||
    res.status === 127 ||
    /not logged in|not authenticated|please run .*login|unauthor/i.test(errText);
  if (unavailable) {
    emit({ ok: false, error: 'codex_unavailable', detail: errText.trim() || 'codex not found or not authenticated' });
    process.exit(0);
  }

  const threadId = extractThreadId(res.stdout);

  let verdict = null, rawMsg = '';
  if (existsSync(a.out)) {
    rawMsg = readFileSync(a.out, 'utf8').trim();
    try { verdict = JSON.parse(rawMsg); } catch { verdict = null; }
  }

  if (!verdict || (verdict.verdict !== 'AGREE' && verdict.verdict !== 'CHANGES')) {
    emit({ ok: false, error: 'bad_verdict', thread_id: threadId, raw_message: rawMsg });
    process.exit(0);
  }

  emit({
    ok: true,
    thread_id: threadId,
    verdict: verdict.verdict,
    remaining_issues: verdict.remaining_issues || [],
    rationale: verdict.rationale || '',
  });
}

main();
