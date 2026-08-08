import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseLocatorMeta, resolveLocator } from './locator-resolver.js';
import { isOverlayStep } from './semantic-locator-resolver.js';
import { showStepAction } from './action-visualizer.js';
import { collectPageSummary, throwIfPageError } from './page-state-diagnostics.js';
import { isInfrastructureStep, runInfrastructureStep } from './infrastructure-step-runner.js';
import { isPlaywrightActionSupported, normalizeActionType } from './action-registry.js';
import { isLocalVariableAction, runLocalVariableAction } from './global-variable-actions.js';
import { formatPlatformDateTime, RunnerError, sleep } from '../shared/utils.js';

export async function runStep(page, testCase, step, options = {}) {
  const startedAt = Date.now();
  options = resolveBrowserActionOptions(options);
  if (step.wait_before > 0) await sleep(step.wait_before);
  const action = normalizeActionType(step.action_type);

  // 基础设施动作不能经过页面错误检测、locator 或 Playwright 可视化；
  // 它们由服务端按冻结步骤和环境绑定创建受控任务。
  if (isInfrastructureStep(step)) {
    const result = await runInfrastructureStep(testCase, step, options);
    return {
      ...result,
      duration_ms: result.duration_ms ?? Date.now() - startedAt,
    };
  }

  if (isLocalVariableAction(action)) {
    if (!isPlaywrightActionSupported(action)) {
      throw new RunnerError('UNSUPPORTED_STEP', `Unsupported action_type: ${step.action_type}`, { action_type: step.action_type });
    }
    const localResult = await runLocalVariableAction(page, step, options);
    const variable = localResult.variable || {};
    const locatorInfo = localResult.locatorInfo;
    const variableDetails = variable.variable_name ? {
      variable_name: variable.variable_name,
      value_masked: variable.value_masked,
      ...(variable.value_preview != null ? { value_preview: variable.value_preview } : {}),
      source: variable.source || '',
    } : null;
    await sleep(options.afterStepDelayMs ?? 0);
    return {
      step_index: step.step_index,
      step_id: step.id,
      ...(step.original_step_id != null ? { original_step_id: step.original_step_id } : {}),
      action_type: action,
      status: 'passed',
      duration_ms: Date.now() - startedAt,
      ...(variable.variable_name ? {
        variable_name: variable.variable_name,
        value_masked: variable.value_masked,
        ...(variable.value_preview != null ? { value_preview: variable.value_preview } : {}),
      } : {}),
      ...(locatorInfo ? {
        locator_source: locatorInfo.source || '',
        locator_type: locatorInfo.locatorType || '',
        locator_value: locatorInfo.locatorValue || '',
        matched_count: locatorInfo.matchedCount ?? null,
        visible_count: locatorInfo.visibleCount ?? null,
      } : {}),
      ...(variableDetails ? { details: { variable: variableDetails } } : {}),
      ...(localResult.operation_assertion ? { operation_assertion: localResult.operation_assertion } : {}),
    };
  }

  if (action === 'captcha_ocr') {
    return runCaptchaOcr(page, testCase, step, options, startedAt);
  }

  if (!isPlaywrightActionSupported(action)) {
    throw new RunnerError('UNSUPPORTED_STEP', `Unsupported action_type: ${step.action_type}`, { action_type: step.action_type });
  }
  let locatorInfo = null;
  let extra = {};
  let operationAssertion = null;

  await throwIfPageError(page, options.pageErrorCheckEnabled);
  if (!isDialogAction(action)) {
    armNextDialogAction(page, options.nextStep, options);
  }

  switch (action) {
    case 'navigate': {
      const url = String(step.value || step.url || testCase.start_url || '').trim();
      if (!url) throw new RunnerError('CASE_INVALID', 'navigate step has no URL');
      await showStepAction(page, step, null, options);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      resetActiveFrame(options);
      break;
    }

    case 'click': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      await runLocatorAction(page, locatorInfo, options, () => locatorInfo.locator.click({ timeout: options.timeoutMs }));
      break;
    }

    case 'click_open_page': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      extra = await runLocatorAction(page, locatorInfo, options, () => clickOpenPage(page, locatorInfo.locator, options));
      resetActiveFrame(options);
      break;
    }

    case 'switch_page': {
      await showStepAction(page, step, null, options);
      extra = await switchPage(page, step.value, options);
      resetActiveFrame(options);
      break;
    }

    case 'close_page': {
      await showStepAction(page, step, null, options);
      extra = await closePage(page, step.value, options);
      resetActiveFrame(options);
      break;
    }

    case 'close_all_pages': {
      await showStepAction(page, step, null, options);
      extra = await closeAllPages(page, options);
      resetActiveFrame(options);
      break;
    }

    case 'reload': {
      await showStepAction(page, step, null, options);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      resetActiveFrame(options);
      extra = { reloaded: true };
      break;
    }

    case 'frame_switch': {
      const frameResult = await switchFrame(page, step, options);
      locatorInfo = frameResult.locatorInfo;
      extra = frameResult.extra;
      break;
    }

    case 'frame_parent': {
      extra = switchToParentFrame(page, options);
      break;
    }

    case 'frame_main': {
      extra = switchToMainFrame(options);
      break;
    }

    case 'evaluate': {
      await showStepAction(page, step, null, options);
      const result = await executeBrowserScript(getActionRoot(page, options), scriptFromStep(step, 'evaluate'));
      extra = { evaluated: true, evaluation_result_type: valueType(result) };
      break;
    }

    case 'double_click': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      await runLocatorAction(page, locatorInfo, options, () => locatorInfo.locator.dblclick({ timeout: options.timeoutMs }));
      break;
    }

    case 'right_click': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      await runLocatorAction(page, locatorInfo, options, () => locatorInfo.locator.click({ button: 'right', timeout: options.timeoutMs }));
      break;
    }

    case 'select_option': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      extra = await runLocatorAction(
        page,
        locatorInfo,
        options,
        () => selectOption(page, getActionRoot(page, options), locatorInfo.locator, selectValueFromStep(step), options),
      );
      break;
    }

    case 'combo_select': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      extra = await runLocatorAction(
        page,
        locatorInfo,
        options,
        () => selectComboOption(page, getActionRoot(page, options), locatorInfo.locator, step, options),
      );
      break;
    }

    case 'dialog_accept':
    case 'dialog_dismiss':
    case 'dialog_prompt': {
      await showStepAction(page, step, null, options);
      extra = completeOrArmDialogAction(page, step, options);
      break;
    }

    case 'input': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      await runLocatorAction(
        page,
        locatorInfo,
        options,
        () => fillInput(page, locatorInfo.locator, step.value ?? '', options, step, getActionRoot(page, options)),
      );
      break;
    }

    case 'input_date': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      const dateValue = resolveDateInputValue(step);
      await runLocatorAction(
        page,
        locatorInfo,
        options,
        () => fillInput(page, locatorInfo.locator, dateValue, options, step, getActionRoot(page, options)),
      );
      extra = { input_date_value: dateValue };
      break;
    }

    case 'file_upload': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      extra = await uploadFiles(getActionRoot(page, options), locatorInfo.locator, fileValueFromStep(step), options);
      break;
    }

    case 'certificate_upload': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      extra = await uploadCertificate(getActionRoot(page, options), locatorInfo.locator, certificateValueFromStep(step), options);
      break;
    }

    case 'clear': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      await runLocatorAction(
        page,
        locatorInfo,
        options,
        () => clearInput(page, locatorInfo.locator, options),
      );
      break;
    }

    case 'assert_download': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      extra = await runLocatorAction(
        page,
        locatorInfo,
        options,
        () => assertDownload(page, locatorInfo.locator, step.value, options),
      );
      break;
    }

    case 'assert_json': {
      await showStepAction(page, step, null, options);
      locatorInfo = await runAssertJson(page, step, options);
      break;
    }

    case 'assert_request': {
      locatorInfo = hasLocator(step) ? await resolveStepLocator(page, step, options) : null;
      await showStepAction(page, step, locatorInfo?.locator || null, options);
      extra = locatorInfo
        ? await runLocatorAction(
          page,
          locatorInfo,
          options,
          () => assertRequest(page, locatorInfo.locator, step.value, options),
        )
        : await assertRequest(page, null, step.value, options);
      break;
    }

    case 'assert_response': {
      locatorInfo = hasLocator(step) ? await resolveStepLocator(page, step, options) : null;
      await showStepAction(page, step, locatorInfo?.locator || null, options);
      extra = locatorInfo
        ? await runLocatorAction(
          page,
          locatorInfo,
          options,
          () => assertResponse(page, locatorInfo.locator, step.value, options, step),
        )
        : await assertResponse(page, null, step.value, options, step);
      break;
    }

    case 'assert_request_count': {
      await showStepAction(page, step, null, options);
      extra = assertRequestCount(step.value, options);
      break;
    }

    case 'network_mock': {
      await showStepAction(page, step, null, options);
      extra = await registerNetworkMock(page, step.value);
      break;
    }

    case 'network_replay': {
      await showStepAction(page, step, null, options);
      extra = await registerNetworkReplay(page, step.value);
      break;
    }

    case 'key': {
      if (hasLocator(step)) {
        locatorInfo = await resolveStepLocator(page, step, options);
        await showStepAction(page, step, locatorInfo.locator, options);
        await runLocatorAction(
          page,
          locatorInfo,
          options,
          () => locatorInfo.locator.press(String(step.value || 'Enter'), { timeout: options.timeoutMs }),
        );
      } else {
        await showStepAction(page, step, null, options);
        await page.keyboard.press(String(step.value || 'Enter'));
      }
      break;
    }

    case 'hover': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      await runLocatorAction(page, locatorInfo, options, () => locatorInfo.locator.hover({ timeout: options.timeoutMs }));
      break;
    }

    case 'wait': {
      await showStepAction(page, step, null, options);
      const waitDurationMs = Number(step.value) || step.wait_before || 1000;
      extra = { wait_duration_ms: await waitWithCountdown(waitDurationMs, options.onWaitCountdown) };
      break;
    }

    case 'scroll':
    case 'scroll_to_element': {
      locatorInfo = hasLocator(step) ? await resolveStepLocator(page, step, options) : null;
      await showStepAction(page, step, locatorInfo?.locator || null, options);
      await runScroll(page, step, options, locatorInfo?.locator || null);
      break;
    }

    case 'assert_text': {
      locatorInfo = hasLocator(step) ? await resolveStepLocator(page, step, options) : null;
      await showStepAction(page, step, locatorInfo?.locator || null, options);
      const assertionResult = await runAssertText(page, step, options, locatorInfo);
      locatorInfo = assertionResult.locatorInfo;
      operationAssertion = assertionResult.assertion;
      break;
    }

    case 'assert_text_not': {
      locatorInfo = hasLocator(step) ? await resolveStepLocator(page, step, options) : null;
      await showStepAction(page, step, locatorInfo?.locator || null, options);
      const assertionResult = await runAssertTextNot(page, step, options, locatorInfo);
      locatorInfo = assertionResult.locatorInfo;
      operationAssertion = assertionResult.assertion;
      break;
    }

    case 'assert_attribute': {
      locatorInfo = await resolveStepLocator(page, step, options);
      await showStepAction(page, step, locatorInfo.locator, options);
      operationAssertion = await assertAttribute(locatorInfo.locator, step, options);
      break;
    }

    case 'assert_script': {
      await showStepAction(page, step, null, options);
      const actual = await executeBrowserScript(getActionRoot(page, options), scriptFromStep(step, 'assert_script'));
      assertValueEquals(actual, expectedFromStep(step), step, 'script result');
      operationAssertion = createAssertion('脚本返回值', 'equals', expectedFromStep(step), actual);
      extra = { script_result_type: valueType(actual) };
      break;
    }

    case 'assert_text_regex': {
      locatorInfo = hasLocator(step) ? await resolveStepLocator(page, step, options) : null;
      await showStepAction(page, step, locatorInfo?.locator || null, options);
      const assertionResult = await runAssertTextRegex(page, step, options, locatorInfo);
      locatorInfo = assertionResult.locatorInfo;
      operationAssertion = assertionResult.assertion;
      break;
    }

    case 'assert_element_match': {
      locatorInfo = await resolveStepLocator(page, step, {
        ...options,
        allowHidden: String(step.match_mode || '').trim().toLowerCase() === 'visible',
      });
      await showStepAction(page, step, locatorInfo.locator, options);
      operationAssertion = await runAssertElementMatch(locatorInfo.locator, step, options);
      break;
    }

    case 'implicit_wait': {
      const timeoutMs = resolveImplicitWaitMs(step);
      const context = browserContextFor(options);
      const previousTimeoutMs = context.defaultTimeoutMs || options.timeoutMs;
      context.defaultTimeoutMs = timeoutMs;
      extra = { implicit_wait_ms: timeoutMs, previous_implicit_wait_ms: previousTimeoutMs };
      break;
    }

    case 'pointer_move': {
      await showStepAction(page, step, null, options);
      extra = await movePointer(page, step, options);
      break;
    }

    default:
      throw new RunnerError('UNSUPPORTED_STEP', `Unsupported action_type: ${step.action_type}`, { action_type: step.action_type });
  }

  const pageErrorDetails = {
    locator_diagnostics: locatorInfo?.diagnostics,
    recent_resource_failures: recentResourceFailures(options),
  };
  await throwIfPageError(page, options.pageErrorCheckEnabled, pageErrorDetails);
  await sleep(options.afterStepDelayMs ?? 250);
  // 部分接口错误提示在点击完成后异步出现；最后一步也必须在稳定等待后再检查一次。
  await throwIfPageError(page, options.pageErrorCheckEnabled, pageErrorDetails);
  return {
    step_index: step.step_index,
    step_id: step.id,
    ...(step.original_step_id != null ? { original_step_id: step.original_step_id } : {}),
    action_type: action,
    status: 'passed',
    duration_ms: Date.now() - startedAt,
    locator_source: locatorInfo?.source || '',
    locator_type: locatorInfo?.locatorType || '',
    locator_value: locatorInfo?.locatorValue || '',
    matched_count: locatorInfo?.matchedCount ?? null,
    visible_count: locatorInfo?.visibleCount ?? null,
    ...(locatorInfo?.diagnostics ? { details: { locator_diagnostics: locatorInfo.diagnostics } } : {}),
    ...(operationAssertion ? { operation_assertion: operationAssertion } : {}),
    ...extra,
  };
}

export async function waitWithCountdown(durationMs, onCountdown, sleeper = sleep) {
  const totalMs = Math.max(0, Number(durationMs) || 0);
  let remainingMs = totalMs;
  while (remainingMs > 0) {
    onCountdown?.(Math.ceil(remainingMs / 1000));
    const intervalMs = Math.min(1000, remainingMs);
    await sleeper(intervalMs);
    remainingMs -= intervalMs;
  }
  return totalMs;
}

const FALLBACK_BROWSER_CONTEXTS = new WeakMap();
const DIALOG_ACTIONS = new Set(['dialog_accept', 'dialog_dismiss', 'dialog_prompt']);

/**
 * 每条用例独占浏览器执行上下文。Playwright 没有 Selenium 的全局 switchTo(frame)，
 * 因此必须显式保存当前 Frame 和后续定位超时，避免并发用例相互污染。
 */
export function createBrowserActionContext({ defaultTimeoutMs } = {}) {
  return {
    defaultTimeoutMs: positiveTimeout(defaultTimeoutMs),
    activeFrame: null,
    pointerPosition: { x: 0, y: 0 },
    dialogPlan: null,
  };
}

function resolveBrowserActionOptions(options) {
  const browserContext = browserContextFor(options);
  const timeoutMs = positiveTimeout(browserContext.defaultTimeoutMs);
  return timeoutMs
    ? { ...options, browserContext, timeoutMs }
    : { ...options, browserContext };
}

function browserContextFor(options = {}) {
  if (options.browserContext && typeof options.browserContext === 'object') {
    normalizeBrowserContext(options.browserContext);
    return options.browserContext;
  }
  if (options && typeof options === 'object') {
    let context = FALLBACK_BROWSER_CONTEXTS.get(options);
    if (!context) {
      context = createBrowserActionContext();
      FALLBACK_BROWSER_CONTEXTS.set(options, context);
    }
    return context;
  }
  return createBrowserActionContext();
}

function normalizeBrowserContext(context) {
  if (!context.pointerPosition || typeof context.pointerPosition !== 'object') {
    context.pointerPosition = { x: 0, y: 0 };
  }
  if (!Number.isFinite(Number(context.pointerPosition.x))) context.pointerPosition.x = 0;
  if (!Number.isFinite(Number(context.pointerPosition.y))) context.pointerPosition.y = 0;
}

function positiveTimeout(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;
}

function resolveStepLocator(page, step, options) {
  return resolveLocator(getActionRoot(page, options), step, options);
}

function getActionRoot(page, options) {
  if (!page || page.isClosed?.()) {
    throw new RunnerError('PAGE_NOT_FOUND', 'No active browser page is available for this step');
  }
  const context = browserContextFor(options);
  const frame = context.activeFrame;
  if (frame && !frame.isDetached?.()) return frame;
  if (frame?.isDetached?.()) context.activeFrame = null;
  return page;
}

function resetActiveFrame(options) {
  const context = browserContextFor(options);
  context.activeFrame = null;
}

async function closeAllPages(currentPage, options) {
  const pages = await getOpenPages(currentPage, options);
  const failures = [];
  await Promise.all(pages.map(async (candidate) => {
    try {
      await candidate.close({ runBeforeUnload: false });
    } catch (error) {
      failures.push({ url: candidate.url?.() || '', message: error?.message || String(error) });
    }
  }));
  if (failures.length) {
    throw new RunnerError('PAGE_CLOSE_FAILED', 'Failed to close all runner pages', { failures });
  }
  return {
    _activePage: null,
    closed_page_count: pages.length,
  };
}

async function switchFrame(page, step, options) {
  const index = frameIndexFromStep(step);
  let frame;
  let locatorInfo = null;
  if (index != null) {
    const parent = activeFrameOrMain(page, options);
    const frames = parent?.childFrames?.() || [];
    frame = frames[index] || null;
    if (!frame) {
      throw new RunnerError('FRAME_NOT_FOUND', `Frame index ${index} was not found`, {
        requested_index: index,
        child_frame_count: frames.length,
      });
    }
  } else {
    locatorInfo = await resolveStepLocator(page, step, options);
    await showStepAction(page, step, locatorInfo.locator, options);
    frame = await frameFromLocator(locatorInfo.locator, options);
    if (!frame) {
      throw new RunnerError('FRAME_NOT_FOUND', 'The resolved element does not contain a frame', {
        locator_source: locatorInfo.source,
        locator_type: locatorInfo.locatorType,
        locator_value: locatorInfo.locatorValue,
      });
    }
  }
  const context = browserContextFor(options);
  context.activeFrame = frame;
  return {
    locatorInfo,
    extra: {
      frame_url: frame.url?.() || '',
      frame_depth: frameDepth(page, frame),
    },
  };
}

function frameIndexFromStep(step) {
  const configured = firstPresent(step.frame_index, step.frameIndex, step.index);
  if (configured !== undefined && configured !== null && String(configured).trim() !== '') {
    const index = Number(configured);
    if (!Number.isInteger(index) || index < 0) {
      throw new RunnerError('FRAME_CONFIG_INVALID', `Invalid frame index: ${configured}`);
    }
    return index;
  }
  // XML/Selenium 的 value 是从 1 开始的 frame 序号；canonical frame_index 始终从 0 开始。
  const legacy = String(step.value ?? '').trim();
  if (!/^\d+$/.test(legacy)) return null;
  return Math.max(0, Number(legacy) - 1);
}

async function frameFromLocator(locator, options) {
  const handle = await locator.elementHandle({ timeout: options.timeoutMs });
  if (!handle) return null;
  try {
    return await handle.contentFrame();
  } finally {
    if (typeof handle.dispose === 'function') await handle.dispose().catch(() => {});
  }
}

function switchToParentFrame(page, options) {
  const context = browserContextFor(options);
  const current = context.activeFrame;
  if (!current) return { frame_depth: 0, frame_url: page.url?.() || '' };
  const parent = current.parentFrame?.();
  const main = page.mainFrame?.();
  context.activeFrame = parent && parent !== main ? parent : null;
  return {
    frame_depth: context.activeFrame ? frameDepth(page, context.activeFrame) : 0,
    frame_url: context.activeFrame?.url?.() || page.url?.() || '',
  };
}

function switchToMainFrame(options) {
  resetActiveFrame(options);
  return { frame_depth: 0 };
}

function activeFrameOrMain(page, options) {
  const active = browserContextFor(options).activeFrame;
  return active && !active.isDetached?.() ? active : page.mainFrame?.() || null;
}

function frameDepth(page, frame) {
  const main = page.mainFrame?.();
  let current = frame;
  let depth = 0;
  while (current && current !== main && depth < 64) {
    depth += 1;
    current = current.parentFrame?.();
  }
  return depth;
}

function isDialogAction(action) {
  return DIALOG_ACTIONS.has(normalizeActionType(action));
}

function armNextDialogAction(page, nextStep, options) {
  const action = normalizeActionType(nextStep?.action_type);
  if (!isDialogAction(action)) return;
  armDialogAction(page, nextStep, options);
}

function completeOrArmDialogAction(page, step, options) {
  const context = browserContextFor(options);
  const action = normalizeActionType(step.action_type);
  const existing = context.dialogPlan;
  if (existing && existing.page === page && existing.action === action) {
    if (existing.status === 'failed') {
      context.dialogPlan = null;
      throw new RunnerError('DIALOG_ACTION_FAILED', existing.error?.message || 'Browser dialog action failed', {
        dialog_type: existing.dialogType || '',
      });
    }
    if (existing.status === 'handled') {
      context.dialogPlan = null;
      return {
        dialog_action: action,
        dialog_handled: true,
        dialog_type: existing.dialogType || '',
      };
    }
    return { dialog_action: action, dialog_armed: true };
  }
  armDialogAction(page, step, options);
  return { dialog_action: action, dialog_armed: true };
}

function armDialogAction(page, step, options) {
  if (!page || typeof page.once !== 'function') {
    throw new RunnerError('DIALOG_UNAVAILABLE', 'Browser page cannot subscribe to dialog events');
  }
  const context = browserContextFor(options);
  const action = normalizeActionType(step.action_type);
  const existing = context.dialogPlan;
  if (existing && existing.page === page && existing.action === action && existing.status === 'armed') {
    return existing;
  }
  if (existing?.page?.off && existing.listener) {
    existing.page.off('dialog', existing.listener);
  }
  const plan = {
    page,
    action,
    promptValue: action === 'dialog_prompt' ? String(firstPresent(step.value, step.prompt_value, step.promptValue) ?? '') : '',
    status: 'armed',
    dialogType: '',
    error: null,
    listener: null,
  };
  plan.listener = async (dialog) => {
    try {
      plan.dialogType = String(dialog.type?.() || '');
      if (plan.action === 'dialog_dismiss') {
        await dialog.dismiss();
      } else if (plan.action === 'dialog_prompt') {
        await dialog.accept(plan.promptValue);
      } else {
        await dialog.accept();
      }
      plan.status = 'handled';
    } catch (error) {
      plan.status = 'failed';
      plan.error = error instanceof Error ? error : new Error(String(error));
    }
  };
  page.once('dialog', plan.listener);
  context.dialogPlan = plan;
  return plan;
}

function scriptFromStep(step, action) {
  const script = String(firstPresent(step.script, step.javascript, step.code, step.value) ?? '').trim();
  if (!script) throw new RunnerError('METHOD_CONFIG_INVALID', `${action} requires script`);
  return script;
}

async function executeBrowserScript(root, script) {
  try {
    // 脚本只在已连接的页面/Frame 中执行，绝不通过 Node eval 执行；保留 Selenium 旧脚本的 return 语义。
    return await root.evaluate((source) => Function(String(source))(), script);
  } catch (error) {
    throw new RunnerError('SCRIPT_EXECUTION_FAILED', `Browser script failed: ${error?.message || String(error)}`);
  }
}

function valueType(value) {
  if (value == null) return String(value);
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function resolveImplicitWaitMs(step) {
  const configured = firstPresent(step.duration_ms, step.timeout_ms, step.timeoutMs);
  const legacyValue = firstPresent(step.value, configured);
  const rawValue = configured ?? legacyValue;
  const number = Number(rawValue);
  if (!Number.isFinite(number) || number < 0) {
    throw new RunnerError('METHOD_CONFIG_INVALID', `Invalid implicit wait duration: ${rawValue}`);
  }
  const unit = String(firstPresent(step.duration_unit, step.durationUnit, step.unit) ?? '').trim().toLowerCase();
  const isCanonical = Boolean(step.catalog_version || step.catalogVersion || step.method_code || step.methodCode || step.source === 'admin-manual');
  if (['s', 'sec', 'second', 'seconds'].includes(unit) || (!unit && !isCanonical && configured == null)) {
    return Math.floor(number * 1000);
  }
  // 新目录明确使用 duration_ms；旧 XML 无单位 value 保持 Selenium 的秒语义。
  if (!unit && !isCanonical && configured != null && String(step.value ?? '').trim() !== '') {
    return Math.floor(number * 1000);
  }
  return Math.floor(number);
}

async function movePointer(page, step, options) {
  const valueConfig = objectValue(step.value);
  const x = Number(firstPresent(step.x, valueConfig?.x));
  const y = Number(firstPresent(step.y, valueConfig?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RunnerError('METHOD_CONFIG_INVALID', 'pointer_move requires numeric x and y');
  }
  const coordinate = String(firstPresent(step.coordinate, step.coordinate_mode, step.coordinateMode, valueConfig?.coordinate) || 'relative')
    .trim()
    .toLowerCase();
  if (!['relative', 'absolute', 'viewport'].includes(coordinate)) {
    throw new RunnerError('METHOD_CONFIG_INVALID', `Unsupported pointer coordinate mode: ${coordinate}`);
  }
  const context = browserContextFor(options);
  const targetX = coordinate === 'relative' ? context.pointerPosition.x + x : x;
  const targetY = coordinate === 'relative' ? context.pointerPosition.y + y : y;
  await page.mouse.move(targetX, targetY, { steps: Math.max(1, Number(step.steps) || 1) });
  context.pointerPosition = { x: targetX, y: targetY };
  return {
    pointer_coordinate_mode: coordinate,
    pointer_x: targetX,
    pointer_y: targetY,
  };
}

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstPresent(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return undefined;
}

/**
 * 截图只在本次 OCR 任务创建请求中以 base64 传递；识别结果由 Agent 返回到变量上下文，
 * 不能进入 Runner 报告或磁盘工件，避免验证码和会话内容被长期保存。
 */
async function runCaptchaOcr(page, testCase, step, options, startedAt) {
  if (!String(step.variable_name || '').trim()) {
    throw new RunnerError('METHOD_CONFIG_INVALID', 'captcha_ocr 缺少 variable_name');
  }
  const locatorInfo = await resolveStepLocator(page, step, options);
  await showStepAction(page, step, locatorInfo.locator, options);
  const image = await locatorInfo.locator.screenshot({ type: 'png', timeout: options.timeoutMs });
  if (!image?.length || image.length > 2 * 1024 * 1024) {
    throw new RunnerError('CAPTCHA_IMAGE_INVALID', '验证码截图为空或超过 2MB 限制');
  }
  const result = await runInfrastructureStep(testCase, step, {
    ...options,
    runtimeInput: { captcha_image_base64: image.toString('base64') },
  });
  return {
    ...result,
    duration_ms: result.duration_ms ?? Date.now() - startedAt,
    locator_source: locatorInfo.source || '',
    locator_type: locatorInfo.locatorType || '',
    locator_value: locatorInfo.locatorValue || '',
    matched_count: locatorInfo.matchedCount ?? null,
    visible_count: locatorInfo.visibleCount ?? null,
  };
}

async function runLocatorAction(page, locatorInfo, options, action) {
  try {
    return await action();
  } catch (error) {
    if (options.locatorMode !== 'semantic-v1') throw error;
    const locatorActionFailed = isLocatorActionFailure(error);
    const actionability = await diagnoseLocatorAction(locatorInfo.locator);
    const details = {
      source: locatorInfo.source,
      locatorType: locatorInfo.locatorType,
      locatorValue: locatorInfo.locatorValue,
      matchedCount: locatorInfo.matchedCount,
      visibleCount: locatorInfo.visibleCount,
      locator_diagnostics: {
        ...(locatorInfo.diagnostics || {}),
        outcome: 'action-failed',
        actionability,
      },
      page: await collectPageSummary(page),
      recent_resource_failures: recentResourceFailures(options),
    };
    // 断言或 popup 等后续等待失败时保留原错误码，只补充定位诊断；仅 Playwright 元素动作失败才重新分类。
    if (error instanceof RunnerError || !locatorActionFailed) {
      if (error && typeof error === 'object') {
        error.details = { ...details, ...(error.details || {}) };
      }
      throw error;
    }
    if (!actionability.attached) {
      throw new RunnerError('LOCATOR_NOT_FOUND', '目标元素在操作前已从页面移除', details);
    }
    if (!actionability.visible) {
      throw new RunnerError('LOCATOR_HIDDEN', '目标元素在操作前不可见', details);
    }
    if (!actionability.enabled) {
      throw new RunnerError('LOCATOR_DISABLED', '目标元素在操作前处于禁用状态', details);
    }
    if (actionability.covered) {
      throw new RunnerError('LOCATOR_COVERED', '目标元素中心点被其他元素遮挡', details);
    }
    if (error && typeof error === 'object') {
      error.details = details;
    }
    throw error;
  }
}

function isLocatorActionFailure(error) {
  const message = String(error?.message || '').toLowerCase();
  return /locator\.(?:click|dblclick|hover|fill|press|type|check|uncheck|setinputfiles)/.test(message)
    || message.includes('waiting for locator')
    || message.includes('element is not visible')
    || message.includes('element is not enabled')
    || message.includes('intercepts pointer events');
}

async function diagnoseLocatorAction(locator) {
  const attached = await locator.count().then((count) => count > 0).catch(() => false);
  if (!attached) return { attached: false, visible: false, enabled: false, covered: false };
  const [visible, enabled, hitTest] = await Promise.all([
    locator.isVisible({ timeout: 0 }).catch(() => false),
    locator.isEnabled({ timeout: 0 }).catch(() => false),
    locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(centerX, centerY);
      const brief = (node) => {
        if (!node) return '';
        const tag = String(node.tagName || '').toLowerCase();
        const id = node.id ? `#${node.id}` : '';
        const cls = typeof node.className === 'string' && node.className.trim()
          ? `.${node.className.trim().replace(/\s+/g, '.')}`
          : '';
        return `${tag}${id}${cls}`.slice(0, 300);
      };
      const receivesEvents = Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element)));
      return {
        target: brief(element),
        hit: brief(hit),
        covered: rect.width > 0 && rect.height > 0 && !receivesEvents,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    }).catch(() => ({ target: '', hit: '', covered: false, rect: null })),
  ]);
  return { attached, visible, enabled, ...hitTest };
}

function recentResourceFailures(options) {
  return (Array.isArray(options.diagnosticEvents) ? options.diagnosticEvents : [])
    .filter((event) => event?.type === 'requestfailed')
    .slice(-10)
    .map((event) => ({
      url: String(event.text || '').slice(0, 2000),
      failure: String(event.failure || '').slice(0, 500),
      timestamp: event.timestamp || '',
    }));
}

async function fillInput(page, locator, value, options, step = {}, root = page) {
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (await isMonacoEditor(locator)) {
    await fillMonacoEditor(page, locator, value, options);
    return;
  }
  if (tag === 'select') {
    const raw = String(value ?? '');
    await locator.selectOption(raw, { timeout: options.timeoutMs }).catch(async () => {
      await locator.selectOption({ label: raw }, { timeout: options.timeoutMs });
    });
    return;
  }
  const editable = await locator.evaluate((el) => el.isContentEditable || el.closest('[contenteditable="true"]') != null).catch(() => false);
  if (editable) {
    await locator.click({ timeout: options.timeoutMs });
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await locator.press('Backspace');
    await page.keyboard.insertText(String(value ?? ''));
    return;
  }
  if (await isCustomSelect(locator)) {
    if (isRecordedSelectSearch(step, options.nextStep)) {
      const searchInput = await findCustomSelectInput(locator);
      if (searchInput) {
        // Element/Ant Select 的录制输入只负责过滤选项，不能在此步骤提前点击选项。
        await searchInput.fill(String(value ?? ''), { timeout: options.timeoutMs });
        return;
      }
    }
    await selectCustomOption(root, locator, value, options);
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    await locator.fill(String(value ?? ''), { timeout: options.timeoutMs });
    return;
  }
  throw new RunnerError('UNSUPPORTED_CONTROL', 'Unsupported input control', {
    tag,
    value_preview: String(value ?? '').slice(0, 200),
  });
}

async function selectOption(page, root, locator, rawOption, options) {
  const option = parseSelectOption(rawOption);
  const tag = await locator.evaluate((element) => String(element.tagName || '').toLowerCase()).catch(() => '');
  if (tag === 'select') {
    try {
      await locator.selectOption(option, { timeout: options.timeoutMs });
    } catch (error) {
      const text = optionText(option);
      if (!text) throw error;
      await locator.selectOption({ label: text }, { timeout: options.timeoutMs });
    }
    return { selected_option: optionText(option) };
  }

  const text = optionText(option);
  if (!text) {
    throw new RunnerError('METHOD_CONFIG_INVALID', 'select_option requires option value for a custom select');
  }
  await selectCustomOption(root, locator, text, options);
  return { selected_option: text };
}

function selectValueFromStep(step) {
  return firstPresent(step.option, step.option_value, step.optionValue, step.value);
}

async function selectComboOption(page, root, locator, step, options) {
  const searchText = String(firstPresent(step.search, step.query, step.value, step.option) ?? '').trim();
  const optionTextValue = String(firstPresent(step.option, step.option_text, step.optionText, searchText) ?? '').trim();
  const tag = await locator.evaluate((element) => String(element.tagName || '').toLowerCase()).catch(() => '');
  if (tag === 'select') {
    return selectOption(page, root, locator, optionTextValue, options);
  }

  if (await isCustomSelect(locator)) {
    await locator.click({ timeout: options.timeoutMs });
    const input = await findCustomSelectInput(locator);
    if (input && searchText) {
      await input.fill(searchText, { timeout: options.timeoutMs });
    }
  } else if (searchText) {
    await fillInput(page, locator, searchText, options, step, root);
  }

  const explicitOption = String(firstPresent(step.option_selector, step.optionSelector, step.element) ?? '').trim();
  if (explicitOption) {
    const optionLocator = root.locator(normalizeLocatorExpression(explicitOption)).first();
    await optionLocator.click({ timeout: options.timeoutMs });
    return { selected_option: optionTextValue || explicitOption, combo_search: searchText };
  }
  if (!optionTextValue) {
    throw new RunnerError('METHOD_CONFIG_INVALID', 'combo_select requires option or element');
  }
  await selectCustomOption(root, locator, optionTextValue, options);
  return { selected_option: optionTextValue, combo_search: searchText };
}

function parseSelectOption(rawOption) {
  if (rawOption && typeof rawOption === 'object') return rawOption;
  const value = String(rawOption ?? '').trim();
  if (!value) throw new RunnerError('METHOD_CONFIG_INVALID', 'select_option requires option');
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // 普通字符串同时兼容原生 select 的 value 与 label。
  }
  return value;
}

function optionText(option) {
  if (option && typeof option === 'object') {
    return String(firstPresent(option.label, option.value, option.text, option.index) ?? '').trim();
  }
  return String(option ?? '').trim();
}

function normalizeLocatorExpression(value) {
  return value.startsWith('/') || value.startsWith('(') ? `xpath=${value}` : value;
}

async function clearInput(page, locator, options) {
  if (await isMonacoEditor(locator)) {
    await fillMonacoEditor(page, locator, '', options);
    return;
  }
  const tag = await locator.evaluate((element) => String(element.tagName || '').toLowerCase()).catch(() => '');
  const editable = await locator.evaluate((element) => element.isContentEditable || element.closest('[contenteditable="true"]') != null).catch(() => false);
  if (editable) {
    await locator.click({ timeout: options.timeoutMs });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    await locator.fill('', { timeout: options.timeoutMs });
    return;
  }
  throw new RunnerError('UNSUPPORTED_CONTROL', 'clear requires an input, textarea, contenteditable, or Monaco editor', { tag });
}

function resolveDateInputValue(step) {
  const explicitValue = String(firstPresent(step.date_value, step.dateValue, step.value) ?? '').trim();
  if (explicitValue) return explicitValue;
  const format = String(firstPresent(step.format, step.date_format, step.dateFormat, step.key) || 'yyyy-MM-dd HH:mm:ss').trim();
  const offsetExpression = firstPresent(step.offset_seconds, step.offsetSeconds, step.offset, step.keys);
  const offsetSeconds = offsetExpression == null || String(offsetExpression).trim() === ''
    ? 0
    : evaluateSafeSecondsExpression(offsetExpression);
  return formatDate(new Date(Date.now() + offsetSeconds * 1000), format);
}

function evaluateSafeSecondsExpression(value) {
  const expression = String(value ?? '').trim();
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
    throw new RunnerError('METHOD_CONFIG_INVALID', `Unsupported date offset expression: ${expression}`);
  }
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g) || [];
  if (!tokens.length || tokens.join('') !== expression.replace(/\s+/g, '')) {
    throw new RunnerError('METHOD_CONFIG_INVALID', `Invalid date offset expression: ${expression}`);
  }
  let position = 0;
  const parsePrimary = () => {
    const token = tokens[position];
    if (token === '+') {
      position += 1;
      return parsePrimary();
    }
    if (token === '-') {
      position += 1;
      return -parsePrimary();
    }
    if (token === '(') {
      position += 1;
      const result = parseExpression();
      if (tokens[position] !== ')') throw new RunnerError('METHOD_CONFIG_INVALID', `Invalid date offset expression: ${expression}`);
      position += 1;
      return result;
    }
    const parsed = Number(token);
    if (!Number.isFinite(parsed)) throw new RunnerError('METHOD_CONFIG_INVALID', `Invalid date offset expression: ${expression}`);
    position += 1;
    return parsed;
  };
  const parseTerm = () => {
    let result = parsePrimary();
    while (['*', '/'].includes(tokens[position])) {
      const operator = tokens[position];
      position += 1;
      const right = parsePrimary();
      if (operator === '/' && right === 0) throw new RunnerError('METHOD_CONFIG_INVALID', 'Date offset cannot divide by zero');
      result = operator === '*' ? result * right : result / right;
    }
    return result;
  };
  const parseExpression = () => {
    let result = parseTerm();
    while (['+', '-'].includes(tokens[position])) {
      const operator = tokens[position];
      position += 1;
      const right = parseTerm();
      result = operator === '+' ? result + right : result - right;
    }
    return result;
  };
  const result = parseExpression();
  if (position !== tokens.length || !Number.isFinite(result)) {
    throw new RunnerError('METHOD_CONFIG_INVALID', `Invalid date offset expression: ${expression}`);
  }
  return result;
}

function formatDate(date, format) {
  const values = {
    yyyy: String(date.getFullYear()).padStart(4, '0'),
    yy: String(date.getFullYear() % 100).padStart(2, '0'),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    dd: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
  };
  return format.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (token) => values[token]);
}

async function clickOpenPage(page, locator, options) {
  const [openedPage] = await Promise.all([
    page.waitForEvent('popup', { timeout: options.timeoutMs }),
    locator.click({ timeout: options.timeoutMs }),
  ]);
  await openedPage.waitForLoadState('domcontentloaded', { timeout: options.timeoutMs }).catch(() => {});
  await openedPage.bringToFront().catch(() => {});
  if (typeof options.onPageOpened === 'function') options.onPageOpened(openedPage);
  return {
    _activePage: openedPage,
    opened_page_url: openedPage.url(),
  };
}

async function switchPage(currentPage, rawValue, options) {
  const config = parsePageActionConfig(rawValue);
  const pages = await getOpenPages(currentPage, options);
  const targetPage = await selectPage(currentPage, config, options, pages);
  await targetPage.bringToFront().catch(() => {});
  await targetPage.waitForLoadState('domcontentloaded', { timeout: Math.min(options.timeoutMs || 6000, 3000) }).catch(() => {});
  return {
    _activePage: targetPage,
    switched_page_url: targetPage.url(),
    switched_page_title: await safePageTitle(targetPage),
    switched_page_index: pages.indexOf(targetPage),
  };
}

async function closePage(currentPage, rawValue, options) {
  const config = parsePageActionConfig(rawValue);
  const pagesBefore = await getOpenPages(currentPage, options);
  const targetPage = await selectPage(currentPage, config, options, pagesBefore);
  if (pagesBefore.length <= 1) {
    throw new RunnerError('PAGE_NOT_FOUND', 'close_page requires at least one remaining page', {
      target_url: targetPage.url(),
    });
  }

  const closedUrl = targetPage.url();
  const closedTitle = await safePageTitle(targetPage);
  await targetPage.close({ runBeforeUnload: false }).catch((error) => {
    throw new RunnerError('PAGE_CLOSE_FAILED', `Failed to close page: ${error?.message || error}`, {
      target_url: closedUrl,
      target_title: closedTitle,
    });
  });

  const pagesAfter = await getOpenPages(currentPage, options);
  const fallbackConfig = parseFallbackPageConfig(config, targetPage === currentPage);
  const activePage = await selectPage(currentPage, fallbackConfig, options, pagesAfter, { defaultToFirst: true });
  await activePage.bringToFront().catch(() => {});
  return {
    _activePage: activePage,
    closed_page_url: closedUrl,
    closed_page_title: closedTitle,
    active_page_url: activePage.url(),
    active_page_title: await safePageTitle(activePage),
    active_page_index: pagesAfter.indexOf(activePage),
  };
}

function parsePageActionConfig(rawValue) {
  if (rawValue && typeof rawValue === 'object') return rawValue;
  const value = String(rawValue ?? '').trim();
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed;
    return { target: String(parsed ?? '') };
  } catch {
    return { target: value };
  }
}

function parseFallbackPageConfig(config, closedCurrentPage) {
  const fallback = config.fallback ?? config.fallbackTarget ?? config.fallback_target;
  if (fallback != null && fallback !== '') return parsePageActionConfig(fallback);
  return { target: closedCurrentPage ? 'main' : 'current' };
}

async function getOpenPages(currentPage, options) {
  const rawPages = typeof options.getPages === 'function'
    ? await options.getPages()
    : currentPage.context().pages();
  const pages = [];
  const seen = new Set();
  for (const candidate of rawPages || []) {
    if (!candidate || candidate.isClosed()) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    pages.push(candidate);
  }
  return pages;
}

async function selectPage(currentPage, config, options, pages, behavior = {}) {
  if (!pages.length) {
    throw new RunnerError('PAGE_NOT_FOUND', 'No open pages are available');
  }

  const target = String(config.target || config.page || config.window || '').trim();
  const targetLower = target.toLowerCase();
  const mainPage = options.mainPage && !options.mainPage.isClosed() ? options.mainPage : null;
  if (['main', 'original', 'root', 'first'].includes(targetLower)) return mainPage || pages[0];
  if (['current', 'active'].includes(targetLower)) {
    return currentPage && !currentPage.isClosed() ? currentPage : pages[0];
  }
  if (['latest', 'last'].includes(targetLower)) return pages[pages.length - 1];
  if (['popup', 'new'].includes(targetLower)) return pages.findLast((candidate) => candidate !== mainPage) || pages[pages.length - 1];

  const index = pageIndexFromConfig(config);
  if (index != null) {
    const page = pages[index];
    if (page) return page;
    throw new RunnerError('PAGE_NOT_FOUND', `Page index ${index} was not found`, {
      requested_index: index,
      open_pages: await pageDebugList(pages),
    });
  }

  const matched = [];
  for (const candidate of pages) {
    if (await pageMatches(candidate, config, target)) matched.push(candidate);
  }
  if (matched.length) return matched[matched.length - 1];
  if (!target && !hasPageMatcher(config)) {
    return currentPage && !currentPage.isClosed() ? currentPage : pages[0];
  }
  if (behavior.defaultToFirst) return pages[0];

  throw new RunnerError('PAGE_NOT_FOUND', `No open page matched ${target || JSON.stringify(config)}`, {
    target: target || config,
    open_pages: await pageDebugList(pages),
  });
}

function pageIndexFromConfig(config) {
  const raw = config.index ?? config.pageIndex ?? config.page_index;
  if (raw == null || raw === '') return null;
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

async function pageMatches(page, config, plainTarget) {
  const url = page.url();
  const title = await safePageTitle(page);
  const urlExact = firstString(config.urlExact, config.url_exact);
  const urlExpected = firstString(config.urlContains, config.url_contains, config.url, config.pattern, config.urlPattern, config.url_pattern);
  const titleExact = firstString(config.titleExact, config.title_exact);
  const titleExpected = firstString(config.titleContains, config.title_contains, config.title, config.name);

  if (urlExact && url !== urlExact) return false;
  if (urlExpected && !urlMatches(url, urlExpected)) return false;
  if (titleExact && title !== titleExact) return false;
  if (titleExpected && !textMatches(title, titleExpected)) return false;
  if (urlExact || urlExpected || titleExact || titleExpected) return true;

  const value = String(plainTarget || '').trim();
  return Boolean(value) && (urlMatches(url, value) || textMatches(title, value));
}

function hasPageMatcher(config) {
  return pageIndexFromConfig(config) != null
    || Boolean(firstString(
      config.urlExact,
      config.url_exact,
      config.urlContains,
      config.url_contains,
      config.url,
      config.pattern,
      config.urlPattern,
      config.url_pattern,
      config.titleExact,
      config.title_exact,
      config.titleContains,
      config.title_contains,
      config.title,
      config.name,
    ));
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function textMatches(actual, expected) {
  const value = String(expected || '');
  if (!value) return true;
  if (value.includes('*')) {
    const escaped = value.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(String(actual || ''));
  }
  return String(actual || '').includes(value);
}

async function safePageTitle(page) {
  return page.title().catch(() => '');
}

async function pageDebugList(pages) {
  return Promise.all(pages.map(async (candidate, index) => ({
    index,
    url: candidate.url(),
    title: await safePageTitle(candidate),
  })));
}

async function runScroll(page, step, options, locator) {
  if (locator) {
    await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
    return;
  }
  const y = Number(step.value) || 500;
  const root = getActionRoot(page, options);
  if (root !== page && typeof root.evaluate === 'function') {
    await root.evaluate((offset) => window.scrollBy(0, offset), y);
    return;
  }
  await page.mouse.wheel(0, y);
}

async function runAssertText(page, step, options, locatorInfo) {
  const expected = expectedFromStep(step);
  if (locatorInfo) {
    const actual = await locatorInfo.locator.textContent({ timeout: options.timeoutMs });
    assertContains(actual, expected, step);
    return { locatorInfo, assertion: createAssertion('元素文本', 'contains', expected, actual) };
  }
  const bodyText = await getActionRoot(page, options).locator('body').textContent({ timeout: options.timeoutMs });
  assertContains(bodyText, expected, step);
  return { locatorInfo: null, assertion: createAssertion('页面文本', 'contains', expected, bodyText) };
}

async function runAssertTextNot(page, step, options, locatorInfo) {
  const expected = expectedFromStep(step);
  const actual = locatorInfo
    ? await locatorInfo.locator.textContent({ timeout: options.timeoutMs })
    : await getActionRoot(page, options).locator('body').textContent({ timeout: options.timeoutMs });
  assertNotContains(actual, expected, step, 'text');
  return { locatorInfo, assertion: createAssertion('元素文本', 'not_contains', expected, actual) };
}

async function runAssertElementMatch(locator, step, options) {
  const matchMode = String(step.match_mode || '').trim().toLowerCase();
  if (!['contains', 'equals', 'not_contains', 'regex', 'visible'].includes(matchMode)) {
    throw new RunnerError('METHOD_CONFIG_INVALID', `不支持的元素断言匹配方式：${matchMode || '(空)'}`);
  }
  if (matchMode === 'visible') {
    try {
      await locator.waitFor({ state: 'visible', timeout: options.timeoutMs });
    } catch {
      throw new RunnerError('ASSERTION_FAILED', '目标元素在超时内不可见', {
        step_id: step.id,
        step_index: step.step_index,
        match_mode: matchMode,
      });
    }
    return createAssertion('页面元素', 'visible', 'visible', 'visible');
  }

  const expected = expectedFromStep(step);
  const actual = await readElementAssertionValue(locator, step.read_mode, options.timeoutMs);
  switch (matchMode) {
    case 'contains':
      assertContains(actual, expected, step);
      break;
    case 'equals':
      assertValueEquals(actual, expected, step, 'element value', true);
      break;
    case 'not_contains':
      assertNotContains(actual, expected, step, 'element value');
      break;
    case 'regex':
      assertRegexMatch(actual, expected, step);
      break;
    default:
      break;
  }
  return createAssertion('页面元素', matchMode, expected, actual, matchMode === 'regex' ? 'regex' : 'text');
}

async function readElementAssertionValue(locator, rawReadMode, timeoutMs) {
  const readMode = String(rawReadMode || 'auto').trim().toLowerCase();
  if (!['auto', 'text', 'value'].includes(readMode)) {
    throw new RunnerError('METHOD_CONFIG_INVALID', `不支持的元素断言读取方式：${readMode || '(空)'}`);
  }
  await locator.waitFor({ state: 'attached', timeout: timeoutMs });
  return locator.evaluate((node, mode) => {
    const tagName = String(node.tagName || '').toLowerCase();
    const effectiveMode = mode === 'auto' && ['input', 'textarea', 'select'].includes(tagName) ? 'value' : mode;
    if (effectiveMode === 'value') return 'value' in node ? node.value : '';
    return typeof node.innerText === 'string' ? node.innerText : (node.textContent || '');
  }, readMode);
}

async function assertAttribute(locator, step, options) {
  const attribute = String(firstPresent(step.attribute, step.name, step.value) ?? '').trim();
  if (!attribute) throw new RunnerError('METHOD_CONFIG_INVALID', 'assert_attribute requires attribute');
  const actual = await locator.getAttribute(attribute, { timeout: options.timeoutMs });
  assertValueEquals(actual, expectedFromStep(step), step, `attribute ${attribute}`);
  return createAssertion(`元素属性 ${attribute}`, 'equals', expectedFromStep(step), actual);
}

async function runAssertTextRegex(page, step, options, locatorInfo) {
  const rawRegex = String(firstPresent(step.regex, step.pattern, step.value) ?? '');
  let regex;
  try {
    regex = new RegExp(rawRegex);
  } catch (error) {
    throw new RunnerError('METHOD_CONFIG_INVALID', `Invalid text regex: ${error?.message || rawRegex}`);
  }
  const actual = locatorInfo
    ? await locatorInfo.locator.textContent({ timeout: options.timeoutMs })
    : await getActionRoot(page, options).locator('body').textContent({ timeout: options.timeoutMs });
  if (!regex.test(String(actual ?? ''))) {
    throw new RunnerError('ASSERTION_FAILED', `Text did not match regex: ${rawRegex.slice(0, 200)}`, {
      step_id: step.id,
      step_index: step.step_index,
      regex: rawRegex.slice(0, 500),
      actual_preview: String(actual ?? '').slice(0, 500),
    });
  }
  return { locatorInfo, assertion: createAssertion('元素文本', 'regex_match', rawRegex, actual, 'regex') };
}

function createAssertion(subject, operator, expected, actual, expectedFormat = 'text') {
  return {
    subject,
    operator,
    expected: { value_state: 'visible', preview: String(expected ?? ''), format: expectedFormat },
    actual: { value_state: 'visible', preview: previewAssertionValue(actual), format: valueType(actual) },
    passed: true,
  };
}

function previewAssertionValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 512);
  return String(value).replace(/[\r\n]+/g, ' ').slice(0, 512);
}

function hasLocator(step) {
  return Boolean(String(step.target_selector || step.target_xpath || '').trim() || step.locator_meta);
}

function expectedFromStep(step) {
  return String(firstPresent(step.expect, step.expected, step.value) ?? '');
}

function assertValueEquals(actual, expected, step, subject, normalizeText = false) {
  const actualText = normalizeText ? normalizeAssertionText(actual) : String(actual ?? '');
  const expectedText = normalizeText ? normalizeAssertionText(expected) : String(expected ?? '');
  if (actualText !== expectedText) {
    throw new RunnerError('ASSERTION_FAILED', `Expected ${subject} did not match`, {
      step_id: step.id,
      step_index: step.step_index,
      expected: String(expected ?? '').slice(0, 500),
      actual_preview: String(actual ?? '').slice(0, 500),
    });
  }
}

function assertNotContains(actual, expected, step, subject) {
  if (normalizeAssertionText(actual).includes(normalizeAssertionText(expected))) {
    throw new RunnerError('ASSERTION_FAILED', `Expected ${subject} not to contain value`, {
      step_id: step.id,
      step_index: step.step_index,
      unexpected: String(expected ?? '').slice(0, 500),
      actual_preview: String(actual ?? '').slice(0, 500),
    });
  }
}

function assertRegexMatch(actual, expected, step) {
  let regex;
  try {
    regex = new RegExp(String(expected ?? ''));
  } catch (error) {
    throw new RunnerError('METHOD_CONFIG_INVALID', `元素断言正则不合法：${error?.message || expected}`);
  }
  if (!regex.test(String(actual ?? ''))) {
    throw new RunnerError('ASSERTION_FAILED', '元素值未匹配期望正则', {
      step_id: step.id,
      step_index: step.step_index,
      regex: String(expected ?? '').slice(0, 500),
      actual_preview: String(actual ?? '').slice(0, 500),
    });
  }
}

function assertContains(actual, expected, step) {
  if (!normalizeAssertionText(actual).includes(normalizeAssertionText(expected))) {
    throw new RunnerError('ASSERTION_FAILED', `Expected text was not found: ${String(expected ?? '').slice(0, 200)}`, {
      step_id: step.id,
      step_index: step.step_index,
      expected: String(expected ?? '').slice(0, 500),
      actual_preview: String(actual ?? '').slice(0, 500),
    });
  }
}

function normalizeAssertionText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function uploadFiles(page, locator, rawValue, options) {
  const config = parseFileUploadConfig(rawValue);
  const files = config.files;
  if (!files.length) {
    throw new RunnerError('UNSUPPORTED_CONTROL', 'file_upload requires at least one file path');
  }
  const input = await resolveUploadInput(page, locator, config, options);
  await input.setInputFiles(files, { timeout: options.timeoutMs });
  return {
    uploaded_files: files,
    upload_input_selector: config.inputSelector || '',
    upload_via_proxy: Boolean(config.inputSelector),
  };
}

async function uploadCertificate(page, locator, rawValue, options) {
  const result = await uploadFiles(page, locator, rawValue, options);
  // 证书路径可能带有执行节点目录信息；执行结果只保留文件名，不回传路径或证书正文。
  return {
    certificate_uploaded: true,
    uploaded_certificate_files: result.uploaded_files.map((file) => path.basename(file)),
    upload_input_selector: result.upload_input_selector,
    upload_via_proxy: result.upload_via_proxy,
  };
}

function fileValueFromStep(step) {
  return firstPresent(step.file_ref, step.fileRef, step.files, step.file, step.value);
}

function certificateValueFromStep(step) {
  return firstPresent(step.certificate_ref, step.certificateRef, step.file_ref, step.fileRef, step.value);
}

async function resolveUploadInput(page, locator, config, options) {
  if (config.inputSelector) {
    const input = page.locator(config.inputSelector).first();
    if (await input.count().catch(() => 0) > 0) return input;
    throw new RunnerError('LOCATOR_NOT_FOUND', `file_upload inputSelector not found: ${config.inputSelector}`, {
      input_selector: config.inputSelector,
    });
  }

  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  const type = await locator.evaluate((el) => String(el.getAttribute('type') || '').toLowerCase()).catch(() => '');
  if (tag === 'input' && type === 'file') return locator;

  const nested = locator.locator('input[type="file"]').first();
  if (await nested.count().catch(() => 0) > 0) return nested;

  const describedInput = page.locator('input[type="file"]').filter({ has: locator }).first();
  if (await describedInput.count().catch(() => 0) > 0) return describedInput;

  throw new RunnerError('UNSUPPORTED_CONTROL', 'file_upload requires an input[type=file] or value.inputSelector', {
    tag,
    type,
    value_preview: JSON.stringify(config.raw).slice(0, 300),
  });
}

function parseFileUploadConfig(rawValue) {
  if (Array.isArray(rawValue)) return { files: rawValue.map(resolveFileReference), inputSelector: '', raw: rawValue };
  if (rawValue && typeof rawValue === 'object') return fileUploadConfigFromObject(rawValue);
  const value = String(rawValue ?? '').trim();
  if (!value) return { files: [], inputSelector: '', raw: rawValue };
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return { files: parsed.map(resolveFileReference), inputSelector: '', raw: parsed };
    if (parsed && typeof parsed === 'object') return fileUploadConfigFromObject(parsed);
  } catch {
    // Fall through to comma-separated paths.
  }
  return { files: value.split(',').map((item) => item.trim()).filter(Boolean).map(resolveLocalPath), inputSelector: '', raw: rawValue };
}

function fileUploadConfigFromObject(config) {
  const rawFiles = Array.isArray(config.files)
    ? config.files
    : firstPresent(config.file, config.path, config.file_path, config.filePath, config.local_path, config.localPath) != null
      ? [firstPresent(config.file, config.path, config.file_path, config.filePath, config.local_path, config.localPath)]
      : [];
  return {
    files: rawFiles.map(resolveFileReference),
    inputSelector: String(config.inputSelector || config.input_selector || '').trim(),
    raw: config,
  };
}

function parseFileList(rawValue) {
  if (Array.isArray(rawValue)) return rawValue.map(resolveLocalPath);
  const value = String(rawValue ?? '').trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(resolveLocalPath);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.files)) return parsed.files.map(resolveLocalPath);
  } catch {
    // Fall through to comma-separated paths.
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean).map(resolveLocalPath);
}

function resolveLocalPath(filePath) {
  const value = String(filePath || '').trim();
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function resolveFileReference(fileReference) {
  const rawPath = fileReference && typeof fileReference === 'object'
    ? firstPresent(
      fileReference.path,
      fileReference.file_path,
      fileReference.filePath,
      fileReference.local_path,
      fileReference.localPath,
      fileReference.resolved_path,
      fileReference.resolvedPath,
    )
    : fileReference;
  const value = String(rawPath ?? '').trim();
  if (!value) {
    throw new RunnerError('FILE_REFERENCE_UNRESOLVED', 'file_ref must include a runner-resolved local path');
  }
  return resolveLocalPath(value);
}

async function assertDownload(page, locator, rawValue, options) {
  const expected = parseDownloadExpected(rawValue);
  const downloadsDir = path.join(options.artifacts?.runDir || process.cwd(), 'downloads');
  await fs.mkdir(downloadsDir, { recursive: true });

  const responseWaiter = expected.mime || expected.url
    ? page.waitForResponse((response) => downloadResponseMatches(response, expected), { timeout: Math.min(options.timeoutMs || 6000, 1500) }).catch(() => null)
    : Promise.resolve(null);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: options.timeoutMs }),
    locator.click({ timeout: options.timeoutMs }),
  ]);
  const response = await responseWaiter;
  const suggestedFilename = download.suggestedFilename();
  if (expected.filename && !suggestedFilename.includes(expected.filename)) {
    throw new RunnerError('ASSERTION_FAILED', `Downloaded filename did not match: ${expected.filename}`, {
      expected_filename: expected.filename,
      actual_filename: suggestedFilename,
    });
  }

  const savePath = path.join(downloadsDir, sanitizeFilename(suggestedFilename || `download-${Date.now()}`));
  await download.saveAs(savePath);
  const downloadedMime = String(response?.headers()['content-type'] || guessMimeType(savePath));
  if (expected.mime) {
    const actualMime = downloadedMime.toLowerCase();
    if (!actualMime.includes(expected.mime.toLowerCase())) {
      throw new RunnerError('ASSERTION_FAILED', `Downloaded MIME did not match: ${expected.mime}`, {
        expected_mime: expected.mime,
        actual_mime: actualMime,
        filename: suggestedFilename,
      });
    }
  }
  const stat = await fs.stat(savePath);
  if (expected.minBytes != null && stat.size < expected.minBytes) {
    throw new RunnerError('ASSERTION_FAILED', `Downloaded file was smaller than expected: ${expected.minBytes}`, {
      expected_min_bytes: expected.minBytes,
      actual_bytes: stat.size,
      filename: suggestedFilename,
    });
  }
  if (expected.maxBytes != null && stat.size > expected.maxBytes) {
    throw new RunnerError('ASSERTION_FAILED', `Downloaded file was larger than expected: ${expected.maxBytes}`, {
      expected_max_bytes: expected.maxBytes,
      actual_bytes: stat.size,
      filename: suggestedFilename,
    });
  }
  if (expected.contains) {
    const content = await fs.readFile(savePath, 'utf8').catch(() => '');
    if (!content.includes(expected.contains)) {
      throw new RunnerError('ASSERTION_FAILED', `Downloaded file did not contain expected text: ${expected.contains}`, {
        expected: expected.contains,
        filename: suggestedFilename,
      });
    }
  }
  const sha256 = expected.sha256 ? await fileSha256(savePath) : '';
  if (expected.sha256 && sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
    throw new RunnerError('ASSERTION_FAILED', 'Downloaded file sha256 did not match', {
      expected_sha256: expected.sha256,
      actual_sha256: sha256,
      filename: suggestedFilename,
    });
  }
  return {
    downloaded_file: savePath,
    downloaded_filename: suggestedFilename,
    downloaded_bytes: stat.size,
    downloaded_sha256: sha256 || null,
    downloaded_mime: downloadedMime,
  };
}

function parseDownloadExpected(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return {
        filename: String(parsed.filename || parsed.name || '').trim(),
        contains: String(parsed.contains || parsed.text || '').trim(),
        mime: String(parsed.mime || parsed.contentType || parsed.content_type || '').trim(),
        url: String(parsed.url || parsed.urlContains || parsed.url_contains || '').trim(),
        minBytes: numberOrNull(parsed.minBytes ?? parsed.min_bytes),
        maxBytes: numberOrNull(parsed.maxBytes ?? parsed.max_bytes),
        sha256: String(parsed.sha256 || '').trim(),
      };
    }
  } catch {
    // Plain value means expected filename substring.
  }
  return { filename: value };
}

function downloadResponseMatches(response, expected) {
  if (expected.url && !urlMatches(response.url(), expected.url)) return false;
  if (!expected.url && expected.filename && !response.url().includes(expected.filename)) return false;
  return response.status() >= 200 && response.status() < 400;
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt') return 'text/plain';
  if (ext === '.json') return 'application/json';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

async function fileSha256(filePath) {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function sanitizeFilename(value) {
  return String(value || 'download.txt').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

async function runAssertJson(page, step, options) {
  const config = parseJsonAssertion(step.value);
  const hasTarget = String(step.target_selector || step.target_xpath || '').trim() || step.locator_meta;
  let info = null;
  let actual;
  if (hasTarget) {
    info = await resolveStepLocator(page, step, options);
    const text = await info.locator.textContent({ timeout: options.timeoutMs });
    actual = parseJsonStrict(text, step);
  } else {
    actual = await fetchJsonAssertion(config, options);
    info = {
      source: 'api:assert_json',
      locatorType: 'json_api',
      matchedCount: null,
      visibleCount: null,
    };
  }
  const expected = config.expected ?? config;
  if (!compareJsonSubset(expected, actual)) {
    throw new RunnerError('ASSERTION_FAILED', 'JSON assertion failed', {
      expected,
      actual_preview: JSON.stringify(actual).slice(0, 1000),
    });
  }
  return info;
}

function parseJsonAssertion(rawValue) {
  if (rawValue && typeof rawValue === 'object') return rawValue;
  const value = String(rawValue ?? '').trim();
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new RunnerError('CASE_INVALID', 'assert_json value must be valid JSON');
  }
}

function parseJsonStrict(text, step) {
  try {
    return JSON.parse(String(text ?? ''));
  } catch {
    throw new RunnerError('ASSERTION_FAILED', 'Target text is not valid JSON', {
      step_id: step.id,
      step_index: step.step_index,
      actual_preview: String(text ?? '').slice(0, 500),
    });
  }
}

async function fetchJsonAssertion(config, options) {
  const rawUrl = String(config.url || config.path || '').trim();
  if (!rawUrl) {
    throw new RunnerError('CASE_INVALID', 'assert_json without target requires value.url or value.path');
  }
  const url = rawUrl.startsWith('http') ? rawUrl : `${String(options.apiBase || '').replace(/\/+$/, '')}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`;
  const method = String(config.method || 'GET').toUpperCase();
  const headers = config.headers && typeof config.headers === 'object' ? { ...config.headers } : {};
  const request = { method, headers };
  if (config.body !== undefined || config.json !== undefined) {
    const body = config.json !== undefined ? config.json : config.body;
    request.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      request.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(url, request);
  if (!res.ok) {
    throw new RunnerError('INFRA_API_FAILED', `assert_json API failed with HTTP ${res.status}`, { url });
  }
  return res.json();
}

async function registerNetworkMock(page, rawValue) {
  const config = parseNetworkMockConfig(rawValue);
  await page.route(config.url, async (route) => {
    if (config.delayMs > 0) await sleep(config.delayMs);
    if (config.abort) {
      await route.abort(config.abort);
      return;
    }
    await fulfillNetworkRoute(route, config);
  });
  return {
    network_mock_url: config.url,
    network_mock_status: config.status,
    network_mock_abort: config.abort || '',
  };
}

async function registerNetworkReplay(page, rawValue) {
  const config = await parseNetworkReplayConfig(rawValue);
  for (const entry of config.entries) {
    await page.route(entry.url, async (route) => {
      if (entry.method && route.request().method().toUpperCase() !== entry.method) {
        await route.fallback();
        return;
      }
      if (entry.delayMs > 0) await sleep(entry.delayMs);
      if (entry.abort) {
        await route.abort(entry.abort);
        return;
      }
      await fulfillNetworkRoute(route, entry);
    });
  }
  return {
    network_replay_path: config.path,
    network_replay_entries: config.entries.length,
  };
}

async function fulfillNetworkRoute(route, config) {
  const fulfill = {
    status: config.status,
    headers: config.headers,
  };
  if (config.json !== undefined) {
    fulfill.contentType = 'application/json';
    fulfill.body = JSON.stringify(config.json);
  } else {
    fulfill.contentType = config.contentType || 'text/plain';
    fulfill.body = String(config.body ?? '');
  }
  await route.fulfill(fulfill);
}

async function assertRequest(page, triggerLocator, rawValue, options) {
  const config = parseRequestAssertion(rawValue);
  const waiter = page.waitForRequest((request) => requestMatches(request, config), { timeout: options.timeoutMs });
  const request = triggerLocator
    ? await Promise.all([waiter, triggerLocator.click({ timeout: options.timeoutMs })]).then(([matched]) => matched)
    : await waiter;
  return {
    request_url: request.url(),
    request_method: request.method(),
  };
}

async function assertResponse(page, triggerLocator, rawValue, options, step) {
  const config = parseResponseAssertion(rawValue);
  const waiter = page.waitForResponse((response) => responseMatches(response, config), { timeout: options.timeoutMs });
  const response = triggerLocator
    ? await Promise.all([waiter, triggerLocator.click({ timeout: options.timeoutMs })]).then(([matched]) => matched)
    : await waiter;
  const body = await readResponseBodyIfNeeded(response, config);
  await assertResponseBody(response, config, body);
  const baselineResult = await assertResponseBaseline(response, config, body);
  return {
    response_url: response.url(),
    response_status: response.status(),
    response_body_bytes: body == null ? null : Buffer.byteLength(body, 'utf8'),
    ...baselineResult,
    ...await saveResponseSnapshot(response, config, body, options, step),
  };
}

function parseRequestAssertion(rawValue, actionName = 'assert_request') {
  const value = parseJsonAssertion(rawValue);
  const url = String(value.url || value.pattern || '').trim();
  if (!url) {
    throw new RunnerError('CASE_INVALID', `${actionName} requires value.url`);
  }
  return {
    url,
    method: String(value.method || '').trim().toUpperCase(),
    postDataContains: String(value.postDataContains || value.post_data_contains || '').trim(),
    headers: value.headers && typeof value.headers === 'object' ? value.headers : {},
  };
}

function parseResponseAssertion(rawValue) {
  const value = parseJsonAssertion(rawValue);
  const base = parseRequestAssertion(rawValue, 'assert_response');
  return {
    ...base,
    status: Number.isFinite(Number(value.status)) ? Number(value.status) : null,
    textContains: String(value.textContains || value.text_contains || value.bodyContains || value.body_contains || '').trim(),
    json: value.json ?? value.expected ?? null,
    snapshot: value.snapshot === true || value.snapshot === 1 || value.snapshot === 'true' || Boolean(value.snapshotName || value.snapshot_name),
    snapshotName: String(value.snapshotName || value.snapshot_name || '').trim(),
    baselinePath: String(value.baselinePath || value.baseline_path || value.baseline || '').trim(),
    baselineMode: String(value.baselineMode || value.baseline_mode || 'exact').trim().toLowerCase(),
  };
}

function requestMatches(request, config) {
  if (!urlMatches(request.url(), config.url)) return false;
  if (config.method && request.method().toUpperCase() !== config.method) return false;
  if (config.postDataContains && !String(request.postData() || '').includes(config.postDataContains)) return false;
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (String(request.headers()[String(key).toLowerCase()] || '') !== String(value)) return false;
  }
  return true;
}

function responseMatches(response, config) {
  if (!urlMatches(response.url(), config.url)) return false;
  if (config.method && response.request().method().toUpperCase() !== config.method) return false;
  if (config.status != null && response.status() !== config.status) return false;
  return true;
}

async function readResponseBodyIfNeeded(response, config) {
  if (!config.textContains && config.json == null && !config.snapshot && !config.baselinePath) return null;
  return response.text();
}

async function assertResponseBody(response, config, body) {
  if (!config.textContains && config.json == null) return;

  const text = String(body ?? '');
  if (config.textContains && !text.includes(config.textContains)) {
    throw new RunnerError('ASSERTION_FAILED', `Response body did not contain expected text: ${config.textContains}`, {
      expected: config.textContains,
      actual_preview: text.slice(0, 1000),
      url: response.url(),
    });
  }
  if (config.json != null) {
    let actual;
    try {
      actual = JSON.parse(text);
    } catch {
      throw new RunnerError('ASSERTION_FAILED', 'Response body is not valid JSON', {
        actual_preview: text.slice(0, 1000),
        url: response.url(),
      });
    }
    if (!compareJsonSubset(config.json, actual)) {
      throw new RunnerError('ASSERTION_FAILED', 'Response JSON assertion failed', {
        expected: config.json,
        actual_preview: JSON.stringify(actual).slice(0, 1000),
        url: response.url(),
      });
    }
  }
}

async function assertResponseBaseline(response, config, body) {
  if (!config.baselinePath) return {};

  const baselinePath = resolveLocalPath(config.baselinePath);
  const expectedText = await fs.readFile(baselinePath, 'utf8').catch((error) => {
    throw new RunnerError('CASE_INVALID', `Response baseline file not found: ${config.baselinePath}`, {
      baseline_path: baselinePath,
      cause: error?.message || String(error),
    });
  });
  const actualText = String(body ?? '');
  const mode = config.baselineMode || 'exact';

  if (mode === 'text') {
    if (normalizeText(expectedText) !== normalizeText(actualText)) {
      throw new RunnerError('ASSERTION_FAILED', 'Response text baseline assertion failed', {
        baseline_path: baselinePath,
        actual_preview: actualText.slice(0, 1000),
      });
    }
  } else {
    const expected = parseBaselineJson(expectedText, baselinePath);
    const actual = parseBaselineJson(actualText, response.url());
    const matched = mode === 'subset'
      ? compareJsonSubset(expected, actual)
      : JSON.stringify(sortJsonKeys(expected)) === JSON.stringify(sortJsonKeys(actual));
    if (!matched) {
      throw new RunnerError('ASSERTION_FAILED', 'Response JSON baseline assertion failed', {
        baseline_path: baselinePath,
        baseline_mode: mode,
        actual_preview: JSON.stringify(actual).slice(0, 1000),
      });
    }
  }

  return {
    response_baseline: baselinePath,
    response_baseline_mode: mode,
    response_baseline_matched: true,
  };
}

function parseBaselineJson(text, source) {
  try {
    return JSON.parse(String(text ?? ''));
  } catch {
    throw new RunnerError('ASSERTION_FAILED', 'Response baseline comparison requires valid JSON', {
      source,
      actual_preview: String(text ?? '').slice(0, 500),
    });
  }
}

function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortJsonKeys(value[key]);
    return acc;
  }, {});
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trimEnd();
}

async function saveResponseSnapshot(response, config, body, options, step) {
  if (!config.snapshot) return {};

  const text = body == null ? await response.text() : String(body);
  const responsesDir = path.join(options.artifacts?.runDir || process.cwd(), 'responses');
  await fs.mkdir(responsesDir, { recursive: true });
  const baseName = sanitizeFilename(config.snapshotName || `step-${step?.step_index ?? step?.id ?? Date.now()}-response`);
  const contentType = String(response.headers()['content-type'] || '').toLowerCase();
  const ext = contentType.includes('json') ? 'json' : 'txt';
  const bodyPath = path.join(responsesDir, `${baseName}.${ext}`);
  const metaPath = path.join(responsesDir, `${baseName}.meta.json`);
  await fs.writeFile(bodyPath, text, 'utf8');
  await fs.writeFile(metaPath, `${JSON.stringify({
    url: response.url(),
    status: response.status(),
    method: response.request().method(),
    headers: response.headers(),
    content_type: response.headers()['content-type'] || '',
    body_path: bodyPath,
    captured_at: formatPlatformDateTime(),
  }, null, 2)}\n`, 'utf8');
  return {
    response_snapshot: bodyPath,
    response_snapshot_meta: metaPath,
  };
}

function urlMatches(actual, expected) {
  if (expected.includes('*')) {
    const escaped = expected.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(actual);
  }
  return actual.includes(expected);
}

function parseNetworkMockConfig(rawValue) {
  const value = parseJsonAssertion(rawValue);
  const url = String(value.url || value.pattern || '').trim();
  if (!url) {
    throw new RunnerError('CASE_INVALID', 'network_mock requires value.url');
  }
  return {
    url,
    status: Number(value.status) || 200,
    headers: value.headers && typeof value.headers === 'object' ? value.headers : {},
    json: value.json,
    body: value.body,
    contentType: value.contentType || value.content_type || '',
    delayMs: Number(value.delayMs ?? value.delay_ms ?? 0) || 0,
    abort: value.abort ? String(value.abort) : '',
  };
}

async function parseNetworkReplayConfig(rawValue) {
  const value = parseJsonAssertion(rawValue);
  const fixturePath = String(value.path || value.fixture || value.har || '').trim();
  const rawEntries = Array.isArray(value.entries) ? value.entries : [];
  let loadedEntries = rawEntries;
  let resolvedPath = '';
  if (fixturePath) {
    resolvedPath = resolveLocalPath(fixturePath);
    const content = await fs.readFile(resolvedPath, 'utf8').catch((error) => {
      throw new RunnerError('CASE_INVALID', `network_replay fixture not found: ${fixturePath}`, {
        fixture_path: resolvedPath,
        cause: error?.message || String(error),
      });
    });
    const parsed = parseReplayJson(content, resolvedPath);
    loadedEntries = Array.isArray(parsed) ? parsed : parsed.entries;
  }
  if (!Array.isArray(loadedEntries) || !loadedEntries.length) {
    throw new RunnerError('CASE_INVALID', 'network_replay requires entries or value.path with entries');
  }
  return {
    path: resolvedPath,
    entries: loadedEntries.map(normalizeReplayEntry),
  };
}

function parseReplayJson(content, source) {
  try {
    return JSON.parse(content);
  } catch {
    throw new RunnerError('CASE_INVALID', 'network_replay fixture must be valid JSON', {
      source,
    });
  }
}

function normalizeReplayEntry(entry, index) {
  const url = String(entry?.url || entry?.pattern || '').trim();
  if (!url) {
    throw new RunnerError('CASE_INVALID', `network_replay entry ${index + 1} requires url`);
  }
  return {
    url,
    method: String(entry.method || '').trim().toUpperCase(),
    status: Number(entry.status) || 200,
    headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : {},
    json: entry.json,
    body: entry.body,
    contentType: entry.contentType || entry.content_type || '',
    delayMs: Number(entry.delayMs ?? entry.delay_ms ?? 0) || 0,
    abort: entry.abort ? String(entry.abort) : '',
  };
}

function assertRequestCount(rawValue, options) {
  const config = parseRequestCountAssertion(rawValue);
  const matched = (options.networkEvents || []).filter((event) => requestEventMatches(event, config));
  const count = matched.length;
  if (config.count != null && count !== config.count) {
    throw new RunnerError('ASSERTION_FAILED', `Expected request count ${config.count}, got ${count}`, {
      expected_count: config.count,
      actual_count: count,
      url: config.url,
    });
  }
  if (config.min != null && count < config.min) {
    throw new RunnerError('ASSERTION_FAILED', `Expected at least ${config.min} requests, got ${count}`, {
      expected_min: config.min,
      actual_count: count,
      url: config.url,
    });
  }
  if (config.max != null && count > config.max) {
    throw new RunnerError('ASSERTION_FAILED', `Expected at most ${config.max} requests, got ${count}`, {
      expected_max: config.max,
      actual_count: count,
      url: config.url,
    });
  }
  return {
    request_count: count,
    request_count_url: config.url,
  };
}

function parseRequestCountAssertion(rawValue) {
  const value = parseJsonAssertion(rawValue);
  const base = parseRequestAssertion(rawValue);
  return {
    ...base,
    count: numberOrNull(value.count),
    min: numberOrNull(value.min),
    max: numberOrNull(value.max),
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function requestEventMatches(event, config) {
  if (!urlMatches(event.url, config.url)) return false;
  if (config.method && String(event.method || '').toUpperCase() !== config.method) return false;
  if (config.postDataContains && !String(event.post_data || '').includes(config.postDataContains)) return false;
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (String(event.headers?.[String(key).toLowerCase()] || '') !== String(value)) return false;
  }
  return true;
}

function compareJsonSubset(expected, actual) {
  if (expected == null) return true;
  if (typeof expected !== 'object') return Object.is(expected, actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length > actual.length) return false;
    return expected.every((item, index) => compareJsonSubset(item, actual[index]));
  }
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => compareJsonSubset(value, actual[key]));
}

async function isCustomSelect(locator) {
  return locator.evaluate((el) => {
    const root = el.closest('.ant-select, .el-select, [data-control-kind="custom-select"]') || el;
    const className = String(root.className || '');
    return root.getAttribute('role') === 'combobox'
      || root.getAttribute('aria-haspopup') === 'listbox'
      || root.getAttribute('data-control-kind') === 'custom-select'
      || className.includes('ant-select')
      || className.includes('el-select');
  }).catch(() => false);
}

function isRecordedSelectSearch(step, nextStep) {
  if (!nextStep || String(step?.action_type || '').toLowerCase() !== 'input') return false;
  const nextAction = String(nextStep.action_type || '').toLowerCase();
  if (!['click', 'click_open_page', 'double_click', 'right_click'].includes(nextAction)) return false;
  const value = String(nextStep.value ?? '').trim();
  if (!value) return false;
  const meta = parseLocatorMeta(nextStep.locator_meta);
  return isOverlayStep(nextStep, meta?.context || {});
}

async function findCustomSelectInput(locator) {
  const tag = await locator.evaluate((element) => String(element.tagName || '').toLowerCase()).catch(() => '');
  if (['input', 'textarea'].includes(tag)) {
    return locator;
  }
  const candidates = locator.locator([
    'input:not([type="hidden"])',
    'textarea',
    '[role="textbox"]',
    '[contenteditable="true"]',
  ].join(', '));
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible({ timeout: 0 }).catch(() => false)) return candidate;
  }
  return null;
}

async function isMonacoEditor(locator) {
  return locator.evaluate((el) => {
    const root = el.closest('.monaco-editor, [data-control-kind="monaco"]') || el;
    const className = String(root.className || '');
    return root.getAttribute('data-control-kind') === 'monaco'
      || className.includes('monaco-editor')
      || root.querySelector('.inputarea, textarea[aria-label*="Editor"], [contenteditable="true"]') != null;
  }).catch(() => false);
}

async function fillMonacoEditor(page, locator, value, options) {
  const input = locator.locator('.inputarea, textarea[aria-label*="Editor"], [contenteditable="true"]').first();
  const target = await input.count().catch(() => 0) > 0 ? input : locator;
  await target.click({ timeout: options.timeoutMs });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(String(value ?? ''));
}

async function selectCustomOption(page, locator, value, options) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new RunnerError('UNSUPPORTED_CONTROL', 'Custom select input requires a non-empty value');
  }

  await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs }).catch(() => {});
  await locator.click({ timeout: options.timeoutMs });
  const option = page.locator([
    '.ant-select-dropdown [role="option"]',
    '.ant-select-dropdown .ant-select-item-option',
    '.el-select-dropdown [role="option"]',
    '.el-select-dropdown .el-select-dropdown__item',
    '[data-overlay="true"] [role="option"]',
    '[role="listbox"] [role="option"]',
  ].join(', ')).filter({ hasText: text });

  const exact = option.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`) });
  const target = await exact.count().catch(() => 0) > 0 ? exact.first() : option.first();
  if (!(await target.isVisible({ timeout: options.timeoutMs }).catch(() => false))) {
    throw new RunnerError('LOCATOR_NOT_FOUND', `Custom select option not found: ${text}`, {
      locator_source: 'custom_select_option',
      locator_type: 'text_exact',
      locator_value: text,
    });
  }
  await target.scrollIntoViewIfNeeded({ timeout: Math.min(options.timeoutMs || 6000, 1000) }).catch(() => {});
  await target.click({ timeout: Math.min(options.timeoutMs || 6000, 2000) }).catch(async () => {
    await target.dispatchEvent('click');
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stepControlKind(step) {
  return parseLocatorMeta(step.locator_meta)?.context?.control_kind || '';
}
