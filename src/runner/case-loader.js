import { RunnerError } from '../shared/utils.js';

export function normalizeCase(testCase, options = {}) {
  if (!testCase || typeof testCase !== 'object') {
    throw new RunnerError('CASE_INVALID', 'Test case response is empty or invalid');
  }
  const steps = normalizeSteps(testCase.steps || [], options.startStep || 0);
  const startUrl = String(testCase.start_url || steps[0]?.url || '').trim();
  if (!startUrl) {
    throw new RunnerError('CASE_INVALID', 'Test case start_url is missing');
  }
  return {
    ...testCase,
    id: testCase.id ?? options.caseId,
    start_url: startUrl,
    steps,
  };
}

export function normalizeSteps(rawSteps, startStep = 0) {
  const steps = (Array.isArray(rawSteps) ? rawSteps : [])
    .map((step, index) => ({
      id: step.id ?? index + 1,
      original_step_id: step.original_step_id ?? null,
      step_index: Number.isInteger(Number(step.step_index)) ? Number(step.step_index) : index,
      action_type: String(step.action_type || 'click').trim().toLowerCase(),
      target_selector: step.target_selector ?? '',
      target_xpath: step.target_xpath ?? '',
      locator_meta: step.locator_meta ?? null,
      value: step.value ?? '',
      value_masked: step.value_masked === true || step.value_masked === 1 || step.value_masked === '1' ? 1 : 0,
      url: step.url ?? '',
      description: step.description ?? '',
      wait_before: Number(step.wait_before) || 0,
      is_overlay: step.is_overlay === true || step.is_overlay === 1 || step.is_overlay === '1' ? 1 : 0,
    }))
    .sort((a, b) => a.step_index - b.step_index);

  return ensureUniqueStepIds(steps).filter((_, index) => index >= startStep);
}

function ensureUniqueStepIds(steps) {
  const usedIds = new Set();
  return steps.map((step) => {
    const key = stepIdKey(step.id);
    if (!usedIds.has(key)) {
      usedIds.add(key);
      return step;
    }

    let suffix = String(step.step_index);
    let uniqueId = `${String(step.id)}__${suffix}`;
    while (usedIds.has(stepIdKey(uniqueId))) {
      suffix = `${suffix}_duplicate`;
      uniqueId = `${String(step.id)}__${suffix}`;
    }
    usedIds.add(stepIdKey(uniqueId));
    return {
      ...step,
      id: uniqueId,
      // 异常旧数据仍保留录制 ID，执行结果使用唯一 ID，避免报告和前端行键覆盖。
      original_step_id: step.original_step_id ?? step.id,
    };
  });
}

function stepIdKey(value) {
  return String(value);
}

export function resolveViewport(testCase, options = {}) {
  const mode = resolveWindowSizeMode(testCase);
  if (mode === 'maximized' && options.headed) return null;

  const width = Number(testCase.viewport_width);
  const height = Number(testCase.viewport_height);
  if ((mode === 'current' || mode === 'custom') && Number.isFinite(width) && Number.isFinite(height) && width >= 320 && height >= 320) {
    return { width: Math.floor(width), height: Math.floor(height) };
  }
  return { width: 1920, height: 1080 };
}

export function shouldLaunchMaximized(testCase, options = {}) {
  return Boolean(options.headed) && resolveWindowSizeMode(testCase) === 'maximized';
}

function resolveWindowSizeMode(testCase) {
  const raw = String(testCase?.window_size_mode || '').toLowerCase();
  if (['current', 'current_window', 'current-window'].includes(raw)) return 'current';
  if (['custom', 'custom_size', 'custom-size'].includes(raw)) return 'custom';
  return 'maximized';
}
