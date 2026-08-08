import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalVariableAction } from '../../src/runner/global-variable-actions.js';
import { runStep } from '../../src/runner/step-runner.js';
import { createVariableContext } from '../../src/runner/variable-context.js';

test('设置字面量变量后可使用公式继续计算', async () => {
  const context = createVariableContext();
  await runLocalVariableAction(null, {
    action_type: 'global_variable_set',
    variable_name: 'price',
    source_type: 'literal',
    value: '12.5',
  }, { variableContext: context });
  context.set('count', 2);
  const result = await runLocalVariableAction(null, {
    action_type: 'calculation',
    variable_name: 'total',
    expression: '${price} * ${count}',
    scale: 2,
    keep_trailing_zeros: true,
  }, { variableContext: context });

  assert.equal(context.get('total'), '25.00');
  assert.equal(result.variable.value_preview, '25.00');
});

test('变量断言不匹配时明确失败', async () => {
  const context = createVariableContext({ rows: ['a', 'b'] });
  await assert.rejects(() => runLocalVariableAction(null, {
    action_type: 'assert_variable_list',
    value: 'rows',
    expect: 'missing',
  }, { variableContext: context }), { code: 'ASSERTION_FAILED' });
});

test('数据库查询结果仅从本次变量上下文读取并可断言', async () => {
  const context = createVariableContext({ rows: [{ id: 101, status: 'READY' }] });
  const result = await runLocalVariableAction(null, {
    action_type: 'assert_database_value',
    variable_name: 'rows[0].status',
    expect: 'READY',
  }, { variableContext: context });

  assert.equal(result.variable.variable_name, 'rows[0].status');
  assert.equal(context.get('rows[0].id'), 101);
});

test('全局变量步骤结果包含脱敏后的变量执行详情', async () => {
  const context = createVariableContext();
  const result = await runStep(null, {}, {
    id: 'STEP_DATE',
    step_index: 0,
    action_type: 'global_variable_date',
    variable_name: 'stamp',
    date_mode: 'custom_datetime',
    datetime: '2026-08-05T17:30:00',
    format: 'yyyyMMddHHmmss',
    diagnostic_fields: [{
      name: 'variable_name',
      placeholder: '例如：current_time',
      help: '后续步骤使用 ${current_time} 引用该值。',
    }],
  }, { variableContext: context, afterStepDelayMs: 0 });

  assert.deepEqual(result.details.variable, {
    variable_name: 'stamp',
    value_masked: 0,
    value_preview: '20260805173000',
    source: 'date',
  });
});

test('变量正则提取保留分组 0，并在捕获组不存在时明确失败', async () => {
  const context = createVariableContext();
  await runLocalVariableAction(null, {
    action_type: 'global_variable_set',
    variable_name: 'order',
    source_type: 'literal',
    value: 'ORD-20260807',
    regex: 'ORD-(\\d+)',
    regex_group: 0,
  }, { variableContext: context });
  assert.equal(context.get('order'), 'ORD-20260807');

  await assert.rejects(() => runLocalVariableAction(null, {
    action_type: 'global_variable_set',
    variable_name: 'missing_group',
    source_type: 'literal',
    value: 'ORD-20260807',
    regex: 'ORD-(\\d+)',
    regex_group: 2,
  }, { variableContext: context }), { code: 'VARIABLE_VALUE_NOT_FOUND' });
});
