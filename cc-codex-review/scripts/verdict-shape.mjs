// verdict-shape.mjs — verdict 结构形状校验(共享:codex-round 产出门 + review-audit 重放门复用,避免两套逻辑漂移)。
// 对应 schemas/verdict.schema.json(strict、additionalProperties:false、required 覆盖全部字段)。
export const SEV = new Set(['blocker', 'major', 'minor']);
export const V_KEYS = ['verdict', 'remaining_issues', 'candidate_dispositions', 'rationale', 'truncated', 'reviewed_scope', 'assumptions'];
export const ISSUE_KEYS = ['id', 'title', 'detail', 'severity'];
export const DISP_KEYS = ['id', 'disposition'];

// 精确键集:对应 schema 的 additionalProperties:false——不多不少(RS-P0-EXTRA)。
export function exactKeys(o, keys) {
  if (!o || typeof o !== 'object') return false;
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(o, x));
}

export function isValidVerdict(v) {
  if (!exactKeys(v, V_KEYS)) return false;
  if (v.verdict !== 'AGREE' && v.verdict !== 'CHANGES') return false;
  if (typeof v.rationale !== 'string' || typeof v.reviewed_scope !== 'string' || typeof v.truncated !== 'boolean') return false;
  if (!Array.isArray(v.assumptions) || !v.assumptions.every((x) => typeof x === 'string')) return false;
  if (!Array.isArray(v.remaining_issues) || !v.remaining_issues.every((it) =>
    exactKeys(it, ISSUE_KEYS) && typeof it.id === 'string' && typeof it.title === 'string' && typeof it.detail === 'string' && SEV.has(it.severity))) return false;
  if (!Array.isArray(v.candidate_dispositions) || !v.candidate_dispositions.every((d) =>
    exactKeys(d, DISP_KEYS) && typeof d.id === 'string' && (d.disposition === 'confirmed' || d.disposition === 'rejected'))) return false;
  return true;
}
