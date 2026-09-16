import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { extractLiveFramePresentation } from '../../src/runner/live-frame-publisher.js';
import { createBrowserActionContext, runStep } from '../../src/runner/step-runner.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const pdfStep = {
  id: '8', step_index: 7, action_type: 'assert_attribute',
  target_xpath: "//embed[@type='application/x-google-chrome-pdf']",
  attribute: 'type', expect: 'application/x-google-chrome-pdf',
  description: '检查是否打开帮助手册成功',
};

test('真实 Runner 在有头和无头模式下切换 PDF、等待三秒并上传新窗口画面', { timeout: 240000 }, async (t) => {
  const fixtureBrowser = await chromium.launch({ channel: 'chromium', headless: true });
  t.after(() => fixtureBrowser.close());
  const fixturePage = await fixtureBrowser.newPage();
  await fixturePage.setContent('<h1>Sakura PDF regression</h1><p>Help manual opened successfully.</p>');
  const pdf = await fixturePage.pdf();
  const artifactsParent = path.join(projectRoot, 'artifacts/pdf-viewer-regression');
  await fs.mkdir(artifactsParent, { recursive: true });
  const artifactsRoot = await fs.mkdtemp(path.join(artifactsParent, 'run-'));
  t.diagnostic(`验证产物：${artifactsRoot}`);

  const variants = ['isolated', 'reuse-browser'].flatMap((sessionMode) => [
    { sessionMode, headed: false }, { sessionMode, headed: true },
  ]);
  for (const { sessionMode, headed } of variants) {
    const modeName = `${sessionMode}-${headed ? 'headed' : 'headless'}`;
    await t.test(modeName, async (modeTest) => {
      const modeDir = path.join(artifactsRoot, modeName);
      await fs.mkdir(modeDir, { recursive: true });
      const frames = [];
      let reported;
      let requestError;
      const server = http.createServer(async (request, response) => {
        try {
          const origin = `http://127.0.0.1:${request.socket.localPort}`;
          const url = new URL(request.url, origin);
          if (url.pathname === '/fixture') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(fixtureHtml(pdf));
            return;
          }
          if (url.pathname === '/favicon.ico') {
            response.writeHead(204);
            response.end();
            return;
          }
          assert.equal(request.headers.authorization, 'Bearer local-pdf-test');
          if (request.method === 'GET' && url.pathname === '/automation/playwright/testcases/PDF/CASE') {
            assert.equal(url.searchParams.get('projectEnvironmentId'), 'local-pdf');
            return sendJson(response, recordingCase(origin));
          }
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          if (request.method === 'PUT' && url.pathname === '/automation/playwright/runner/jobs/pdf-regression/live-frame') {
            frames.push({ content: body, presentation: extractLiveFramePresentation(body) });
          } else if (request.method === 'POST' && url.pathname === '/automation/playwright/testcases/PDF/CASE/results') {
            reported = JSON.parse(body.toString());
          } else if (request.method === 'POST' && url.pathname === '/automation/playwright/artifacts') {
            return sendJson(response, { fileId: 'local-file', url: '/local-artifacts/test' });
          } else if (request.method === 'POST' && url.pathname === '/automation/operation-catalog/capabilities/playwright') {
            return sendJson(response, {});
          } else {
            // 未模拟的接口必须失败，防止错误路径被当成空用例并产生假通过。
            requestError = new Error(`未模拟接口：${request.method} ${url.pathname}`);
            response.writeHead(404);
            response.end(JSON.stringify({ code: 404, message: requestError.message }));
            return;
          }
          return sendJson(response, {});
        } catch (error) {
          requestError = error;
          response.writeHead(500);
          response.end(JSON.stringify({ code: 500, message: error.message }));
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const run = await runLocalCase(origin, headed, modeDir, sessionMode);
        await fs.writeFile(path.join(modeDir, 'runner.log'), run.output);
        if (reported) await fs.writeFile(path.join(modeDir, 'reported-result.json'), JSON.stringify(reported, null, 2));
        assert.ifError(requestError);
        assert.equal(run.code, 0, run.output);
        assert.equal(reported?.status, 'passed', run.output);
        assert.equal(reported.raw.steps.length, 8);
        assert.ok(reported.raw.steps.every((step) => step.status === 'passed'));
        const switched = reported.raw.steps[5];
        const waited = reported.raw.steps[6];
        const checked = reported.raw.steps[7];
        assert.match(switched.switched_page_url, /^blob:http:\/\/127\.0\.0\.1:/);
        assert.equal(switched.switched_page_index, 1);
        assert.equal(waited.wait_duration_ms, 3000);
        assert.ok(waited.duration_ms >= 3000 && waited.duration_ms < 6000, `等待耗时 ${waited.duration_ms}ms`);
        assert.ok(checked.duration_ms < 4000, `属性断言耗时 ${checked.duration_ms}ms`);
        assert.equal(checked.locator_source, 'pdf_viewer_frame');
        assert.equal(checked.details.operation.outcome.assertion.actual.preview, 'application/x-google-chrome-pdf');
        assert.equal(checked.pdf_viewer_fallback, undefined);
        for (const sequence of [6, 7, 8]) {
          const matching = frames.filter((frame) => frame.presentation?.label?.startsWith(`步骤 ${sequence} ·`));
          assert.ok(matching.length, `缺少步骤 ${sequence} 的实时帧`);
          for (const frame of matching) {
            assert.equal(await isOriginalGreenPage(fixturePage, frame.content), false, `步骤 ${sequence} 仍展示旧窗口`);
          }
          await fs.writeFile(path.join(modeDir, `step-${sequence}.jpg`), matching[0].content);
        }
        const firstFrame = frames.find((frame) => frame.presentation?.label?.startsWith('步骤 1 ·'));
        assert.ok(firstFrame);
        assert.equal(await isOriginalGreenPage(fixturePage, firstFrame.content), true);
        modeTest.diagnostic(`切页 ${switched.duration_ms}ms；等待 ${waited.duration_ms}ms；属性断言 ${checked.duration_ms}ms；实时帧 ${frames.length} 张`);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});

test('PDF 定位等待内部 frame 加载，不接受错误期望或其他窗口的 PDF', { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe id="viewer"></iframe>');
    const frame = page.frames()[1];
    const options = { browserContext: createBrowserActionContext({ defaultTimeoutMs: 1000 }), afterStepDelayMs: 0 };
    await frame.evaluate(() => setTimeout(() => {
      const root = document.body.appendChild(document.createElement('div')).attachShadow({ mode: 'open' });
      root.innerHTML = '<embed type="application/x-google-chrome-pdf">';
    }, 150));
    const result = await runStep(page, {}, pdfStep, options);
    assert.equal(result.operation_assertion.actual.preview, 'application/x-google-chrome-pdf');
    await assert.rejects(runStep(page, {}, { ...pdfStep, expect: 'wrong' }, options), { code: 'ASSERTION_FAILED' });
    const otherPage = await browser.newPage();
    await otherPage.setContent('<p>No help manual here</p>');
    await assert.rejects(runStep(otherPage, {}, pdfStep, options), { code: 'LOCATOR_NOT_FOUND' });
  } finally {
    await browser.close();
  }
});

function recordingCase(origin) {
  return {
    id: 'PDF:CASE', name: 'PDF 帮助手册回归', start_url: `${origin}/fixture`,
    steps: [
      { action_type: 'input', target_selector: '#username', value: 'test-user' },
      { action_type: 'key', target_selector: '#username', value: 'Tab' },
      { action_type: 'input', target_selector: '#password', value: 'test-only' },
      { action_type: 'click', target_selector: '#login' },
      { action_type: 'click', target_selector: '#help' },
      { action_type: 'switch_page', value: '', description: '切换当前最新窗口' },
      { action_type: 'wait', value: '3000', description: '等待3秒' },
      pdfStep,
    ].map((step, index) => ({ id: String(index + 1), step_index: index, ...step })),
  };
}

function fixtureHtml(pdf) {
  return `<!doctype html><html><body style="background:rgb(0,255,0)">
    <h1>Original business window</h1>
    <input id="username"><input id="password" type="password">
    <button id="login">Login</button><button id="help" hidden>Help manual</button>
    <script>
      document.querySelector('#login').onclick = () => { document.querySelector('#help').hidden = false; };
      document.querySelector('#help').onclick = () => {
        const bytes = Uint8Array.from(atob('${pdf.toString('base64')}'), (character) => character.charCodeAt(0));
        window.open(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })));
      };
    </script></body></html>`;
}

function sendJson(response, data) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ code: 0, data }));
}

async function isOriginalGreenPage(page, jpeg) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(10, 10, 1, 1).data;
    return r < 50 && g > 200 && b < 50;
  }, jpeg.toString('base64'));
}

function runLocalCase(origin, headed, artifactsDir, sessionMode) {
  return new Promise((resolve, reject) => {
    const sharedBrowser = sessionMode === 'reuse-browser';
    const child = spawn(process.execPath, [
      sharedBrowser ? 'src/batch.js' : 'src/index.js',
      sharedBrowser ? '--case-ids' : '--case-id', 'PDF:CASE', '--workers', '1', '--api-base', origin,
      '--admin-api', 'true', '--project-environment-id', 'local-pdf', '--job-id', 'pdf-regression',
      '--token', 'local-pdf-test', '--browser', 'chromium', '--headed', String(headed),
      '--locator-mode', 'semantic-v1', '--timeout', '6000', '--case-timeout', '45000',
      '--trace', 'on', '--video', sharedBrowser ? 'off' : 'on', '--session-mode', sessionMode,
      '--finish-delay', '0', '--slow-mo', '0',
      '--artifact-dir', path.join(artifactsDir, 'artifacts'), '--log-dir', path.join(artifactsDir, 'logs'),
    ], {
      cwd: projectRoot, windowsHide: true,
      env: {
        ...process.env,
        SAKURA_ADMIN_ACCESS_KEY: '', SAKURA_ADMIN_SECRET_KEY: '', CUECAST_ACCESS_KEY: '', CUECAST_SECRET_KEY: '',
        RUNNER_STORAGE_STATE: '', CUECAST_STORAGE_STATE: '', CUECAST_BATCH_ID: '', CUECAST_ENV_FILE: '',
        CUECAST_EXECUTION_CAPABILITY: '', CUECAST_EXECUTION_ID: '', CUECAST_RUN_ID: '',
        // batch 通过环境传递这些任务参数，子进程不能继承开发机的真实任务配置。
        CUECAST_PROJECT_ENVIRONMENT_ID: 'local-pdf', CUECAST_JOB_ID: 'pdf-regression',
        RUNNER_LOCATOR_MODE: 'semantic-v1', RUNNER_OPERATION_DIAGNOSTIC_ENABLED: 'true',
        RUNNER_LOG_DIR: path.join(artifactsDir, 'logs'), RUNNER_LIVE_FRAME_QUALITY: 'smooth',
        SAKURA_PLAYWRIGHT_BROWSER_SESSION_ENDPOINT: '',
        RUNNER_LOCAL_ARTIFACT_CLEANUP_ENABLED: 'false',
      },
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 55000);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
