import { durationMs, serializeError } from './utils.js';

export function createRunResult({ config, artifacts, startedAt }) {
  return {
    case_id: Number(config.caseId) || config.caseId,
    run_id: artifacts.runId,
    executor: 'playwright-runner',
    status: 'running',
    success: false,
    started_at: new Date(startedAt).toISOString(),
    finished_at: '',
    duration_ms: 0,
    browser: config.browser,
    headless: !config.headed,
    failed_step_index: null,
    error: '',
    steps: [],
    artifacts: {
      run_dir: artifacts.runDir,
      result_json: artifacts.resultPath,
      screenshots: [],
      videos: [],
      logs: [],
      dom_snapshots: [],
    },
    raw: {},
  };
}

export function attachCaseInfo(result, testCase) {
  result.raw.case_name = testCase.name || '';
  result.raw.start_url = testCase.start_url;
  result.raw.window_size_mode = testCase.window_size_mode || 'maximized';
  result.raw.viewport_width = testCase.viewport_width ?? null;
  result.raw.viewport_height = testCase.viewport_height ?? null;
  return result;
}

export function markStepFailed(result, step, error, startedAt) {
  const serialized = serializeError(error);
  result.failed_step_index = step.step_index;
  result.steps.push({
    step_index: step.step_index,
    step_id: step.id,
    action_type: step.action_type,
    status: 'failed',
    duration_ms: durationMs(startedAt),
    error: serialized.message,
    error_code: serialized.code,
    locator_source: serialized.details?.source || serialized.details?.locator_source || '',
    locator_type: serialized.details?.locatorType || serialized.details?.locator_type || '',
    details: serialized.details,
  });
  return serialized;
}

export function markRunPassed(result) {
  result.status = 'passed';
  result.success = true;
  return result;
}

export function markRunFailed(result, error) {
  const serialized = serializeError(error);
  result.status = 'failed';
  result.success = false;
  result.error = serialized.message;
  result.error_code = serialized.code;
  result.error_details = serialized.details;
  return serialized;
}

export function finalizeRunResult(result, startedAt) {
  result.finished_at = new Date().toISOString();
  result.duration_ms = durationMs(startedAt);
  return result;
}

export async function reportRunResult(api, caseId, result) {
  return api.saveResult(caseId, {
    status: result.status,
    success: result.success,
    duration_ms: result.duration_ms,
    error: result.error,
    raw: result,
  });
}
