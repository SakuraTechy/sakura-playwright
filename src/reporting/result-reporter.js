import { durationMs, formatPlatformDateTime, serializeError } from '../shared/utils.js';

export function createRunResult({ config, artifacts, startedAt }) {
  const result = {
    case_id: Number(config.caseId) || config.caseId,
    job_id: config.jobId || '',
    batch_id: config.batchId || '',
    run_id: artifacts.runId,
    executor: 'playwright-runner',
    status: 'running',
    success: false,
    started_at: formatPlatformDateTime(startedAt),
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
    raw: {
      project_environment_id: config.projectEnvironmentId || '',
      execution_id: config.executionId || '',
      session_mode: config.sessionMode,
      auth_state_loaded: false,
      auth_state_saved: false,
      ignore_https_errors: config.ignoreHttpsErrors,
      locator_mode: config.locatorMode,
      page_error_check_enabled: config.pageErrorCheckEnabled,
      step_timeout_ms: config.timeoutMs,
      case_timeout_ms: config.caseTimeoutMs,
      slow_mo_ms: config.slowMoMs,
      finish_delay_ms: config.finishDelayMs,
      trace_policy: config.trace,
      video_policy: config.video,
    },
  };
  return result;
}

export function attachCaseInfo(result, testCase) {
  result.raw.case_name = testCase.name || '';
  result.raw.project_short_name = testCase.project_short_name || testCase.projectShortName || '';
  result.raw.version_name = testCase.version_name || testCase.versionName || '';
  result.raw.scene_id = testCase.scene_id || testCase.sceneId || '';
  result.raw.scene_name = testCase.scene_name || testCase.sceneName || '';
  result.raw.business_case_id = testCase.case_id || testCase.caseId || '';
  result.raw.start_url = testCase.start_url;
  result.raw.environment_origin = testCase.environment_origin || testCase.environmentOrigin || '';
  result.raw.project_environment_name = testCase.project_environment_name || testCase.projectEnvironmentName || '';
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
    ...(step.original_step_id != null ? { original_step_id: step.original_step_id } : {}),
    action_type: step.action_type,
    status: 'failed',
    duration_ms: durationMs(startedAt),
    error: serialized.message,
    error_code: serialized.code,
    locator_source: serialized.details?.source || serialized.details?.locator_source || '',
    locator_type: serialized.details?.locatorType || serialized.details?.locator_type || '',
    locator_value: serialized.details?.locatorValue || serialized.details?.locator_value || '',
    matched_count: serialized.details?.matchedCount ?? null,
    visible_count: serialized.details?.visibleCount ?? null,
    details: serialized.details,
  });
  return serialized;
}

export function markStepSkipped(result, step, error, startedAt) {
  const serialized = serializeError(error);
  result.steps.push({
    step_index: step.step_index,
    step_id: step.id,
    ...(step.original_step_id != null ? { original_step_id: step.original_step_id } : {}),
    action_type: step.action_type,
    status: 'skipped',
    duration_ms: durationMs(startedAt),
    error: serialized.message,
    error_code: serialized.code,
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
  result.finished_at = formatPlatformDateTime();
  result.duration_ms = durationMs(startedAt);
  result.step_duration_ms = result.steps.reduce(
    (total, step) => total + Math.max(0, Number(step.duration_ms) || 0),
    0,
  );
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
