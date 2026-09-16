import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const fixturePassword = 'sakura-local-variable-fixture';

test('同一场景的前一用例保存变量后，后续 Runner 进程可以输入该变量', { timeout: 120000 }, async (t) => {
  const privateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-scene-variables-'));
  t.after(() => fs.rm(privateDirectory, { recursive: true, force: true }));
  const artifactParent = path.join(projectRoot, 'artifacts/scene-variables-regression');
  await fs.mkdir(artifactParent, { recursive: true });
  const artifactDirectory = await fs.mkdtemp(path.join(artifactParent, 'run-'));
  t.diagnostic(`验证产物：${artifactDirectory}`);

  for (const sessionMode of ['isolated', 'reuse-auth', 'reuse-browser']) {
    await t.test(sessionMode, async (modeTest) => {
      const reports = new Map();
      const requestErrors = [];
      const server = createFixtureServer(reports, requestErrors);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      modeTest.after(() => new Promise((resolve) => server.close(resolve)));
      const origin = `http://127.0.0.1:${server.address().port}`;
      let endpoint = '';
      if (sessionMode === 'reuse-browser') {
        const owner = await chromium.launch({ channel: 'chromium', headless: true });
        modeTest.after(() => owner.close());
        await owner.newContext();
        ({ endpoint } = await owner.bind('scene-variable-regression', { host: '127.0.0.1', port: 0 }));
      }
      const stateDirectory = path.join(privateDirectory, sessionMode);
      await fs.mkdir(stateDirectory, { recursive: true });
      const currentPath = path.join(stateDirectory, 'variables.json');
      const candidatePath = path.join(stateDirectory, 'candidate.json');
      const artifactRoot = path.join(artifactDirectory, sessionMode);
      const run = (caseId, inputPath = '', outputPath = candidatePath) => runCase({
        origin, sessionMode, endpoint, stateDirectory, artifactRoot, caseId, inputPath, outputPath,
      });

      const producer = await run('SCENE_CASE_003');
      assert.equal(producer.code, 0, producer.output);
      assert.equal(reports.get('SCENE_CASE_003')?.status, 'passed');
      // 模拟 Admin 在子进程成功后提交候选；旧实现没有候选时继续执行，以复现 VARIABLE_NOT_FOUND。
      const candidateExists = await fs.stat(candidatePath).then(() => true, () => false);
      if (candidateExists) await fs.rename(candidatePath, currentPath);
      const consumer = await run('SCENE_CASE_004', candidateExists ? currentPath : '');
      assert.equal(consumer.code, 0, consumer.output);
      const reported = reports.get('SCENE_CASE_004');
      assert.equal(reported?.status, 'passed');
      assert.equal(reported.raw.steps.length, 2);
      assert.ok(reported.raw.steps.every((step) => step.status === 'passed'));
      assert.equal(reported.raw.steps[0].details.variable_references[0].value_masked, 1);
      assert.equal(reported.raw.steps[0].details.variable_references[0].source, 'locator');
      assert.ok(!JSON.stringify([...reports.values()]).includes(fixturePassword));
      assert.ok(!consumer.output.includes(fixturePassword));
      assert.ok(!JSON.stringify(reported).includes(privateDirectory));
      assert.deepEqual(requestErrors, []);
    });
  }
});

function createFixtureServer(reports, errors) {
  return http.createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${request.socket.localPort}`;
      const url = new URL(request.url, origin);
      if (url.pathname === '/fixture') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><body>
          <span id="initial-password">${fixturePassword}</span>
          <input name="user_pwd" type="password"><output id="result"></output>
          <script>document.querySelector('input').oninput = (event) => {
            document.querySelector('output').textContent = event.target.value === '${fixturePassword}'
              ? 'password-accepted' : 'password-rejected';
          };</script>
        </body></html>`);
        return;
      }
      if (url.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      const match = url.pathname.match(/^\/automation\/playwright\/testcases\/VARIABLE_SCENE\/(SCENE_CASE_00[34])(\/results)?$/);
      if (request.method === 'GET' && match && !match[2]) {
        assert.equal(url.searchParams.get('batchId'), 'VARIABLE_BATCH');
        assert.equal(url.searchParams.get('projectEnvironmentId'), '47');
        const steps = match[1] === 'SCENE_CASE_003' ? [{
          action_type: 'click', target_selector: '#initial-password',
        }, {
          action_type: 'global_variable_set', variable_name: 'passwd', source_type: 'locator',
          target_selector: '#initial-password', value_masked: 1,
        }] : [{
          action_type: 'input', target_selector: 'input[name=user_pwd]', value: '${passwd}', value_masked: 1,
        }, { action_type: 'assert_text', target_selector: '#result', value: 'password-accepted' }];
        return sendJson(response, {
          id: `VARIABLE_SCENE:${match[1]}`, name: match[1], start_url: `${origin}/fixture`,
          steps: steps.map((step, index) => ({ id: index + 1, step_index: index, ...step })),
        });
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.method === 'POST' && match?.[2]) {
        reports.set(match[1], JSON.parse(Buffer.concat(chunks).toString()));
        return sendJson(response, {});
      }
      if (request.method === 'POST' && url.pathname === '/automation/playwright/artifacts') {
        return sendJson(response, { fileId: 'local-file', url: '/local-artifacts/test' });
      }
      if (request.method === 'POST' && url.pathname === '/automation/operation-catalog/capabilities/playwright') {
        return sendJson(response, {});
      }
      throw new Error(`未模拟接口：${request.method} ${url.pathname}`);
    } catch (error) {
      errors.push(error.message);
      response.writeHead(500);
      response.end(JSON.stringify({ code: 500, message: error.message }));
    }
  });
}

function sendJson(response, data) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ code: 0, data }));
}

function runCase({ origin, sessionMode, endpoint, stateDirectory, artifactRoot, caseId, inputPath, outputPath }) {
  const args = [
    'src/index.js', '--case-id', `VARIABLE_SCENE:${caseId}`, '--batch-id', 'VARIABLE_BATCH',
    '--api-base', origin, '--admin-api', 'true', '--project-environment-id', '47',
    '--token', 'local-variable-test', '--browser', 'chromium', '--headed', 'false',
    '--trace', 'off', '--video', 'off', '--session-mode', sessionMode,
    '--locator-mode', 'semantic-v1', '--timeout', '3000', '--case-timeout', '20000',
    '--finish-delay', '0', '--slow-mo', '0', '--artifact-dir', artifactRoot,
    '--log-dir', path.join(artifactRoot, 'logs'),
  ];
  if (sessionMode === 'reuse-auth') args.push('--storage-state-out', path.join(stateDirectory, `${caseId}-auth.json`));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot, windowsHide: true,
      env: {
        ...process.env,
        SAKURA_ADMIN_ACCESS_KEY: '', SAKURA_ADMIN_SECRET_KEY: '', CUECAST_ACCESS_KEY: '', CUECAST_SECRET_KEY: '',
        RUNNER_STORAGE_STATE: '', CUECAST_STORAGE_STATE: '', CUECAST_ENV_FILE: '',
        CUECAST_EXECUTION_CAPABILITY: '', CUECAST_EXECUTION_ID: '', CUECAST_RUN_ID: '', CUECAST_JOB_ID: '',
        RUNNER_LOCAL_ARTIFACT_CLEANUP_ENABLED: 'false',
        SAKURA_PLAYWRIGHT_BROWSER_SESSION_ENDPOINT: endpoint,
        SAKURA_PLAYWRIGHT_BROWSER_SESSION_DIR: '',
        SAKURA_PLAYWRIGHT_VARIABLE_STATE_IN: inputPath,
        SAKURA_PLAYWRIGHT_VARIABLE_STATE_OUT: outputPath,
      },
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
