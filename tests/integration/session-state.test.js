import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const batchEntry = path.join(projectRoot, 'src', 'batch.js');

test('reuse-auth batch carries Cookie localStorage IndexedDB and sessionStorage to the next case', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-session-integration-'));
  const server = createSessionServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const apiBase = `http://127.0.0.1:${port}/api`;

  try {
    const isolated = await runBatch(apiBase, temporaryDirectory, 'isolated');
    assert.notEqual(isolated.code, 0);
    assert.match(isolated.output, /failed total=2 passed=1 failed=1/);

    const reused = await runBatch(apiBase, temporaryDirectory, 'reuse-auth');
    assert.equal(reused.code, 0, reused.output);
    assert.match(reused.output, /passed total=2 passed=2 failed=0/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('reuse-auth batch rejects requested workers greater than one', async () => {
  const result = await runBatchCommand([
    batchEntry,
    '--case-ids', '901',
    '--workers', '2',
    '--session-mode', 'reuse-auth',
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /reuse-auth session mode requires --workers 1/);
});

function createSessionServer() {
  const cases = {
    901: {
      id: 901,
      name: '建立登录态',
      start_url: '',
      steps: [
        { id: 1, step_index: 0, action_type: 'wait', value: '500', description: '等待登录态写入' },
        { id: 2, step_index: 1, action_type: 'assert_text', value: 'auth-created', description: '确认登录态已建立' },
      ],
    },
    902: {
      id: 902,
      name: '复用登录态',
      start_url: '',
      steps: [
        { id: 1, step_index: 0, action_type: 'wait', value: '500', description: '等待认证状态读取' },
        { id: 2, step_index: 1, action_type: 'assert_text', value: 'access-granted', description: '确认无需重新登录' },
      ],
    },
  };

  return http.createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    if (request.method === 'GET' && request.url?.startsWith('/api/testcases/901')) {
      return sendJson(response, { success: true, data: { ...cases[901], start_url: `${origin}/login` } });
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/testcases/902')) {
      // 第二条仍保存录制时的登录入口，验证 Runner 能恢复上一条成功用例的业务页面。
      return sendJson(response, { success: true, data: { ...cases[902], start_url: `${origin}/login-entry` } });
    }
    if (request.url?.startsWith('/api/testcases/') && request.method === 'POST') {
      for await (const _chunk of request) {
        // 消费结果请求体后返回成功，模拟 CueCast test-lab 协议。
      }
      return sendJson(response, { success: true, data: {} });
    }
    if (request.url === '/login') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'auth-cookie=ready; HttpOnly; Path=/; SameSite=Lax',
      });
      return response.end(loginPage());
    }
    if (request.url === '/protected') {
      const cookiePresent = String(request.headers.cookie || '').includes('auth-cookie=ready');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(protectedPage(cookiePresent));
    }
    if (request.url === '/login-entry') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end('<!doctype html><html><body>login-screen</body></html>');
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    return response.end('not found');
  });
}

function loginPage() {
  return `<!doctype html>
<html><body>creating-auth<script>
localStorage.setItem('auth-local', 'ready');
sessionStorage.setItem('auth-session', 'ready');
const request = indexedDB.open('auth-db', 1);
request.onupgradeneeded = () => request.result.createObjectStore('tokens');
request.onsuccess = () => {
  const transaction = request.result.transaction('tokens', 'readwrite');
  transaction.objectStore('tokens').put('ready', 'auth-indexed');
  transaction.oncomplete = () => {
    history.replaceState({}, '', '/protected');
    document.body.textContent = 'auth-created';
  };
};
</script></body></html>`;
}

function protectedPage(cookiePresent) {
  return `<!doctype html>
<html><body>checking-auth<script>
const cookiePresent = ${JSON.stringify(cookiePresent)};
const localPresent = localStorage.getItem('auth-local') === 'ready';
const sessionPresent = sessionStorage.getItem('auth-session') === 'ready';
const request = indexedDB.open('auth-db', 1);
request.onupgradeneeded = () => request.result.createObjectStore('tokens');
request.onsuccess = () => {
  const transaction = request.result.transaction('tokens', 'readonly');
  const read = transaction.objectStore('tokens').get('auth-indexed');
  read.onsuccess = () => {
    document.body.textContent = cookiePresent && localPresent && sessionPresent && read.result === 'ready'
      ? 'access-granted'
      : 'access-denied';
  };
};
</script></body></html>`;
}

function sendJson(response, payload) {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function runBatch(apiBase, temporaryDirectory, sessionMode) {
  const artifactDirectory = path.join(temporaryDirectory, `artifacts-${sessionMode}`);
  const args = [
    batchEntry,
    '--case-ids', '901,902',
    '--api-base', apiBase,
    '--workers', '1',
    '--session-mode', sessionMode,
    '--trace', 'off',
    '--video', 'off',
    '--artifact-dir', artifactDirectory,
  ];
  return runBatchCommand(args);
}

function runBatchCommand(args) {
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
