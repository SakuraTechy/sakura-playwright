import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCase, normalizeSteps } from '../../src/runner/case-loader.js';

test('duplicate source step ids receive stable unique execution ids', () => {
  const steps = normalizeSteps([
    { id: 1, step_index: 0, action_type: 'click' },
    { id: 2, step_index: 1, action_type: 'input' },
    { id: 1, step_index: 4, action_type: 'click' },
  ]);

  assert.deepEqual(steps.map((step) => step.id), [1, 2, '1__4']);
  assert.equal(steps[2].original_step_id, 1);
});

test('partial execution keeps the same unique id generated from the full case', () => {
  const steps = normalizeSteps([
    { id: 1, step_index: 0, action_type: 'click' },
    { id: 1, step_index: 4, action_type: 'click' },
  ], 1);

  assert.equal(steps[0].id, '1__4');
  assert.equal(steps[0].original_step_id, 1);
});

test('disabled admin steps are excluded before the Runner starts execution', () => {
  const steps = normalizeSteps([
    { id: 'STEP_001', step_index: 0, action_type: 'click', status: 'ENABLE' },
    { id: 'STEP_002', step_index: 1, action_type: 'click', status: 'DISABLE' },
    { id: 'STEP_003', step_index: 2, action_type: 'click', status: 2 },
    { id: 'STEP_004', step_index: 3, action_type: 'click', status: 'enabled' },
  ]);

  assert.deepEqual(steps.map((step) => step.id), ['STEP_001', 'STEP_004']);
  assert.deepEqual(steps.map((step) => step.step_index), [0, 3]);
});

test('失败后继续开关兼容 Admin 的下划线和驼峰字段', () => {
  const steps = normalizeSteps([
    { id: 'STEP_001', action_type: 'click', continue_on_failure: 'true' },
    { id: 'STEP_002', action_type: 'database_sql', continueOnFailure: true },
    { id: 'STEP_003', action_type: 'input', continue_on_failure: false },
  ]);

  assert.deepEqual(steps.map((step) => step.continue_on_failure), [true, true, false]);
});

test('partial execution uses definition indexes when earlier steps are disabled', () => {
  const steps = normalizeSteps([
    { id: 'STEP_001', step_index: 0, action_type: 'click', status: 'ENABLE' },
    { id: 'STEP_002', step_index: 1, action_type: 'click', status: 'DISABLE' },
    { id: 'STEP_003', step_index: 2, action_type: 'click', status: 'ENABLE' },
  ], 2);

  assert.deepEqual(steps.map((step) => step.id), ['STEP_003']);
  assert.deepEqual(steps.map((step) => step.step_index), [2]);
});

test('admin execution id keeps the original recorded id for result tracing', () => {
  const steps = normalizeSteps([
    { id: 'CASE_STEP_005', original_step_id: 1, step_index: 4, action_type: 'click' },
  ]);

  assert.equal(steps[0].id, 'CASE_STEP_005');
  assert.equal(steps[0].original_step_id, 1);
});

test('infrastructure-only cases do not require a browser start_url and retain execution fields', () => {
  const testCase = normalizeCase({
    id: 'SCENE:CASE',
    steps: [{
      id: 'STEP_SQL',
      action_type: 'database_sql',
      sql_mode: 'update',
      sql: 'UPDATE user SET password = ?',
      parameters: [{ jdbc_type: 'VARCHAR', value_ref: 'secret.password' }],
      target_ref: { kind: 'database', binding_key: 'audit-db' },
    }],
  });

  assert.equal(testCase.start_url, '');
  assert.equal(testCase.steps[0].sql_mode, 'update');
  assert.equal(testCase.steps[0].parameters[0].value_ref, 'secret.password');
  assert.deepEqual(testCase.steps[0].target_ref, { kind: 'database', binding_key: 'audit-db' });
});

test('CueCast 保存变量步骤只在运行时转换并保留原始定位元数据', () => {
  const locatorMeta = {
    candidates: [{ type: 'css_unique', value: '.order-number', score: 100 }],
    context: {
      variable: {
        name: 'order_number',
        source: 'text',
        extract: { mode: 'regex', pattern: 'ORD-(\\d+)', group: 0 },
      },
    },
  };
  const [step] = normalizeSteps([{
    id: 'RECORDED_VAR',
    action_type: 'set_variable',
    target_selector: '.order-number',
    value: 'order_number',
    value_text: 'ORD-20260807',
    locator_meta: locatorMeta,
  }]);

  assert.equal(step.action_type, 'global_variable_set');
  assert.equal(step.original_action_type, 'set_variable');
  assert.equal(step.recording_source, 'cuecast-v1.2');
  assert.equal(step.variable_name, 'order_number');
  assert.equal(step.source_type, 'locator');
  assert.equal(step.read_mode, 'text');
  assert.equal(step.regex, 'ORD-(\\d+)');
  assert.equal(step.regex_group, 0);
  assert.equal(step.value_text, 'ORD-20260807');
  assert.strictEqual(step.locator_meta, locatorMeta);
});

test('CueCast 元素断言转换为统一匹配动作，普通文本断言保持不变', () => {
  const [recorded, legacy] = normalizeSteps([{
    id: 'RECORDED_ASSERT',
    action_type: 'assert_text',
    target_selector: '#title',
    value: '系统管理平台',
    locator_meta: {
      assertion: { target: 'element', match: 'not_contains' },
      context: { assertion: { target: 'element', match: 'not_contains', source: 'text' } },
    },
  }, {
    id: 'LEGACY_ASSERT',
    action_type: 'assert_text',
    value: '页面文本',
  }]);

  assert.equal(recorded.action_type, 'assert_element_match');
  assert.equal(recorded.original_action_type, 'assert_text');
  assert.equal(recorded.match_mode, 'not_contains');
  assert.equal(recorded.read_mode, 'text');
  assert.equal(recorded.expect, '系统管理平台');
  assert.equal(legacy.action_type, 'assert_text');
  assert.equal(legacy.original_action_type, undefined);
});

test('CueCast 录制步骤结构不完整时返回带步骤身份的明确错误', () => {
  assert.throws(() => normalizeSteps([{
    id: 'RECORDED_VAR_INVALID',
    step_index: 4,
    action_type: 'set_variable',
    target_selector: '#title',
    value: '',
    locator_meta: { context: { variable: { source: 'text', extract: { mode: 'full' } } } },
  }]), {
    code: 'RECORDED_VARIABLE_NAME_MISSING',
    details: {
      step_id: 'RECORDED_VAR_INVALID',
      step_index: 4,
      action_type: 'set_variable',
    },
  });
});
