import fs from 'node:fs/promises';
import path from 'node:path';
import { createVariableContext, validateVariableName } from './variable-context.js';
import { RunnerError } from '../shared/utils.js';

export async function loadVariableContext(config, initialValues = {}) {
  const context = createVariableContext(initialValues);
  if (!config.variableStateInput && !config.variableStateOutput) return context;
  const scope = resolveScope(config);
  if (!config.variableStateInput) return context;
  try {
    const state = JSON.parse(await fs.readFile(config.variableStateInput, 'utf8'));
    validateState(state, scope);
    // 用例初始值作为默认值；前序成功用例的最新变量及其脱敏标记优先。
    for (const entry of state.variables) {
      context.set(entry.name, entry.value, { masked: entry.masked, source: entry.source, allowReserved: true });
    }
    return context;
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    // JSON 解析异常可能含原始敏感值，文件路径也不能进入长期执行日志。
    throw new RunnerError('VARIABLE_STATE_LOAD_FAILED', '无法读取场景批次变量，请检查受控临时状态文件', {
      reason: error?.code || 'INVALID_JSON',
    });
  }
}

export async function saveVariableContext(config, context) {
  if (!config.variableStateOutput) return;
  const scope = resolveScope(config);
  const outputPath = path.resolve(config.variableStateOutput);
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const serialized = JSON.stringify({ version: 1, scope, variables: context.snapshot() });
    validateState(JSON.parse(serialized), scope);
    await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    // 这里只生成候选；Admin 确认进程成功、回传成功且未取消后才提交给后续用例。
    await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw new RunnerError('VARIABLE_STATE_SAVE_FAILED', '无法保存场景批次变量候选，请检查变量是否可序列化及临时目录权限', {
      reason: error?.code || 'INVALID_STATE',
    });
  }
}

function resolveScope(config) {
  const caseKey = String(config.caseId || '');
  const separator = caseKey.indexOf(':');
  if (!config.batchId || !config.projectEnvironmentId || separator <= 0 || separator === caseKey.length - 1) {
    throw new RunnerError('CONFIG_INVALID', '场景变量共享需要批次、产品环境及 sceneKey:caseId 用例标识');
  }
  return {
    batch_id: String(config.batchId),
    scene_key: caseKey.slice(0, separator),
    project_environment_id: String(config.projectEnvironmentId),
  };
}

function validateState(state, scope) {
  if (state?.version !== 1 || !Array.isArray(state.variables) || !state.scope || typeof state.scope !== 'object') {
    throw new RunnerError('VARIABLE_STATE_LOAD_FAILED', '场景批次变量快照格式无效');
  }
  if (Object.entries(scope).some(([key, value]) => state.scope[key] !== value)) {
    throw new RunnerError('VARIABLE_STATE_SCOPE_MISMATCH', '变量快照不属于当前批次、场景或产品环境');
  }
  const names = new Set();
  for (const entry of state.variables) {
    if (!entry || typeof entry.name !== 'string' || !Object.prototype.hasOwnProperty.call(entry, 'value')
      || typeof entry.masked !== 'boolean' || typeof entry.source !== 'string' || names.has(entry.name)) {
      throw new RunnerError('VARIABLE_STATE_LOAD_FAILED', '场景批次变量条目格式无效');
    }
    validateVariableName(entry.name, true);
    names.add(entry.name);
  }
}
