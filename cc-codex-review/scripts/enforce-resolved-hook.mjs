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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 框定哨兵识别(修 I1,降误拦):只认**剥除代码块后、最后一行整行**就是哨兵的情形——
// 真 §7 结论以独占一行的哨兵收尾;散文里引用/代码块里的示例(开发讨论常见)不会成为最后一行整行,故不触发。
const SENTINEL_LINE = /^<<CCR-RESOLVED\s+manifest="([^"]+)">>$/;
const MANIFEST_KIND = 'cc-codex-review-audit-manifest';
function stripFences(text) { return String(text || '').replace(/```[\s\S]*?```/g, ''); }
function finalLineManifest(text) {
  const lines = stripFences(text).split('\n').map((l) => l.trim()).filter((l) => l.length);
  if (!lines.length) return null;
  const m = SENTINEL_LINE.exec(lines[lines.length - 1]);
  return m ? m[1] : null;
}

function out(obj) { if (obj) process.stdout.write(JSON.stringify(obj) + '\n'); }
function allow() { out({}); process.exit(0); }
function block(reason) { out({ decision: 'block', reason: `[cc-codex-review 硬门禁] ${reason}` }); process.exit(2); }

// 从 transcript jsonl 取最后一条 assistant 消息的纯文本(只看当前回合的结论,避免旧哨兵在后续回合误拦)。
function lastAssistantText(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const m = o.message || o;
    const role = m.role || o.type;
    if (role !== 'assistant') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n');
    return '';
  }
  return '';
}


async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let inp; try { inp = JSON.parse(raw); } catch { allow(); return; } // stdin 坏 → infra fail-open
  const tp = inp && inp.transcript_path;
  if (!tp || typeof tp !== 'string') { allow(); return; }

  let text;
  try { text = lastAssistantText(tp); } catch { allow(); return; } // 读不到 transcript → infra fail-open
  const manifestPath = finalLineManifest(text || '');
  if (!manifestPath) { allow(); return; } // 非"最后一行整行哨兵" → 非受控回合(含散文引用/代码块示例),放行(全局快路径)

  // 有哨兵:独立重放审计。manifest/证据问题 → block(可疑);hook 跑不起来(import 失败)→ infra fail-open。
  let loadRounds, auditRounds;
  try { ({ loadRounds, auditRounds } = await import(join(dirname(fileURLToPath(import.meta.url)), 'review-audit.mjs'))); }
  catch { allow(); return; } // import 失败 = infra → fail-open

  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
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
