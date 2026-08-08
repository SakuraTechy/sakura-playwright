import { RunnerError } from '../shared/utils.js';

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const RESERVED_PREFIXES = ['system.', 'secret.', 'execution.'];
const STEP_METADATA_KEYS = new Set([
  'id',
  'original_step_id',
  'step_index',
  'action_type',
  'description',
  'source',
  'schema_version',
  'catalog_version',
  'canonical_digest',
  'original_action_type',
  'recording_source',
  // 目录表单的帮助、占位符和选项是诊断元数据，不是执行参数。
  'diagnostic_fields',
]);

/**
 * 一个用例执行只创建一个变量上下文，绝不能复用进程级 Map。
 * 变量值只在步骤运行时内存中存在，结果中仅输出经过截断的非敏感预览。
 */
export class VariableContext {
  constructor(initialValues = {}) {
    this.values = new Map();
    this.metadata = new Map();
    for (const [name, value] of Object.entries(initialValues || {})) {
      this.set(name, value, { source: 'initial', overwrite: true, allowReserved: true });
    }
  }

  set(name, value, options = {}) {
    const normalizedName = validateVariableName(name, options.allowReserved === true);
    if (this.values.has(normalizedName) && options.overwrite === false) {
      throw new RunnerError('VARIABLE_ALREADY_EXISTS', `变量已存在且不允许覆盖：${normalizedName}`);
    }
    this.values.set(normalizedName, value);
    this.metadata.set(normalizedName, {
      masked: Boolean(options.masked),
      source: String(options.source || 'step'),
    });
    return this.describe(normalizedName);
  }

  get(reference) {
    const normalized = String(reference || '').trim();
    if (!normalized) {
      throw new RunnerError('VARIABLE_NOT_FOUND', '变量引用不能为空');
    }
    if (this.values.has(normalized)) return this.values.get(normalized);

    const parsed = this.parseReference(normalized);
    if (!this.values.has(parsed.root)) {
      throw new RunnerError('VARIABLE_NOT_FOUND', `变量不存在：${parsed.root}`, { variable_name: parsed.root });
    }
    let value = this.values.get(parsed.root);
    for (const segment of parsed.segments) {
      if (value == null || !Object.prototype.hasOwnProperty.call(Object(value), segment)) {
        throw new RunnerError('VARIABLE_NOT_FOUND', `变量引用不存在：${normalized}`, { variable_name: normalized });
      }
      value = value[segment];
    }
    return value;
  }

  has(name) {
    return this.values.has(String(name || '').trim());
  }

  resolveText(text) {
    if (typeof text !== 'string' || (!text.includes('${') && !text.includes('{{'))) return text;
    const wholeReference = text.match(/^\$\{([^{}]+)}$/) || text.match(/^\{\{([^{}]+)}}$/);
    if (wholeReference) return this.get(wholeReference[1].trim());
    return text.replace(/\$\{([^{}]+)}|\{\{([^{}]+)}}/g, (_all, canonical, cuecast) => (
      stringifyVariable(this.get(String(canonical ?? cuecast).trim()))
    ));
  }

  resolveStep(step) {
    return resolveRuntimeValue(step, this, true);
  }

  referencesInStep(step) {
    const references = new Set();
    collectReferences(step, references, true);
    return [...references];
  }

  bindingsForStep(step) {
    const bindings = {};
    for (const reference of this.referencesInStep(step)) {
      const parsed = this.parseReference(reference);
      // Admin 只需要根变量即可在冻结步骤中按相同引用解析嵌套值。
      bindings[parsed.root] = this.get(parsed.root);
    }
    return bindings;
  }

  describeReferencesForStep(step) {
    return this.referencesInStep(step).map((reference) => {
      const parsed = this.parseReference(reference);
      const metadata = this.metadata.get(parsed.root) || {};
      const masked = Boolean(metadata.masked);
      let valuePreview;
      if (!masked) {
        try {
          valuePreview = preview(this.get(reference));
        } catch {
          // 缺失变量由 bindingsForStep 抛出；这里保留引用诊断，避免掩盖真实错误。
        }
      }
      return {
        reference,
        variable_name: parsed.root,
        value_masked: masked ? 1 : 0,
        ...(valuePreview != null ? { value_preview: valuePreview } : {}),
        source: metadata.source || '',
      };
    });
  }

  describe(name) {
    const normalized = String(name || '').trim();
    const metadata = this.metadata.get(normalized) || {};
    const value = this.values.get(normalized);
    return {
      variable_name: normalized,
      value_masked: metadata.masked ? 1 : 0,
      ...(metadata.masked ? {} : { value_preview: preview(value) }),
      source: metadata.source || '',
    };
  }

  parseReference(reference) {
    const normalized = String(reference || '').trim();
    const variableName = [...this.values.keys()]
      .filter((candidate) => normalized === candidate
        || normalized.startsWith(`${candidate}.`)
        || normalized.startsWith(`${candidate}[`))
      .sort((left, right) => right.length - left.length)[0];
    if (variableName) {
      return { root: variableName, segments: parseReferenceSegments(normalized.slice(variableName.length), normalized) };
    }
    return parseVariableReference(normalized);
  }
}

export function createVariableContext(initialValues = {}) {
  return new VariableContext(initialValues);
}

export function validateVariableName(name, allowReserved = false) {
  const normalized = String(name || '').trim();
  if (!VARIABLE_NAME.test(normalized)) {
    throw new RunnerError('VARIABLE_NAME_INVALID', `变量名不合法：${normalized || '(空)'}`);
  }
  if (!allowReserved && RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw new RunnerError('VARIABLE_NAME_INVALID', `变量名不允许使用保留前缀：${normalized}`);
  }
  return normalized;
}

/**
 * 仅支持数字、变量替换后的四则运算、括号和空白。绝不使用 eval/Function，
 * 避免用户配置借全局变量公式执行任意 Node 代码。
 */
export function evaluateArithmeticExpression(expression, variableContext) {
  const resolved = String(variableContext?.resolveText(expression) ?? expression ?? '').trim();
  if (!resolved || /[^0-9+\-*/%().\s]/.test(resolved)) {
    throw new RunnerError('VARIABLE_EXPRESSION_INVALID', '计算公式只支持数字、+、-、*、/、%、括号和变量引用');
  }
  const parser = new ArithmeticParser(resolved);
  const value = parser.parse();
  if (!Number.isFinite(value)) {
    throw new RunnerError('VARIABLE_EXPRESSION_INVALID', '计算公式结果不是有限数字');
  }
  return value;
}

function resolveRuntimeValue(value, variableContext, isRoot = false) {
  if (typeof value === 'string') return variableContext.resolveText(value);
  if (Array.isArray(value)) return value.map((item) => resolveRuntimeValue(item, variableContext));
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((copy, [key, item]) => {
    copy[key] = isRoot && STEP_METADATA_KEYS.has(key)
      ? item
      : resolveRuntimeValue(item, variableContext);
    return copy;
  }, {});
}

function collectReferences(value, references, isRoot = false) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{([^{}]+)}|\{\{([^{}]+)}}/g)) {
      references.add(String(match[1] ?? match[2]).trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferences(item, references));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, item]) => {
    if (!(isRoot && STEP_METADATA_KEYS.has(key))) collectReferences(item, references);
  });
}

function parseVariableReference(reference) {
  const normalized = String(reference || '').trim();
  const rootMatch = normalized.match(/^([A-Za-z_][A-Za-z0-9_.-]*)(.*)$/);
  if (!rootMatch) {
    throw new RunnerError('VARIABLE_NOT_FOUND', `变量引用格式不合法：${normalized}`);
  }
  // 精确变量名优先；这里的根名只在变量不存在精确匹配时用于对象导航。
  const root = rootMatch[1].split('.')[0];
  return { root, segments: parseReferenceSegments(normalized.slice(root.length), normalized) };
}

function parseReferenceSegments(suffix, normalized) {
  const segments = [];
  let cursor = suffix;
  while (cursor) {
    const dot = cursor.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)/);
    const index = cursor.match(/^\[(\d+|"[^"]+"|'[^']+')]/);
    if (dot) {
      segments.push(dot[1]);
      cursor = cursor.slice(dot[0].length);
    } else if (index) {
      const raw = index[1];
      segments.push(/^\d+$/.test(raw) ? Number(raw) : raw.slice(1, -1));
      cursor = cursor.slice(index[0].length);
    } else {
      throw new RunnerError('VARIABLE_NOT_FOUND', `变量引用格式不合法：${normalized}`);
    }
  }
  return segments;
}

function stringifyVariable(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function preview(value) {
  const text = stringifyVariable(value).replace(/[\r\n]+/g, ' ');
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

class ArithmeticParser {
  constructor(source) {
    this.source = source;
    this.position = 0;
  }

  parse() {
    const value = this.parseExpression();
    this.skipWhitespace();
    if (this.position !== this.source.length) {
      throw new RunnerError('VARIABLE_EXPRESSION_INVALID', '计算公式包含无法解析的内容');
    }
    return value;
  }

  parseExpression() {
    let value = this.parseTerm();
    while (true) {
      this.skipWhitespace();
      if (this.consume('+')) value += this.parseTerm();
      else if (this.consume('-')) value -= this.parseTerm();
      else return value;
    }
  }

  parseTerm() {
    let value = this.parseFactor();
    while (true) {
      this.skipWhitespace();
      if (this.consume('*')) value *= this.parseFactor();
      else if (this.consume('/')) {
        const divisor = this.parseFactor();
        if (divisor === 0) throw new RunnerError('VARIABLE_EXPRESSION_INVALID', '计算公式不能除以 0');
        value /= divisor;
      } else if (this.consume('%')) {
        const divisor = this.parseFactor();
        if (divisor === 0) throw new RunnerError('VARIABLE_EXPRESSION_INVALID', '计算公式不能对 0 取模');
        value %= divisor;
      } else return value;
    }
  }

  parseFactor() {
    this.skipWhitespace();
    if (this.consume('+')) return this.parseFactor();
    if (this.consume('-')) return -this.parseFactor();
    if (this.consume('(')) {
      const value = this.parseExpression();
      this.skipWhitespace();
      if (!this.consume(')')) throw new RunnerError('VARIABLE_EXPRESSION_INVALID', '计算公式括号不匹配');
      return value;
    }
    const number = this.source.slice(this.position).match(/^(?:\d+(?:\.\d+)?|\.\d+)/);
    if (!number) throw new RunnerError('VARIABLE_EXPRESSION_INVALID', '计算公式缺少数字');
    this.position += number[0].length;
    return Number(number[0]);
  }

  consume(character) {
    if (this.source[this.position] !== character) return false;
    this.position += 1;
    return true;
  }

  skipWhitespace() {
    while (/\s/.test(this.source[this.position] || '')) this.position += 1;
  }
}
