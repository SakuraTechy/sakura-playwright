import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  attachOperationDiagnostic,
  buildOperationDiagnostic,
  diagnosticProfileForStep,
} from '../../src/runner/operation-diagnostics.js';

const fixture = JSON.parse(fs.readFileSync(new URL(
  '../../../sakura-admin/continew-automation/src/test/resources/automation/automation-operation-63-fixture.json',
  import.meta.url,
), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(new URL(
  '../../../sakura-admin/continew-automation/src/main/resources/automation/automation-operation-catalog.json',
  import.meta.url,
), 'utf8'));
const profileByMethod = Object.fromEntries(Object.entries(catalog.diagnostic_profiles)
  .flatMap(([profile, methods]) => methods.map((methodCode) => [methodCode, profile])));

test('目录动作映射到有限诊断模板', () => {
  assert.equal(diagnosticProfileForStep({ action_type: 'input' }), 'element_interaction');
  assert.equal(diagnosticProfileForStep({ action_type: 'assert_text' }), 'assertion');
  assert.equal(diagnosticProfileForStep({ action_type: 'global_variable_date' }), 'variable');
  assert.equal(diagnosticProfileForStep({ action_type: 'server_command' }), 'infrastructure');
  assert.equal(diagnosticProfileForStep({ action_type: 'unknown_action' }), 'generic');
});

test('全部 63 个目录方法在 Playwright 中保持方法身份和 profile 契约', () => {
  assert.equal(fixture.methods.length, 63);
  for (const method of fixture.methods) {
    const operation = buildOperationDiagnostic(
      {
        catalog_version: fixture.catalog_version,
        method_code: method.method_code,
        action_type: method.action_type,
      },
      { action_type: method.action_type },
      { action_type: method.action_type, status: 'passed' },
    );
    assert.equal(operation.catalog_version, fixture.catalog_version);
    assert.equal(operation.method.method_code, method.method_code);
    assert.equal(operation.profile, profileByMethod[method.method_code]);
    assert.equal(operation.outcome.kind, profileByMethod[method.method_code]);
  }
});

test('所有目录 form_schema 字段都进入 Playwright 执行详情', () => {
  let fieldCount = 0;
  for (const type of catalog.types) {
    for (const method of type.methods) {
      const values = Object.fromEntries(method.form_schema.map((field) => [
        field.name,
        field.name === 'variable_name' ? 'run.value' : 'configured',
      ]));
      const operation = buildOperationDiagnostic(
        {
          ...values,
          catalog_version: catalog.catalog_version,
          method_code: method.method_code,
          action_type: method.action_type,
          diagnostic_profile: profileByMethod[method.method_code],
          diagnostic_fields: method.form_schema,
        },
        { ...values, action_type: method.action_type },
        { action_type: method.action_type, status: 'passed' },
      );
      assert.deepEqual(operation.inputs.map((input) => input.key), method.form_schema.map((field) => field.name));
      fieldCount += method.form_schema.length;
    }
  }
  assert.equal(fieldCount, 117);
});

test('统一执行详情同时保留配置值和变量解析后的安全值', () => {
  const operation = buildOperationDiagnostic(
    {
      method_code: 'input.text',
      type_label: '输入操作',
      catalog_version: '2026-08-07.1',
      action_type: 'input',
      target_ref: 'css=input[name=username]',
      value: '${account.username}',
    },
    {
      method_code: 'input.text',
      action_type: 'input',
      target_ref: 'css=input[name=username]',
      value: 'sysadmin',
    },
    {
      action_type: 'input',
      status: 'passed',
      locator_type: 'css',
      locator_value: 'input[name=username]',
      locator_source: 'locator_meta.candidates[0]',
      matched_count: 1,
      visible_count: 1,
    },
  );

  assert.equal(operation.profile, 'element_interaction');
  assert.equal(operation.method.method_code, 'input.text');
  assert.equal(operation.method.type_label, '输入操作');
  assert.equal(operation.inputs.find((item) => item.key === 'value').configured.preview, '${account.username}');
  assert.equal(operation.inputs.find((item) => item.key === 'value').effective.preview, 'sysadmin');
  assert.deepEqual(operation.inputs.find((item) => item.key === 'value').source, {
    code: 'variable_reference',
    label: '引用变量：account.username',
  });
  assert.equal(operation.target.actual_summary, 'input[name=username]');
  assert.equal(operation.target.matched_count, 1);
});

test('优先使用 Admin 下发的目录字段元数据生成参数详情', () => {
  const operation = buildOperationDiagnostic(
    {
      method_code: 'browser.evaluate',
      action_type: 'evaluate',
      diagnostic_fields: [
        { name: 'script', label: '执行脚本', diagnostic_role: 'definition', sensitivity: 'restricted', result_display: 'definition_endpoint' },
      ],
      script: 'return window.location.href',
    },
    { action_type: 'evaluate', script: 'return window.location.href' },
    { action_type: 'evaluate', status: 'passed', evaluation_result_type: 'string' },
  );

  assert.deepEqual(operation.inputs.map((item) => ({ key: item.key, label: item.label, role: item.role })), [
    { key: 'script', label: '执行脚本', role: 'definition' },
  ]);
  assert.equal(operation.inputs[0].configured.value_state, 'restricted');
  assert.equal(operation.inputs[0].effective.value_state, 'restricted');
  assert.equal(operation.outcome.facts[0].label, '返回类型');
});

test('操作详情把 CueCast 双花括号识别为变量引用', () => {
  const operation = buildOperationDiagnostic(
    {
      method_code: 'assertion.element.match',
      action_type: 'assert_element_match',
      expect: '{{account.username}}',
    },
    { action_type: 'assert_element_match', expect: 'sysadmin' },
    { action_type: 'assert_element_match', status: 'passed' },
  );

  assert.deepEqual(operation.inputs.find((item) => item.key === 'expect').source, {
    code: 'variable_reference',
    label: '引用变量：account.username',
  });
});

test('统一执行详情不回显敏感值和受限脚本命令', () => {
  const operation = buildOperationDiagnostic(
    {
      action_type: 'host_command',
      command: 'curl -H "Authorization: Bearer secret-token" /health',
      value_masked: 0,
    },
    {
      action_type: 'host_command',
      command: 'curl -H "Authorization: Bearer secret-token" /health',
    },
    { action_type: 'host_command', status: 'passed' },
  );

  const command = operation.inputs.find((item) => item.key === 'command');
  assert.equal(command.effective.value_state, 'restricted');
  assert.deepEqual(command.source, {
    code: 'definition_snapshot',
    label: '定义快照',
  });
  assert.equal(command.effective.preview, undefined);
  assert.equal(JSON.stringify(operation).includes('secret-token'), false);
});

test('目录参数完整进入变量和基础设施执行详情', () => {
  const variableOperation = buildOperationDiagnostic(
    {
      method_code: 'global.variable.set',
      action_type: 'global_variable_set',
      variable_name: 'account.name',
      source_type: 'locator',
      value: '${account.source}',
      target_ref: 'css=input[name=username]',
      read_mode: 'text',
      regex: 'user=(.*)',
      regex_group: 1,
      replace_from: 'user=',
      replace_to: '',
    },
    {
      action_type: 'global_variable_set',
      variable_name: 'account.name',
      source_type: 'locator',
      value: 'sysadmin',
      target_ref: 'css=input[name=username]',
      read_mode: 'text',
      regex: 'user=(.*)',
      regex_group: 1,
      replace_from: 'user=',
      replace_to: '',
    },
    { action_type: 'global_variable_set', status: 'passed' },
  );
  assert.deepEqual(
    variableOperation.inputs.map((item) => item.key),
    ['variable_name', 'source_type', 'value', 'target_ref', 'read_mode', 'regex', 'regex_group', 'replace_from', 'replace_to'],
  );

  const infrastructureOperation = buildOperationDiagnostic(
    {
      method_code: 'database.query.bind',
      action_type: 'database_sql',
      target_ref: 'db-main',
      sql: 'select * from users',
      variable_name: 'users',
    },
    {
      action_type: 'database_sql',
      target_ref: 'db-main',
      sql: 'select * from users',
      variable_name: 'users',
    },
    { action_type: 'database_sql', status: 'passed' },
  );
  assert.deepEqual(
    infrastructureOperation.inputs.map((item) => item.key),
    ['target_ref', 'sql', 'variable_name'],
  );
  assert.equal(infrastructureOperation.inputs.find((item) => item.key === 'sql').effective.value_state, 'restricted');
});

test('统一执行详情叠加到现有 typed facets 而不覆盖基础设施结果', () => {
  const result = attachOperationDiagnostic(
    {
      action_type: 'database_sql',
      status: 'passed',
      details: { infrastructure: { kind: 'DATABASE_QUERY', rowCount: 2 } },
    },
    { action_type: 'database_sql', method_code: 'database.query', target_ref: 'db-test' },
    { action_type: 'database_sql', method_code: 'database.query', target_ref: 'db-test' },
  );

  assert.equal(result.details.infrastructure.kind, 'DATABASE_QUERY');
  assert.equal(result.details.operation.profile, 'infrastructure');
});

test('断言详情保留期望值、实际值和判定结果', () => {
  const operation = buildOperationDiagnostic(
    { method_code: 'assertion.text', action_type: 'assert_text', target_ref: 'css=.message', expect: '提交成功' },
    { action_type: 'assert_text', target_ref: 'css=.message', expect: '提交成功' },
    {
      action_type: 'assert_text',
      status: 'passed',
      operation_assertion: {
        subject: '元素文本',
        operator: 'contains',
        expected: { value_state: 'visible', preview: '提交成功' },
        actual: { value_state: 'visible', preview: '提交成功，正在跳转' },
        passed: true,
      },
    },
  );

  assert.equal(operation.outcome.assertion.operator, 'contains');
  assert.equal(operation.outcome.assertion.expected.preview, '提交成功');
  assert.equal(operation.outcome.assertion.actual.preview, '提交成功，正在跳转');
  assert.equal(operation.outcome.assertion.passed, true);
});

test('断言失败时从错误详情保留安全实际值而不伪造成功', () => {
  const operation = buildOperationDiagnostic(
    { action_type: 'assert_text', expect: '提交成功' },
    { action_type: 'assert_text', expect: '提交成功' },
    {
      action_type: 'assert_text',
      status: 'failed',
      details: { expected: '提交成功', actual_preview: '系统错误' },
    },
  );

  assert.equal(operation.outcome.assertion.expected.preview, '提交成功');
  assert.equal(operation.outcome.assertion.actual.preview, '系统错误');
  assert.equal(operation.outcome.assertion.passed, false);
});
