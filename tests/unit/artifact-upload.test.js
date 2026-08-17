import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../../src/api/api-client.js';
import { uploadRunArtifacts } from '../../src/reporting/artifacts.js';

test('run artifact upload preserves logical paths and replaces local step paths with admin URLs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-artifact-upload-'));
  const runDir = path.join(root, 'runs', '20260810170019');
  const files = {
    console: path.join(runDir, 'logs', 'console.json'),
    executionLog: path.join(runDir, 'logs', 'execution-log.json'),
    download: path.join(runDir, 'downloads', 'clientInfoFile47628A57FE84D04A.info'),
    response: path.join(runDir, 'responses', 'license.json'),
    responseMeta: path.join(runDir, 'responses', 'license.meta.json'),
    report: path.join(runDir, 'report.html'),
    result: path.join(runDir, 'result.json'),
  };
  try {
    for (const [name, filePath] of Object.entries(files)) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, name, 'utf8');
    }
    const calls = [];
    const api = {
      adminApi: true,
      uploadArtifact: async (runId, artifactType, filePath, relativePath) => {
        calls.push({ runId, artifactType, filePath, relativePath });
        return {
          url: `/automation/playwright/artifacts/files/${calls.length}`,
          fileId: calls.length,
        };
      },
    };
    const artifacts = { runDir, reportPath: files.report, resultPath: files.result };
    const result = {
      run_id: '20260810170019',
      status: 'passed',
      steps: [{
        step_index: 1,
        action_type: 'assert_download',
        downloaded_file: files.download,
        response_snapshot: files.response,
        response_snapshot_meta: files.responseMeta,
      }],
      artifacts: {
        console_log: files.console,
        execution_log: files.executionLog,
        report_html: files.report,
      },
    };

    await uploadRunArtifacts(api, artifacts, result);

    assert.deepEqual(calls.map((item) => `${item.artifactType}:${item.relativePath}`), [
      'console:logs/console.json',
      'execution-log:logs/execution-log.json',
      'download:downloads/clientInfoFile47628A57FE84D04A.info',
      'response:responses/license.json',
      'response:responses/license.meta.json',
      'report:report.html',
      'result:result.json',
    ]);
    assert.equal(result.steps[0].downloaded_file, '/automation/playwright/artifacts/files/3');
    assert.equal(result.steps[0].downloaded_file_relative_path, 'downloads/clientInfoFile47628A57FE84D04A.info');
    assert.equal(result.steps[0].downloaded_file_id, '3');
    assert.deepEqual(result.artifacts.downloads, ['/automation/playwright/artifacts/files/3']);
    assert.deepEqual(result.artifact_file_ids.downloads, ['3']);
    assert.equal(result.artifacts.result_json, '/automation/playwright/artifacts/files/7');
    assert.deepEqual(result.artifact_upload_errors, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('artifact upload request sends the logical relative path to admin', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-artifact-request-'));
  const filePath = path.join(root, 'client.info');
  const originalFetch = globalThis.fetch;
  let requestBody;
  try {
    await fs.writeFile(filePath, 'fixture', 'utf8');
    globalThis.fetch = async (_url, options = {}) => {
      requestBody = options.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { url: '/files/1', fileId: 1 } }),
      };
    };
    const client = new ApiClient({ apiBase: 'http://127.0.0.1:8000', adminApi: true });

    await client.uploadArtifact('20260810170019', 'download', filePath, 'downloads/client.info');

    assert.equal(requestBody.get('runId'), '20260810170019');
    assert.equal(requestBody.get('artifactType'), 'download');
    assert.equal(requestBody.get('relativePath'), 'downloads/client.info');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});
