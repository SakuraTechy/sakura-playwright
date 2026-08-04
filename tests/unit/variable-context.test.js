import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVariableContext,
  evaluateArithmeticExpression,
} from '../../src/runner/variable-context.js';

test('变量上下文仅在当前实例保存并支持嵌套替换', () => {
  const context = createVariableContext();
  context.set('token', 'abc-123');
  context.set('rows', [{ id: 42, name: 'Alice' }]);
  context.set('query.rows', [{ id: 7 }]);

  assert.equal(context.resolveText('Bearer ${token}'), 'Bearer abc-123');
  assert.equal(context.resolveText('${rows[0].id}'), 42);
  assert.equal(context.resolveText('${query.rows[0].id}'), 7);
  assert.deepEqual(context.resolveStep({
    action_type: 'input',
    value: '${rows[0].name}',
    parameters: [{ value: '${token}' }],
  }), {
    action_type: 'input',
    value: 'Alice',
    parameters: [{ value: 'abc-123' }],
  });
});

test('变量缺失和保留前缀返回明确错误码', () => {
  const context = createVariableContext();
  assert.throws(() => context.resolveText('${missing}'), { code: 'VARIABLE_NOT_FOUND' });
  assert.throws(() => context.set('secret.password', 'x'), { code: 'VARIABLE_NAME_INVALID' });
});

test('公式计算不使用任意 JavaScript 执行', () => {
  const context = createVariableContext({ price: 12.5, count: 2, tax: 1 });
  assert.equal(evaluateArithmeticExpression('(${price} * ${count}) + ${tax}', context), 26);
  assert.throws(() => evaluateArithmeticExpression('process.exit(1)', context), { code: 'VARIABLE_EXPRESSION_INVALID' });
});
