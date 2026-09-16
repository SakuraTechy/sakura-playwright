import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { PlayerManager } from '../../../sakura-cuecast/modules/player-manager.js';
import { CuecastVariableContext } from '../../../sakura-cuecast/modules/variable-context.js';

const root = path.resolve(import.meta.dirname, '../..');
const agentRoot = path.resolve(root, '../sakura-execution-agent');
const privateFixture = 'sakura-shell-masked-fixture';

async function processOutput(stdout, config, exitCode = 0) {
  // 调用真实 Java 后处理实现，避免用 JavaScript 正则模拟另一套执行语义。
  const dependencies = await fs.readFile(path.join(agentRoot, 'target/shell-result-test-classpath.txt'), 'utf8');
  const classpath = [path.join(agentRoot, 'target/test-classes'), path.join(agentRoot, 'target/classes'), dependencies.trim()].join(path.delimiter);
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const result = spawnSync(java, ['-Dfile.encoding=UTF-8', '-cp', classpath, 'top.continew.sakura.agent.service.ServerCommandResultFixture'], {
    input: JSON.stringify({ request: { action_type: 'server_command', ...config }, stdout, exitCode }),
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Agent 结果被现有 CDP 变量上下文精确消费且敏感预览隐藏', async () => {
  const manager = Object.create(PlayerManager.prototype);
  for (const [input, regex, replacement, expected] of [
    ['123\r\n', '[\\r\\n]+', '', '123'],
    ['size=0012', '^size=(\\d+)$', '$1', '0012'],
    ['x', 'x', '', ''],
  ]) {
    const step = { action_type: 'server_command', variable_name: 'disk', value_masked: 1 };
    const response = await processOutput(input, { ...step, replace_regex: regex, replace_value: replacement });
    const context = new CuecastVariableContext();
    const variable = manager._applyInfrastructureVariableResult(step, response.result, context);
    assert.equal(context.resolveText('${disk}'), expected);
    assert.equal(variable.value_masked, 1);
    assert.equal('value_preview' in variable, false);
  }
});

test('真实 Runner 使用 Shell 结果输入网页，失败步骤不覆盖已有值', { timeout: 120000 }, async (t) => {
  const parent = path.join(root, 'artifacts/server-shell-variables');
  await fs.mkdir(parent, { recursive: true });
  const artifactRoot = await fs.mkdtemp(path.join(parent, 'run-'));
  t.diagnostic('验证产物：' + artifactRoot);
  for (const mode of ['success', 'empty', 'masked', 'failure', 'failure-stop']) {
    await t.test(mode, { timeout: 30000 }, async (childTest) => {
      const expected = mode === 'masked' ? privateFixture : mode === 'empty' ? '' : mode === 'failure' ? 'previous' : '0012';
      const source = mode === 'masked' ? privateFixture + '\r\n' : mode === 'empty' ? '\r\n' : '0012\r\n';
      const shell = {
        id: 'SHELL', action_type: 'server_command', shell: 'bash', command: 'printf sample',
        replace_regex: '[\\r\\n]+', replace_value: '', variable_name: 'disk',
        ...(mode === 'masked' ? { value_masked: 1 } : {}),
        ...(mode === 'failure' ? { continue_on_failure: true } : {}),
      };
      const outcome = await processOutput(source, shell, mode.startsWith('failure') ? 1 : 0);
      let report;
      let taskCount = 0;
      const errors = [];
      const server = http.createServer(async (request, response) => {
        try {
          const origin = 'http://127.0.0.1:' + request.socket.localPort;
          const url = new URL(request.url, origin);
          const send = data => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ code: 0, data }));
          };
          if (url.pathname === '/fixture') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end('<!doctype html><input id="result" value="initial"><output id="accepted"></output><script>'
              + 'document.querySelector("input").oninput = event => { document.querySelector("output").textContent = '
              + 'event.target.value === ' + JSON.stringify(expected) + ' ? "accepted" : "rejected" };</script>');
            return;
          }
          if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
          const route = '/automation/playwright/testcases/SHELL_SCENE/CASE_1';
          if (request.method === 'GET' && url.pathname === route) {
            return send({
              id: 'SHELL_SCENE:CASE_1', name: mode, start_url: origin + '/fixture', initial_variables: { disk: 'previous' },
              steps: [shell,
                { id: 'INPUT', action_type: 'input', target_selector: '#result', value: '${disk}', ...(mode === 'masked' ? { value_masked: 1 } : {}) },
                { id: 'ASSERT', action_type: 'assert_text', target_selector: '#accepted', value: 'accepted' },
              ].map((step, index) => ({ ...step, step_index: index })),
            });
          }
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          if (request.method === 'POST' && url.pathname === '/automation/infrastructure/tasks') {
            const payload = JSON.parse(Buffer.concat(chunks).toString());
            assert.equal('command' in payload, false);
            assert.equal('replace_regex' in payload, false);
            taskCount++;
            return send({ taskId: 'INFRA_LOCAL', ...outcome });
          }
          if (request.method === 'POST' && url.pathname === route + '/results') {
            report = JSON.parse(Buffer.concat(chunks).toString());
            return send({});
          }
          if (request.method === 'POST' && url.pathname === '/automation/playwright/artifacts') {
            return send({ fileId: 'local-fixture', url: '/local-artifacts/fixture' });
          }
          if (request.method === 'POST' && url.pathname === '/automation/operation-catalog/capabilities/playwright') return send({});
          throw new Error('未模拟接口：' + request.method + ' ' + url.pathname);
        } catch (error) {
          errors.push(error.message);
          response.writeHead(500); response.end(JSON.stringify({ code: 500, message: error.message }));
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      childTest.after(() => new Promise(resolve => server.close(resolve)));
      const run = await runCase('http://127.0.0.1:' + server.address().port, path.join(artifactRoot, mode));
      assert.equal(run.code, mode === 'failure-stop' ? 1 : 0, run.output);
      assert.equal(report?.status, mode === 'failure-stop' ? 'failed' : 'passed');
      if (mode === 'failure-stop') {
        assert.equal(report.raw.steps[0].status, 'failed');
      } else {
        assert.equal(report.raw.steps.at(-1).status, 'passed');
        assert.equal(report.raw.steps[1].status, 'passed');
      }
      if (mode === 'failure') {
        // 沿用失败跳过的既有汇总语义；后续输入已证明旧变量未被失败候选覆盖。
        assert.equal(report.raw.steps[0].status, 'skipped');
      }
      assert.equal(taskCount, 1);
      assert.deepEqual(errors, []);
      assert.equal(JSON.stringify(report).includes('_runtime_variables'), false);
      if (mode === 'masked') {
        assert.equal(JSON.stringify(report).includes(privateFixture), false);
        assert.equal(run.output.includes(privateFixture), false);
      }
    });
  }
});

function runCase(origin, artifactRoot) {
  const args = ['src/index.js', '--case-id', 'SHELL_SCENE:CASE_1', '--batch-id', 'SHELL_BATCH',
    '--api-base', origin, '--admin-api', 'true', '--project-environment-id', '47',
    '--token', 'local-shell-test', '--browser', 'chromium', '--headed', 'false',
    '--trace', 'off', '--video', 'off', '--session-mode', 'isolated',
    '--locator-mode', 'semantic-v1', '--timeout', '3000', '--case-timeout', '20000',
    '--finish-delay', '0', '--slow-mo', '0', '--artifact-dir', artifactRoot, '--log-dir', path.join(artifactRoot, 'logs')];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, env: {
      ...process.env, SAKURA_ADMIN_ACCESS_KEY: '', SAKURA_ADMIN_SECRET_KEY: '', CUECAST_ACCESS_KEY: '', CUECAST_SECRET_KEY: '',
      RUNNER_STORAGE_STATE: '', CUECAST_STORAGE_STATE: '', CUECAST_ENV_FILE: '', CUECAST_EXECUTION_CAPABILITY: '',
      CUECAST_EXECUTION_ID: '', CUECAST_RUN_ID: '', CUECAST_JOB_ID: '', RUNNER_LOCAL_ARTIFACT_CLEANUP_ENABLED: 'false',
      SAKURA_PLAYWRIGHT_BROWSER_SESSION_ENDPOINT: '', SAKURA_PLAYWRIGHT_BROWSER_SESSION_DIR: '',
      SAKURA_PLAYWRIGHT_VARIABLE_STATE_IN: '', SAKURA_PLAYWRIGHT_VARIABLE_STATE_OUT: '',
    } });
    let output = '';
    const timer = setTimeout(() => child.kill(), 25000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
