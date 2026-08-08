import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const runnerEntry = path.join(projectRoot, 'src', 'index.js');
const cuecastCasesPath = path.join(workspaceRoot, 'sakura-cuecast', 'test-lab', 'mock-data', 'cases.json');

test('Runner replays the CueCast variable and five-mode assertion mock case', async () => {
  const mockData = JSON.parse(await fs.readFile(cuecastCasesPath, 'utf8'));
  const sourceCase = mockData.cases?.['298'];
  assert.ok(sourceCase, 'CueCast mock case 298 is required');

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-cuecast-recording-'));
  let reportedResult;
  const server = http.createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    if (request.method === 'GET' && request.url?.startsWith('/api/testcases/298')) {
      return sendJson(response, {
        success: true,
        data: {
          ...structuredClone(sourceCase),
          start_url: `${origin}/target.html`,
        },
      });
    }
    if (request.method === 'POST' && request.url === '/api/testcases/298/results') {
      reportedResult = JSON.parse(await readRequestBody(request));
      return sendJson(response, { success: true, data: {} });
    }
    if (request.method === 'GET' && request.url === '/target.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(`<!doctype html><html><body>
        <div id="statusText">Ready</div>
        <label>Username <input id="username" /></label>
      </body></html>`);
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const apiBase = `http://127.0.0.1:${server.address().port}/api`;
    const run = await runCase(apiBase, temporaryDirectory);
    assert.equal(run.code, 0, run.output);
    assert.equal(reportedResult?.status, 'passed', run.output);
    assert.equal(reportedResult?.raw?.steps?.length, 8, run.output);
    assert.ok(reportedResult.raw.steps.every((step) => step.status === 'passed'), run.output);
    assert.deepEqual(
      reportedResult.raw.steps.map((step) => step.action_type),
      [
        'global_variable_set',
        'input',
        'assert_element_match',
        'assert_element_match',
        'assert_element_match',
        'assert_element_match',
        'assert_element_match',
        'assert_element_match',
      ],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function sendJson(response, payload) {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  return body;
}

function runCase(apiBase, temporaryDirectory) {
  const args = [
    runnerEntry,
    '--case-id', '298',
    '--api-base', apiBase,
    '--trace', 'off',
    '--video', 'off',
    '--artifact-dir', path.join(temporaryDirectory, 'artifacts'),
    '--log-dir', path.join(temporaryDirectory, 'logs'),
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
