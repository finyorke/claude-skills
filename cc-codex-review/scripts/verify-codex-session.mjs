#!/usr/bin/env node
// verify-codex-session.mjs — 核对 codex thread_id 是否真有会话记录(防 review/do 假互审,见 DESIGN §12)。
// codex exec 每次在 $CODEX_HOME/sessions/年/月/日/rollout-<时间>-<thread_id>.jsonl 留记录。
// 只核对**文件存在性**(不解析内容):thread_id 能找到对应 .jsonl = verified。
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const isUuid = (s) => typeof s === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);

// 纯函数:{ok, verified:[...], missing:[...]}。安全:非 UUID 直接 missing,绝不拿去匹配文件名(防遍历/注入)。
export function verifySessions(threadIds, opts = {}) {
  if (!Array.isArray(threadIds)) return { ok: false, error: 'bad_input', detail: 'threadIds 须为数组' };
  const root = opts.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
  const sessionsDir = join(root, 'sessions');
  let files = [];
  try {
    if (existsSync(sessionsDir)) files = readdirSync(sessionsDir, { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.jsonl'));
  } catch { files = []; }
  const verified = [], missing = [];
  for (const id of threadIds) {
    if (isUuid(id) && files.some((f) => f.includes(id))) verified.push(id);
    else missing.push(id);
  }
  return { ok: true, verified, missing };
}

function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const raw = await readStdin();
  let inp; try { inp = raw.trim() ? JSON.parse(raw) : {}; } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'bad_json' }) + '\n'); process.exit(2); }
  const out = verifySessions(inp.threadIds || [], { codexHome: inp.codexHome });
  process.stdout.write(JSON.stringify(out) + '\n');
  if (!out.ok) process.exit(2);
}
