#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { ApiClient } from './api/api-client.js';
import { normalizeCase, resolveViewport, shouldLaunchMaximized } from './runner/case-loader.js';
import { resolveLiveFrameQualityPreset, startLiveFramePublisher } from './runner/live-frame-publisher.js';
import { LOADING_WAIT_WALL_MS, resolvePageErrorCheckEnabled } from './runner/page-state-diagnostics.js';
import { runStep } from './runner/step-runner.js';
import {
  captureSessionStorage,
  isLikelyAuthenticationUrl,
  loadStorageStateBundle,
  redactSensitiveCliArgs,
  resolveSessionStartUrl,
  restoreSessionStorage,
  safeUrlForLog,
  saveStorageState,
  summarizeStorageState,
} from './runner/session-state.js';
import {
  collectFailureArtifacts,
  collectVideoArtifact,
  createRunArtifacts,
  writeConsoleLog,
  writeExecutionLog,
  writeHtmlReport,
  writeJson,
  uploadRunArtifacts,
  cleanupLocalRunArtifacts,
  resolveRunPathMetadata,
} from './reporting/artifacts.js';
import {
  attachCaseInfo,
  createRunResult,
  finalizeRunResult,
  markRunFailed,
  markRunPassed,
  markStepFailed,
  reportRunResult,
} from './reporting/result-reporter.js';
import { createExecutionLogger, formatStepLogLabel } from './reporting/execution-logger.js';
import {
  formatPlatformDateTime,
  formatPlatformDateTimeWithMillis,
  parseArgs,
  RunnerError,
  serializeError,
  sleep,
  withTimeout,
} from './shared/utils.js';

const browserTypes = { chromium, firefox, webkit };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const focusExtensionPath = path.resolve(__dirname, '..', 'tools', 'focus-extension');

async function main() {
  const config = parseArgs();
  const startedAt = Date.now();
  let localLogPath = '';
  const executionLogger = createExecutionLogger(console.log);
  const api = new ApiClient({
    apiBase: config.apiBase,
    token: config.token,
    adminApi: config.adminApi,
    projectEnvironmentId: config.projectEnvironmentId,
  });
  let artifacts;
  let result;

  let browser;
  let context;
  let page;
  let activePage;
  let liveFramePublisher;
  let actionPreviewWarningReported = false;
  const consoleEvents = [];
  const networkEvents = [];
  let caseTimedOut = false;

  executionLogger.info('runner', `Runner 任务开始，case=${config.caseId}`);
  executionLogger.info(
    'config',
    `浏览器=${config.browser}，headed=${config.headed}，实时画面=${config.liveFrameQuality}，trace=${config.trace}，video=${config.video}，步骤超时=${config.timeoutMs}ms`,
    true,
  );

  try {
    await withTimeout((async () => {
    executionLogger.info('case', '正在读取 admin 用例快照');
    const testCaseRaw = await api.getTestCase(config.caseId);
    if (caseTimedOut) throw new RunnerError('CASE_TIMEOUT', `Case execution timed out after ${config.caseTimeoutMs}ms`);
    const testCase = normalizeCase(testCaseRaw, { caseId: config.caseId, startStep: config.startStep });
    config.pageErrorCheckEnabled = resolvePageErrorCheckEnabled(config.pageErrorCheckEnabled, testCase);
    executionLogger.success('case', `用例加载完成，共 ${testCase.steps.length} 个步骤`);
    executionLogger.info(
      'config',
      `定位模式=${config.locatorMode}，页面错误检测=${config.pageErrorCheckEnabled}`,
      true,
    );
    artifacts = await createRunArtifacts({
      artifactDir: config.artifactDir,
      caseId: config.caseId,
      runId: config.runId,
      testCase,
    });
    // 先在内存保留早期日志，加载 admin 用例后再绑定完整业务目录。
    localLogPath = buildLocalLogPath(config, startedAt, testCase, artifacts.runId);
    executionLogger.setLocalFile(localLogPath);
    executionLogger.info(
      'diagnostic',
      `本机诊断日志=${path.relative(process.cwd(), localLogPath) || path.basename(localLogPath)}`,
      true,
    );
    result = createRunResult({ config, artifacts, startedAt });
    attachCaseInfo(result, testCase);

    const launchArgs = [];
    if (shouldLaunchMaximized(testCase, { headed: config.headed })) {
      launchArgs.push('--start-maximized');
    }
    const viewport = resolveViewport(testCase, { headed: config.headed });
    const liveFramePreset = resolveLiveFrameQualityPreset(config.liveFrameQuality);
    const liveFrameDeviceScaleFactor = viewport ? liveFramePreset.deviceScaleFactor : 1;
    const storageStateBundle = await loadStorageStateBundle(config.storageState);
    const storageState = storageStateBundle.storageState;
    const reusableSessionStorage = config.sessionMode === 'reuse-auth'
      ? storageStateBundle.metadata.sessionStorage
      : null;
    const storageStateSummary = summarizeStorageState(
      storageState,
      resolveUrlOrigin(testCase.start_url),
      reusableSessionStorage,
    );
    result.raw.auth_state_loaded = Boolean(storageState);
    result.raw.auth_state_summary = storageStateSummary;
    result.raw.session_navigation_resumed = false;
    result.raw.session_navigation_reason = 'recorded-start-url';
    result.raw.runner_log_file = path.relative(process.cwd(), localLogPath);
    executionLogger.info(
      'session',
      `登录态加载=${Boolean(storageState)}，Cookie=${storageStateSummary.cookies}，origin=${storageStateSummary.origins}，localStorage=${storageStateSummary.localStorageEntries}，IndexedDB=${storageStateSummary.indexedDatabases}，待恢复 sessionStorage=${storageStateSummary.sessionStorageEntries}，目标域匹配=${formatOptionalBoolean(storageStateSummary.expectedOriginMatched)}`,
      true,
    );
    if (storageState && storageStateSummary.cookies === 0
      && storageStateSummary.localStorageEntries === 0
      && storageStateSummary.indexedDatabases === 0
      && storageStateSummary.sessionStorageEntries === 0) {
      executionLogger.warning('session', '已加载登录态文件，但其中没有可复用的认证存储条目');
    }
    const contextOptions = {
      viewport,
      deviceScaleFactor: viewport ? liveFrameDeviceScaleFactor : undefined,
      acceptDownloads: true,
      ...(storageState ? { storageState } : {}),
      // 内部测试环境可能使用自签名证书；由平台任务显式传入时才跳过浏览器证书校验。
      ignoreHTTPSErrors: config.ignoreHttpsErrors,
      recordVideo: shouldRecordVideo(config.video) ? { dir: artifacts.runDir } : undefined,
    };

    executionLogger.info('browser', '正在初始化 Playwright 浏览器');

    if (shouldUseFocusExtension(config)) {
      await fs.mkdir(path.join(artifacts.runDir, 'browser-profile'), { recursive: true });
      launchArgs.push(
        `--disable-extensions-except=${focusExtensionPath}`,
        `--load-extension=${focusExtensionPath}`,
        '--new-window',
      );
      context = await chromium.launchPersistentContext(path.join(artifacts.runDir, 'browser-profile'), {
        ...contextOptions,
        headless: false,
        slowMo: config.slowMoMs,
        args: launchArgs,
      });
    } else {
      const launchOptions = { headless: !config.headed, slowMo: config.slowMoMs };
      if (launchArgs.length) launchOptions.args = launchArgs;
      browser = await browserTypes[config.browser].launch(launchOptions);
      context = await browser.newContext(contextOptions);
    }
    const registeredSessionStorageEntries = await restoreSessionStorage(context, reusableSessionStorage);
    result.raw.session_storage_loaded_count = registeredSessionStorageEntries;
    if (registeredSessionStorageEntries > 0) {
      executionLogger.success(
        'session',
        `已注册 sessionStorage 预加载，共 ${registeredSessionStorageEntries} 项，将在同源页面脚本运行前恢复`,
        true,
      );
    }
    if (shouldStartTrace(config.trace)) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    }
    page = context.pages().find((candidate) => !candidate.isClosed()) || await context.newPage();
    attachPageDiagnostics(page, consoleEvents);
    attachNetworkRecorder(page, networkEvents);
    activePage = page;
    executionLogger.success('browser', `浏览器初始化成功，viewport=${formatViewport(contextOptions.viewport)}`);

    if (config.jobId && config.adminApi) {
      executionLogger.success(
        'live',
        `实时画面已启用，档位=${config.liveFrameQuality}，JPEG=${liveFramePreset.jpegQuality}，像素倍率=${liveFrameDeviceScaleFactor}，间隔=${liveFramePreset.intervalMs}ms`,
      );
    }
    if (config.headed) {
      await page.bringToFront().catch(() => {});
      console.log('[runner] headed page ready');
    }
    const sessionStart = resolveSessionStartUrl(
      testCase.start_url,
      storageStateBundle.metadata.lastUrl,
      {
        sessionMode: config.sessionMode,
        authStateLoaded: Boolean(storageState),
      },
    );
    result.raw.session_navigation_resumed = sessionStart.resumed;
    result.raw.session_navigation_reason = sessionStart.reason;
    executionLogger.info(
      'navigation',
      `起始页决策=${sessionStart.reason}，录制地址=${safeUrlForLog(testCase.start_url)}，实际地址=${safeUrlForLog(sessionStart.url)}`,
      true,
    );
    const navigationResponse = await withTimeout(
      page.goto(sessionStart.url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs }),
      config.timeoutMs,
      'Initial navigation',
    );
    const actualStartUrl = safeUrlForLog(page.url());
    const restoredSessionStorageEntries = await page.evaluate(() => sessionStorage.length).catch(() => 0);
    result.raw.session_storage_restored_count = restoredSessionStorageEntries;
    executionLogger.success(
      'navigation',
      `起始页面加载完成，当前地址=${actualStartUrl}，HTTP=${navigationResponse?.status() ?? '-'}，sessionStorage=${restoredSessionStorageEntries}`,
    );
    if (registeredSessionStorageEntries > 0
      && restoredSessionStorageEntries < registeredSessionStorageEntries) {
      executionLogger.warning(
        'session',
        `sessionStorage 恢复数量低于候选状态：候选=${registeredSessionStorageEntries}，页面=${restoredSessionStorageEntries}`,
      );
    }
    if (storageState && isLikelyAuthenticationUrl(page.url())) {
      executionLogger.warning(
        'session',
        '登录态已加载但页面仍处于登录地址；请检查目标域匹配，或确认系统是否依赖页面内存或服务端一次性会话',
      );
    }
    liveFramePublisher = startLiveFramePublisher({
      api,
      jobId: config.jobId,
      getPage: () => activePage || page,
      logger: executionLogger,
      intervalMs: liveFramePreset.intervalMs,
      jpegQuality: liveFramePreset.jpegQuality,
    });
    for (let stepPosition = 0; stepPosition < testCase.steps.length; stepPosition += 1) {
      const step = testCase.steps[stepPosition];
      const nextStep = testCase.steps[stepPosition + 1];
      const stepStartedAt = Date.now();
      const stepLogLabel = formatStepLogLabel(step);
      executionLogger.info('step', `${stepLogLabel}，开始执行`);
      executionLogger.info('step', `${stepLogLabel}，动作类型=${step.action_type || 'custom'}`, true);
      try {
        const stepResult = await withTimeout(runStep(activePage, testCase, step, {
          timeoutMs: config.timeoutMs,
          locatorMode: config.locatorMode,
          locatorWallTimeoutMs: LOADING_WAIT_WALL_MS,
          pageErrorCheckEnabled: config.pageErrorCheckEnabled,
          // 录制的 Element Select 搜索输入与选项点击是两个连续步骤；
          // Runner 需要看到下一步才能保持下拉层打开并复现原始语义。
          nextStep,
          artifacts,
          apiBase: config.apiBase,
          networkEvents,
          diagnosticEvents: consoleEvents,
          mainPage: page,
          activePage,
          afterStepDelayMs: config.jobId && config.adminApi ? 500 : undefined,
          getPages: () => context.pages(),
          onPageOpened: (openedPage) => {
            attachPageDiagnostics(openedPage, consoleEvents);
            attachNetworkRecorder(openedPage, networkEvents);
          },
          onActionPreview: config.jobId && config.adminApi
            ? (_previewPage, _previewStep, presentation) => liveFramePublisher?.captureNow(presentation)
            : undefined,
          onActionPreviewError: (error) => {
            if (actionPreviewWarningReported) return;
            actionPreviewWarningReported = true;
            executionLogger.warning('live', `动作可视化暂不可用：${error?.message || String(error)}`);
          },
        }), (config.locatorMode === 'semantic-v1' ? LOADING_WAIT_WALL_MS : config.timeoutMs)
          + Math.max(0, step.wait_before), `Step ${step.step_index}`);
        if (stepResult._activePage) {
          activePage = stepResult._activePage;
          delete stepResult._activePage;
          if (config.headed) await activePage.bringToFront().catch(() => {});
        }
        result.steps.push(stepResult);
        executionLogger.success(
          'step',
          `${stepLogLabel}，执行成功，耗时 ${stepResult.duration_ms ?? Date.now() - stepStartedAt}ms`,
        );
        if (stepResult.locator_source) {
          const locatorDetails = [
            `定位来源=${stepResult.locator_source}`,
            stepResult.locator_type ? `定位类型=${stepResult.locator_type}` : '',
            stepResult.locator_value ? `定位元素=${stepResult.locator_value}` : '',
            stepResult.matched_count != null ? `命中=${stepResult.matched_count}` : '',
            stepResult.visible_count != null ? `可见=${stepResult.visible_count}` : '',
          ].filter(Boolean).join('，');
          executionLogger.info('locator', `${stepLogLabel}，${locatorDetails}`, true);
        }
      } catch (error) {
        markStepFailed(result, step, error, stepStartedAt);
        executionLogger.error('step', `${stepLogLabel}，执行失败：${error?.message || String(error)}`);
        throw error;
      }
    }

    markRunPassed(result);
    })(), config.caseTimeoutMs, 'Case execution', {
      code: 'CASE_TIMEOUT',
      onTimeout: async () => {
        caseTimedOut = true;
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
      },
    });
  } catch (error) {
    artifacts ||= await createRunArtifacts({
      artifactDir: config.artifactDir,
      caseId: config.caseId,
      runId: config.runId,
    });
    if (!localLogPath) {
      localLogPath = buildLocalLogPath(config, startedAt, null, artifacts.runId);
      executionLogger.setLocalFile(localLogPath);
    }
    result ||= createRunResult({ config, artifacts, startedAt });
    markRunFailed(result, error);
    executionLogger.error('runner', `Runner 执行失败：${error?.message || String(error)}`);
    await collectFailureArtifacts(activePage || page, artifacts, result);
  } finally {
    if (result?.success && context && config.storageStateOut) {
      try {
        const statePage = activePage || page;
        const finalUrl = statePage && !statePage.isClosed() ? safeUrlForLog(statePage.url()) : '';
        const capturedSessionStorage = await captureSessionStorage(statePage);
        const sessionStorageEntries = capturedSessionStorage?.entries.length || 0;
        const savedStateSummary = await saveStorageState(
          context,
          config.storageStateOut,
          {
            ...(finalUrl && finalUrl !== '-' ? { lastUrl: finalUrl } : {}),
            ...(capturedSessionStorage ? { sessionStorage: capturedSessionStorage } : {}),
          },
        );
        result.raw.auth_state_saved = true;
        result.raw.auth_state_saved_summary = savedStateSummary;
        result.raw.session_storage_entry_count = sessionStorageEntries;
        executionLogger.success(
          'session',
          `批次登录态候选已生成，等待服务端确认提交；Cookie=${savedStateSummary.cookies}，origin=${savedStateSummary.origins}，localStorage=${savedStateSummary.localStorageEntries}，IndexedDB=${savedStateSummary.indexedDatabases}，sessionStorage=${sessionStorageEntries}`,
          true,
        );
      } catch (error) {
        markRunFailed(result, error);
        executionLogger.error('session', `批次登录态保存失败：${error?.message || String(error)}`);
      }
    }
    if (config.finishDelayMs > 0 && context) {
      await sleep(config.finishDelayMs).catch(() => {});
    }
    await liveFramePublisher?.stop().catch(() => {});
    if (context && shouldStartTrace(config.trace)) {
      const keepTrace = shouldKeepArtifact(config.trace, result.success);
      await context.tracing.stop(keepTrace ? { path: artifacts.tracePath } : {}).catch(() => {});
      if (keepTrace) result.artifacts.trace = artifacts.tracePath;
    }
    if (context) await context.close().catch(() => {});
    await collectVideoArtifact(activePage || page, result, shouldKeepArtifact(config.video, result.success)).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    finalizeRunResult(result, startedAt);
    if (result.success) {
      executionLogger.success('runner', `Runner 执行完成，耗时 ${result.duration_ms}ms`);
    }
    executionLogger.info('artifact', '正在整理执行产物', true);
    const finalRunnerLog = `[runner] ${result.status} case=${config.caseId} duration=${result.duration_ms}ms artifacts=${artifacts.runDir}`;
    // 长期 artifact 需要和 Job 实时日志保持一致，补入 admin 启动诊断、入队和 Runner 进程最终输出。
    const persistedAdminEvents = [
      {
        sequence: 1,
        timestamp: formatPlatformDateTimeWithMillis(startedAt),
        level: 'info',
        phase: 'admin',
        message: 'Runner 任务已加入执行队列',
        detail: false,
      },
      {
        sequence: 2,
        timestamp: formatPlatformDateTimeWithMillis(startedAt),
        level: 'info',
        phase: 'admin',
        message: `runnerRoot=${process.cwd()}`,
        detail: true,
      },
      {
        sequence: 3,
        timestamp: formatPlatformDateTimeWithMillis(startedAt),
        level: 'info',
        phase: 'admin',
        message: `runnerConfig=${path.join(process.cwd(), '.env')}`,
        detail: true,
      },
      {
        sequence: 4,
        timestamp: formatPlatformDateTimeWithMillis(startedAt),
        level: 'info',
        phase: 'admin',
        message: `command=node src/index.js ${redactSensitiveCliArgs(process.argv.slice(2)).join(' ')}`,
        detail: true,
      },
    ];
    const persistedExecutionEvents = [
      ...persistedAdminEvents,
      ...executionLogger.events.map((event, index) => ({
        ...event,
        sequence: index + persistedAdminEvents.length + 1,
      })),
      {
        sequence: executionLogger.events.length + persistedAdminEvents.length + 1,
        timestamp: formatPlatformDateTimeWithMillis(),
        level: result.success ? 'success' : 'error',
        phase: 'runner',
        message: finalRunnerLog,
        detail: false,
      },
    ];
    // 结果快照也保留完整执行日志，历史批次才能按日志首尾时间计算真实批次耗时。
    result.execution_logs = persistedExecutionEvents;
    await writeConsoleLog(artifacts, result, consoleEvents).catch(() => {});
    await writeExecutionLog(artifacts, result, persistedExecutionEvents).catch(() => {});
    await writeHtmlReport(artifacts, result).catch(() => {});
    await writeJson(artifacts.resultPath, result);
    await uploadRunArtifacts(api, artifacts, result).catch((error) => {
      result.artifact_upload_errors = [{
        artifact_type: 'all',
        error: error?.message || String(error),
      }];
    });
    await writeJson(artifacts.resultPath, result);
    let resultReported = false;
    try {
      await reportRunResult(api, config.caseId, result);
      resultReported = true;
    } catch (error) {
      console.warn('[runner] failed to report result:', error?.message || error,
        `result_error=${result.error || '-'}`,
        `details=${JSON.stringify(error?.details || {})}`);
    }
    result.artifact_delivery = {
      upload_completed: Array.isArray(result.artifact_upload_errors) && result.artifact_upload_errors.length === 0,
      result_reported: resultReported,
    };
    await writeJson(artifacts.resultPath, result);
    await cleanupLocalRunArtifacts(config).catch((error) => {
      console.warn('[runner] failed to clean local artifacts:', error?.message || error);
    });
  }

  console.log(`[runner] ${result.status} case=${config.caseId} duration=${result.duration_ms}ms artifacts=${artifacts.runDir}`);
  if (!result.success) {
    process.exitCode = 1;
  }
}

function shouldStartTrace(mode) {
  return ['on', 'retain-on-failure'].includes(String(mode || '').toLowerCase());
}

function shouldRecordVideo(mode) {
  return ['on', 'retain-on-failure'].includes(String(mode || '').toLowerCase());
}

function shouldUseFocusExtension(config) {
  // launchPersistentContext 不支持直接装载 storageState；复用批次从第二条用例开始改用普通 context。
  return config.headed && config.browser === 'chromium' && !config.storageState;
}

function shouldKeepArtifact(mode, success) {
  const raw = String(mode || '').toLowerCase();
  if (raw === 'on') return true;
  if (raw === 'retain-on-failure') return !success;
  return false;
}

function formatViewport(viewport) {
  if (!viewport) return 'browser-window';
  return `${viewport.width}x${viewport.height}`;
}

function buildLocalLogPath(config, startedAt, testCase, runId) {
  const effectiveRunId = String(runId || config.runId || '').trim();
  const datePart = /^\d{14}$/.test(effectiveRunId)
    ? effectiveRunId.slice(0, 8)
    : formatPlatformDateTime(startedAt).slice(0, 10).replaceAll('-', '');
  const logIdentity = effectiveRunId || `${datePart}${formatPlatformDateTime(startedAt).slice(11).replaceAll(':', '')}`;
  const safeIdentity = logIdentity.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
  const pathMetadata = resolveRunPathMetadata(testCase, config.caseId);
  return path.join(
    config.logDir,
    pathMetadata.projectShortName,
    pathMetadata.versionName,
    pathMetadata.sceneId,
    pathMetadata.caseId,
    datePart,
    `${safeIdentity}.log`,
  );
}

function resolveUrlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function formatOptionalBoolean(value) {
  if (value == null) return '-';
  return value ? '是' : '否';
}

function attachPageDiagnostics(page, events) {
  page.on('console', (message) => {
    events.push({
      type: 'console',
      level: message.type(),
      text: message.text().slice(0, 2000),
      location: message.location(),
      timestamp: formatPlatformDateTime(),
    });
  });
  page.on('pageerror', (error) => {
    events.push({
      type: 'pageerror',
      level: 'error',
      text: (error?.message || String(error)).slice(0, 2000),
      timestamp: formatPlatformDateTime(),
    });
  });
  page.on('requestfailed', (request) => {
    events.push({
      type: 'requestfailed',
      level: 'warn',
      text: request.url().slice(0, 2000),
      failure: request.failure()?.errorText || '',
      timestamp: formatPlatformDateTime(),
    });
  });
}

function attachNetworkRecorder(page, events) {
  page.on('request', (request) => {
    events.push({
      url: request.url(),
      method: request.method(),
      post_data: request.postData() || '',
      headers: request.headers(),
      timestamp: formatPlatformDateTime(),
    });
  });
}

main().catch((error) => {
  const serialized = serializeError(error instanceof Error ? error : new RunnerError('UNKNOWN_ERROR', String(error)));
  console.error(`[runner] ${serialized.code}: ${serialized.message}`);
  process.exitCode = 1;
});
