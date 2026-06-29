#!/usr/bin/env node
// review-audit.mjs — 收敛诚实性的**独立重放审计**(缓解「运动员兼裁判」泄漏,DESIGN §12 ①)。
//
// 问题:review/do 的收敛判定虽由 review-state(确定性纯函数)做,但**喂给它的每轮 Codex 字段是 Claude 转述的**,
//   Claude 可能误报 verdict/disposition、隐藏分歧 → 把假收敛喂成真收敛。
// 抓手:每轮 codex-round 把 Codex **原始结构化输出**写到 `--out` 文件。本审计器**直接读这些 raw 文件**重建每轮的
//   Codex 字段(verdict/remaining_issues/candidate_dispositions),只接受 Claude 提供**自己的动作**(adopted/rebutted/
//   merges/annotations/claudeAgree),再用现有 review-state 的 validateRound→reduce→validateState→canConverge **重放**。
//   于是"收敛是否诚实"可被独立核验,而非只能信 Claude 转述。
// 边界(诚实):这是**插件层、提高门槛**,非防恶意硬强制——Claude 仍可跳过审计/篡改证据文件/在 final 谎称通过;
//   真硬强制需 Claude Code hook(后续档)。本器只让"独立核验路径存在且默认 fail-closed"。
// 不改 review-state 的纯函数/无 IO 不变量;本器**导入并重放**它,文件 IO 只在 CLI 层。
import { reduce, validateRound, validateState, canConverge, emptyState, counts } from './review-state.mjs';
import { isValidVerdict } from './verdict-shape.mjs';
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// 有界、安全地读取证据文件(修 I1:全局 hook 会调到这里,绝不能在 FIFO/特殊文件上阻塞、或被超大文件 OOM)。
// 须是**普通文件**(lstat isFile,挡 FIFO/目录/符号链接特殊项)且**不超上限**;否则抛(→ 上层当证据无效 fail-closed)。
const RAW_CAP = 4 * 1024 * 1024; // 单个 codex_out raw 文件上限
export function readBoundedFile(path, cap, label) {
  let st;
  try { st = lstatSync(path); } catch (e) { throw new Error(`${label} 读不到(${path}):${e.message}`); }
  if (!st.isFile()) throw new Error(`${label} 不是普通文件(${path};拒读 FIFO/目录/特殊文件,防阻塞)`);
  if (st.size > cap) throw new Error(`${label} 超过大小上限 ${cap} 字节(${path}:${st.size})`);
  return readFileSync(path);
}

// 纯核心:rounds=[{ codexOutput:{verdict,remaining_issues,candidate_dispositions,...}, claudeActions:{adopted,rebutted,merges,annotations} }]
//   - Codex 字段**只取自 codexOutput**(=raw --out 文件解析),忽略任何 Claude 转述的 Codex 字段;
//   - Claude 动作**只取自 claudeActions**;
//   - 逐轮 validateRound(失败即 fail-closed 停)→ reduce → validateState(失败即停);末轮 canConverge。
// 返回 { ok, audited_converged, reasons, state, counts, failures }。
export function auditRounds(rounds, claudeAgree) {
  const failures = [];
  let state = emptyState();
  let lastVerdict = null;
  if (!Array.isArray(rounds) || rounds.length === 0) {
    return { ok: false, audited_converged: false, reasons: ['无 round 证据(fail-closed)'], state, counts: counts(state), failures: ['no_rounds'] };
  }
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i] || {};
    const co = r.codexOutput;
    // 修 I1:raw --out 必须是**合法 verdict 结构**(枚举/三数组/各字段类型),否则 validateRound 会把缺失数组当空 → schema 非法证据也能审过。fail-closed。
    if (!isValidVerdict(co)) {
      failures.push(`round ${i + 1}: codexOutput 不是合法 verdict 结构(raw --out 不合 schema)`);
      return { ok: false, audited_converged: false, reasons: ['raw 证据不合 verdict schema(fail-closed)'], state, counts: counts(state), failures };
    }
    const ca = (r.claudeActions && typeof r.claudeActions === 'object') ? r.claudeActions : {};
    const round = {
      verdict: co.verdict,
      remaining_issues: co.remaining_issues,
      candidate_dispositions: co.candidate_dispositions,
      adopted: ca.adopted,
      rebutted: ca.rebutted,
      merges: ca.merges,
      annotations: ca.annotations,
    };
    const vr = validateRound(state, round);
    if (!vr.ok) {
      failures.push(`round ${i + 1} validate-round: ${vr.errors.join('; ')}`);
      return { ok: false, audited_converged: false, reasons: ['本轮事件不合协议(fail-closed)'], state, counts: counts(state), failures };
    }
    state = reduce(state, round);
    const vs = validateState(state);
    if (!vs.ok) {
      failures.push(`round ${i + 1} validate-state: ${vs.errors.join('; ')}`);
      return { ok: false, audited_converged: false, reasons: ['reduce 后状态非法(fail-closed)'], state, counts: counts(state), failures };
    }
    lastVerdict = co.verdict;
  }
  const cc = canConverge(state, lastVerdict, claudeAgree === true);
  return { ok: true, audited_converged: cc.converged, reasons: cc.reasons, state, counts: counts(state), failures };
}

// ---- CLI(IO 层):读 manifest,逐轮读 raw --out 文件 + 校验 sha256,再调 auditRounds ----
// manifest = { claudeAgree:bool, rounds:[ { round_index:<1-based 连续>, codex_out:"<path>", codex_out_sha256:"<64 hex,必填>", claude_actions?:{...} } ] }
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

export function loadRounds(manifest) {
  const out = [];
  const rounds = (manifest && manifest.rounds) || [];
  if (!Array.isArray(rounds)) throw new Error('manifest.rounds 须为数组');
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i] || {};
    // 修 I3:round_index 须 1-based 连续(防 manifest 内部乱序/抽轮);**注意残余**:漏掉"末尾轮"靠脚本无法发现——
    // manifest 完整性仍是**受信边界**(Claude 控制列了哪些轮),硬保证需 hook/wrapper(见 DESIGN §12 ①)。
    if (r.round_index !== i + 1) throw new Error(`round ${i + 1}: round_index 须为 ${i + 1}(1-based 连续;收到 ${JSON.stringify(r.round_index)})`);
    if (typeof r.codex_out !== 'string' || !r.codex_out) throw new Error(`round ${i + 1}: 缺 codex_out 路径`);
    // 修 I2:sha256 必填(不可选)——否则缺哈希即退化成只信路径,防篡改/串文件形同虚设。
    if (typeof r.codex_out_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.codex_out_sha256)) throw new Error(`round ${i + 1}: 缺/坏 codex_out_sha256(须 64 位 hex,fail-closed)`);
    let raw;
    try { raw = readBoundedFile(r.codex_out, RAW_CAP, `round ${i + 1} codex_out`); } catch (e) { throw new Error(e.message); } // 有界安全读(普通文件+上限,修 I1)
    const got = sha256(raw);
    if (got !== r.codex_out_sha256) throw new Error(`round ${i + 1}: codex_out sha256 不符(篡改/串文件?expected ${r.codex_out_sha256.slice(0, 12)}… got ${got.slice(0, 12)}…)`);
    let co;
    try { co = JSON.parse(raw.toString('utf8')); } catch (e) { throw new Error(`round ${i + 1}: codex_out 非合法 JSON(${e.message})`); }
    out.push({ codexOutput: co, claudeActions: r.claude_actions || {} });
  }
  return out;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let raw = '';
  process.stdin.on('data', (c) => (raw += c)).on('end', () => {
    let manifest;
    try { manifest = raw.trim() ? JSON.parse(raw) : {}; } catch (e) { emit({ ok: false, error: 'bad_json', detail: String(e.message || e) }); process.exit(2); }
    if (typeof manifest.claudeAgree !== 'boolean') { emit({ ok: false, error: 'bad_claudeAgree', detail: 'manifest.claudeAgree 须为布尔(fail-closed)' }); process.exit(2); }
    let rounds;
    try { rounds = loadRounds(manifest); } catch (e) { emit({ ok: false, error: 'evidence_invalid', detail: String(e.message || e) }); process.exit(2); }
    const res = auditRounds(rounds, manifest.claudeAgree);
    emit(res);
    if (!res.audited_converged) process.exit(1); // 未审计通过 → 非零退出,便于命令/wrapper 据此拒绝 RESOLVED
  });
}
