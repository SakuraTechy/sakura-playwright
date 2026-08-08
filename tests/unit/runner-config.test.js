import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../../src/api/api-client.js';
import { cleanupLocalRunArtifacts, createRunArtifacts } from '../../src/reporting/artifacts.js';
import { createExecutionLogger, EXECUTION_LOG_PREFIX, formatStepLogLabel } from '../../src/reporting/execution-logger.js';
import { buildStepActionPresentation, formatStepActionLabel } from '../../src/runner/action-visualizer.js';
import {
  appendLiveFramePresentation,
  extractLiveFramePresentation,
  resolveLiveFrameQualityPreset,
  startLiveFramePublisher,
} from '../../src/runner/live-frame-publisher.js';
import {
  formatPlatformDateTime,
  formatPlatformDateTimeWithMillis,
  parseArgs,
  timestampForPath,
  withTimeout,
} from '../../src/shared/utils.js';
import {
  loadStorageState,
  loadStorageStateBundle,
  redactSensitiveCliArgs,
  resolveSharedBrowserStart,
  resolveSessionStartUrl,
  restoreSessionStorage,
  saveStorageState,
  summarizeStorageState,
} from '../../src/runner/session-state.js';

test('platform CLI options override runner environment defaults', () => {
  const config = parseArgs([
    '--case-id', '100:CASE_001',
    '--batch-id', 'BATCH-20260717-0001',
    '--run-id', 'RUN-20260717-0001',
    '--job-id', 'JOB-20260717-0001',
    '--execution-id', 'EXEC-20260717-0001',
    '--execution-capability', 'capability-1',
    '--project-environment-id', '47',
    '--headed', 'true',
    '--ignore-https-errors', 'false',
    '--live-frame-quality', 'high',
    '--session-mode', 'reuse-auth',
    '--storage-state-out', 'candidate.json',
    '--trace', 'on',
    '--video', 'off',
    '--case-timeout', '120000',
  ], {
    RUNNER_HEADED: 'false',
    RUNNER_IGNORE_HTTPS_ERRORS: 'true',
  });

  assert.equal(config.projectEnvironmentId, '47');
  assert.equal(config.batchId, 'BATCH-20260717-0001');
  assert.equal(config.runId, 'RUN-20260717-0001');
  assert.equal(config.jobId, 'JOB-20260717-0001');
  assert.equal(config.executionId, 'EXEC-20260717-0001');
  assert.equal(config.executionCapability, 'capability-1');
  assert.equal(config.headed, true);
  assert.equal(config.ignoreHttpsErrors, false);
  assert.equal(config.liveFrameQuality, 'high');
  assert.equal(config.sessionMode, 'reuse-auth');
  assert.equal(config.storageStateOut, 'candidate.json');
  assert.equal(config.trace, 'on');
  assert.equal(config.video, 'off');
  assert.equal(config.caseTimeoutMs, 120000);
});

test('live frame quality presets balance resolution compression and refresh interval', () => {
  assert.deepEqual(resolveLiveFrameQualityPreset('smooth'), {
    deviceScaleFactor: 1,
    jpegQuality: 65,
    intervalMs: 1000,
  });
  assert.deepEqual(resolveLiveFrameQualityPreset('high'), {
    deviceScaleFactor: 1.5,
    jpegQuality: 82,
    intervalMs: 1000,
  });
  assert.deepEqual(resolveLiveFrameQualityPreset('ultra'), {
    deviceScaleFactor: 2,
    jpegQuality: 85,
    intervalMs: 1500,
  });
  assert.deepEqual(resolveLiveFrameQualityPreset('8k'), {
    deviceScaleFactor: 4,
    jpegQuality: 90,
    intervalMs: 3000,
  });
});

test('live frame publisher applies the selected jpeg quality and device pixel scale', async () => {
  let screenshotOptions;
  let notifyUploaded;
  const uploaded = new Promise((resolve) => { notifyUploaded = resolve; });
  const publisher = startLiveFramePublisher({
    api: {
      adminApi: true,
      pushLiveFrame: async () => notifyUploaded(),
    },
    jobId: 'JOB_QUALITY',
    getPage: () => ({
      isClosed: () => false,
      screenshot: async (options) => {
        screenshotOptions = options;
        return Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
      },
    }),
    intervalMs: 60000,
    jpegQuality: 82,
  });

  await uploaded;
  await publisher.stop();
  assert.deepEqual(screenshotOptions, {
    type: 'jpeg',
    quality: 82,
    scale: 'device',
    fullPage: false,
  });
});

test('live frame publisher can force a fresh frame before a short step action', async () => {
  let uploadCount = 0;
  const presentations = [];
  let notifyFirstUpload;
  const firstUpload = new Promise((resolve) => { notifyFirstUpload = resolve; });
  const publisher = startLiveFramePublisher({
    api: {
      adminApi: true,
      pushLiveFrame: async (_jobId, frame) => {
        uploadCount += 1;
        presentations.push(extractLiveFramePresentation(frame));
        if (uploadCount === 1) notifyFirstUpload();
      },
    },
    jobId: 'JOB_ACTION_PREVIEW',
    getPage: () => ({
      isClosed: () => false,
      screenshot: async () => Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]),
    }),
    intervalMs: 60000,
  });

  await firstUpload;
  await publisher.captureNow({
    label: '步骤 1 · 点击 登录按钮',
    focusX: 0.6,
    focusY: 0.4,
    focusScale: 1.75,
    pointer: true,
    ripple: true,
  });
  await publisher.captureNow();
  await publisher.stop();
  assert.equal(uploadCount, 3);
  assert.equal(presentations[1].ripple, true);
  assert.equal(presentations[2].ripple, false);
  assert.equal(presentations[2].focusScale, 1.75);
  assert.equal(presentations[2].pointer, true);
});

test('action preview label uses one-based sequence and recorded step name', () => {
  assert.equal(
    formatStepActionLabel({ step_index: 0, action_type: 'click', description: '点击 登录按钮' }),
    '步骤 1 · 点击 登录按钮',
  );
  assert.equal(formatStepActionLabel({ step_index: 2, action_type: 'hover' }), '步骤 3 · 悬停');
});

test('action preview focuses the actual locator and only clicks ripple once', () => {
  const presentation = buildStepActionPresentation(
    { step_index: 0, action_type: 'click', description: '点击 登录按钮' },
    { x: 720, y: 270, width: 160, height: 40 },
    { width: 1280, height: 720 },
  );
  assert.deepEqual(presentation, {
    label: '步骤 1 · 点击 登录按钮',
    focusX: 0.625,
    focusY: 0.4027777777777778,
    focusScale: 1.75,
    pointer: true,
    ripple: true,
  });
});

test('live frame keeps full jpeg while carrying focus presentation metadata', () => {
  const jpeg = Buffer.from([0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9]);
  const encoded = appendLiveFramePresentation(jpeg, {
    label: '步骤 1 · 点击 登录按钮',
    focusX: 0.75,
    focusY: 0.4,
    focusScale: 1.75,
    pointer: true,
    ripple: true,
  });

  assert.equal(encoded[0], 0xFF);
  assert.equal(encoded[1], 0xD8);
  assert.equal(encoded.at(-2), 0xFF);
  assert.equal(encoded.at(-1), 0xD9);
  assert.deepEqual(extractLiveFramePresentation(encoded), {
    label: '步骤 1 · 点击 登录按钮',
    focusX: 0.75,
    focusY: 0.4,
    focusScale: 1.75,
    pointer: true,
    ripple: true,
  });
  assert.deepEqual(extractLiveFramePresentation(appendLiveFramePresentation(jpeg)), {
    label: '',
    focusX: null,
    focusY: null,
    focusScale: 1,
    pointer: false,
    ripple: false,
  });
});

test('admin case request includes the selected project environment', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedHeaders = {};
  globalThis.fetch = async (url, options = {}) => {
    requestedUrl = String(url);
    requestedHeaders = options.headers || {};
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { steps: [] } }),
    };
  };
  try {
    const client = new ApiClient({
      apiBase: 'http://127.0.0.1:8000',
      adminApi: true,
      projectEnvironmentId: '47',
      batchId: 'BATCH_001',
      executionCapability: 'capability-1',
    });
    await client.getTestCase('AAS_P_SMOKE_006:SCENE_CASE_001');
    assert.equal(
      requestedUrl,
      'http://127.0.0.1:8000/automation/playwright/testcases/AAS_P_SMOKE_006/SCENE_CASE_001?projectEnvironmentId=47&batchId=BATCH_001',
    );
    // 批次读取和结果回传使用同一个短期 capability 请求头。
    assert.equal(requestedHeaders['X-Execution-Capability'], 'capability-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('infrastructure task requests carry only execution identity and use the admin task endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { task_id: 'INFRA_001', status: 'queued' } }),
    };
  };
  try {
    const client = new ApiClient({ apiBase: 'http://127.0.0.1:8000', adminApi: true, token: 'runner-token' });
    await client.createInfrastructureTask({ jobId: 'JOB_001', stepId: 'STEP_001' });
    await client.getInfrastructureTask('INFRA_001', 12);
    await client.cancelInfrastructureTask('INFRA_001', 'case_timeout');

    assert.equal(requests[0].url, 'http://127.0.0.1:8000/automation/infrastructure/tasks');
    assert.deepEqual(JSON.parse(requests[0].options.body), { jobId: 'JOB_001', stepId: 'STEP_001' });
    assert.equal(requests[1].url, 'http://127.0.0.1:8000/automation/infrastructure/tasks/INFRA_001?afterSequence=12');
    assert.equal(requests[2].options.method, 'DELETE');
    assert.deepEqual(JSON.parse(requests[2].options.body), { reason: 'case_timeout' });
    assert.equal(requests[0].options.headers.Authorization, 'Bearer runner-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('execution capability is sent as a short-lived request header', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { task_id: 'INFRA_CAP', status: 'queued' } }),
    };
  };
  try {
    const client = new ApiClient({
      apiBase: 'http://127.0.0.1:8000',
      adminApi: true,
      executionCapability: 'capability-1',
    });
    await client.createInfrastructureTask({ jobId: 'JOB_001', stepId: 'STEP_001' });
    await client.saveResult('100:CASE_001', { success: true, raw: { batch_id: 'BATCH_001' } });
    await client.getInfrastructureTask('INFRA_CAP');
    await client.cancelInfrastructureTask('INFRA_CAP');
    assert.equal(requests.length, 4);
    for (const request of requests) assert.equal(request.options.headers['X-Execution-Capability'], 'capability-1');
    assert.equal(JSON.parse(requests[0].options.body).executionCapability, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('case timeout uses a dedicated error code and runs cleanup', async () => {
  let cleaned = false;
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, 'Case execution', {
      code: 'CASE_TIMEOUT',
      onTimeout: async () => { cleaned = true; },
    }),
    (error) => error.code === 'CASE_TIMEOUT',
  );
  assert.equal(cleaned, true);
});

test('live frame upload uses authenticated jpeg request', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: null }),
    };
  };
  try {
    const client = new ApiClient({
      apiBase: 'http://127.0.0.1:8000',
      adminApi: true,
      token: 'runner-token',
    });
    const frame = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
    await client.pushLiveFrame('JOB_001', frame);
    assert.equal(request.url, 'http://127.0.0.1:8000/automation/playwright/runner/jobs/JOB_001/live-frame');
    assert.equal(request.options.method, 'PUT');
    assert.equal(request.options.headers.Authorization, 'Bearer runner-token');
    assert.equal(request.options.headers['Content-Type'], 'image/jpeg');
    assert.equal(request.options.body, frame);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('execution logger emits prefixed structured events', () => {
  const output = [];
  const logger = createExecutionLogger((line) => output.push(line));
  logger.info('step', '步骤 1 开始');
  logger.success('step', '步骤 1 成功', true);

  assert.equal(logger.events.length, 2);
  assert.equal(logger.events[1].sequence, 2);
  assert.equal(logger.events[1].detail, true);
  assert.equal(output[0].startsWith(EXECUTION_LOG_PREFIX), true);
  assert.deepEqual(JSON.parse(output[0].slice(EXECUTION_LOG_PREFIX.length)), logger.events[0]);
});

test('execution logger also writes JSON lines to the configured local diagnostic file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-runner-log-'));
  const logPath = path.join(directory, 'runner.log');
  try {
    const logger = createExecutionLogger(() => {}, { localFile: logPath });
    logger.info('session', 'Cookie=1，localStorage=2');
    const lines = (await fs.readFile(logPath, 'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).phase, 'session');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('execution logger can bind the final hierarchy after the case metadata is loaded', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-runner-log-rebind-'));
  const logPath = path.join(directory, 'AAS_P', 'V6.5B06D011', 'AAS_P_SMOKE_008', 'SCENE_CASE_001', '20260724', '20260724165936.log');
  try {
    const logger = createExecutionLogger(() => {});
    logger.info('case', '正在读取 admin 用例快照');
    logger.setLocalFile(logPath);
    logger.success('case', '用例加载完成');

    const lines = (await fs.readFile(logPath, 'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).message, '正在读取 admin 用例快照');
    assert.equal(JSON.parse(lines[1]).message, '用例加载完成');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('step log label uses one-based sequence and admin step name', () => {
  assert.equal(
    formatStepLogLabel({ step_index: 0, action_type: 'click', description: '点击 input' }),
    '步骤 1：点击 input',
  );
  assert.equal(formatStepLogLabel({ step_index: 2, action_type: 'fill' }), '步骤 3：fill');
});

test('runner rejects unsupported policies and values outside platform boundaries', () => {
  assert.throws(
    () => parseArgs(['--case-id', '100:CASE_001', '--trace', 'sometimes'], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /trace policy/.test(error.message),
  );
  assert.throws(
    () => parseArgs(['--case-id', '100:CASE_001', '--timeout', '999'], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /--timeout/.test(error.message),
  );
  assert.throws(
    () => parseArgs(['--case-id', '100:CASE_001', '--live-frame-quality', 'lossless'], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /live frame quality/.test(error.message),
  );
  assert.throws(
    () => parseArgs([
      '--case-id', '100:CASE_001',
      '--timeout', '20000',
      '--case-timeout', '10000',
    ], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /Case timeout/.test(error.message),
  );
  assert.throws(
    () => parseArgs(['--case-id', '100:CASE_001', '--session-mode', 'shared-context'], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /session mode/.test(error.message),
  );
  assert.throws(
    () => parseArgs(['--case-id', '100:CASE_001', '--session-mode', 'reuse-auth', '--storage-state-out', 'state.json'], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /--batch-id/.test(error.message),
  );
  assert.throws(
    () => parseArgs(['--case-id', '100:CASE_001', '--batch-id', 'B1', '--session-mode', 'reuse-auth'], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /--storage-state-out/.test(error.message),
  );
  assert.throws(
    () => parseArgs(['--case-id', '100:CASE_001', '--batch-id', 'B1', '--session-mode', 'reuse-browser', '--video', 'off'], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /managed browser endpoint/.test(error.message),
  );
  const sharedBrowserConfig = parseArgs([
    '--case-id', '100:CASE_001',
    '--batch-id', 'B1',
    '--session-mode', 'reuse-browser',
    '--video', 'retain-on-failure',
  ], {
    CUECAST_ADMIN_API: 'false',
    SAKURA_PLAYWRIGHT_BROWSER_SESSION_ENDPOINT: 'ws://127.0.0.1/session',
  });
  assert.equal(sharedBrowserConfig.video, 'retain-on-failure');
  assert.throws(
    () => parseArgs(['--case-id', '100:CASE_001', '--admin-api', 'true'], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /project-environment-id/.test(error.message),
  );
});

test('storage state loads valid JSON and rejects broken files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-storage-state-load-'));
  const validPath = path.join(directory, 'valid.json');
  const brokenPath = path.join(directory, 'broken.json');
  const invalidSessionPath = path.join(directory, 'invalid-session.json');
  try {
    await fs.writeFile(validPath, JSON.stringify({ cookies: [], origins: [] }));
    await fs.writeFile(brokenPath, '{broken');
    await fs.writeFile(invalidSessionPath, JSON.stringify({
      cookies: [],
      origins: [],
      _sakura: { session_storage: { origin: 'https://example.test', entries: 'invalid' } },
    }));
    assert.deepEqual(await loadStorageState(validPath), { cookies: [], origins: [] });
    await assert.rejects(
      loadStorageState(brokenPath),
      (error) => error?.code === 'STORAGE_STATE_LOAD_FAILED',
    );
    await assert.rejects(
      loadStorageState(invalidSessionPath),
      (error) => error?.code === 'STORAGE_STATE_LOAD_FAILED' && /entries/.test(error.message),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('successful storage state output includes IndexedDB and CLI logs redact paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-storage-state-save-'));
  const outputPath = path.join(directory, 'candidate.json');
  let options;
  try {
    await saveStorageState({
      storageState: async (receivedOptions) => {
        options = receivedOptions;
        return { cookies: [], origins: [] };
      },
    }, outputPath);
    assert.deepEqual(options, { indexedDB: true });
    assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')), { cookies: [], origins: [] });
    assert.deepEqual(
      redactSensitiveCliArgs([
        '--case-id', '1',
        '--storage-state', 'secret-input.json',
        '--storage-state-out=secret-output.json',
        '--token', 'secret-token',
      ]),
      ['--case-id', '1', '--storage-state', '***', '--storage-state-out=***', '--token', '***'],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('storage state metadata resumes the previous business page without entering Playwright context options', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-storage-state-metadata-'));
  const outputPath = path.join(directory, 'candidate.json');
  try {
    const summary = await saveStorageState({
      storageState: async () => ({
        cookies: [{ name: 'sid', value: 'secret', domain: 'example.test', path: '/' }],
        origins: [{
          origin: 'https://example.test',
          localStorage: [{ name: 'auth', value: 'secret' }],
          indexedDB: [{ name: 'auth-db', version: 1, stores: [] }],
        }],
      }),
    }, outputPath, {
      lastUrl: 'https://example.test/protected',
      sessionStorage: {
        origin: 'https://example.test',
        entries: [{ name: 'tab-auth', value: 'secret' }],
      },
    });

    assert.deepEqual(summary, {
      cookies: 1,
      origins: 1,
      localStorageEntries: 1,
      indexedDatabases: 1,
      sessionStorageEntries: 1,
      expectedOriginMatched: null,
    });
    const bundle = await loadStorageStateBundle(outputPath);
    assert.equal(bundle.metadata.lastUrl, 'https://example.test/protected');
    assert.deepEqual(bundle.metadata.sessionStorage, {
      origin: 'https://example.test',
      entries: [{ name: 'tab-auth', value: 'secret' }],
    });
    assert.equal('_sakura' in bundle.storageState, false);
    let initScriptArgument;
    const restoredCount = await restoreSessionStorage({
      addInitScript: async (_script, argument) => {
        initScriptArgument = argument;
      },
    }, bundle.metadata.sessionStorage);
    assert.equal(restoredCount, 1);
    assert.deepEqual(initScriptArgument, bundle.metadata.sessionStorage);
    assert.deepEqual(
      resolveSessionStartUrl(
        'https://example.test/login1',
        bundle.metadata.lastUrl,
        { sessionMode: 'reuse-auth', authStateLoaded: true },
      ),
      {
        url: 'https://example.test/protected',
        resumed: true,
        reason: 'resume-previous-page',
      },
    );
    assert.equal(
      resolveSessionStartUrl(
        'https://another.test/login',
        bundle.metadata.lastUrl,
        { sessionMode: 'reuse-auth', authStateLoaded: true },
      ).reason,
      'different-origin',
    );
    assert.equal(
      summarizeStorageState(
        bundle.storageState,
        'https://example.test',
        bundle.metadata.sessionStorage,
      ).expectedOriginMatched,
      true,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('shared browser navigation keeps a business page and reloads an authentication page', () => {
  assert.deepEqual(
    resolveSharedBrowserStart('https://example.test/login', 'https://example.test/workspace'),
    {
      url: 'https://example.test/workspace',
      navigate: false,
      resumed: true,
      reason: 'reuse-current-page',
    },
  );
  assert.equal(
    resolveSharedBrowserStart('https://example.test/login', 'https://example.test/login').reason,
    'shared-browser-authentication-reload',
  );
  assert.equal(
    resolveSharedBrowserStart('https://example.test/login', 'about:blank').reason,
    'shared-browser-initial-navigation',
  );
});

test('run artifacts use project version scene case date and time hierarchy', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-runner-artifacts-'));
  try {
    const artifacts = await createRunArtifacts({
      artifactDir,
      caseId: 'AAS_P_SMOKE_006:SCENE_CASE_001',
      runId: '20260717180409',
      timestamp: '20260715-180409',
      testCase: {
        project_short_name: 'AAS_P',
        version_name: 'V6.5B06D011',
        scene_id: 'AAS_P_SMOKE_006',
        case_id: 'SCENE_CASE_001',
      },
    });

    assert.equal(
      artifacts.runDir,
      path.join(artifactDir, 'runs', 'AAS_P', 'V6.5B06D011', 'AAS_P_SMOKE_006', 'SCENE_CASE_001', '20260717', '20260717180409'),
    );
    assert.equal(artifacts.runId, '20260717180409');
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test('platform cleanup only removes expired runs that completed upload and result reporting', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-runner-cleanup-'));
  const runsRoot = path.join(artifactDir, 'runs');
  const removableRun = path.join(runsRoot, 'project', 'version', 'scene', 'case', '20260722', '20260722120022');
  const retainedRun = path.join(runsRoot, 'project', 'version', 'scene', 'case', '20260722', '20260722120023');
  try {
    await fs.mkdir(removableRun, { recursive: true });
    await fs.mkdir(retainedRun, { recursive: true });
    await fs.writeFile(path.join(removableRun, 'result.json'), JSON.stringify({
      success: true,
      artifact_upload_errors: [],
      artifact_delivery: { upload_completed: true, result_reported: true },
    }));
    await fs.writeFile(path.join(retainedRun, 'result.json'), JSON.stringify({
      success: true,
      artifact_upload_errors: [{ artifact_type: 'report' }],
      artifact_delivery: { upload_completed: false, result_reported: true },
    }));
    const expired = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await fs.utimes(path.join(removableRun, 'result.json'), expired, expired);
    await fs.utimes(path.join(retainedRun, 'result.json'), expired, expired);

    await cleanupLocalRunArtifacts({
      adminApi: true,
      localArtifactCleanupEnabled: true,
      localArtifactSuccessRetentionHours: 24,
      localArtifactFailureRetentionDays: 7,
      artifactDir,
    });

    await assert.rejects(fs.access(removableRun));
    await fs.access(retainedRun);
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test('execution timestamps use Asia Shanghai platform format', () => {
  const utcTime = new Date('2026-07-15T09:15:34.971Z');
  assert.equal(formatPlatformDateTime(utcTime), '2026-07-15 17:15:34');
  assert.equal(formatPlatformDateTimeWithMillis(utcTime), '2026-07-15 17:15:34.971');
  assert.equal(timestampForPath(utcTime), '20260715-171534');
});
