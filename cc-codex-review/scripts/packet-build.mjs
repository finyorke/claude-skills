#!/usr/bin/env node
// packet-build.mjs — 确定性拼装评审包 packet.txt 的**固定段**(尤其「你的职责」+ schema 字段要求 + 镜头注入),
// 保证这些关键指令**逐字送达 Codex**,不靠执行 Claude 复述/压缩。
//
// 动机(DESIGN §12,v0.12.5):真机 dogfood 发现执行 Claude 组 packet 时会把 §4「你的职责」散文压缩,
// 导致 v0.12.3 加的指令根本没进 packet。把固定段抽成脚本权威生成 → 变量段(任务目标/待审材料/
// 代码上下文/Claude 主张)由调用方填,固定段由本脚本保证不漂移、不丢字。
//
// 纯函数(无 IO)+ 薄 CLI(stdin JSON → stdout packet 文本),沿用本项目脚本风格。
// 镜头注入:omission 仅第 1 轮、focus(security/correctness/requirements)每轮;
//   **LENS-MODE 材料模式过滤是判断型规则,仍由 prompt 负责**——调用方若判定镜头与材料不符,自行传 lens:null。
import { pathToFileURL } from 'node:url';

export const LENSES = ['omission', 'security', 'correctness', 'requirements'];

// 「你的职责」固定段(逐字对应 review.md §4;本脚本为权威来源,改这里 = 改送给 Codex 的职责)。
export const DUTY_BLOCK = `## 你的职责
你是对抗式复核方。请**对照「任务目标」复核「待审材料 / 代码上下文」这份工作本身**,
并评估上面「Claude 当前主张」是否成立——Claude 的主张只是一个输入,不要默认它对。
有任何实质疑虑就给 verdict=CHANGES;不要为了收敛而同意。
优先质疑(按本次评审模式选取,见顶部「适用模式与边界」):实现路径、设计取舍、假设是否成立、需求是否完整覆盖、有无潜藏 bug、边界用例、论点/证据是否充分。
按提供的 JSON Schema 输出全部字段:verdict / remaining_issues / candidate_dispositions / rationale / truncated / reviewed_scope / assumptions。
- \`remaining_issues[].id\`:每条 issue 一个**稳定短 id**(如 \`I1\`/\`I2\`)。**新** issue 自取一个本次评审内唯一的 id;若是续审/重提**增量里已带 id 的点**(见下),**复用原 id**,不要换新。
- \`candidate_dispositions\`:针对**增量里 Claude 列出的每个 candidate(按其 id)**给出裁定 \`{id, disposition}\`,\`disposition ∈ {confirmed(认可该修订、不再质疑), rejected(仍不接受)}\`。**首轮无 candidate 时输出空数组 \`[]\`**;不得引用未在增量中出现的 id;每个被列出的 candidate 都要给一条(不可遗漏)。\`rejected\` 的点须同时在 \`remaining_issues\` 里(用同一 id)给出仍存在的理由;\`confirmed\` 的点表示已了结,**通常不必再列进 \`remaining_issues\`**(它是"仍未解决"清单、非回执清单;但若你仍回显已确认项也无妨——记账以 disposition 为准,confirmed 的回显会被当无害 echo 忽略)。
- \`truncated\`:若你只看到了材料/改动的一部分(被摘要、截断、或仅 diff 片段),置 true。
- \`reviewed_scope\`:一句话说明你实际审了什么范围(如「仅 packet 内摘要,未读全量 diff」)。
- \`assumptions\`:你为得出结论而做的假设(如「假设测试通过」)。
- **范围 gate**:若 \`truncated=true\` 且被省略的部分对结论是必要证据,**不得给 AGREE**,应给 CHANGES 并说明需要补哪些证据。仅当你确无实质异议、且范围足以支撑结论时才给 AGREE。`;

const OMISSION_BLOCK = `## 额外:首轮遗漏检查(本轮一次性)
在常规复核之外,对照「任务目标」与「待审材料/代码上下文」做一次**遗漏检查**:列出当前主张或材料中
**应被覆盖却缺失/未触及**的点(如未处理的输入域、未声明的前置条件、目标里要求却没落实的项)。
**硬约束**:① 只基于**当前已在场的证据与目标**判断遗漏,**不要预判投机性的二阶/连锁问题**;
② **不要输出任何 completeness 自评分或百分比**;③ 发现的遗漏照常并入 \`remaining_issues\`(各带稳定 id)。`;

const FOCUS_DESC = {
  security: '· security:攻击面、输入信任与校验、鉴权/越权、机密泄露、注入/反序列化、不安全的文件/进程/网络操作。',
  correctness: '· correctness:逻辑正确性、边界/极端用例、错误与异常处理、并发/竞态、状态不变量。',
  requirements: '· requirements:是否覆盖「任务目标」/规格、缺失或不可验证的需求、未声明的依赖与前置。',
};
function focusBlock(lens) {
  return `## 焦点镜头:${lens}
本次评审请**优先**从「${lens}」视角审查,但**不得降低其它 rubric 的覆盖标准**(仍执行完整通用评审,只是额外侧重该视角;故 AGREE 仍是全面签核):
${FOCUS_DESC[lens]}
仍按 JSON Schema 输出全部字段;发现并入 \`remaining_issues\`(各带稳定 id)。`;
}

// 镜头注入文本。
// **边界(LENS-MODE,§4.5):focus 镜头的「材料模式过滤」是判断型规则,脚本不做。**
//   - lens=null → '';
//   - lens='omission' → 通用遗漏检查块(无材料过滤),仅第 1 轮(round 缺省视为第 1 轮);
//   - lens∈focus(security/correctness/requirements) → **抛 bad_lens_focus**:调用方须按 §4.5 过滤后用 lensText 传入,
//     不能让脚本输出未过滤的代码向 focus 文本(会对提案/文字材料不忠实)。
//   - 调用方可经 buildPacket 的 lensText 传任意已组好的焦点块(脚本逐字放置,不解读)。
export const FOCUS_LENSES = ['security', 'correctness', 'requirements'];
export function lensInjection(lens, { round } = {}) {
  if (!lens) return '';
  if (lens === 'omission') return (round == null || round === 1) ? OMISSION_BLOCK : '';
  if (FOCUS_LENSES.includes(lens)) throw new Error(`bad_lens_focus: ${lens} 含材料模式过滤判断,请按 §4.5 过滤后用 lensText 传入,不经 lens 自动生成`);
  throw new Error(`bad_lens: ${lens}`);
}
// 供调用方组 focus 焦点块的辅助(调用方负责按材料过滤后再用 lensText 传入)。
export function focusLensText(lens) {
  if (!FOCUS_LENSES.includes(lens)) throw new Error(`bad_lens: ${lens}`);
  return focusBlock(lens);
}

// 拼装完整 packet(固定段权威生成,变量段由调用方填)。
// lensText:可选,调用方已组好的焦点块全文(逐字放置,优先于 lens);用于 focus 镜头(经材料过滤)。
export function buildPacket({ taskGoal, materials, codeContext, claudeClaim, lens, round, lensText } = {}) {
  const inj = (lensText != null && String(lensText).trim()) ? String(lensText).trim() : lensInjection(lens || null, { round });
  const parts = [
    '## 任务目标', (taskGoal || '').trim() || '(未提供——调用方须给目标或文件引用)',
    '', '## 待审材料', (materials || '').trim() || '见下方代码上下文',
    '', '## 代码上下文', (codeContext || '').trim() || '无',
    '', '## Claude 当前主张', (claudeClaim || '').trim() || '(未提供)',
    '', DUTY_BLOCK,
  ];
  if (inj) { parts.push('', inj); }
  return parts.join('\n') + '\n';
}

// ---- 薄 CLI(IO 层)----
function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const emit = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o) + '\n');
  const raw = await readStdin();
  let inp;
  try { inp = raw.trim() ? JSON.parse(raw) : {}; }
  catch (e) { emit({ ok: false, error: 'bad_json', detail: String(e.message || e) }); process.exit(2); }
  try { process.stdout.write(buildPacket(inp)); }
  catch (e) { emit({ ok: false, error: 'bad_input', detail: String(e.message || e) }); process.exit(2); }
}
