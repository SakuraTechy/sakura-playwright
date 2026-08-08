import { RunnerError } from '../shared/utils.js';

const ASSERTION_MATCH_MODES = new Set(['contains', 'equals', 'not_contains', 'regex', 'visible']);
const RECORDING_SOURCE = 'cuecast-v1.2';

/**
 * 只转换 Runner 内存中的执行副本，Admin 保存的 playwright_step 仍是录制事实来源。
 */
export function adaptCuecastRecordedStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
  const action = String(step.action_type || '').trim().toLowerCase();
  if (action === 'set_variable') return adaptRecordedVariable(step);
  if (action === 'assert_text') return adaptRecordedAssertion(step);
  return { ...step };
}

function adaptRecordedVariable(step) {
  const locatorMeta = parseLocatorMeta(step.locator_meta, step, true);
  const variable = locatorMeta?.context?.variable;
  if (!variable || typeof variable !== 'object' || Array.isArray(variable)) {
    throw recordedStepError(
      'RECORDED_VARIABLE_METADATA_MISSING',
      step,
      'CueCast 保存变量步骤缺少 locator_meta.context.variable',
    );
  }
  const variableName = String(variable.name ?? step.value ?? '').trim();
  if (!variableName) {
    throw recordedStepError('RECORDED_VARIABLE_NAME_MISSING', step, 'CueCast 保存变量步骤缺少变量名');
  }
  assertRecordedTarget(step, locatorMeta);

  const source = String(variable.source || 'text').trim().toLowerCase();
  if (!['value', 'text', 'contenteditable'].includes(source)) {
    throw recordedStepError(
      'RECORDED_VARIABLE_SOURCE_UNSUPPORTED',
      step,
      `CueCast 保存变量步骤不支持读取来源：${source || '(空)'}`,
    );
  }
  const extract = variable.extract && typeof variable.extract === 'object' ? variable.extract : {};
  const extractMode = String(extract.mode || 'full').trim().toLowerCase();
  if (!['full', 'regex'].includes(extractMode)) {
    throw recordedStepError(
      'RECORDED_VARIABLE_EXTRACT_UNSUPPORTED',
      step,
      `CueCast 保存变量步骤不支持抽取方式：${extractMode || '(空)'}`,
    );
  }

  const adapted = {
    ...step,
    action_type: 'global_variable_set',
    original_action_type: 'set_variable',
    recording_source: RECORDING_SOURCE,
    variable_name: variableName,
    source_type: 'locator',
    read_mode: source === 'value' ? 'value' : 'text',
  };
  if (extractMode === 'regex') {
    const pattern = String(extract.pattern ?? '');
    if (!pattern) {
      throw recordedStepError('RECORDED_VARIABLE_REGEX_MISSING', step, 'CueCast 保存变量步骤缺少正则表达式');
    }
    adapted.regex = pattern;
    adapted.regex_group = extract.group ?? 0;
  }
  return adapted;
}

function adaptRecordedAssertion(step) {
  const locatorMeta = parseLocatorMeta(step.locator_meta, step, false);
  if (!locatorMeta) return { ...step };
  const assertion = locatorMeta.assertion || locatorMeta.context?.assertion;
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) return { ...step };
  if (String(assertion.target || 'element').trim().toLowerCase() !== 'element') return { ...step };
  assertRecordedTarget(step, locatorMeta);

  const matchMode = String(assertion.match || '').trim().toLowerCase();
  if (!ASSERTION_MATCH_MODES.has(matchMode)) {
    throw recordedStepError(
      'RECORDED_ASSERTION_MATCH_UNSUPPORTED',
      step,
      `CueCast 元素断言不支持匹配方式：${matchMode || '(空)'}`,
    );
  }
  const source = String(locatorMeta.context?.assertion?.source || 'auto').trim().toLowerCase();
  const readMode = source === 'contenteditable' ? 'text' : source;
  if (!['auto', 'text', 'value'].includes(readMode)) {
    throw recordedStepError(
      'RECORDED_ASSERTION_SOURCE_UNSUPPORTED',
      step,
      `CueCast 元素断言不支持读取来源：${source || '(空)'}`,
    );
  }
  const expected = matchMode === 'visible' ? '' : String(step.value ?? '');
  if (matchMode !== 'visible' && !expected) {
    throw recordedStepError('RECORDED_ASSERTION_EXPECT_MISSING', step, 'CueCast 元素断言缺少期望值');
  }
  return {
    ...step,
    action_type: 'assert_element_match',
    original_action_type: 'assert_text',
    recording_source: RECORDING_SOURCE,
    read_mode: readMode,
    match_mode: matchMode,
    expect: expected,
  };
}

function parseLocatorMeta(value, step, required) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      if (!required) return null;
    }
  }
  if (!required) return null;
  throw recordedStepError('RECORDED_LOCATOR_META_INVALID', step, 'CueCast 录制步骤的 locator_meta 不是合法对象');
}

function assertRecordedTarget(step, locatorMeta) {
  const candidates = Array.isArray(locatorMeta?.candidates) ? locatorMeta.candidates : [];
  const hasCandidate = candidates.some((candidate) => String(candidate?.value || '').trim());
  if (String(step.target_selector || step.target_xpath || '').trim() || hasCandidate) return;
  throw recordedStepError('RECORDED_TARGET_MISSING', step, 'CueCast 录制步骤缺少目标元素定位信息');
}

function recordedStepError(code, step, message) {
  return new RunnerError(code, message, {
    step_id: step?.id ?? null,
    step_index: step?.step_index ?? null,
    action_type: step?.action_type || '',
  });
}
