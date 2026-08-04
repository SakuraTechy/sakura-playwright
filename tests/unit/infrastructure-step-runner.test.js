import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInfrastructureTaskCancellation,
  hasBrowserSteps,
  isInfrastructureStep,
  runInfrastructureStep,
} from '../../src/runner/infrastructure-step-runner.js';
import { runStep } from '../../src/runner/step-runner.js';

test('infrastructure action types are classified before browser execution', () => {
  assert.equal(isInfrastructureStep({ action_type: 'server_command' }), true);
  assert.equal(isInfrastructureStep({ action_type: 'database_sql' }), true);
  assert.equal(isInfrastructureStep({ action_type: 'database_native' }), true);
  assert.equal(hasBrowserSteps([{ action_type: 'database_sql' }]), false);
  assert.equal(hasBrowserSteps([{ action_type: 'global_variable_formula' }]), false);
  assert.equal(hasBrowserSteps([{ action_type: 'database_sql' }, { action_type: 'click' }]), true);
});

test('database step creates a server-resolved task without sending SQL or target configuration', async () => {
  let request;
  let reads = 0;
  const logs = [];
  const api = {
    adminApi: true,
    createInfrastructureTask: async (payload) => {
      request = payload;
      return { task_id: 'INFRA_001', status: 'queued' };
    },
    getInfrastructureTask: async () => {
      reads += 1;
      return reads === 1
        ? { task_id: 'INFRA_001', status: 'running', logs: [{ sequence: 1, message: '任务已开始' }] }
        : {
          task_id: 'INFRA_001', status: 'passed', executor: 'sakura-execution-agent', duration_ms: 18,
          affected_rows: 1, logs: [{ sequence: 1, message: '任务已开始' }],
        };
    },
    cancelInfrastructureTask: async () => {},
  };
  const step = {
    id: 'STEP_002', step_index: 1, action_type: 'database_sql', sql: 'DELETE FROM user',
    target_ref: { kind: 'database', binding_key: 'audit-db' },
  };
  const result = await runInfrastructureStep({ id: 'SCENE:CASE', definition_version: 4 }, step, {
    api,
    infrastructureExecution: {
      jobId: 'JOB_1', batchId: 'BATCH_1', executionId: 'EXEC_1', projectEnvironmentId: '7',
    },
    infrastructurePollIntervalMs: 100,
    onInfrastructureLog: (event) => logs.push(event),
  });

  assert.deepEqual(request, {
    jobId: 'JOB_1', batchId: 'BATCH_1', executionId: 'EXEC_1', caseKey: 'SCENE:CASE',
    stepId: 'STEP_002', stepIndex: 1, projectEnvironmentId: '7', definitionVersion: 4,
  });
  assert.equal('sql' in request, false);
  assert.equal('target_ref' in request, false);
  assert.equal(result.status, 'passed');
  assert.equal(result.infrastructure_task_id, 'INFRA_001');
  assert.equal(result.affected_rows, 1);
  assert.equal(logs.length, 1);
});

test('infrastructure step only sends referenced runtime bindings', async () => {
  let request;
  const api = {
    adminApi: true,
    createInfrastructureTask: async (payload) => {
      request = payload;
      return { task_id: 'INFRA_BINDINGS', status: 'passed', duration_ms: 1 };
    },
    getInfrastructureTask: async () => { throw new Error('should not poll terminal task'); },
    cancelInfrastructureTask: async () => {},
  };

  await runInfrastructureStep({ id: 'SCENE:CASE' }, {
    id: 'STEP_004', step_index: 3, action_type: 'server_command', wait_before: 0,
  }, {
    api,
    infrastructureExecution: { caseKey: 'SCENE:CASE' },
    runtimeBindings: { orderNo: 'A-001' },
  });

  assert.deepEqual(request.runtimeBindings, { orderNo: 'A-001' });
  assert.equal('command' in request, false);
});

test('infrastructure result keeps declared runtime variables out of the public report shape', async () => {
  const api = {
    adminApi: true,
    createInfrastructureTask: async () => ({
      task_id: 'INFRA_VARIABLE', status: 'passed', duration_ms: 1,
      result: { variables: { rows: [{ id: '1' }] } },
    }),
    getInfrastructureTask: async () => { throw new Error('should not poll terminal task'); },
    cancelInfrastructureTask: async () => {},
  };
  const result = await runInfrastructureStep({ id: 'SCENE:CASE' }, {
    id: 'STEP_005', step_index: 4, action_type: 'database_sql', wait_before: 0,
  }, { api, infrastructureExecution: { caseKey: 'SCENE:CASE' } });

  assert.deepEqual(result._runtime_variables, { rows: [{ id: '1' }] });
  assert.equal(result.status, 'passed');
});

test('runStep delegates infrastructure actions without accessing a Playwright page', async () => {
  const api = {
    adminApi: true,
    createInfrastructureTask: async () => ({ task_id: 'INFRA_002', status: 'passed', duration_ms: 1 }),
    getInfrastructureTask: async () => { throw new Error('should not poll terminal task'); },
    cancelInfrastructureTask: async () => {},
  };
  const result = await runStep(null, { id: 'SCENE:CASE' }, {
    id: 'STEP_003', step_index: 2, action_type: 'server_command', wait_before: 0,
  }, { api, infrastructureExecution: { caseKey: 'SCENE:CASE' } });

  assert.equal(result.status, 'passed');
  assert.equal(result.infrastructure_task_id, 'INFRA_002');
});

test('tracked infrastructure tasks are cancelled when the runner aborts', async () => {
  const cancelled = [];
  const tracker = createInfrastructureTaskCancellation({
    cancelInfrastructureTask: async (taskId, reason) => cancelled.push({ taskId, reason }),
  });
  tracker.track('INFRA_003');
  await tracker.cancelActive('case_timeout');
  assert.deepEqual(cancelled, [{ taskId: 'INFRA_003', reason: 'case_timeout' }]);
});
