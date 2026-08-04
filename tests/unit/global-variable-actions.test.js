import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalVariableAction } from '../../src/runner/global-variable-actions.js';
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
