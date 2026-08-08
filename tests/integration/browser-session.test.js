import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const batchEntry = path.join(projectRoot, 'src', 'batch.js');

test('reuse-browser batch keeps successful page state and resets the host after failure', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-browser-session-'));
  let secondStartRequests = 0;
  let freshStartRequests = 0;
  const server = http.createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    if (request.method === 'GET' && request.url?.startsWith('/api/testcases/911')) {
      return sendJson(response, {
        success: true,
        data: {
          id: 911,
          name: '建立页面内存状态',
          start_url: `${origin}/login`,
          steps: [{
            id: 1,
            step_index: 0,
            action_type: 'click',
            target_selector: '#continue',
            description: '进入工作页',
          }],
        },
      });
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/testcases/912')) {
      return sendJson(response, {
        success: true,
        data: {
          id: 912,
          name: '复用当前页面',
          start_url: `${origin}/login-entry`,
          steps: [{
            id: 1,
            step_index: 0,
            action_type: 'assert_text',
            value: 'runtime-only-ready',
            description: '确认页面内存仍存在',
          }],
        },
      });
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/testcases/913')) {
      return sendJson(response, {
        success: true,
        data: {
          id: 913,
          name: '失败页面不得继续传递',
          start_url: `${origin}/dirty`,
          steps: [{
            id: 1,
            step_index: 0,
            action_type: 'assert_text',
            value: 'never-present',
            description: '制造失败状态',
          }],
        },
      });
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/testcases/914')) {
      return sendJson(response, {
        success: true,
        data: {
          id: 914,
          name: '失败后使用新宿主',
          start_url: `${origin}/fresh`,
          steps: [{
            id: 1,
            step_index: 0,
            action_type: 'assert_text',
            value: 'fresh-ready',
            description: '确认新宿主加载起点',
          }],
        },
      });
    }
    if (request.url?.startsWith('/api/testcases/') && request.method === 'POST') {
      for await (const _chunk of request) {
        // 消费 Runner 结果请求体。
      }
      return sendJson(response, { success: true, data: {} });
    }
    if (request.url === '/login') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(`<!doctype html><html><body>
        <button id="continue">continue</button>
        <script>
          document.querySelector('#continue').onclick = () => {
            window.runtimeOnlyState = { ready: true };
            history.replaceState({}, '', '/workspace');
            document.body.textContent = window.runtimeOnlyState.ready ? 'runtime-only-ready' : 'failed';
          };
        </script>
      </body></html>`);
    }
    if (request.url === '/login-entry') {
      secondStartRequests += 1;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end('<!doctype html><html><body>new-browser-login-page</body></html>');
    }
    if (request.url === '/workspace') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end('<!doctype html><html><body>reloaded-workspace</body></html>');
    }
    if (request.url === '/dirty') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end('<!doctype html><html><body>dirty-state</body></html>');
    }
    if (request.url === '/fresh') {
      freshStartRequests += 1;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end('<!doctype html><html><body>fresh-ready</body></html>');
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    return response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}/api`;

  try {
    const result = await runBatch(apiBase, temporaryDirectory, '911,912', 'success');
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /passed total=2 passed=2 failed=0/);
    assert.equal(secondStartRequests, 0);
    const successfulVideos = await findFiles(path.join(temporaryDirectory, 'success'), '.webm');
    assert.equal(successfulVideos.length, 2);
    for (const videoPath of successfulVideos) {
      assert.ok((await fs.stat(videoPath)).size > 0);
      const header = await fs.readFile(videoPath);
      assert.deepEqual([...header.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    }

    const resetResult = await runBatch(apiBase, temporaryDirectory, '913,914', 'reset-after-failure');
    assert.notEqual(resetResult.code, 0);
    assert.match(resetResult.output, /failed total=2 passed=1 failed=1/);
    assert.equal(freshStartRequests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function sendJson(response, payload) {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function runBatch(apiBase, temporaryDirectory, caseIds, artifactName) {
  const args = [
    batchEntry,
    '--case-ids', caseIds,
    '--api-base', apiBase,
    '--workers', '1',
    '--session-mode', 'reuse-browser',
    '--trace', 'off',
    '--video', 'on',
    '--artifact-dir', path.join(temporaryDirectory, artifactName),
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: { ...process.env, CUECAST_ADMIN_API: 'false', RUNNER_HEADED: 'false' },
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function findFiles(directory, extension) {
  const matches = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...await findFiles(resolved, extension));
    else if (entry.name.endsWith(extension)) matches.push(resolved);
  }
  return matches;
}
