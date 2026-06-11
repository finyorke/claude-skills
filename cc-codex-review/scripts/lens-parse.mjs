#!/usr/bin/env node
// lens-parse.mjs — `--lens <name>` 解析与归一化(P4 scope-down,见 DESIGN §12 / review.md §1)。
//
// 把镜头解析中**确定性**的部分从 review.md 散文规格抽成可单测的纯函数:
//   flag→effective_lens、`--omission-check` 别名归一、未知名/冲突/缺名/重复 报错。
// **判断型**部分仍由 prompt 负责(不在此脚本):⑲ 每轮重述焦点镜头头、⑳ 材料模式过滤、
//   ㉑/LENS-DECLARE 声明义务(隐性侧重也须 §7 声明)——这些需语义判断。
// 补 #11 验收暴露的短板:lens 曾是本项目唯一未脚本化+无单测的关键逻辑。
import { pathToFileURL } from 'node:url';

export const LENS_PRESETS = ['omission', 'security', 'correctness', 'requirements'];
const PRESET_SET = new Set(LENS_PRESETS);

// 纯函数:扫描 argv 里的 `--lens <name>` 与 `--omission-check`,归一为单一 effective_lens 或返回错误。
// 返回 { ok:true, effective_lens: string|null } 或 { ok:false, error:<code>, detail:<msg> }。
// 规则(见 review.md §1):
//   - 无 --lens 且无 --omission-check → effective_lens=null(通用评审,⑯)
//   - --omission-check ≡ --lens omission(向后兼容别名,⑰)
//   - 缺 name(--lens 后无值 / 紧跟另一个 `-` 开头的 flag)→ lens_missing_name(⑱)
//   - 重复 --lens(出现 >1 次)→ lens_duplicate(单次单镜头,⑱)
//   - 未知 name(不在预设)→ lens_unknown(⑱)
//   - --lens 与 --omission-check 同时出现且不一致(--lens 值≠omission)→ lens_conflict(⑱)
//     (一致即 --lens omission + --omission-check → 不报错,归一 omission)
export function parseLens(argv) {
  if (!Array.isArray(argv)) return { ok: false, error: 'bad_input', detail: 'argv 须为字符串数组' };
  const lensValues = [];
  let missingName = false;
  let hasOmissionCheck = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--lens') {
      const next = argv[i + 1];
      // --lens 后无值,或紧跟另一个 flag(预设镜头名都是字母、不以 `-` 开头)→ 缺 name
      if (typeof next !== 'string' || next.startsWith('-')) missingName = true;
      else { lensValues.push(next); i++; }
    } else if (tok === '--omission-check') {
      hasOmissionCheck = true;
    }
  }
  // 校验顺序:缺名 → 重复 → 未知 → 冲突
  if (missingName) return { ok: false, error: 'lens_missing_name', detail: '--lens 缺 name(后须紧跟预设镜头名)' };
  if (lensValues.length > 1) return { ok: false, error: 'lens_duplicate', detail: `--lens 出现多次(单次单镜头):${lensValues.join(', ')}` };
  const lensVal = lensValues[0]; // string | undefined
  if (lensVal !== undefined && !PRESET_SET.has(lensVal))
    return { ok: false, error: 'lens_unknown', detail: `未知 lens name '${lensVal}'(预设:${LENS_PRESETS.join('/')})` };
  if (lensVal !== undefined && hasOmissionCheck && lensVal !== 'omission')
    return { ok: false, error: 'lens_conflict', detail: `--lens ${lensVal} 与 --omission-check(≡omission)冲突且不一致` };
  const effective_lens = lensVal ?? (hasOmissionCheck ? 'omission' : null);
  return { ok: true, effective_lens };
}

// 薄 CLI:stdin JSON {argv:[...]} → stdout JSON(与 review-state/metrics/experiment 一致)。
// ok:false 时 exit 2(参数错误),但 JSON 仍打到 stdout 供调用方读取。
function readStdin() { return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => res(d)); }); }
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const raw = await readStdin();
  let inp;
  try { inp = raw.trim() ? JSON.parse(raw) : {}; }
  catch { process.stdout.write(JSON.stringify({ ok: false, error: 'bad_json', detail: 'stdin 非合法 JSON' }) + '\n'); process.exit(2); }
  // fail-closed(LP-CLI-INPUT):缺失/非数组 argv 交由 parseLens 返回 bad_input,
  // 不用 `|| []` 吞成"无镜头"。区分:{argv:[]} 显式空=合法无镜头;{} 或 {argv:null}=调用方违约→bad_input。
  const out = parseLens(inp.argv);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (!out.ok) process.exit(2);
}
