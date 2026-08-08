import { resolveLocator } from './locator-resolver.js';
import { evaluateArithmeticExpression, validateVariableName } from './variable-context.js';
import { RunnerError } from '../shared/utils.js';

const DATE_TOKENS = /yyyy|SSS|MM|dd|HH|mm|ss|M|d|H|m|s/g;

export const LOCAL_VARIABLE_ACTION_TYPES = new Set([
  'global_variable_set',
  'global_variable_date',
  'calculation',
  'global_variable_formula',
  'assert_variable_list',
  'assert_variable_list_not',
  'assert_database_value',
]);

export function isLocalVariableAction(actionType) {
  return LOCAL_VARIABLE_ACTION_TYPES.has(String(actionType || '').trim().toLowerCase());
}

/**
 * 全局变量动作的原始值仅保存到当前 Runner 的 VariableContext；Admin 结果只允许写脱敏、截断后的预览。
 * 不依赖浏览器的日期/公式/变量断言在纯基础设施用例中也可运行。
 */
export async function runLocalVariableAction(page, step, options = {}) {
  const action = String(step.action_type || '').trim().toLowerCase();
  const context = options.variableContext;
  if (!context) {
    throw new RunnerError('VARIABLE_CONTEXT_MISSING', '当前执行未初始化变量上下文');
  }

  switch (action) {
    case 'global_variable_set':
      return setVariable(page, step, options, context);
    case 'global_variable_date':
      return setDateVariable(step, context);
    case 'calculation':
    case 'global_variable_formula':
      return setFormulaVariable(step, context);
    case 'assert_variable_list':
      return assertVariableContains(step, context, false);
    case 'assert_variable_list_not':
      return assertVariableContains(step, context, true);
    case 'assert_database_value':
      return assertVariableContains(step, context, false);
    default:
      throw new RunnerError('UNSUPPORTED_STEP', `Unsupported variable action_type: ${step.action_type}`);
  }
}

async function setVariable(page, step, options, context) {
  const name = validateVariableName(step.variable_name);
  const sourceType = normalizeSourceType(step.source_type ?? step.source ?? 'literal');
  let value;
  let locatorInfo;
  if (sourceType === 'literal') {
    value = step.value ?? '';
  } else if (sourceType === 'locator') {
    if (!page) throw new RunnerError('CASE_INVALID', '从页面元素读取变量需要浏览器页面');
    locatorInfo = await resolveLocator(page, step, options);
    value = await locatorInfo.locator.evaluate((node, readMode) => {
      if (readMode === 'value' && 'value' in node) return node.value;
      if (String(readMode || '').startsWith('attribute:')) {
        return node.getAttribute(String(readMode).slice('attribute:'.length));
      }
      return typeof node.innerText === 'string' ? node.innerText : (node.textContent || '');
    }, step.read_mode || 'text');
  } else if (sourceType === 'script') {
    if (!page) throw new RunnerError('CASE_INVALID', '从页面脚本读取变量需要浏览器页面');
    value = await page.evaluate((script) => {
      // 仅在目标页面上下文执行用户显式配置的脚本，不能触达 Runner 的 Node 环境。
      return Function(`"use strict"; return (function () {\n${script}\n})();`)();
    }, String(step.script || step.value || ''));
  } else {
    throw new RunnerError('METHOD_CONFIG_INVALID', `不支持的变量来源：${sourceType}`);
  }

  value = applyTextTransforms(value, step);
  const variable = context.set(name, value, {
    masked: toBoolean(step.value_masked),
    overwrite: step.overwrite !== false && step.overwrite !== 'false',
    source: sourceType,
  });
  return {
    action_type: String(step.action_type),
    variable,
    ...(locatorInfo ? { locatorInfo } : {}),
  };
}

function setDateVariable(step, context) {
  const name = validateVariableName(step.variable_name);
  const mode = String(step.date_mode || 'current_datetime').trim().toLowerCase();
  const offsetSeconds = finiteNumber(step.offset_seconds, 0);
  const now = resolveDate(step, mode);
  now.setTime(now.getTime() + offsetSeconds * 1000);
  const unit = String(step.timestamp_unit || 'milliseconds').trim().toLowerCase();
  const value = mode === 'timestamp'
    ? (unit === 'seconds' ? Math.floor(now.getTime() / 1000) : now.getTime())
    : formatDate(now, String(step.format || 'yyyy-MM-dd HH:mm:ss'));
  return {
    action_type: String(step.action_type),
    variable: context.set(name, value, {
      masked: toBoolean(step.value_masked),
      overwrite: step.overwrite !== false && step.overwrite !== 'false',
      source: 'date',
    }),
  };
}

function setFormulaVariable(step, context) {
  const name = validateVariableName(step.variable_name);
  const value = evaluateArithmeticExpression(step.expression ?? step.value, context);
  return {
    action_type: String(step.action_type),
    variable: context.set(name, formatFormula(value, step), {
      masked: toBoolean(step.value_masked),
      overwrite: step.overwrite !== false && step.overwrite !== 'false',
      source: 'formula',
    }),
  };
}

function assertVariableContains(step, context, negate) {
  const reference = String(step.variable_name || step.value || '').trim();
  if (!reference) throw new RunnerError('METHOD_CONFIG_INVALID', '变量断言缺少变量名');
  const actual = context.get(reference);
  const expected = step.expect ?? step.expected ?? '';
  const actualText = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const matched = actualText.includes(String(expected));
  if (negate ? matched : !matched) {
    throw new RunnerError('ASSERTION_FAILED', negate
      ? `变量 ${reference} 不应包含 ${expected}`
      : `变量 ${reference} 未包含 ${expected}`);
  }
  const description = context.describe(reference);
  return {
    action_type: String(step.action_type),
    variable: description,
    operation_assertion: {
      subject: `变量 ${reference}`,
      operator: negate ? 'not_contains' : 'contains',
      expected: { value_state: 'visible', preview: String(expected ?? '') },
      actual: description.value_masked
        ? { value_state: 'masked' }
        : { value_state: 'visible', preview: String(actualText).slice(0, 512) },
      passed: true,
    },
  };
}

function normalizeSourceType(value) {
  const source = String(value || '').trim().toLowerCase();
  if (['literal', 'value', 'text', 'constant', '常量', '固定值'].includes(source)) return 'literal';
  if (['locator', 'element', '页面元素', '元素'].includes(source)) return 'locator';
  if (['script', 'javascript', 'js', '脚本'].includes(source)) return 'script';
  return source;
}

function applyTextTransforms(value, step) {
  let transformed = value == null ? '' : String(value);
  const pattern = String(step.regex || '');
  if (pattern) {
    if (pattern.length > 512) throw new RunnerError('METHOD_CONFIG_INVALID', '变量提取正则长度不能超过 512');
    let match;
    try {
      match = new RegExp(pattern).exec(transformed);
    } catch {
      throw new RunnerError('METHOD_CONFIG_INVALID', '变量提取正则不合法');
    }
    if (!match) throw new RunnerError('VARIABLE_VALUE_NOT_FOUND', '变量提取正则未匹配到内容');
    const group = String(step.regex_group ?? '0');
    const groupValue = match.groups && Object.prototype.hasOwnProperty.call(match.groups, group)
      ? match.groups[group]
      : match[Number(group)];
    if (groupValue == null) {
      throw new RunnerError('VARIABLE_VALUE_NOT_FOUND', `变量提取正则不存在捕获组：${group}`);
    }
    transformed = groupValue;
  }
  const replaceFrom = step.replace_from;
  if (replaceFrom != null && String(replaceFrom) !== '') {
    transformed = transformed.split(String(replaceFrom)).join(String(step.replace_to ?? ''));
  }
  return transformed;
}

function resolveDate(step, mode) {
  if (mode !== 'custom_datetime') return new Date();
  const raw = step.datetime ?? step.date_value ?? step.value;
  const result = new Date(String(raw || ''));
  if (Number.isNaN(result.getTime())) {
    throw new RunnerError('METHOD_CONFIG_INVALID', '自定义日期不是合法时间');
  }
  return result;
}

function formatDate(date, pattern) {
  const values = {
    yyyy: String(date.getFullYear()).padStart(4, '0'),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    M: String(date.getMonth() + 1),
    dd: String(date.getDate()).padStart(2, '0'),
    d: String(date.getDate()),
    HH: String(date.getHours()).padStart(2, '0'),
    H: String(date.getHours()),
    mm: String(date.getMinutes()).padStart(2, '0'),
    m: String(date.getMinutes()),
    ss: String(date.getSeconds()).padStart(2, '0'),
    s: String(date.getSeconds()),
    SSS: String(date.getMilliseconds()).padStart(3, '0'),
  };
  return pattern.replace(DATE_TOKENS, (token) => values[token]);
}

function formatFormula(value, step) {
  const scale = Number(step.scale);
  if (Number.isInteger(scale) && scale >= 0 && scale <= 20) {
    return step.keep_trailing_zeros === true || step.keep_trailing_zeros === 'true'
      ? value.toFixed(scale)
      : Number(value.toFixed(scale));
  }
  return value;
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}
