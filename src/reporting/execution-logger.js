import fs from 'node:fs';
import path from 'node:path';
import { formatPlatformDateTimeWithMillis } from '../shared/utils.js';

export const EXECUTION_LOG_PREFIX = '@@SAKURA_EXECUTION_LOG@@';

/**
 * 结构化执行日志同时写入 stdout 和内存。
 * stdout 供 admin 实时解析，内存副本用于生成可持久化的 execution-log artifact。
 */
export function createExecutionLogger(output = console.log, options = {}) {
  const events = [];
  let sequence = 0;
  let localLogFile = initializeLocalLogFile(options.localFile);

  const write = (level, phase, message, detail = false) => {
    const event = {
      sequence: ++sequence,
      timestamp: formatPlatformDateTimeWithMillis(),
      level: normalizeLevel(level),
      phase: String(phase || 'runner').slice(0, 64),
      message: String(message || '').slice(0, 4000),
      detail: Boolean(detail),
    };
    events.push(event);
    const serializedEvent = JSON.stringify(event);
    output(`${EXECUTION_LOG_PREFIX}${serializedEvent}`);
    if (localLogFile) {
      try {
        fs.appendFileSync(localLogFile, `${serializedEvent}\n`, 'utf8');
      } catch {
        // 本地诊断日志不能影响 Runner 主流程；后续事件停止写入该文件。
        localLogFile = '';
      }
    }
    return event;
  };

  return {
    events,
    setLocalFile: (filePath) => {
      localLogFile = initializeLocalLogFile(filePath);
      if (!localLogFile) return '';
      try {
        fs.writeFileSync(localLogFile, events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
      } catch {
        localLogFile = '';
      }
      return localLogFile;
    },
    info: (phase, message, detail = false) => write('info', phase, message, detail),
    success: (phase, message, detail = false) => write('success', phase, message, detail),
    warning: (phase, message, detail = false) => write('warning', phase, message, detail),
    error: (phase, message, detail = false) => write('error', phase, message, detail),
  };
}

function initializeLocalLogFile(filePath) {
  if (!filePath) return '';
  try {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    return resolvedPath;
  } catch {
    return '';
  }
}

export function formatStepLogLabel(step = {}) {
  const internalIndex = Number(step.step_index);
  const displayIndex = Number.isInteger(internalIndex) && internalIndex >= 0 ? internalIndex + 1 : '-';
  const displayName = [step.description, step.name, step.step_name, step.operation_name, step.operationName]
    .map((value) => String(value || '').trim())
    .find(Boolean)
    || String(step.action_type || '未命名步骤').trim();
  return `步骤 ${displayIndex}：${displayName}`;
}

function normalizeLevel(level) {
  return ['info', 'success', 'warning', 'error'].includes(level) ? level : 'info';
}
