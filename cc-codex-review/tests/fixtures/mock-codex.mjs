#!/usr/bin/env node
// 假 codex,供 codex-round 单测注入(CODEX_BIN)。行为由环境变量控制。
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);

// 记录收到的 argv(测试断言 resume / flags 用)
if (process.env.MOCK_ARGV_LOG) {
  appendFileSync(process.env.MOCK_ARGV_LOG, JSON.stringify(argv) + '\n');
}

// 模拟 codex 缺失/未登录
if (process.env.MOCK_FAIL === 'auth') {
  process.stderr.write('stream error: Not logged in. Run `codex login` to authenticate.\n');
  process.exit(1);
}

function flagVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

const outFile = flagVal('-o');
const threadId = process.env.MOCK_THREAD_ID || '019e0000-0000-7000-8000-000000000001';

// 默认 verdict;可被 MOCK_VERDICT 覆盖
let msg = process.env.MOCK_VERDICT
  || JSON.stringify({ verdict: 'AGREE', remaining_issues: [], rationale: 'looks good' });

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
