# cc-codex-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个 Claude Code 插件 `cc-codex-review`,提供 `/cc-codex-review:review` 命令,让 Claude 与 Codex 围绕某项工作循环互审直到双方 AGREE。

**Architecture:** 智能部分(形成主张、修订、判断收敛)写在命令 prompt(`commands/review.md`)里由 Claude 驱动;确定性部分(调用 `codex exec`、按 `thread_id` resume、解析结构化 verdict、错误/重试)封装进一个可单测的 Node 辅助脚本 `scripts/codex-round.mjs`,每轮调用一次。脚本用 `node:test` + 一个假 codex(`tests/fixtures/mock-codex.mjs`)做 hermetic 测试,不触真实 codex/网络。

**Tech Stack:** Node.js (≥18, 实测 v22) 内置模块(`node:child_process`、`node:fs`、`node:test`),无第三方依赖;Codex CLI (`codex exec` / `resume`);Claude Code 插件(command + plugin.json + marketplace.json)。

详见同目录 `DESIGN.md`。

---

## File Structure

```
cc-codex-review/
  .claude-plugin/plugin.json          # 插件清单
  commands/review.md                  # 命令体 = Claude 执行的互审协议(prompt)
  scripts/codex-round.mjs             # 单轮 Codex 调用原语(可单测)
  schemas/verdict.schema.json         # Codex 结构化 verdict 的 JSON Schema
  tests/codex-round.test.mjs          # codex-round.mjs 的单元测试
  tests/fixtures/mock-codex.mjs       # 假 codex,供测试注入(CODEX_BIN)
  DESIGN.md                           # 设计文档(已存在)
  PLAN.md                             # 本计划(已存在)
(仓库根)/.claude-plugin/marketplace.json   # 修改:plugins 数组追加 cc-codex-review 条目
```

职责边界:
- `codex-round.mjs`:**纯确定性**。输入 = stdin(评审包)+ flags;输出 = 一行 JSON `{ok, thread_id, verdict, remaining_issues, rationale, error?}`。不含循环、不含"判断收敛"。
- `review.md`:**编排**。解析参数、收集材料、形成/修订主张、循环调用 `codex-round.mjs`、停滞检测、双 AGREE 闸门、输出。Claude 是解释器。
- `mock-codex.mjs`:仅测试用,按环境变量产出可控的 `--json` 流与 verdict 文件。

---

## Task 1: 脚手架 — plugin.json、verdict schema、注册到 marketplace

**Files:**
- Create: `cc-codex-review/.claude-plugin/plugin.json`
- Create: `cc-codex-review/schemas/verdict.schema.json`
- Modify: `.claude-plugin/marketplace.json`(仓库根)

- [ ] **Step 1: 创建 `cc-codex-review/.claude-plugin/plugin.json`**

```json
{
  "name": "cc-codex-review",
  "version": "0.1.0",
  "description": "Claude × Codex 收敛互审 — 两方迭代复核直到双方 AGREE",
  "author": {
    "name": "finyorke"
  }
}
```

- [ ] **Step 2: 创建 `cc-codex-review/schemas/verdict.schema.json`**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "rationale"],
  "properties": {
    "verdict": { "type": "string", "enum": ["AGREE", "CHANGES"] },
    "remaining_issues": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "detail"],
        "properties": {
          "title": { "type": "string" },
          "detail": { "type": "string" },
          "severity": { "type": "string", "enum": ["blocker", "major", "minor"] }
        }
      }
    },
    "rationale": { "type": "string" }
  }
}
```

- [ ] **Step 3: 修改仓库根 `.claude-plugin/marketplace.json`,在 `plugins` 数组追加一条**

将原内容:

```json
{
  "name": "fun-plugins",
  "owner": { "name": "finyorke" },
  "plugins": [
    {
      "name": "codex-image-gen",
      "source": "./codex-image-gen",
      "description": "用 codex CLI 生成图片 - 支持中英文触发词"
    }
  ]
}
```

改为(新增第二个元素):

```json
{
  "name": "fun-plugins",
  "owner": { "name": "finyorke" },
  "plugins": [
    {
      "name": "codex-image-gen",
      "source": "./codex-image-gen",
      "description": "用 codex CLI 生成图片 - 支持中英文触发词"
    },
    {
      "name": "cc-codex-review",
      "source": "./cc-codex-review",
      "description": "Claude × Codex 收敛互审 — 两方迭代复核直到双方 AGREE"
    }
  ]
}
```

- [ ] **Step 4: 校验三个 JSON 均合法**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && \
node -e "for (const f of ['.claude-plugin/marketplace.json','cc-codex-review/.claude-plugin/plugin.json','cc-codex-review/schemas/verdict.schema.json']) { JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('OK', f); }"
```
Expected: 三行 `OK <path>`,无异常。

- [ ] **Step 5: Commit**

```bash
cd /Users/fun/D/Projects/claude-skills && \
git add cc-codex-review/.claude-plugin/plugin.json cc-codex-review/schemas/verdict.schema.json .claude-plugin/marketplace.json && \
git commit -m "feat(cc-codex-review): scaffold plugin manifest, verdict schema, marketplace entry"
```

---

## Task 2: `codex-round.mjs` — fresh 轮 happy path(TDD)

**Files:**
- Create: `cc-codex-review/tests/fixtures/mock-codex.mjs`
- Create: `cc-codex-review/tests/codex-round.test.mjs`
- Create: `cc-codex-review/scripts/codex-round.mjs`

- [ ] **Step 1: 创建假 codex `cc-codex-review/tests/fixtures/mock-codex.mjs`(完整,后续任务复用)**

```javascript
#!/usr/bin/env node
// 假 codex,供 codex-round 单测注入(CODEX_BIN)。行为由环境变量控制。
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);

// 记录收到的 argv(测试断言 resume / flags 用)
if (process.env.MOCK_ARGV_LOG) {
  appendFileSync(process.env.MOCK_ARGV_LOG, JSON.stringify(argv) + '\n');
}

// 模拟 codex 缺失/未登录
if (process.env.MOCK_FAIL === 'auth') {
  process.stderr.write('stream error: Not logged in. Run `codex login` to authenticate.\n');
  process.exit(1);
}

function flagVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

const outFile = flagVal('-o');
const threadId = process.env.MOCK_THREAD_ID || '019e0000-0000-7000-8000-000000000001';

// 默认 verdict;可被 MOCK_VERDICT 覆盖
let msg = process.env.MOCK_VERDICT
  || JSON.stringify({ verdict: 'AGREE', remaining_issues: [], rationale: 'looks good' });

// 第一次写非法、第二次写合法(测重试)
if (process.env.MOCK_BAD_OUTPUT === '1') {
  const counterFile = process.env.MOCK_COUNTER || '/tmp/cc-codex-mock-counter';
  let n = 0;
  try { n = parseInt(readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
  writeFileSync(counterFile, String(n + 1));
  if (n === 0) msg = 'this-is-not-json';
}

// JSONL 事件流到 stdout(首行 thread.started 含 id)
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');

if (outFile) writeFileSync(outFile, msg);

process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: { id: 'item_0', type: 'agent_message', text: msg },
}) + '\n');

process.exit(0);
```

- [ ] **Step 2: 赋予 mock 可执行权限**

Run:
```bash
chmod +x /Users/fun/D/Projects/claude-skills/cc-codex-review/tests/fixtures/mock-codex.mjs
```
Expected: 无输出,退出码 0。

- [ ] **Step 3: 写失败测试 `cc-codex-review/tests/codex-round.test.mjs`(fresh happy path)**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUND = resolve(HERE, '../scripts/codex-round.mjs');
const MOCK = resolve(HERE, 'fixtures/mock-codex.mjs');
const SCHEMA = resolve(HERE, '../schemas/verdict.schema.json');

// 跑一轮 codex-round,注入 mock 作为 CODEX_BIN,返回解析后的结果 JSON
function runRound(extraArgs, input, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const stdout = execFileSync(
    'node',
    [ROUND, '--schema', SCHEMA, '--out', out, ...extraArgs],
    { input, encoding: 'utf8', env: { ...process.env, CODEX_BIN: MOCK, ...env } }
  );
  const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

test('fresh round: returns ok with thread_id and AGREE verdict', () => {
  const res = runRound([], 'PACKET BODY', {
    MOCK_THREAD_ID: '019e1111-aaaa-7000-8000-000000000abc',
    MOCK_VERDICT: JSON.stringify({ verdict: 'AGREE', remaining_issues: [], rationale: 'ok' }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.thread_id, '019e1111-aaaa-7000-8000-000000000abc');
  assert.equal(res.verdict, 'AGREE');
  assert.deepEqual(res.remaining_issues, []);
});

test('fresh round: no --repo => passes --skip-git-repo-check, never --last', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const argvLog = join(dir, 'argv.log');
  execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_ARGV_LOG: argvLog },
  });
  const argv = JSON.parse(readFileSync(argvLog, 'utf8').trim().split('\n')[0]);
  assert.ok(argv.includes('--skip-git-repo-check'), 'should skip git repo check when no --repo');
  assert.ok(argv.includes('exec'));
  assert.ok(!argv.includes('--last'), 'must never use --last');
});

test('fresh round: --repo => passes --cd <dir>, not --skip-git-repo-check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const argvLog = join(dir, 'argv.log');
  execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out, '--repo', '/some/repo'], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_ARGV_LOG: argvLog },
  });
  const argv = JSON.parse(readFileSync(argvLog, 'utf8').trim().split('\n')[0]);
  const i = argv.indexOf('--cd');
  assert.ok(i >= 0 && argv[i + 1] === '/some/repo', 'should pass --cd <repo>');
  assert.ok(!argv.includes('--skip-git-repo-check'));
});
```

- [ ] **Step 4: 运行测试,确认因脚本缺失而失败**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: FAIL —— 报 `codex-round.mjs` 不存在 / 无法 require(ENOENT 或 execFileSync 抛错)。

- [ ] **Step 5: 实现 `cc-codex-review/scripts/codex-round.mjs`(仅 fresh + repo flag,暂不含 resume/重试)**

```javascript
#!/usr/bin/env node
// 单轮 Codex 复核原语:stdin=评审包,stdout=一行结果 JSON。纯确定性,无循环。
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

function parseArgs(argv) {
  const a = { repo: null, model: null, resume: null, schema: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--repo') a.repo = argv[++i];
    else if (x === '--model') a.model = argv[++i];
    else if (x === '--resume') a.resume = argv[++i];
    else if (x === '--schema') a.schema = argv[++i];
    else if (x === '--out') a.out = argv[++i];
  }
  return a;
}

function buildCodexArgs(a) {
  const args = ['exec'];
  // NOTE: resume 分支在 Task 3 加入
  args.push('--json', '-s', 'read-only', '--output-schema', a.schema, '-o', a.out);
  if (a.repo) args.push('--cd', a.repo);
  else args.push('--skip-git-repo-check');
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

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.schema || !a.out) {
    emit({ ok: false, error: 'usage', detail: '--schema and --out are required' });
    process.exit(2);
  }
  const bin = process.env.CODEX_BIN || 'codex';
  const input = readFileSync(0, 'utf8'); // stdin 评审包

  const res = spawnSync(bin, buildCodexArgs(a), {
    input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });

  const threadId = extractThreadId(res.stdout);

  let verdict = null, rawMsg = '';
  if (existsSync(a.out)) {
    rawMsg = readFileSync(a.out, 'utf8').trim();
    try { verdict = JSON.parse(rawMsg); } catch { verdict = null; }
  }

  if (!verdict || (verdict.verdict !== 'AGREE' && verdict.verdict !== 'CHANGES')) {
    emit({ ok: false, error: 'bad_verdict', thread_id: threadId, raw_message: rawMsg });
    process.exit(0);
  }

  emit({
    ok: true,
    thread_id: threadId,
    verdict: verdict.verdict,
    remaining_issues: verdict.remaining_issues || [],
    rationale: verdict.rationale || '',
  });
}

main();
```

- [ ] **Step 6: 运行测试,确认通过**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: PASS —— 3 个 fresh 相关 test 全绿。

- [ ] **Step 7: Commit**

```bash
cd /Users/fun/D/Projects/claude-skills && \
git add cc-codex-review/scripts/codex-round.mjs cc-codex-review/tests/ && \
git commit -m "feat(cc-codex-review): codex-round fresh round (thread_id capture + verdict parse)"
```

---

## Task 3: resume by id(TDD)

**Files:**
- Modify: `cc-codex-review/tests/codex-round.test.mjs`(追加测试)
- Modify: `cc-codex-review/scripts/codex-round.mjs:buildCodexArgs`

- [ ] **Step 1: 追加失败测试(在 test 文件末尾)**

```javascript
test('resume round: passes `exec resume <id>` and never --last', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const argvLog = join(dir, 'argv.log');
  const TID = '019e2222-bbbb-7000-8000-0000000def01';
  execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out, '--resume', TID], {
    input: 'DELTA', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: MOCK, MOCK_ARGV_LOG: argvLog },
  });
  const argv = JSON.parse(readFileSync(argvLog, 'utf8').trim().split('\n')[0]);
  const i = argv.indexOf('resume');
  assert.ok(i >= 0, 'should call exec resume');
  assert.equal(argv[0], 'exec');
  assert.equal(argv[i + 1], TID, 'resume must be followed by the captured thread id');
  assert.ok(!argv.includes('--last'), 'must never use --last');
});
```

- [ ] **Step 2: 运行,确认新测试失败**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: 新增 `resume round` test FAIL(当前 `buildCodexArgs` 没有 resume 分支)。

- [ ] **Step 3: 修改 `buildCodexArgs` 加入 resume 分支**

将:
```javascript
function buildCodexArgs(a) {
  const args = ['exec'];
  // NOTE: resume 分支在 Task 3 加入
  args.push('--json', '-s', 'read-only', '--output-schema', a.schema, '-o', a.out);
```
改为:
```javascript
function buildCodexArgs(a) {
  const args = ['exec'];
  if (a.resume) args.push('resume', a.resume);
  args.push('--json', '-s', 'read-only', '--output-schema', a.schema, '-o', a.out);
```

- [ ] **Step 4: 运行,确认全绿**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: PASS —— 含 resume 在内全部通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/fun/D/Projects/claude-skills && \
git add cc-codex-review/scripts/codex-round.mjs cc-codex-review/tests/codex-round.test.mjs && \
git commit -m "feat(cc-codex-review): resume by captured thread_id (never --last)"
```

---

## Task 4: codex 不可用错误处理(TDD)

**Files:**
- Modify: `cc-codex-review/tests/codex-round.test.mjs`
- Modify: `cc-codex-review/scripts/codex-round.mjs`

- [ ] **Step 1: 追加失败测试**

```javascript
test('codex unavailable (auth fail): ok=false, error=codex_unavailable', () => {
  const res = runRound([], 'PACKET', { MOCK_FAIL: 'auth' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'codex_unavailable');
});

test('codex binary missing (ENOENT): ok=false, error=codex_unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-round-'));
  const out = join(dir, 'last.json');
  const stdout = execFileSync('node', [ROUND, '--schema', SCHEMA, '--out', out], {
    input: 'PACKET', encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: '/nonexistent/codex-binary-xyz' },
  });
  const res = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'codex_unavailable');
});
```

- [ ] **Step 2: 运行,确认失败**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: 两个新 test FAIL(当前会落到 `bad_verdict` 或抛错而非 `codex_unavailable`)。

- [ ] **Step 3: 在 `main()` 里加入不可用检测(spawn 之后、解析之前)**

在 `const res = spawnSync(...)` 之后,紧接着插入:
```javascript
  // codex 缺失或未登录 → 提示用户 /codex:setup
  const errText = (res.stderr || '') + (res.error ? String(res.error.message || res.error) : '');
  const unavailable =
    (res.error && res.error.code === 'ENOENT') ||
    res.status === 127 ||
    /not logged in|not authenticated|please run .*login|unauthor/i.test(errText);
  if (unavailable) {
    emit({ ok: false, error: 'codex_unavailable', detail: errText.trim() || 'codex not found or not authenticated' });
    process.exit(0);
  }
```

- [ ] **Step 4: 运行,确认全绿**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /Users/fun/D/Projects/claude-skills && \
git add cc-codex-review/scripts/codex-round.mjs cc-codex-review/tests/codex-round.test.mjs && \
git commit -m "feat(cc-codex-review): detect codex unavailable/unauthenticated"
```

---

## Task 5: verdict 解析失败 → 重试一次(TDD)

**Files:**
- Modify: `cc-codex-review/tests/codex-round.test.mjs`
- Modify: `cc-codex-review/scripts/codex-round.mjs`

- [ ] **Step 1: 追加失败测试(第一次非法 JSON、第二次合法 → 最终 ok)**

```javascript
test('bad verdict then good: retries once and succeeds', () => {
  const counter = join(mkdtempSync(join(tmpdir(), 'cc-round-')), 'counter');
  const res = runRound([], 'PACKET', {
    MOCK_BAD_OUTPUT: '1',
    MOCK_COUNTER: counter,
    MOCK_VERDICT: JSON.stringify({ verdict: 'CHANGES', remaining_issues: [{ title: 't', detail: 'd' }], rationale: 'r' }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'CHANGES');
  assert.equal(res.remaining_issues.length, 1);
});
```

- [ ] **Step 2: 运行,确认失败**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: `bad verdict then good` FAIL(当前无重试,首次非法即返回 `bad_verdict`)。

- [ ] **Step 3: 把 main() 中"单次解析"改为"最多两次"循环**

将:
```javascript
  const res = spawnSync(bin, buildCodexArgs(a), {
    input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });

  // codex 缺失或未登录 → 提示用户 /codex:setup
  const errText = (res.stderr || '') + (res.error ? String(res.error.message || res.error) : '');
  const unavailable =
    (res.error && res.error.code === 'ENOENT') ||
    res.status === 127 ||
    /not logged in|not authenticated|please run .*login|unauthor/i.test(errText);
  if (unavailable) {
    emit({ ok: false, error: 'codex_unavailable', detail: errText.trim() || 'codex not found or not authenticated' });
    process.exit(0);
  }

  const threadId = extractThreadId(res.stdout);

  let verdict = null, rawMsg = '';
  if (existsSync(a.out)) {
    rawMsg = readFileSync(a.out, 'utf8').trim();
    try { verdict = JSON.parse(rawMsg); } catch { verdict = null; }
  }
```
改为:
```javascript
  const codexArgs = buildCodexArgs(a);
  let threadId = null, verdict = null, rawMsg = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = spawnSync(bin, codexArgs, {
      input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });

    // codex 缺失或未登录 → 提示用户 /codex:setup(不重试)
    const errText = (res.stderr || '') + (res.error ? String(res.error.message || res.error) : '');
    const unavailable =
      (res.error && res.error.code === 'ENOENT') ||
      res.status === 127 ||
      /not logged in|not authenticated|please run .*login|unauthor/i.test(errText);
    if (unavailable) {
      emit({ ok: false, error: 'codex_unavailable', detail: errText.trim() || 'codex not found or not authenticated' });
      process.exit(0);
    }

    threadId = extractThreadId(res.stdout) || threadId;

    if (existsSync(a.out)) {
      rawMsg = readFileSync(a.out, 'utf8').trim();
      try { verdict = JSON.parse(rawMsg); } catch { verdict = null; }
    }
    if (verdict && (verdict.verdict === 'AGREE' || verdict.verdict === 'CHANGES')) break;
  }
```

(其后的 `if (!verdict ...) { emit bad_verdict }` 与 `emit ok` 保持不变。)

- [ ] **Step 4: 运行,确认全绿**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: PASS —— 所有 test 通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/fun/D/Projects/claude-skills && \
git add cc-codex-review/scripts/codex-round.mjs cc-codex-review/tests/codex-round.test.mjs && \
git commit -m "feat(cc-codex-review): retry once on unparseable verdict"
```

---

## Task 6: 命令体 `commands/review.md`(互审协议 prompt)

**Files:**
- Create: `cc-codex-review/commands/review.md`

> 这是 prompt(非可单测代码),按 DESIGN.md §3–§8 全文写出。验证靠 Task 7 的 dry-run 与人工安装。

- [ ] **Step 1: 创建 `cc-codex-review/commands/review.md`,内容如下(完整)**

````markdown
---
description: Claude 与 Codex 围绕某项工作循环互审,直到双方 AGREE
argument-hint: '[--repo <dir>] [--diff <file|->] [--plan <file>] [--model <m>] [--max-rounds <n>] [--dry-run] <评审指令>'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

你要执行一次「Claude × Codex 收敛互审」。你(Claude)是驱动方/主张方,Codex 是对抗式复核方。
被审材料可能是计划、代码 diff、执行结果、草案等。每轮 Codex 的调用通过辅助脚本完成:
`${CLAUDE_PLUGIN_ROOT}/scripts/codex-round.mjs`(schema 在 `${CLAUDE_PLUGIN_ROOT}/schemas/verdict.schema.json`)。

原始参数:
`$ARGUMENTS`

## 1. 解析参数
从 `$ARGUMENTS` 中解析可选 flag,余下作为「评审指令」:
- `--repo <dir>`:Codex 工作根(可读文件、跑 git);不给则纯文本/diff 评审。
- `--diff <file|->`:一份 diff;`-` 表示从本对话里用户粘贴的 diff 块取。
- `--plan <file>`:任务目标/规格文件。
- `--model <m>`:传给 Codex 的模型。
- `--max-rounds <n>`:硬上限轮数。
- `--dry-run`:只组装并打印「评审包」+ 将要执行的命令,**不真正调用 Codex**,然后停止。

硬上限优先级:`--max-rounds` > 评审指令自然语言里出现的轮数("最多 5 轮"等,你来解析) > 默认无硬上限。

## 2. 收集被审材料
- 从本对话中收集用户最近粘贴的材料(A 的输出、结果、片段等),可多段并标注来源。
- 若给了 `--plan <file>`,读取它;否则用对话里的目标;都没有就**问用户**目标是什么。
- 若给了 `--diff`,读取/取出该 diff 文本。
- 若既无任何材料、也无 `--repo`/`--diff` 可审 → **停下来问用户要评审什么**,不要猜。

## 3. 形成你的初版主张
基于 评审指令 + 材料 + 目标(+ repo/diff),写出:结论(通过 / 返工 / 阻止)+ 理由 + 给后续的具体修改建议。

## 4. 组装评审包(写入临时文件 packet.txt)
结构:
```
## 任务目标
<目标内容或文件引用>

## 待审材料
<材料;或 "见下方代码上下文">

## 代码上下文
<若有 --repo:指示 Codex 在工作根自行运行 `git log -n 20` / `git diff` 查看;
 若有 --diff:内联粘贴该 diff;否则:无>

## Claude 当前主张
<你的判断 + 理由 + 修改建议>

## 你的职责
你是对抗式复核方。请**对照「任务目标」复核「待审材料 / 代码上下文」这份工作本身**,
并评估上面「Claude 当前主张」是否成立——Claude 的主张只是一个输入,不要默认它对。
有任何实质疑虑就给 verdict=CHANGES;不要为了收敛而同意。
优先质疑:实现路径、设计取舍、假设是否成立、需求是否完整覆盖、有无潜藏 bug、边界用例。
仅当你确无实质异议时才给 verdict=AGREE。
按提供的 JSON Schema 输出 verdict / remaining_issues / rationale。
```
材料过大时摘要,并在包里**显式标注截断了什么**。

## 5. dry-run 短路
若有 `--dry-run`:打印组装好的 packet.txt 全文 + 下一节将执行的 `codex-round.mjs` 命令行,然后**结束**,不调用 Codex。

## 6. 互审循环
维护 `thread_id`(初始空)、`round=0`、`prev`(上一轮的 issue 摘要,初始空)。

每轮:
1. `round++`。
2. 调用辅助脚本(第 1 轮 fresh,无 `--resume`;第 2 轮起带 `--resume <thread_id>`):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-round.mjs" \
     --schema "${CLAUDE_PLUGIN_ROOT}/schemas/verdict.schema.json" \
     --out "<临时文件 last.json>" \
     [--repo <dir>] [--model <m>] [--resume <thread_id>] \
     < <packet 或增量文件>
   ```
   - 第 1 轮 stdin 喂完整 packet.txt;第 2 轮起只喂**增量**(你对上轮每条 issue 的逐条回应 + 修订后的「Claude 当前主张」)。
3. 解析脚本 stdout 的那行 JSON:
   - `error=codex_unavailable` → 告诉用户运行 `/codex:setup`,**停止**。
   - `error=bad_verdict` → 已重试仍失败;把 raw_message 给用户,**停止**。
   - 成功:记下 `thread_id`(若本轮返回了)、`verdict`、`remaining_issues`。
4. **打印进度行**:`第 N 轮 · Codex=<verdict> · 剩 <k> issue(<b> blocker) · Claude=<同意/持异议>`。
5. 处理:
   - 若 Codex=CHANGES:对**每条 issue** 要么采纳并修订你的主张,要么带理由反驳(写下你的理由)。更新你的主张。
   - 你给出本轮自己的立场:无任何剩余异议 → Claude=AGREE,否则 Claude=持异议。
6. **双 AGREE 闸门**:仅当 `Codex.verdict==AGREE` 且你也 Claude=AGREE → 收敛,跳出。
7. **终止条件**(任一即停):
   - 双 AGREE → 收敛成功。
   - 设了硬上限且 `round>=max` → 未收敛,交人工。
   - **停滞**:本轮 `remaining_issues` 与上一轮实质相同、且你的主张未实质变化 → 暂停交人工。
   - 把本轮 issue 摘要存入 `prev` 供下一轮比较。

## 7. 输出
- 收敛成功:打印
  ```
  ✅ 收敛结论
  <商定的结论>
  <后续行动的具体建议>
  ```
- 未收敛(硬上限 / 停滞 / 用户打断):打印「双方最后立场 + 卡点列表」,请用户裁决。

## 注意
- 只有真的无异议才输出 AGREE;不认同 Codex 就带理由反驳,而非投降。顺从式同意视为失败。
- 临时文件放系统临时目录,用完可留痕便于排查。
- 绝不让 Codex 写文件(脚本已固定 `-s read-only`)。
````

- [ ] **Step 2: 校验 frontmatter 与文件可读**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && head -6 cc-codex-review/commands/review.md
```
Expected: 显示以 `---` 开头的 YAML frontmatter,含 `description:` 与 `argument-hint:`。

- [ ] **Step 3: Commit**

```bash
cd /Users/fun/D/Projects/claude-skills && \
git add cc-codex-review/commands/review.md && \
git commit -m "feat(cc-codex-review): add review command protocol prompt"
```

---

## Task 7: 安装验证 + dry-run 冒烟 + README

**Files:**
- Create: `cc-codex-review/README.md`

- [ ] **Step 1: 创建 `cc-codex-review/README.md`**

```markdown
# cc-codex-review

Claude × Codex 收敛互审插件:Claude 对某项工作形成主张,Codex 对抗式复核,两方迭代到都 AGREE。

## 安装
\`\`\`
claude plugin marketplace add finyorke/claude-skills   # 或已加则刷新
claude plugin install cc-codex-review@fun-plugins
\`\`\`
需本机已安装并登录 Codex CLI(否则命令会提示运行 `/codex:setup`)。

## 用法
\`\`\`
/cc-codex-review:review [--repo <dir>] [--diff <file|->] [--plan <file>] [--model <m>] [--max-rounds <n>] [--dry-run] <评审指令>
\`\`\`
把要评审的材料粘贴进当前会话,再运行命令。详见 DESIGN.md。

## 开发
\`\`\`
node --test cc-codex-review/tests/codex-round.test.mjs
\`\`\`
```

- [ ] **Step 2: 跑全部单测(回归)**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: PASS —— 全绿。

- [ ] **Step 3: 真·codex 单轮冒烟(需已登录 codex;在一个临时 git 仓库)**

Run:
```bash
cd "$(mktemp -d)" && git init -q && echo hello > a.txt && git add a.txt && \
printf '## 任务目标\n判断 a.txt 是否只含一个英文单词\n## 待审材料\na.txt 内容: hello\n## Claude 当前主张\n我认为达标。\n## 你的职责\n对抗式复核,按 schema 给 verdict。\n' | \
node "/Users/fun/D/Projects/claude-skills/cc-codex-review/scripts/codex-round.mjs" \
  --schema "/Users/fun/D/Projects/claude-skills/cc-codex-review/schemas/verdict.schema.json" \
  --out ./verdict.json --repo .
```
Expected: 打印一行 `{"ok":true,"thread_id":"...","verdict":"AGREE"|"CHANGES",...}`。
若打印 `{"ok":false,"error":"codex_unavailable",...}` → 先 `/codex:setup` 登录再试。
(此步验证 DESIGN §11 的开放点:`--json`+`--output-schema`+`-o` 共存、thread_id 捕获。若 `thread_id` 为 null,记录到 DESIGN §11 并按"降级:无 resume"处理。)

- [ ] **Step 4: dry-run 人工验证(安装后,在 Claude Code 里)**

手动:重启 Claude Code 会话使插件生效,运行
`/cc-codex-review:review --dry-run "看看这段材料"`(先随便粘贴一段材料)。
Expected: 打印组装好的评审包 + 将执行的 codex-round 命令行,**不**真正调用 Codex。
记录实际调用名(`/cc-codex-review:review` 是否可简写)到 DESIGN §11。

- [ ] **Step 5: Commit**

```bash
cd /Users/fun/D/Projects/claude-skills && \
git add cc-codex-review/README.md && \
git commit -m "docs(cc-codex-review): add README + install/smoke instructions"
```

---

## Task 8: 收尾 — 自检与推送准备

- [ ] **Step 1: 跑全部单测最后一遍**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && node --test cc-codex-review/tests/codex-round.test.mjs
```
Expected: PASS。

- [ ] **Step 2: 确认无敏感信息、文件结构齐全**

Run:
```bash
cd /Users/fun/D/Projects/claude-skills && find cc-codex-review -type f -not -path '*/node_modules/*' | sort && echo '---' && git -C . status --short
```
Expected: 列出 plugin.json / commands/review.md / scripts/codex-round.mjs / schemas/verdict.schema.json / tests/* / README.md / DESIGN.md / PLAN.md;工作区干净(已全部提交)。

- [ ] **Step 3: 推送(仅在用户确认后)**

> 注意:`main` 为默认分支;按惯例先开分支再推。remote 当前为 HTTPS;副账号 `finyorke` 推送可能需切到 SSH 别名 `github-finyorke`(见用户记忆)。**此步等用户明确指示再做。**

```bash
cd /Users/fun/D/Projects/claude-skills && \
git checkout -b feat/cc-codex-review && \
git push -u origin feat/cc-codex-review
```

---

## Self-Review

**Spec coverage(对照 DESIGN.md):**
- §2 角色/为何 command/为何 codex exec → Task 6 prompt + Task 2 脚本体现。✅
- §3 命令接口(flags、硬上限优先级) → Task 6 §1。✅
- §4 循环协议(7 步、双 AGREE、进度行) → Task 6 §6。✅
- §5 评审包结构(首轮整包/后续增量、截断标注) → Task 6 §4、§6.2。✅
- §6 codex 调用(read-only、--cd/--skip-git、--output-schema/-o、resume by thread_id、in-band 取 id) → Task 2/3 脚本 + 测试。✅
- §7 AGREE 契约(对抗、审"工作"、防顺从、固有局限) → Task 6 §4「你的职责」+「注意」。✅
- §8 错误处理(codex 不可用→/codex:setup、非 git→skip、schema 失败→重试、无材料→问、过大→摘要) → Task 4/5 脚本 + Task 6 §2/§6。✅
- §9 打包安装 → Task 1 + Task 7 README。✅
- §10 测试(dry-run、冒烟) → Task 7 Step 3/4 + 单测贯穿。✅
- §11 开放点(--json/-o 共存、resume 保留 flag、id 捕获、调用名) → Task 7 Step 3/4 实测确认并回填。✅

**Placeholder scan:** 无 TBD/TODO;每个代码步给了完整代码;Task 3/4/5 的"修改"均给出被替换前后的确切代码块。✅
（Task 2 Step 3 的 ESM import 修正已在该步内显式给出,执行者照修。）

**Type consistency:** 脚本输出契约统一为 `{ok, thread_id, verdict, remaining_issues, rationale, error?, detail?, raw_message?}`;`buildCodexArgs`/`extractThreadId`/`emit`/`parseArgs` 命名跨 Task 2–5 一致;flag 名(`--schema/--out/--repo/--model/--resume`)脚本与 prompt 调用处一致。✅
