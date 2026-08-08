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

test('CueCast 双花括号变量与规范变量使用相同的解析和诊断链路', () => {
  const context = createVariableContext({ order: { id: 42 }, token: 'abc' });

  assert.equal(context.resolveText('{{order.id}}'), 42);
  assert.equal(context.resolveText('order={{order.id}}; token=${token}'), 'order=42; token=abc');
  assert.deepEqual(context.referencesInStep({ value: '{{order.id}}-${token}-{{order.id}}' }), ['order.id', 'token']);
  assert.deepEqual(context.bindingsForStep({ value: '{{order.id}}-${token}' }), {
    order: { id: 42 },
    token: 'abc',
  });
  assert.throws(() => context.resolveText('{{missing}}'), { code: 'VARIABLE_NOT_FOUND' });
});

test('变量缺失和保留前缀返回明确错误码', () => {
  const context = createVariableContext();
  assert.throws(() => context.resolveText('${missing}'), { code: 'VARIABLE_NOT_FOUND' });
  assert.throws(() => context.set('secret.password', 'x'), { code: 'VARIABLE_NAME_INVALID' });
});

test('目录诊断元数据中的示例变量不参与运行时解析', () => {
  const context = createVariableContext();
  const step = {
    action_type: 'global_variable_date',
    variable_name: 'stamp',
    diagnostic_fields: [{
      name: 'variable_name',
      placeholder: '例如：current_time',
      help: '后续步骤使用 ${current_time} 引用该值。',
    }],
  };

  assert.deepEqual(context.referencesInStep(step), []);
  assert.deepEqual(context.resolveStep(step), step);
});

test('缺失引用的诊断不会覆盖真实变量错误', () => {
  const context = createVariableContext();
  assert.deepEqual(context.describeReferencesForStep({ value: '${stamp}' }), [{
    reference: 'stamp',
    variable_name: 'stamp',
    value_masked: 0,
    source: '',
  }]);
  assert.throws(() => context.bindingsForStep({ value: '${stamp}' }), {
    code: 'VARIABLE_NOT_FOUND',
    message: '变量不存在：stamp',
  });
});

test('步骤引用诊断包含实际值并隐藏敏感变量', () => {
  const context = createVariableContext();
  context.set('stamp', '20260805173000', { source: 'date' });
  context.set('accessToken', 'secret-value', { source: 'step', masked: true });

  assert.deepEqual(context.describeReferencesForStep({
    sql: 'UPDATE audit SET modified_time = ${stamp}, token = ${accessToken}',
  }), [{
    reference: 'stamp',
    variable_name: 'stamp',
    value_masked: 0,
    value_preview: '20260805173000',
    source: 'date',
  }, {
    reference: 'accessToken',
    variable_name: 'accessToken',
    value_masked: 1,
    source: 'step',
  }]);
});

test('公式计算不使用任意 JavaScript 执行', () => {
  const context = createVariableContext({ price: 12.5, count: 2, tax: 1 });
  assert.equal(evaluateArithmeticExpression('(${price} * ${count}) + ${tax}', context), 26);
  assert.throws(() => evaluateArithmeticExpression('process.exit(1)', context), { code: 'VARIABLE_EXPRESSION_INVALID' });
});
