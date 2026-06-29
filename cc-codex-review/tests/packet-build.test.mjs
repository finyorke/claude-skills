import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPacket, lensInjection, focusLensText, DUTY_BLOCK, LENSES } from '../scripts/packet-build.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'packet-build.mjs');
const cli = (obj) => execFileSync('node', [SCRIPT], { input: JSON.stringify(obj), encoding: 'utf8' });

// ---- DUTY_BLOCK 逐字送达(核心动机:防 v0.12.3 那种职责段被压缩丢失)----
test('buildPacket 含完整 DUTY_BLOCK 逐字(职责正文 + 全部 schema 字段要求)', () => {
  const p = buildPacket({ taskGoal: 'g', claudeClaim: 'c' });
  assert.ok(p.includes(DUTY_BLOCK), 'DUTY_BLOCK 必须逐字出现');
  // 关键字段要求都在
  for (const kw of ['verdict / remaining_issues / candidate_dispositions', 'candidate_dispositions', 'truncated', 'reviewed_scope', 'assumptions', '范围 gate']) assert.ok(p.includes(kw), `缺关键要求: ${kw}`);
});

test('buildPacket: confirmed-echo 措辞已更新为 v0.12.5 语义(无害 echo、记账以 disposition 为准)', () => {
  assert.ok(DUTY_BLOCK.includes('当无害 echo 忽略'));
  assert.ok(!DUTY_BLOCK.includes('被记账校验判为冲突'), '旧的"会判为冲突"措辞应已移除');
});

test('buildPacket: 四个变量段标题齐全、按序', () => {
  const p = buildPacket({ taskGoal: 'TG', materials: 'MAT', codeContext: 'CTX', claudeClaim: 'CLM' });
  for (const h of ['## 任务目标', '## 待审材料', '## 代码上下文', '## Claude 当前主张', '## 你的职责']) assert.ok(p.includes(h));
  assert.ok(p.indexOf('## 任务目标') < p.indexOf('## 你的职责'));
  for (const v of ['TG', 'MAT', 'CTX', 'CLM']) assert.ok(p.includes(v));
});

test('buildPacket: 变量段缺省给占位、不静默空', () => {
  const p = buildPacket({});
  assert.ok(p.includes('未提供'));
  assert.ok(p.includes('见下方代码上下文')); // 待审材料缺省
  assert.ok(p.includes('无')); // 代码上下文缺省
});

// ---- 镜头注入 ----
test('lensInjection: 空 lens → 空串(通用评审)', () => {
  assert.equal(lensInjection(null, {}), '');
  assert.equal(lensInjection('', {}), '');
});

test('lensInjection: omission 仅第 1 轮(round 缺省视为 1)', () => {
  assert.ok(lensInjection('omission', { round: 1 }).includes('首轮遗漏检查'));
  assert.ok(lensInjection('omission', {}).includes('首轮遗漏检查'));
  assert.equal(lensInjection('omission', { round: 2 }), '', '第 2 轮起不再注入 omission');
});

test('LENS-MODE: focus 镜头不经 lens 自动生成(抛 bad_lens_focus,逼调用方按 §4.5 过滤后用 lensText)', () => {
  assert.throws(() => lensInjection('security', { round: 3 }), /bad_lens_focus/);
  assert.throws(() => buildPacket({ taskGoal: 'g', lens: 'correctness' }), /bad_lens_focus/);
});

test('focusLensText: 供调用方取焦点块原文(未过滤)+ 只含所选那一条', () => {
  const sec = focusLensText('security');
  assert.ok(sec.includes('## 焦点镜头:security') && sec.includes('攻击面'));
  assert.ok(!sec.includes('逻辑正确性'), '不应混入 correctness 描述');
  assert.ok(focusLensText('correctness').includes('逻辑正确性'));
});

test('lensText: 调用方组好的焦点块(经材料过滤)逐字放置在职责段之后,优先于 lens', () => {
  const filtered = '## 焦点镜头:security\n· 仅保留对提案成立的项(已剔除并发/反序列化等代码专属项)。';
  const p = buildPacket({ taskGoal: 'g', lensText: filtered });
  assert.ok(p.includes(filtered));
  assert.ok(p.indexOf('## 你的职责') < p.indexOf(filtered));
});

test('lensInjection / buildPacket: 未知 lens → 抛 bad_lens', () => {
  assert.throws(() => lensInjection('bogus', {}), /bad_lens/);
  assert.throws(() => buildPacket({ taskGoal: 'g', lens: 'bogus' }), /bad_lens/);
});

test('buildPacket: 套 omission 镜头时注入在职责段之后', () => {
  const p = buildPacket({ taskGoal: 'g', lens: 'omission', round: 1 });
  assert.ok(p.includes('首轮遗漏检查'));
  assert.ok(p.indexOf('## 你的职责') < p.indexOf('首轮遗漏检查'));
});

// ---- CLI ----
test('CLI: stdin JSON → stdout packet 文本(含 DUTY_BLOCK + lensText 逐字)', () => {
  const out = cli({ taskGoal: 'CLI目标', claudeClaim: 'CLI主张', lensText: '## 焦点镜头:security\n· 过滤后焦点' });
  assert.ok(out.includes('CLI目标'));
  assert.ok(out.includes('## 你的职责'));
  assert.ok(out.includes('## 焦点镜头:security'));
});

test('CLI: lens=omission 由脚本生成', () => {
  const out = cli({ taskGoal: 'g', lens: 'omission', round: 1 });
  assert.ok(out.includes('首轮遗漏检查'));
});

test('CLI: 坏 JSON → bad_json 非零退出', () => {
  assert.throws(() => execFileSync('node', [SCRIPT], { input: '{not json', encoding: 'utf8' }), (e) => {
    assert.ok(String(e.stdout || '').includes('bad_json')); return true;
  });
});

test('LENSES 导出与文档一致', () => {
  assert.deepEqual(LENSES, ['omission', 'security', 'correctness', 'requirements']);
});
