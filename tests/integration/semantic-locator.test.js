import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { throwIfPageError } from '../../src/runner/page-state-diagnostics.js';
import { resolveSemanticLocator } from '../../src/runner/semantic-locator-resolver.js';
import { runStep } from '../../src/runner/step-runner.js';

let browser;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
});

test('hidden Element-style checkbox is promoted to its visible label', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      label { display: inline-flex; width: 120px; height: 32px; align-items: center; }
      .el-checkbox__original { position: absolute; width: 0; height: 0; opacity: 0; z-index: -1; }
    </style>
    <label class="el-checkbox fs-checkbox">
      <span class="el-checkbox__input"><input class="el-checkbox__original" type="checkbox"></span>
      <span>记住密码</span>
    </label>
  `);
  const step = {
    id: 5,
    step_index: 4,
    action_type: 'click',
    target_selector: 'input.el-checkbox__original',
  };
  const meta = {
    version: 1,
    candidates: [{ type: 'css_fallback', value: 'input.el-checkbox__original', score: 0.72 }],
    context: { control_kind: 'input:checkbox', label_text: '记住密码' },
  };

  const resolved = await resolveSemanticLocator(page, step, { timeoutMs: 500 }, meta);
  await resolved.locator.click();

  assert.equal(await page.locator('input').isChecked(), true);
  assert.equal(resolved.diagnostics.selected.normalization_rule, 'checkbox-visible-wrapper');
  await page.close();
});

test('recorded label context narrows duplicated inputs deterministically', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="form-item"><label>源账号</label><input name="account"></div>
    <div class="form-item"><label>目标账号</label><input name="account"></div>
  `);
  const step = { action_type: 'input', target_selector: 'input[name="account"]' };
  const meta = {
    version: 1,
    candidates: [{ type: 'css_attr_name', value: 'input[name="account"]', score: 0.7 }],
    context: { control_kind: 'input:text', label_text: '目标账号', sibling_index: 0 },
  };

  const resolved = await resolveSemanticLocator(page, step, { timeoutMs: 500 }, meta);
  await resolved.locator.fill('target-value');

  assert.deepEqual(await page.locator('input').evaluateAll((items) => items.map((item) => item.value)), ['', 'target-value']);
  assert.equal(resolved.diagnostics.selected.decision, 'semantic-narrowing');
  await page.close();
});

test('Element Select search input keeps the recorded dropdown-click sequence', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      .el-select-dropdown { display: none; position: absolute; }
      .el-select-dropdown.open { display: block; }
    </style>
    <div class="el-select" data-control-kind="custom-select">
      <input aria-label="数据库类型">
    </div>
    <div class="el-select-dropdown" data-overlay="true">
      <div class="el-select-dropdown__item" role="option">MySQL</div>
      <div class="el-select-dropdown__item" role="option">PostgreSQL</div>
    </div>
    <div hidden><li class="el-select-dropdown__item">MySQL</li></div>
    <table><tbody><tr><td>MySQL</td></tr><tr><td>MySQL</td></tr></tbody></table>
    <output id="selected"></output>
    <script>
      const control = document.querySelector('.el-select');
      const input = control.querySelector('input');
      const dropdown = document.querySelector('.el-select-dropdown');
      control.addEventListener('click', () => dropdown.classList.add('open'));
      input.addEventListener('input', () => {
        const query = input.value.toLowerCase();
        dropdown.querySelectorAll('[role="option"]').forEach((item) => {
          item.hidden = query && !item.textContent.toLowerCase().includes(query);
        });
      });
      dropdown.querySelectorAll('[role="option"]').forEach((item) => item.addEventListener('click', () => {
        document.querySelector('#selected').textContent = item.textContent;
        dropdown.classList.remove('open');
      }));
    </script>
  `);

  const openStep = {
    id: 10,
    step_index: 0,
    action_type: 'click',
    target_selector: '.el-select',
    locator_meta: { candidates: [{ type: 'css_fallback', value: '.el-select', score: 1 }], context: {} },
  };
  const searchStep = {
    id: 11,
    step_index: 1,
    action_type: 'input',
    value: 'MY',
    target_selector: '.el-select',
    locator_meta: { candidates: [{ type: 'css_fallback', value: '.el-select', score: 1 }], context: {} },
  };
  const optionStep = {
    id: 12,
    step_index: 2,
    action_type: 'click',
    value: 'MySQL',
    target_xpath: "//li[contains(@class,'el-select-dropdown__item') and normalize-space()='MySQL']",
    locator_meta: {
      candidates: [
        { type: 'text_exact_tag', value: 'li::MySQL', score: 1 },
        { type: 'text_exact', value: 'MySQL', score: 0.9 },
        { type: 'xpath_fallback', value: "//li[contains(@class,'el-select-dropdown__item') and normalize-space()='MySQL']" },
      ],
      context: {},
    },
    is_overlay: 1,
  };
  const options = {
    timeoutMs: 500,
    locatorMode: 'semantic-v1',
    locatorWallTimeoutMs: 1000,
    pageErrorCheckEnabled: false,
    afterStepDelayMs: 0,
  };

  await runStep(page, { start_url: 'about:blank' }, openStep, options);
  await runStep(page, { start_url: 'about:blank' }, searchStep, { ...options, nextStep: optionStep });
  assert.equal(await page.locator('.el-select-dropdown').evaluate((node) => node.classList.contains('open')), true);
  await runStep(page, { start_url: 'about:blank' }, optionStep, options);
  assert.equal(await page.locator('#selected').textContent(), 'MySQL');
  await page.close();
});

test('low-confidence duplicated targets fail with LOCATOR_AMBIGUOUS', async () => {
  const page = await browser.newPage();
  await page.setContent('<button class="same">确定</button><button class="same">确定</button>');
  const step = { action_type: 'click', target_selector: '.same' };
  const meta = {
    version: 1,
    candidates: [{ type: 'css_fallback', value: '.same', score: 0.5 }],
    context: {},
  };

  await assert.rejects(
    resolveSemanticLocator(page, step, { timeoutMs: 80, locatorWallTimeoutMs: 500 }, meta),
    (error) => error?.code === 'LOCATOR_AMBIGUOUS'
      && error.details?.locator_diagnostics?.attempts?.[0]?.matched_count === 2,
  );
  await page.close();
});

test('candidate polling waits for a late element', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div id="root"></div>
    <script>setTimeout(() => { document.querySelector('#root').innerHTML = '<button id="late">稍后出现</button>'; }, 160)</script>
  `);
  const step = { action_type: 'click', target_selector: '#late' };
  const meta = { version: 1, candidates: [{ type: 'css_id', value: '#late', score: 1 }], context: {} };

  const resolved = await resolveSemanticLocator(page, step, { timeoutMs: 600 }, meta);
  assert.equal(resolved.matchedCount, 1);
  assert.equal(resolved.diagnostics.wait.wall_ms >= 120, true);
  await page.close();
});

test('visible loading state pauses the logical locator timeout', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="el-loading-mask" style="width:100px;height:100px"></div>
    <div id="root"></div>
    <script>
      setTimeout(() => document.querySelector('.el-loading-mask').remove(), 190);
      setTimeout(() => { document.querySelector('#root').innerHTML = '<button id="loaded">完成</button>'; }, 220);
    </script>
  `);
  const step = { action_type: 'click', target_selector: '#loaded' };
  const meta = { version: 1, candidates: [{ type: 'css_id', value: '#loaded', score: 1 }], context: {} };

  const resolved = await resolveSemanticLocator(page, step, {
    timeoutMs: 100,
    locatorWallTimeoutMs: 1000,
  }, meta);
  assert.equal(resolved.matchedCount, 1);
  assert.equal(resolved.diagnostics.wait.loading_pause_ms > 0, true);
  await page.close();
});

test('page error detection follows the CDP visible-error contract', async () => {
  const page = await browser.newPage();
  await page.setContent('<div class="el-message--error">服务异常，请稍后重试</div>');

  await throwIfPageError(page, false);
  await assert.rejects(
    throwIfPageError(page, true),
    (error) => error?.code === 'PAGE_ERROR_DETECTED' && error.details?.page_error?.hit === true,
  );
  await page.close();
});

test('covered targets are reported as LOCATOR_COVERED after Playwright actionability failure', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      #target, #cover { position: fixed; left: 20px; top: 20px; width: 120px; height: 40px; }
      #cover { z-index: 2; }
    </style>
    <button id="target">提交</button><div id="cover">遮挡层</div>
  `);
  const step = {
    id: 1,
    step_index: 0,
    action_type: 'click',
    target_selector: '#target',
    target_xpath: '',
    locator_meta: { candidates: [{ type: 'css_id', value: '#target', score: 1 }], context: {} },
    value: '',
    wait_before: 0,
  };

  await assert.rejects(
    runStep(page, { start_url: 'about:blank' }, step, {
      timeoutMs: 100,
      locatorMode: 'semantic-v1',
      locatorWallTimeoutMs: 500,
      pageErrorCheckEnabled: false,
      afterStepDelayMs: 0,
    }),
    (error) => error?.code === 'LOCATOR_COVERED'
      && error.details?.locator_diagnostics?.actionability?.covered === true,
  );
  await page.close();
});

test('downstream request timeout keeps its original error and receives locator diagnostics', async () => {
  const page = await browser.newPage();
  await page.setContent('<button id="trigger">不发请求</button>');
  const step = {
    id: 1,
    step_index: 0,
    action_type: 'assert_request',
    target_selector: '#trigger',
    target_xpath: '',
    locator_meta: { candidates: [{ type: 'css_id', value: '#trigger', score: 1 }], context: {} },
    value: JSON.stringify({ url: '/never-requested' }),
    wait_before: 0,
  };

  await assert.rejects(
    runStep(page, { start_url: 'about:blank' }, step, {
      timeoutMs: 100,
      locatorMode: 'semantic-v1',
      locatorWallTimeoutMs: 500,
      pageErrorCheckEnabled: false,
      afterStepDelayMs: 0,
    }),
    (error) => !String(error?.code || '').startsWith('LOCATOR_')
      && error.details?.locator_diagnostics?.selected?.effective_target === 'button#trigger',
  );
  await page.close();
});
