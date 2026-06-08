#!/usr/bin/env node
// 假 codex,供 codex-round 单测注入(CODEX_BIN)。行为由环境变量控制。
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);

// 记录收到的 argv(测试断言 resume / flags 用)
if (process.env.MOCK_ARGV_LOG) {
  appendFileSync(process.env.MOCK_ARGV_LOG, JSON.stringify(argv) + '\n');
}

// 拟真:`codex exec resume` 不接受 fresh 专属 flag(-s/--sandbox、--cd)。
// 真实 codex-cli 0.135.0 会报 "unexpected argument" 并退出 2。借此让 resume flag 回归被测出。
if (argv.includes('resume') && (argv.includes('-s') || argv.includes('--sandbox') || argv.includes('--cd'))) {
  process.stderr.write("error: unexpected argument found\n\nUsage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\n");
  process.exit(2);
}

// 模拟 codex 缺失/未登录
if (process.env.MOCK_FAIL === 'auth') {
  process.stderr.write('stream error: Not logged in. Run `codex login` to authenticate.\n');
  process.exit(1);
}

// 模拟 wrapper 脚本里 codex 缺失:status 127 + command not found(测 CR-UNAVAILABLE-127-WRAPPER)。
if (process.env.MOCK_MISSING_127 === '1') {
  process.stderr.write('codex: command not found\n');
  process.exit(127);
}

function flagVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

const outFile = flagVal('-o');
const threadId = process.env.MOCK_THREAD_ID || '019e0000-0000-7000-8000-000000000001';

// 模拟 auth 失败只出现在 --json stdout 事件里(stderr 干净、不写 -o),用于测 CR-UNAUTH-STDOUT。
if (process.env.MOCK_AUTH_STDOUT === '1') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'error', message: 'stream error: Not logged in. Run `codex login` to authenticate.' }) + '\n');
  process.exit(1);
}

// 模拟"agent_message 文本里含 'unauthorized' 但并非 auth 失败"+ 写出非法 verdict:
// 错误类事件里没有 auth,故应判 bad_verdict 而非 codex_unavailable(测 CR-UNAUTH-STDOUT-SCOPE)。
if (process.env.MOCK_SCOPE_PROBE === '1') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'discussing unauthorized access as a content topic, not an auth failure' } }) + '\n');
  if (outFile) writeFileSync(outFile, 'not-a-valid-verdict');
  process.exit(0);
}

// 默认 verdict;可被 MOCK_VERDICT 覆盖
let msg = process.env.MOCK_VERDICT
  || JSON.stringify({ verdict: 'AGREE', remaining_issues: [], rationale: 'looks good' });

// 模拟「跑了但失败、未写 verdict 文件」:把 API 级错误写进 stdout 事件流(真实 codex 行为),
// 不写 -o,退出 1。用于测 stale-file 防护(#1)与失败诊断(#2)。
if (process.env.MOCK_NO_WRITE === '1') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'error', message: 'mock turn.failed: invalid_request_error' }) + '\n');
  process.exit(1);
}

// 第一次写非法、第二次写合法(测重试)
if (process.env.MOCK_BAD_OUTPUT === '1') {
  if (!process.env.MOCK_COUNTER) {
    process.stderr.write('mock-codex: MOCK_BAD_OUTPUT requires MOCK_COUNTER\n');
    process.exit(1);
  }
  const counterFile = process.env.MOCK_COUNTER;
  let n = 0;
  try { n = parseInt(readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
  writeFileSync(counterFile, String(n + 1));
  if (n === 0) msg = 'this-is-not-json';
}

// JSONL 事件流到 stdout(首行 thread.started 含 id)
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');

if (outFile) writeFileSync(outFile, msg);

process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: { id: 'item_0', type: 'agent_message', text: msg },
}) + '\n');

process.exit(0);
