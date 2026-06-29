#!/usr/bin/env node
// 单轮 Codex 复核原语:stdin=评审包,stdout=一行结果 JSON。纯确定性,无循环。
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isValidVerdict } from './verdict-shape.mjs';

// 证据字段(review-audit ① 用):成功时回 --out 文件路径 + sha256,供独立重放审计核对"Codex 实际产出"(防驱动方转述污染)。
function outEvidence(p) {
  try { return { out_path: p, out_sha256: createHash('sha256').update(readFileSync(p)).digest('hex') }; }
  catch { return { out_path: p, out_sha256: null }; }
}

function parseArgs(argv) {
  const a = { repo: null, model: null, resume: null, schema: null, out: null, raw: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--repo') a.repo = argv[++i];
    else if (x === '--model') a.model = argv[++i];
    else if (x === '--resume') a.resume = argv[++i];
    else if (x === '--schema') a.schema = argv[++i];
    else if (x === '--out') a.out = argv[++i];
    else if (x === '--raw') a.raw = true; // 非 verdict 用途(如 do 出方案):接受任意符合 --output-schema 的 JSON,不套 verdict 结构校验
  }
  return a;
}

// thread id 形如 UUID(codex 0.135.0 用 UUIDv7,如 019eab2c-1662-79d2-a398-3b5f05122c8e)。
// 严格 8-4-4-4-12 hex:杜绝以 `-`/`--` 开头(或任意非 UUID)的值被 codex 自身 argv 解析当成
// CLI 选项(如 `--last` 会绕过按 id 隔离、可能串入其它会话);spawnSync 无 shell 不防此点,须在传入前把关(CR-SEC-RESUME-OPTION-INJECTION)。
const isValidThreadId = (s) => typeof s === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);

function buildCodexArgs(a) {
  const args = ['exec'];
  if (a.resume) args.push('resume', a.resume);
  args.push('--json', '--output-schema', a.schema, '-o', a.out);
  // 沙箱:Codex 必须全程只读(硬不变量,绝不让 Codex 写文件)。
  // fresh 用 -s read-only;resume 不接受 -s/--cd(实测 0.135.0 报 "unexpected argument" 退出 2)。
  // ⚠️ 实测(0.135.0):resume **不继承** fresh 的 read-only,会回落到默认可写沙箱(能写 /tmp 等),
  //    若仅靠"继承"则第 2+ 轮 Codex 可写文件,违反只读不变量(CR-SEC-001)。
  //    故 resume 必须用 `-c sandbox_mode="read-only"` 显式重申(实测写入被阻断、exit 0 无 unexpected-argument)。
  if (a.resume) {
    args.push('-c', 'sandbox_mode="read-only"');
  } else {
    args.push('-s', 'read-only');
    if (a.repo) args.push('--cd', a.repo);
  }
  // 双保险:显式禁用审批升级(CR-SEC-CONFIG-SIDECHANNELS)。read-only 下被拒的写命令,
  // 若 approval_policy 允许升级,理论上可被"批准后无沙箱重试"而落盘。实测(0.135.0 非交互 exec):
  // 即便 approval_policy=on-failure,升级也"unavailable"(无审批人)、写入仍被阻断;但显式 `never`
  // 使该"无升级写路径"保证**不依赖**用户 config 默认或未来行为变更。两轮(fresh/resume)都加。
  args.push('-c', 'approval_policy="never"');
  // 不加载用户/项目 execpolicy `.rules`(CR-SEC-CONFIG-SIDECHANNELS)。官方语义:rule `decision="allow"`
  // 可让命令"免提示、在沙箱外运行"。本工具是只读复核方,**绝不应**让宿主环境里的 ambient `.rules`
  // 放宽复核沙箱的牢笼;`--ignore-rules` 使本次调用忽略全部 .rules、令 `-s read-only` 成为唯一权威上界。
  // fresh 与 resume 都接受该 flag(实测 0.135.0)。
  args.push('--ignore-rules');
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

// verdict 结构形状校验抽到 verdict-shape.mjs(与 review-audit 重放门共享同一套规则,避免漂移)。
// schema 是 strict、required 覆盖全部字段:枚举 verdict、三个数组(含 item 形状)、rationale/reviewed_scope 字符串、truncated 布尔(RS-P0-BOUNDARY)。

// 认证/未登录文本特征。codex 可能把 API 级 auth 失败放 stderr,也可能放 --json stdout 事件(修 CR-UNAUTH-STDOUT)。
function hasAuthError(text) { return /not logged in|not authenticated|please run .*login|unauthor/i.test(text || ''); }
// command-not-found 文本(配合 status===127 判 wrapper 脚本里的 codex 缺失,修 CR-UNAVAILABLE-127-WRAPPER)。
function hasMissingError(text) { return /command not found|not found|no such file/i.test(text || ''); }
// 仅在 --json **错误类事件**(error/turn.failed/turn.error)里找 auth 失败——不扫 item.completed/agent_message,
// 否则会把"回显了含 'unauthorized' 的 verdict 文本"误判为未登录(修 CR-UNAUTH-STDOUT-SCOPE)。
function stdoutHasAuthEvent(stdout) {
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === 'error' || ev.type === 'turn.failed' || ev.type === 'turn.error') {
      if (hasAuthError(ev.message || ev.error || JSON.stringify(ev))) return true;
    }
  }
  return false;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.schema || !a.out) {
    emit({ ok: false, error: 'usage', detail: '--schema and --out are required' });
    process.exit(2);
  }
  // CR-SEC-RESUME-OPTION-INJECTION + CR-ARG-RESUME-MISSING:resume 值须为合法 thread id(UUID),否则拒绝,
  // 防 `--resume --last` 之类被 codex 当作选项解析、绕过按 id 隔离。
  // 用严格 `!== null`:未给 `--resume` 时 a.resume 为初始 null → 跳过(走 fresh);
  // 给了 `--resume` 但缺值时 a.resume 为 undefined(`undefined !== null` 为真)→ 进入校验 → fail-closed 报错,
  // 不静默退化成 fresh 轮(CR-ARG-RESUME-MISSING)。
  if (a.resume !== null && !isValidThreadId(a.resume)) {
    emit({ ok: false, error: 'bad_resume', detail: `--resume 须为合法 thread id(UUID 形式),收到:${JSON.stringify(a.resume)}` });
    process.exit(2);
  }
  // --raw:出方案等非 verdict 用途——只要 codex 写出合法 JSON(符合传入的 --output-schema)即接受,不套 review 的 verdict 结构校验。
  const accept = (v) => (a.raw ? (v !== null && typeof v === 'object') : isValidVerdict(v));
  const bin = process.env.CODEX_BIN || 'codex';
  const input = readFileSync(0, 'utf8'); // stdin 评审包

  const codexArgs = buildCodexArgs(a);
  let threadId = a.resume || null; // 默认回退到 resume 串;成功时由该尝试自身的 thread 覆盖(修 CR-THREAD-ATTEMPT)
  let verdict = null, rawMsg = '';
  let lastStatus = null, lastStdout = '', lastStderr = '', lastSpawnErr = null;
  const startNs = process.hrtime.bigint(); // 单调时钟:防系统时钟回拨产生负 wall_clock_ms(修 CR-CLOCK-MONOTONIC)
  let attemptsMade = 0;        // 实际尝试次数(含 bad_verdict 重试),供观察重试开销

  for (let attempt = 0; attempt < 2; attempt++) {
    attemptsMade++;
    // 每次尝试前都清掉旧的 verdict 文件,防止读到上一轮/上次尝试的残留导致假成功。
    // cleared:本轮 out 是否处于"干净"起点(原本不存在 或 成功删掉)。不可删的旧文件(目录型/权限)
    // 不崩溃,但**绝不能信其内容**——否则不可删的旧合法 verdict 会被当本轮成功(修 CR-OUT-OWNERSHIP / CR-OUT-UNLINK-STALE)。
    let cleared = true;
    try { if (existsSync(a.out)) unlinkSync(a.out); } catch { cleared = false; }
    const res = spawnSync(bin, codexArgs, {
      input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });

    // codex 缺失 → 立即 unavailable,不重试:ENOENT(直接缺失)或 status127+command-not-found(wrapper 内缺失,修 CR-UNAVAILABLE-127-WRAPPER);
    // 或 stderr 明示未登录。去掉**裸** status===127 误判(127 也可能是 codex 自身退出,修 CR-UNAVAILABLE-CHANNEL)。
    const errText = (res.stderr || '') + (res.error ? String(res.error.message || res.error) : '');
    const missing = (res.error && res.error.code === 'ENOENT') || (res.status === 127 && hasMissingError(res.stderr || ''));
    if (missing || hasAuthError(errText)) {
      emit({ ok: false, error: 'codex_unavailable', detail: errText.trim() || 'codex not found or not authenticated' });
      process.exit(0);
    }
    lastStatus = res.status;
    lastStdout = res.stdout || '';
    lastStderr = res.stderr || '';
    lastSpawnErr = res.error ? String(res.error.code || res.error.message || res.error) : null; // 含 ENOBUFS 等非 ENOENT spawn error(修 CR-RETRY-DIAG)

    const attemptThread = extractThreadId(res.stdout);
    // 每次尝试独立读取/解析——不跨尝试复用 raw/verdict,避免 bad_verdict 把上次 raw 与本次 exit/tail 张冠李戴(修 CR-RETRY-METADATA)。
    // 仅当 cleared(起点干净)才读 out;否则旧文件不可信,视为本轮无产物(修 CR-OUT-UNLINK-STALE)。
    let attemptRaw = '', attemptVerdict = null;
    if (cleared) {
      try {
        if (existsSync(a.out)) { attemptRaw = readFileSync(a.out, 'utf8').trim(); try { attemptVerdict = JSON.parse(attemptRaw); } catch { attemptVerdict = null; } }
      } catch (e) { attemptRaw = ''; attemptVerdict = null; lastSpawnErr = (lastSpawnErr ? lastSpawnErr + '; ' : '') + 'out read error: ' + String(e.message || e); } // 不可读 out 不崩溃(修 CR-OUT-OWNERSHIP)
    } else {
      lastSpawnErr = (lastSpawnErr ? lastSpawnErr + '; ' : '') + 'out 不可删,拒读以防陈旧产物假成功';
    }
    rawMsg = attemptRaw; // 始终反映"最近一次尝试"的产出,与下方 codex_exit/stdout_tail 同属同一尝试

    if (accept(attemptVerdict)) {
      verdict = attemptVerdict;
      threadId = attemptThread || a.resume || null; // 仅取本次成功尝试的 thread;fresh 且无 thread.started 时给 null(不返回别次的陈旧 id,修 CR-THREAD-ATTEMPT)
      break;
    }
  }

  // schema 是 strict、required 覆盖全部字段;若解析出的 verdict 缺这些 required 结构(枚举错、
  // remaining_issues / candidate_dispositions / assumptions 非数组),说明产出不合协议——
  // 视为 bad_verdict 而非静默默认成空,避免把协议异常报成功(修 RS-P0-BOUNDARY)。
  if (!accept(verdict)) {
    // 无有效产出时,再看 stdout 的**错误类事件**是否藏着 auth 失败(codex 把 API 级错误放 --json stdout),据此归为 unavailable 而非 bad_verdict(修 CR-UNAUTH-STDOUT;仅扫错误事件,修 CR-UNAUTH-STDOUT-SCOPE)。
    if (stdoutHasAuthEvent(lastStdout)) {
      emit({ ok: false, error: 'codex_unavailable', detail: 'auth error in stdout events: ' + lastStdout.slice(-500).trim() });
      process.exit(0);
    }
    emit({
      ok: false, error: 'bad_verdict', thread_id: threadId, raw_message: rawMsg,
      codex_exit: lastStatus,
      spawn_error: lastSpawnErr, // 非 ENOENT 的 spawn error(如 ENOBUFS)也带上,助排查(修 CR-RETRY-DIAG)
      stdout_tail: lastStdout.slice(-2000),
      stderr_tail: lastStderr.slice(-1000),
    });
    process.exit(0);
  }

  if (a.raw) {
    // --raw:把 codex 按 --output-schema 写出的结构化产物原样放 result(do 出方案等非 verdict 用途)。
    emit({ ok: true, thread_id: threadId, result: verdict, ...outEvidence(a.out), wall_clock_ms: Math.round(Number(process.hrtime.bigint() - startNs) / 1e6), attempts: attemptsMade });
    return;
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
    ...outEvidence(a.out), // 证据:--out 路径 + sha256,供 review-audit 独立重放(①)
    // P1 度量:本轮**交付**真机耗时——从首次尝试到成功,**含 bad_verdict 重试**(如实反映本轮真实墙钟成本)。
    // 单调时钟,保证非负(与 experiment.mjs 的非负约束一致);想区分有效时间 vs 重试开销时用 attempts。
    wall_clock_ms: Math.round(Number(process.hrtime.bigint() - startNs) / 1e6),
    attempts: attemptsMade,
  });
}

// 顶层兜底:任何未预期异常也输出一行结果 JSON,守"stdout 始终一行结果 JSON"原语契约(修 CR-OUT-OWNERSHIP)。
try { main(); } catch (e) { emit({ ok: false, error: 'exception', detail: String((e && e.stack) || e) }); process.exit(1); }
