#!/usr/bin/env node
// enforce-resolved-hook.mjs — Claude Code **Stop hook**:把"未经诚实收敛审计不得宣布 RESOLVED"做成回合级硬门禁(② 硬强制,DESIGN §12)。
//
// 方案 B(brainstorm 定):hook **自己重跑 review-audit**(从 raw Codex --out 独立重放),不信任何"已通过"声明。
// 落点=Stop(回合结束);范围=插件自带全局;判定=认哨兵(精确优先,几乎不误伤无关回合)。
//
// 流程:读 stdin{transcript_path} → 取**最后一条 assistant 消息**文本 → 找哨兵 `<<CCR-RESOLVED manifest="…">>`
//   - 无哨兵 → 放行(exit 0,{});绝大多数回合走这条快路径。
//   - 有哨兵 → 读 manifest、import review-audit 重放:
//       audited_converged=true → 放行;否则(不收敛/证据无效/manifest 缺失坏)→ exit 2 + {decision:block,reason} 强制不让停。
//   - **基础设施失败 fail-open**:读不到 transcript / import 失败等 → 放行(不把用户整个 Claude Code 卡死);
//     仅"能跑出审计结论且未通过"才 block。
//
// 诚实边界(见 spec/DESIGN):不出哨兵+散文写 RESOLVED 可逃逸;指向旧通过 manifest 重放;manifest 漏末尾轮;
//   弄坏 hook 环境(fail-open)——均为提高门槛非 bulletproof。
import { lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 有界尾读(修 I1:全局 hook 每个 Stop 都会跑,绝不能读整个 transcript〔随会话线性增长〕或在 FIFO/特殊文件上阻塞)。
// 须普通文件;只读末尾 cap 字节(哨兵/最后一条 assistant 消息都在尾部)。非普通文件即抛(→ 上层 infra fail-open)。
const TRANSCRIPT_TAIL_CAP = 512 * 1024;
const MANIFEST_CAP = 1024 * 1024;
function readTail(path, cap) {
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error('not a regular file');
  const start = Math.max(0, st.size - cap);
  const len = st.size - start;
  const fd = openSync(path, 'r');
  try { const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, start); return buf.toString('utf8'); }
  finally { closeSync(fd); }
}

// 框定哨兵识别(修 I1,降误拦):只认**剥除代码块后、最后一行整行**就是哨兵的情形——
// 真 §7 结论以独占一行的哨兵收尾;散文里引用/代码块里的示例(开发讨论常见)不会成为最后一行整行,故不触发。
const SENTINEL_LINE = /^<<CCR-RESOLVED\s+manifest="([^"]+)">>$/;
const SENTINEL_RAW = /<<CCR-RESOLVED\s+manifest=/; // 原始尾部存在性(挡"超大最终记录被尾读截断→解析失败→静默放行"绕过)
const MANIFEST_KIND = 'cc-codex-review-audit-manifest';
function stripFences(text) { return String(text || '').replace(/```[\s\S]*?```/g, ''); }
function finalLineManifest(text) {
  const lines = stripFences(text).split('\n').map((l) => l.trim()).filter((l) => l.length);
  if (!lines.length) return null;
  const m = SENTINEL_LINE.exec(lines[lines.length - 1]);
  return m ? m[1] : null;
}
// #1 部分修:规范 §7 成功结论头(很特定的整行,非宽泛匹配"RESOLVED",避免误拦设计讨论/issue 描述)。
// 命中它却无末行哨兵 = 写了 RESOLVED 结论却没过审计/没出哨兵 → block(堵"忘出哨兵/偷懒不审"的最可能漏法)。
const CANONICAL_RESOLVED = '收敛结论(状态:RESOLVED)';
function hasCanonicalResolvedHeader(text) {
  return stripFences(text).split('\n').some((l) => { const t = l.trim(); return t.startsWith('✅') && t.includes(CANONICAL_RESOLVED); });
}

function out(obj) { if (obj) process.stdout.write(JSON.stringify(obj) + '\n'); }
function allow() { out({}); process.exit(0); }
function block(reason) { out({ decision: 'block', reason: `[cc-codex-review 硬门禁] ${reason}` }); process.exit(2); }

// 从 transcript jsonl 尾部判定本回合结论:{action:'gate',manifestPath} | {action:'allow'} | {action:'block',reason}
// 只看当前回合(最后一条 assistant 记录),避免旧哨兵误拦后续回合;并处理"超大最终记录被尾读截断"的绕过。
function detectSentinel(transcriptPath) {
  const tail = readTail(transcriptPath, TRANSCRIPT_TAIL_CAP);
  const lines = tail.split('\n').filter((l) => l.trim());
  if (!lines.length) return { action: 'allow' };
  // 最终记录是否被尾窗截断:最后一非空行 JSON 解析失败 = 该单条记录大于尾窗。
  let lastParses = true; try { JSON.parse(lines[lines.length - 1]); } catch { lastParses = false; }
  if (!lastParses) {
    // 截断的超大最终记录:**不静默放行**(否则用超长结论把哨兵挤出可解析区即可绕过,round2 漏洞)。
    // 原始尾部含哨兵标记 → 保守 block;否则放行(超大但确无哨兵,不误伤)。
    if (SENTINEL_RAW.test(tail)) return { action: 'block', reason: '最终消息过大、尾读被截断且含 CCR-RESOLVED 标记,无法安全结构化核验。请缩短结论或撤下哨兵改 UNRESOLVED。' };
    return { action: 'allow' };
  }
  // 最终记录完整:取最后一条 assistant 文本,认"剥代码块后最后一行整行哨兵"。
  let text = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const m = o.message || o; const role = m.role || o.type;
    if (role !== 'assistant') continue;
    const c = m.content;
    text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '';
    break;
  }
  const mp = finalLineManifest(text);
  if (mp) return { action: 'gate', manifestPath: mp };
  // #1:写了规范 RESOLVED 结论头却无哨兵 → block(不能靠"忘出哨兵"绕过审计门)。
  if (hasCanonicalResolvedHeader(text)) return { action: 'block', reason: '检测到 §7 成功结论头「✅…收敛结论(状态:RESOLVED)」但末行无 CCR-RESOLVED 哨兵:宣布 RESOLVED 必须过 review-audit 并在结论末行输出哨兵。请补审计+哨兵,或把结论改为 UNRESOLVED。' };
  return { action: 'allow' };
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let inp; try { inp = JSON.parse(raw); } catch { allow(); return; } // stdin 坏 → infra fail-open
  const tp = inp && inp.transcript_path;
  if (!tp || typeof tp !== 'string') { allow(); return; }

  let det;
  try { det = detectSentinel(tp); } catch { allow(); return; } // 读不到 transcript / 非普通文件 → infra fail-open
  if (det.action === 'allow') { allow(); return; } // 非"最后一行整行哨兵"(含散文引用/代码块示例/无哨兵)→ 放行(全局快路径)
  if (det.action === 'block') { block(det.reason); return; } // 超大截断且含哨兵 → 保守 block
  const manifestPath = det.manifestPath;

  // 有哨兵:独立重放审计。manifest/证据问题 → block(可疑);hook 跑不起来(import 失败)→ infra fail-open。
  let loadRounds, auditRounds, readBoundedFile;
  try { ({ loadRounds, auditRounds, readBoundedFile } = await import(join(dirname(fileURLToPath(import.meta.url)), 'review-audit.mjs'))); }
  catch { allow(); return; } // import 失败 = infra → fail-open

  let manifest;
  try { manifest = JSON.parse(readBoundedFile(manifestPath, MANIFEST_CAP, 'manifest').toString('utf8')); } // 有界安全读(普通文件+上限,修 I1)
  catch (e) { block(`检测到 CCR-RESOLVED 哨兵,但读不到/解析不了其 manifest(${manifestPath}):${e.message}。请修正后重跑审计,或把结论改为 UNRESOLVED 并撤下哨兵。`); return; }
  if (manifest.kind !== MANIFEST_KIND) { block(`manifest.kind 须为 "${MANIFEST_KIND}"(哨兵指向的不是本工具的审计 manifest;证据无效)。请重跑审计或撤下哨兵。`); return; }
  if (typeof manifest.claudeAgree !== 'boolean') { block('manifest.claudeAgree 缺失或非布尔(证据无效)。请重跑审计或撤下哨兵。'); return; }

  let rounds;
  try { rounds = loadRounds(manifest); }
  catch (e) { block(`审计证据无效:${e.message}。请修正后重跑,或撤下哨兵改 UNRESOLVED。`); return; }

  const res = auditRounds(rounds, manifest.claudeAgree);
  if (res && res.audited_converged === true) { allow(); return; } // 独立重审通过 → 放行 RESOLVED
  block(`独立重审未通过(audited_converged=false):${(res && (res.reasons || res.failures) || []).join('; ') || '未知'}。宣布 RESOLVED 须有通过的 review-audit 证据;请修正后重跑,或把结论改为 UNRESOLVED 并撤下哨兵。`);
}

main().catch(() => { allow(); }); // 任何未预期异常 = infra → fail-open(不卡死全局回合)
