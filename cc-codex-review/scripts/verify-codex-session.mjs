#!/usr/bin/env node
// verify-codex-session.mjs — 核对 codex thread_id 是否真有会话记录(防 review/do 假互审,见 DESIGN §12)。
// codex exec 每次在 $CODEX_HOME/sessions/年/月/日/rollout-<时间>-<thread_id>.jsonl 留记录。
// 只核对**文件存在性**(不解析内容):thread_id 能找到对应 .jsonl = verified。
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const isUuid = (s) => typeof s === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);

// 纯函数:{ok, verified:[...], missing:[...], paths:{id:绝对路径}}。安全:非 UUID 直接 missing,绝不拿去匹配文件名(防遍历/注入)。
// paths:对每个 verified id 给出其 rollout 文件的绝对路径,便于使用方(review/do §7)直接打开 codex 自留的完整对话记录(B)。
export function verifySessions(threadIds, opts = {}) {
  if (!Array.isArray(threadIds)) return { ok: false, error: 'bad_input', detail: 'threadIds 须为数组' };
  const root = opts.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
  const sessionsDir = join(root, 'sessions');
  let files = [];
  try {
    if (existsSync(sessionsDir)) files = readdirSync(sessionsDir, { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.jsonl'));
  } catch { files = []; }
  const verified = [], missing = [], paths = {};
  for (const id of threadIds) {
    // 精确尾匹配 rollout-…-<id>.jsonl,非子串(EN1:防部分匹配/误判)
    const hit = isUuid(id) ? files.find((f) => f.endsWith(`-${id}.jsonl`)) : undefined;
    if (hit !== undefined) { verified.push(id); paths[id] = join(sessionsDir, hit); } // join 复原绝对路径(readdir recursive 返回相对 sessionsDir 的路径)
    else missing.push(id);
  }
  return { ok: true, verified, missing, paths };
}

function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
const USAGE = 'usage: verify-codex-session.mjs <thread_id…> [--codex-home <dir>]\n   or: echo \'{"threadIds":[…],"codexHome"?}\' | verify-codex-session.mjs';
function fail(error, detail) { process.stdout.write(JSON.stringify({ ok: false, error, detail, usage: USAGE }) + '\n'); process.exit(2); }

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  // 两种入参皆可:① 位置参数 thread_id(+ 可选 --codex-home);② stdin JSON {threadIds,codexHome}。
  // 位置参数优先;两者都没有 → 显式报错(不再静默返回空 verified——曾误导调用方/在硬门禁下假阳性卡收敛)。
  const argv = process.argv.slice(2);
  const posIds = []; let flagHome;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--codex-home') { flagHome = argv[++i]; }
    else if (a === '-h' || a === '--help') { process.stdout.write(USAGE + '\n'); process.exit(0); }
    else if (a.startsWith('--')) fail('bad_arg', `未知参数 ${a}`); // 未知 flag 显式报错,不当成 thread_id 静默吞掉
    else posIds.push(a);
  }
  let threadIds, codexHome = flagHome;
  if (posIds.length) {
    threadIds = posIds; // 位置参数优先,不读 stdin
  } else {
    const raw = await readStdin();
    if (!raw.trim()) fail('no_input', '既无位置参数 thread_id、stdin 也为空');
    let inp; try { inp = JSON.parse(raw); } catch { fail('bad_json', 'stdin 不是合法 JSON'); }
    if (inp.threadIds === undefined) fail('no_input', 'stdin JSON 缺 threadIds');
    threadIds = inp.threadIds; // 非数组交由 verifySessions 判 bad_input
    codexHome = flagHome || inp.codexHome;
  }
  const out = verifySessions(threadIds, { codexHome });
  process.stdout.write(JSON.stringify(out) + '\n');
  if (!out.ok) process.exit(2);
}
