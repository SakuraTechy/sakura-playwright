import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../../src/api/api-client.js';
import { createRunArtifacts } from '../../src/reporting/artifacts.js';
import { formatPlatformDateTime, parseArgs, timestampForPath, withTimeout } from '../../src/shared/utils.js';

test('platform CLI options override runner environment defaults', () => {
  const config = parseArgs([
    '--case-id', '100:CASE_001',
    '--project-environment-id', '47',
    '--headed', 'true',
    '--ignore-https-errors', 'false',
    '--trace', 'on',
    '--video', 'off',
    '--case-timeout', '120000',
  ], {
    RUNNER_HEADED: 'false',
    RUNNER_IGNORE_HTTPS_ERRORS: 'true',
  });

  assert.equal(config.projectEnvironmentId, '47');
  assert.equal(config.headed, true);
  assert.equal(config.ignoreHttpsErrors, false);
  assert.equal(config.trace, 'on');
  assert.equal(config.video, 'off');
  assert.equal(config.caseTimeoutMs, 120000);
});

test('admin case request includes the selected project environment', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
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
    });
    await client.getTestCase('AAS_P_SMOKE_006:SCENE_CASE_001');
    assert.equal(
      requestedUrl,
      'http://127.0.0.1:8000/automation/playwright/testcases/AAS_P_SMOKE_006/SCENE_CASE_001?projectEnvironmentId=47',
    );
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
    () => parseArgs([
      '--case-id', '100:CASE_001',
      '--timeout', '20000',
      '--case-timeout', '10000',
    ], {}),
    (error) => error?.code === 'CONFIG_INVALID' && /Case timeout/.test(error.message),
  );
});

test('run artifacts use project version scene case date and time hierarchy', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-runner-artifacts-'));
  try {
    const artifacts = await createRunArtifacts({
      artifactDir,
      caseId: 'AAS_P_SMOKE_006:SCENE_CASE_001',
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
      path.join(artifactDir, 'runs', 'AAS_P', 'V6.5B06D011', 'AAS_P_SMOKE_006', 'SCENE_CASE_001', '20260715', '180409'),
    );
    assert.equal(artifacts.runId, 'AAS_P_SMOKE_006_SCENE_CASE_001-20260715-180409');
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test('execution timestamps use Asia Shanghai platform format', () => {
  const utcTime = new Date('2026-07-15T09:15:34.971Z');
  assert.equal(formatPlatformDateTime(utcTime), '2026-07-15 17:15:34');
  assert.equal(timestampForPath(utcTime), '20260715-171534');
});
