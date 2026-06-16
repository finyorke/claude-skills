import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(resolve(HERE, '../schemas/verdict.schema.json'), 'utf8')
);

// codex 的 `--output-schema` 走 OpenAI 结构化输出的 strict 模式:
// 每个 object 必须 additionalProperties:false,且 `required` 必须列出 properties 的全部键。
// 否则 codex exec 会以 invalid_json_schema 报错、turn.failed、退出 1、不写 verdict 文件。
function assertStrict(node, path = '$') {
  if (node && node.type === 'object' && node.properties) {
    assert.equal(node.additionalProperties, false, `${path}: additionalProperties 必须为 false`);
    const keys = Object.keys(node.properties);
    const required = node.required || [];
    for (const k of keys) {
      assert.ok(required.includes(k), `${path}: '${k}' 必须出现在 required 中(strict 模式)`);
    }
    for (const k of keys) assertStrict(node.properties[k], `${path}.${k}`);
  }
  if (node && node.type === 'array' && node.items) {
    assertStrict(node.items, `${path}[]`);
  }
}

test('verdict schema 满足 OpenAI strict 模式(每个对象的 required 覆盖全部属性)', () => {
  assertStrict(SCHEMA);
});

const PLAN_SCHEMA = JSON.parse(
  readFileSync(resolve(HERE, '../schemas/plan.schema.json'), 'utf8')
);

test('plan schema(do 出方案用)满足 strict 模式 + required 覆盖 plan/steps/assumptions/risks', () => {
  assertStrict(PLAN_SCHEMA);
  assert.equal(PLAN_SCHEMA.additionalProperties, false);
  assert.deepEqual(PLAN_SCHEMA.required.slice().sort(), ['assumptions', 'plan', 'risks', 'steps']);
});
