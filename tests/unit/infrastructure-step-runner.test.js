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

test('infrastructure task carries the execution capability without step secrets', async () => {
  let request;
  const api = {
    adminApi: true,
    createInfrastructureTask: async (payload) => {
      request = payload;
      return { task_id: 'INFRA_CAP', status: 'passed', duration_ms: 1 };
    },
    getInfrastructureTask: async () => { throw new Error('should not poll terminal task'); },
    cancelInfrastructureTask: async () => {},
  };
  await runInfrastructureStep({ id: 'SCENE:CASE' }, {
    id: 'STEP_CAP', step_index: 0, action_type: 'server_command', command: 'secret',
  }, {
    api,
    infrastructureExecution: { caseKey: 'SCENE:CASE', executionCapability: 'capability-1' },
  });
  assert.equal(request.executionCapability, 'capability-1');
  assert.equal('command' in request, false);
});

test('infrastructure result preview is written into step.details', async () => {
  const api = {
    adminApi: true,
    createInfrastructureTask: async () => ({
      task_id: 'INFRA_PREVIEW', status: 'passed', duration_ms: 8, executor: 'sakura-execution-agent',
      result: {
        infrastructure: {
          kind: 'DATABASE_QUERY', rowCount: 1, truncated: false,
          resultSets: [{ columns: ['user_id'], rows: [{ user_id: 1 }] }],
          stdout: '', stderr: '', artifact: { available: false },
        },
      },
    }),
    getInfrastructureTask: async () => { throw new Error('should not poll terminal task'); },
    cancelInfrastructureTask: async () => {},
  };
  const result = await runInfrastructureStep({ id: 'SCENE:CASE' }, {
    id: 'STEP_PREVIEW', step_index: 4, action_type: 'database_sql',
  }, { api, infrastructureExecution: { caseKey: 'SCENE:CASE' } });
  assert.equal(result.details.infrastructure.kind, 'DATABASE_QUERY');
  assert.equal(result.details.infrastructure.resultSets[0].rows[0].user_id, 1);
});

test('schema v2 keeps ordered rows and duplicate column labels in step.details', async () => {
  const api = {
    adminApi: true,
    createInfrastructureTask: async () => ({
      task_id: 'INFRA_V2', status: 'passed', result: {
        infrastructure: {
          schemaVersion: 2, kind: 'DATABASE_CALL', durationMs: 9, warnings: [], truncated: false,
          results: [{
            type: 'ROW_SET',
            columns: [
              { name: 'left_id', label: 'id', jdbcType: -5, typeName: 'BIGINT', nullable: false },
              { name: 'right_id', label: 'id', jdbcType: -5, typeName: 'BIGINT', nullable: false },
            ],
            rows: [[1, 2]], rowCount: 1, truncated: false,
          }],
        },
      },
    }),
    getInfrastructureTask: async () => { throw new Error('should not poll terminal task'); },
    cancelInfrastructureTask: async () => {},
  };

  const result = await runInfrastructureStep({ id: 'SCENE:CASE' }, {
    id: 'STEP_V2', step_index: 5, action_type: 'database_sql',
  }, { api, infrastructureExecution: { caseKey: 'SCENE:CASE' } });

  assert.deepEqual(result.details.infrastructure.results[0].rows[0], [1, 2]);
  assert.deepEqual(result.details.infrastructure.results[0].columns.map((column) => column.label), ['id', 'id']);
});

test('unsupported infrastructure result schema fails explicitly', async () => {
  const api = {
    adminApi: true,
    createInfrastructureTask: async () => ({
      task_id: 'INFRA_V3', status: 'passed', result: { infrastructure: { schemaVersion: 3, results: [] } },
    }),
    getInfrastructureTask: async () => { throw new Error('should not poll terminal task'); },
    cancelInfrastructureTask: async () => {},
  };

  await assert.rejects(
    runInfrastructureStep({ id: 'SCENE:CASE' }, {
      id: 'STEP_V3', step_index: 6, action_type: 'database_sql',
    }, { api, infrastructureExecution: { caseKey: 'SCENE:CASE' } }),
    (error) => error?.code === 'RESULT_SCHEMA_UNSUPPORTED',
  );
});

test('failed infrastructure step keeps result preview in details', async () => {
  const api = {
    adminApi: true,
    createInfrastructureTask: async () => ({
      task_id: 'INFRA_FAILED', status: 'failed', duration_ms: 12, error_code: 'HOST_COMMAND_EXIT_NON_ZERO',
      error_message: '命令退出码非零', result: {
        infrastructure: { kind: 'SERVER_COMMAND', exitCode: 2, rowCount: 0, truncated: false, stdout: 'partial', stderr: 'boom' },
      },
    }),
    getInfrastructureTask: async () => { throw new Error('should not poll terminal task'); },
    cancelInfrastructureTask: async () => {},
  };
  await assert.rejects(
    runInfrastructureStep({ id: 'SCENE:CASE' }, {
      id: 'STEP_FAILED', step_index: 5, action_type: 'server_command',
    }, { api, infrastructureExecution: { caseKey: 'SCENE:CASE' } }),
    (error) => error?.code === 'INFRASTRUCTURE_STEP_FAILED'
      && error?.details?.infrastructure?.kind === 'SERVER_COMMAND'
      && error?.details?.infrastructure?.exitCode === 2,
  );
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
