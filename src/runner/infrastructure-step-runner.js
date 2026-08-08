import { RunnerError, sleep } from '../shared/utils.js';
import { isLocalVariableAction } from './global-variable-actions.js';

export const INFRASTRUCTURE_ACTION_TYPES = new Set([
  'server_command',
  'database_sql',
  'database_native',
  'host_command',
  'host_file_lookup',
  'host_file_delete',
  'host_pointer_move',
  'server_file_upload',
  'global_variable_system_info',
  'global_variable_available_ip',
  'global_variable_property',
]);

export function isInfrastructureStep(step) {
  return INFRASTRUCTURE_ACTION_TYPES.has(String(step?.action_type || '').trim().toLowerCase());
}

export function hasBrowserSteps(steps) {
  return (Array.isArray(steps) ? steps : []).some((step) => (
    !isInfrastructureStep(step) && !isLocalVariableAction(step?.action_type)
  ));
}

/**
 * 跟踪当前 Runner 已创建但未完成的基础设施任务；超时或异常时由入口统一取消，
 * 防止浏览器进程退出后远端命令或 SQL 仍继续运行。
 */
export function createInfrastructureTaskCancellation(api, logger = null) {
  const taskIds = new Set();
  let cancellationReason = '';
  return {
    track(taskId) {
      if (taskId) taskIds.add(String(taskId));
      return !cancellationReason;
    },
    complete(taskId) {
      if (taskId) taskIds.delete(String(taskId));
    },
    throwIfCancelled(taskId) {
      if (!cancellationReason) return;
      throw new RunnerError(
        'INFRASTRUCTURE_STEP_CANCELLED',
        `Infrastructure task polling cancelled: ${cancellationReason}`,
        { infrastructure_task_id: String(taskId || '') },
      );
    },
    async cancelActive(reason = 'runner_cancelled') {
      cancellationReason = String(reason || 'runner_cancelled');
      const active = [...taskIds];
      taskIds.clear();
      await Promise.all(active.map(async (taskId) => {
        try {
          await api.cancelInfrastructureTask(taskId, reason);
          logger?.warning('infrastructure', `已请求取消基础设施任务 ${taskId}`);
        } catch (error) {
          // 取消失败不能覆盖原始用例错误；服务端仍会依靠任务租约/心跳进行回收。
          logger?.warning('infrastructure', `取消基础设施任务 ${taskId} 失败：${error?.message || String(error)}`);
        }
      }));
    },
  };
}

export async function runInfrastructureStep(testCase, step, options = {}) {
  const api = options.api;
  if (!api?.createInfrastructureTask || !api?.getInfrastructureTask || !api?.cancelInfrastructureTask) {
    throw new RunnerError('INFRASTRUCTURE_UNAVAILABLE', 'Infrastructure API client is not configured');
  }
  if (!api.adminApi) {
    throw new RunnerError('INFRASTRUCTURE_UNAVAILABLE', 'Infrastructure steps require the admin API');
  }

  const execution = options.infrastructureExecution || {};
  const payload = {
    jobId: execution.jobId || '',
    batchId: execution.batchId || '',
    executionId: execution.executionId || '',
    caseKey: execution.caseKey || testCase.id || '',
    stepId: step.id,
    stepIndex: step.step_index,
    projectEnvironmentId: execution.projectEnvironmentId || '',
    definitionVersion: execution.definitionVersion || testCase.definition_version || testCase.definitionVersion || '',
  };
  if (execution.executionCapability) payload.executionCapability = execution.executionCapability;
  const runtimeBindings = options.runtimeBindings || {};
  // 仅携带冻结步骤中实际引用的变量根节点；空绑定不改变既有任务接口契约。
  if (Object.keys(runtimeBindings).length > 0) payload.runtimeBindings = runtimeBindings;
  const runtimeInput = options.runtimeInput || {};
  // 截图等短时输入只允许在当前请求中转发，绝不由 Runner 写入日志或结果。
  if (Object.keys(runtimeInput).length > 0) payload.runtimeInput = runtimeInput;
  // 命令、SQL、主机和凭据只由服务端按冻结步骤快照解析，Runner 不会把它们带入任务请求。
  const created = await api.createInfrastructureTask(payload);
  const task = unwrapTask(created);
  const taskId = String(task.task_id || task.taskId || '').trim();
  if (!taskId) {
    throw new RunnerError('INFRASTRUCTURE_TASK_INVALID', 'Infrastructure task response has no task_id', {
      task_response: safeTaskDetails(task),
    });
  }

  const tracked = options.infrastructureTasks?.track(taskId);
  let afterSequence = -1;
  const seenLogSequences = new Set();
  try {
    if (tracked === false) {
      await api.cancelInfrastructureTask(taskId, 'runner_cancelled').catch(() => {});
    }
    options.infrastructureTasks?.throwIfCancelled(taskId);
    let current = task;
    while (true) {
      options.infrastructureTasks?.throwIfCancelled(taskId);
      emitTaskLogs(current, taskId, options, seenLogSequences);
      const status = normalizeStatus(current.status);
      if (isTerminalStatus(status)) {
        return buildTaskResult(step, taskId, current, status);
      }
      await sleep(resolvePollIntervalMs(options));
      options.infrastructureTasks?.throwIfCancelled(taskId);
      current = unwrapTask(await api.getInfrastructureTask(taskId, afterSequence));
      options.infrastructureTasks?.throwIfCancelled(taskId);
      afterSequence = nextSequence(current, afterSequence);
    }
  } finally {
    options.infrastructureTasks?.complete(taskId);
  }
}

function unwrapTask(response) {
  return response?.data && typeof response.data === 'object' ? response.data : response || {};
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['success', 'succeeded', 'completed'].includes(status)) return 'passed';
  if (['failure', 'failed', 'error'].includes(status)) return 'failed';
  if (['canceled', 'cancelled', 'aborted'].includes(status)) return 'cancelled';
  return status || 'running';
}

function isTerminalStatus(status) {
  return ['passed', 'failed', 'cancelled'].includes(status);
}

function buildTaskResult(step, taskId, task, status) {
  const details = safeTaskDetails(task);
  const infrastructure = validatedInfrastructureResult(task);
  if (status === 'failed' || status === 'cancelled') {
    throw new RunnerError(
      status === 'cancelled' ? 'INFRASTRUCTURE_STEP_CANCELLED' : 'INFRASTRUCTURE_STEP_FAILED',
      taskFailureMessage(task, status),
      { infrastructure_task_id: taskId, ...details, ...(infrastructure
        ? { infrastructure }
        : {}) },
    );
  }
  return {
    step_index: step.step_index,
    step_id: step.id,
    ...(step.original_step_id != null ? { original_step_id: step.original_step_id } : {}),
    action_type: String(step.action_type || '').toLowerCase(),
    status: 'passed',
    duration_ms: numberOrNull(task.duration_ms ?? task.durationMs),
    executor: task.executor || 'infrastructure-agent',
    infrastructure_task_id: taskId,
    // 受限预览进入统一 step.details，完整输出和大结果只能通过 Admin 受鉴权附件读取。
    ...(infrastructure
      ? { details: { infrastructure } }
      : {}),
    // 仅在当前内存循环中交给 VariableContext；调用方会在写入报告前删除该字段。
    ...(task?.result?.variables && typeof task.result.variables === 'object'
      ? { _runtime_variables: task.result.variables }
      : {}),
    ...details,
  };
}

function validatedInfrastructureResult(task) {
  const result = task?.result?.infrastructure;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const schemaVersion = Number(result.schemaVersion ?? 1);
  if (![1, 2].includes(schemaVersion)) {
    throw new RunnerError('RESULT_SCHEMA_UNSUPPORTED', `Unsupported infrastructure result schema: ${schemaVersion}`);
  }
  if (schemaVersion === 2 && !Array.isArray(result.results)) {
    throw new RunnerError('RESULT_SCHEMA_UNSUPPORTED', 'Infrastructure result schema v2 requires an ordered results array');
  }
  return result;
}

// 失败步骤必须带出 Admin/Agent 返回的具体原因，不能退化成“执行 Agent 不可用”。
// 兼容不同版本接口的字段命名，并在旧接口未返回 error_message 时回退到最后一条错误日志。
function taskFailureMessage(task, status) {
  const candidates = [task.error_message, task.errorMessage, task.message, task.error];
  const message = candidates.find((value) => String(value || '').trim());
  if (message) return String(message).trim();

  const logs = Array.isArray(task.logs) ? task.logs : Array.isArray(task.events) ? task.events : [];
  const errorLog = [...logs].reverse().find((log) => {
    const level = String(log?.level || '').toLowerCase();
    return level === 'error' || level === 'warn' || level === 'warning';
  });
  if (errorLog?.message || errorLog?.text) return String(errorLog.message || errorLog.text).trim();

  const errorCode = task.error_code || task.errorCode;
  return errorCode
    ? `基础设施任务执行失败：状态=${status}，错误码=${errorCode}`
    : `基础设施任务执行失败：状态=${status}`;
}

function safeTaskDetails(task) {
  const allow = [
    ['exit_code', 'exit_code'], ['exitCode', 'exit_code'],
    ['affected_rows', 'affected_rows'], ['affectedRows', 'affected_rows'],
    ['row_count', 'row_count'], ['rowCount', 'row_count'],
    ['result_truncated', 'result_truncated'], ['resultTruncated', 'result_truncated'],
    ['error_code', 'infrastructure_error_code'], ['errorCode', 'infrastructure_error_code'],
    ['target', 'target'], ['target_name', 'target'], ['targetName', 'target'],
  ];
  return allow.reduce((details, [source, target]) => {
    if (task[source] != null && details[target] == null) details[target] = task[source];
    return details;
  }, {});
}

function emitTaskLogs(task, taskId, options, seenSequences) {
  const logs = Array.isArray(task.logs) ? task.logs : Array.isArray(task.events) ? task.events : [];
  for (const log of logs) {
    const sequence = log.sequence ?? log.seq ?? `${log.timestamp || ''}:${log.message || ''}`;
    if (seenSequences.has(String(sequence))) continue;
    seenSequences.add(String(sequence));
    options.onInfrastructureLog?.({ taskId, ...log });
  }
}

function nextSequence(task, previous) {
  const candidates = [task.next_sequence, task.nextSequence, task.last_sequence, task.lastSequence];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return Math.max(previous, value);
  }
  const logs = Array.isArray(task.logs) ? task.logs : Array.isArray(task.events) ? task.events : [];
  return logs.reduce((maximum, log) => {
    const value = Number(log.sequence ?? log.seq);
    return Number.isFinite(value) ? Math.max(maximum, value) : maximum;
  }, previous);
}

function resolvePollIntervalMs(options) {
  const value = Number(options.infrastructurePollIntervalMs);
  return Number.isFinite(value) && value >= 100 ? Math.floor(value) : 500;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
