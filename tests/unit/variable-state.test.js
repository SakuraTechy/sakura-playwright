import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadVariableContext, saveVariableContext } from '../../src/runner/variable-state.js';
import { parseArgs } from '../../src/shared/utils.js';

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-variable-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    batchId: 'BATCH_1', caseId: 'SCENE_1:CASE_1', projectEnvironmentId: '47',
    variableStateInput: '', variableStateOutput: path.join(directory, 'candidate.json'),
  };
}

test('场景快照跨用例保留嵌套值、类型、来源和敏感标记，并优先于初始默认值', async (t) => {
  const config = await setup(t);
  const first = await loadVariableContext(config, { defaultOnly: 'default' });
  first.set('passwd', 'private-fixture', { masked: true, source: 'locator' });
  first.set('query.rows', [{ id: 42, enabled: false }], { source: 'infrastructure' });
  first.set('zero', 0);
  first.set('empty', '');
  first.set('nothing', null);
  await saveVariableContext(config, first);

  const next = await loadVariableContext({
    ...config, caseId: 'SCENE_1:CASE_2', variableStateInput: config.variableStateOutput,
  }, { passwd: 'old-default', newDefault: true });

  assert.equal(next.resolveText('${passwd}'), 'private-fixture');
  assert.equal(next.resolveText('{{query.rows[0].id}}'), 42);
  assert.equal(next.resolveText('${query.rows[0].enabled}'), false);
  assert.equal(next.get('zero'), 0);
  assert.equal(next.get('empty'), '');
  assert.equal(next.get('nothing'), null);
  assert.equal(next.get('defaultOnly'), 'default');
  assert.equal(next.get('newDefault'), true);
  assert.deepEqual(next.describe('passwd'), { variable_name: 'passwd', value_masked: 1, source: 'locator' });
  assert.throws(() => next.set('passwd', 'replacement', { overwrite: false }), { code: 'VARIABLE_ALREADY_EXISTS' });
  assert.equal(next.describe('query.rows').source, 'infrastructure');
});

test('新批次或没有托管状态的单用例不继承之前的内存变量', async (t) => {
  const config = await setup(t);
  const first = await loadVariableContext(config);
  first.set('passwd', 'private-fixture');
  await saveVariableContext(config, first);
  const freshBatch = await loadVariableContext({ ...config, batchId: 'BATCH_2' });
  const standalone = await loadVariableContext({ caseId: 'SCENE_1:CASE_2' });
  assert.equal(freshBatch.has('passwd'), false);
  assert.equal(standalone.has('passwd'), false);
  await saveVariableContext({}, standalone);
});

test('变量文件不能跨批次、场景或产品环境读取', async (t) => {
  const config = await setup(t);
  await saveVariableContext(config, await loadVariableContext(config));
  for (const mismatch of [{ batchId: 'BATCH_2' }, { caseId: 'SCENE_2:CASE_1' }, { projectEnvironmentId: '48' }]) {
    await assert.rejects(loadVariableContext({
      ...config, variableStateInput: config.variableStateOutput, ...mismatch,
    }), { code: 'VARIABLE_STATE_SCOPE_MISMATCH' });
  }
});

test('损坏或缺失的快照明确失败，不把密码原文或路径放入异常', async (t) => {
  const config = await setup(t);
  config.variableStateInput = config.variableStateOutput;
  await assert.rejects(loadVariableContext(config), { code: 'VARIABLE_STATE_LOAD_FAILED' });
  await fs.writeFile(config.variableStateOutput, '{"passwd":"private-fixture"');
  await assert.rejects(loadVariableContext(config), (error) => {
    assert.equal(error.code, 'VARIABLE_STATE_LOAD_FAILED');
    assert.ok(!error.message.includes('private-fixture'));
    assert.ok(!JSON.stringify(error).includes(config.variableStateInput));
    return true;
  });
});

test('丢失脱敏标记或重复变量名的快照不能被当成有效状态', async (t) => {
  const config = await setup(t);
  const context = await loadVariableContext(config);
  context.set('passwd', 'private-fixture', { masked: true });
  await saveVariableContext(config, context);
  const state = JSON.parse(await fs.readFile(config.variableStateOutput, 'utf8'));
  for (const variables of [
    [{ ...state.variables[0], masked: undefined }],
    [state.variables[0], state.variables[0]],
  ]) {
    await fs.writeFile(config.variableStateOutput, JSON.stringify({ ...state, variables }));
    await assert.rejects(loadVariableContext({ ...config, variableStateInput: config.variableStateOutput }), {
      code: 'VARIABLE_STATE_LOAD_FAILED',
    });
  }
});

test('无法序列化的变量不会覆盖已有候选，临时写文件会被清理', async (t) => {
  const config = await setup(t);
  const context = await loadVariableContext(config);
  context.set('passwd', 'last-valid', { masked: true });
  await saveVariableContext(config, context);
  const saved = await fs.readFile(config.variableStateOutput, 'utf8');
  context.set('invalid', undefined);
  await assert.rejects(saveVariableContext(config, context), { code: 'VARIABLE_STATE_SAVE_FAILED' });
  assert.equal(await fs.readFile(config.variableStateOutput, 'utf8'), saved);
  assert.deepEqual(await fs.readdir(path.dirname(config.variableStateOutput)), ['candidate.json']);
});

test('托管变量共享缺少执行范围时不能启动', async (t) => {
  const config = await setup(t);
  for (const missing of [{ batchId: '' }, { projectEnvironmentId: '' }, { caseId: 'CASE_1' }]) {
    await assert.rejects(loadVariableContext({ ...config, ...missing }), { code: 'CONFIG_INVALID' });
  }
});

test('变量状态只接受宿主环境注入，CLI 参数不能覆盖受控路径', () => {
  const args = ['--case-id', 'SCENE_1:CASE_1', '--admin-api', 'false', '--session-mode', 'isolated',
    '--variable-state-in', 'untrusted.json'];
  const config = parseArgs(args, {
    SAKURA_PLAYWRIGHT_VARIABLE_STATE_IN: 'managed-current.json',
    SAKURA_PLAYWRIGHT_VARIABLE_STATE_OUT: 'managed-candidate.json',
  });
  assert.equal(config.variableStateInput, 'managed-current.json');
  assert.equal(config.variableStateOutput, 'managed-candidate.json');
  const standalone = parseArgs(args, {});
  assert.equal(standalone.variableStateInput, '');
  assert.equal(standalone.variableStateOutput, '');
});
