import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright';
import { throwIfPageError } from '../../src/runner/page-state-diagnostics.js';
import { resolveLocator } from '../../src/runner/locator-resolver.js';
import { resolveSemanticLocator } from '../../src/runner/semantic-locator-resolver.js';
import { runStep } from '../../src/runner/step-runner.js';
import { PlayerManager } from '../../../sakura-cuecast/modules/player-manager.js';

let browser;
const cuecastDomPlayerSource = fs.readFileSync(new URL(
  '../../../sakura-cuecast/content/player.js',
  import.meta.url,
), 'utf8');
const locatorContract = JSON.parse(fs.readFileSync(new URL(
  '../../../sakura-cuecast/tests/fixtures/locator-contract-v1.json',
  import.meta.url,
), 'utf8'));

async function installCuecastDomPlayer(page) {
  await page.evaluate((source) => {
    const runtime = {
      onMessage: {
        addListener(listener) {
          window.__cuecastDomMessageListener = listener;
        },
      },
      sendMessage() {
        return Promise.resolve({ ok: true });
      },
    };
    window.chrome = window.chrome || {};
    Object.defineProperty(window.chrome, 'runtime', { configurable: true, value: runtime });
    (0, eval)(source);
  }, cuecastDomPlayerSource);
}

async function executeCuecastDomStep(page, step) {
  return page.evaluate((domStep) => new Promise((resolve) => {
    window.__cuecastDomMessageListener(
      { type: 'AT_EXECUTE_STEP', step: domStep, locale: 'zh' },
      {},
      resolve,
    );
  }), step);
}

test.before(async () => {
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
});

test('bracket XPath is passed through unchanged in legacy and semantic modes', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <span class="user-title">防统方系统 - 系统管理平台</span>
    <span class="user-title">隐藏副本</span>
  `);
  const step = {
    action_type: 'assert_element_match',
    target_selector: '',
    target_xpath: "(//span[@class='user-title'])[1]",
    locator_meta: { version: 1, candidates: [], context: {} },
  };

  for (const locatorMode of ['legacy', 'semantic-v1']) {
    const resolved = await resolveLocator(page, step, {
      locatorMode,
      timeoutMs: 300,
      locatorWallTimeoutMs: 600,
      allowHidden: true,
    });
    assert.equal(await resolved.locator.textContent(), '防统方系统 - 系统管理平台');
    assert.equal(resolved.matchedCount, 1);
  }
  const cdpExpression = PlayerManager._buildElementAssertionExpr('', step.target_xpath, 'text', step.locator_meta);
  const cdpResult = await page.evaluate(cdpExpression);
  assert.equal(cdpResult.ok, true);
  assert.equal(cdpResult.value, '防统方系统 - 系统管理平台');
  assert.equal(cdpResult.via, 'xpath');

  await installCuecastDomPlayer(page);
  const domResult = await executeCuecastDomStep(page, {
    ...step,
    value: '防统方系统 - 系统管理平台',
    match_mode: 'equals',
  });
  assert.equal(domResult.ok, true, JSON.stringify(domResult));
  await page.close();
});

test('invalid XPath returns a dedicated error code in both resolver modes', async () => {
  const page = await browser.newPage();
  await page.setContent('<span class="user-title">标题</span>');
  const step = {
    action_type: 'assert_element_match',
    target_xpath: "(//span[@class='user-title']",
    locator_meta: { version: 1, candidates: [], context: {} },
  };

  for (const locatorMode of ['legacy', 'semantic-v1']) {
    await assert.rejects(
      resolveLocator(page, step, { locatorMode, timeoutMs: 50, locatorWallTimeoutMs: 120 }),
      (error) => error?.code === 'LOCATOR_XPATH_INVALID',
    );
  }
  await page.close();
});

test('non-node XPath and private locator strategies return dedicated errors', async () => {
  const page = await browser.newPage();
  await page.setContent('<span class="user-title">标题</span>');

  for (const locatorMode of ['legacy', 'semantic-v1']) {
    await assert.rejects(
      resolveLocator(page, {
        action_type: 'assert_element_match',
        target_xpath: 'count(//span)',
      }, { locatorMode, timeoutMs: 50, locatorWallTimeoutMs: 120 }),
      (error) => error?.code === 'LOCATOR_XPATH_UNSUPPORTED',
    );
    await assert.rejects(
      resolveLocator(page, {
        action_type: 'click',
        target_selector: "jquery=$('.user-title')",
      }, { locatorMode, timeoutMs: 50, locatorWallTimeoutMs: 120 }),
      (error) => error?.code === 'LOCATOR_STRATEGY_UNSUPPORTED',
    );
  }

  await installCuecastDomPlayer(page);
  const domResult = await executeCuecastDomStep(page, {
    action_type: 'assert_element_match',
    target_selector: "document.querySelector('.user-title')",
    value: '标题',
    match_mode: 'equals',
  });
  assert.equal(domResult.ok, false);
  assert.equal(domResult.error_code, 'LOCATOR_STRATEGY_UNSUPPORTED');
  await page.close();
});

test('every recorder candidate type resolves in both Playwright modes', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <span id="locator-target" class="user-title"
      data-testid="locator-target" data-test="locator-target"
      data-qa="locator-target" data-cy="locator-target"
      name="locator-target" aria-label="定位目标" placeholder="定位目标"
      title="定位目标" role="button">统一定位目标</span>
    <div class="ant-tree" role="tree">
      <div class="ant-tree-treenode" role="treeitem">
        <span class="ant-tree-switcher">展开</span>
        <span class="ant-tree-node-content-wrapper"><span class="ant-tree-title">系统管理</span></span>
      </div>
    </div>
  `);

  for (const locatorMode of ['legacy', 'semantic-v1']) {
    for (const candidate of locatorContract.candidates) {
      let resolved;
      try {
        resolved = await resolveLocator(page, {
          action_type: 'click',
          locator_meta: { version: 1, candidates: [{ ...candidate, score: 1 }], context: {} },
        }, { locatorMode, timeoutMs: 300, locatorWallTimeoutMs: 600 });
      } catch (error) {
        error.message = `${locatorMode} 未处理 ${candidate.type}: ${error.message}`;
        throw error;
      }
      assert.equal(await resolved.locator.count(), 1, `${locatorMode} 未处理 ${candidate.type}`);
    }
  }
  await page.close();
});

test('data-qa and data-cy candidates are executable semantic CSS candidates', async () => {
  const page = await browser.newPage();
  await page.setContent('<button data-qa="save">保存</button><button data-cy="cancel">取消</button>');

  for (const [type, value, text] of [
    ['css_attr_data-qa', '[data-qa="save"]', '保存'],
    ['css_attr_data-cy', '[data-cy="cancel"]', '取消'],
  ]) {
    const resolved = await resolveSemanticLocator(page, { action_type: 'click' }, { timeoutMs: 300 }, {
      version: 1,
      candidates: [{ type, value, score: 1 }],
      context: {},
    });
    assert.equal(await resolved.locator.textContent(), text);
  }
  await page.close();
});

test('CueCast CDP input and assertion select the same locator_meta target', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <input data-qa="source" value="source">
    <input data-qa="target" value="target">
  `);
  const locatorMeta = {
    version: 1,
    candidates: [{ type: 'css_attr_data-qa', value: '[data-qa="target"]', score: 0.97 }],
    context: { control_kind: 'input:text' },
  };
  const cdpSession = await page.context().newCDPSession(page);
  await PlayerManager.prototype._setInputValueCDP.call({
    _cdpSend: (_tabId, method, params) => cdpSession.send(method, params),
  }, 1, '', '', 'updated', locatorMeta, false);

  assert.deepEqual(
    await page.locator('input').evaluateAll((items) => items.map((item) => item.value)),
    ['source', 'updated'],
  );
  const assertionResult = await page.evaluate(
    PlayerManager._buildElementAssertionExpr('', '', 'value', locatorMeta),
  );
  assert.equal(assertionResult.ok, true);
  assert.equal(assertionResult.value, 'updated');
  assert.equal(assertionResult.via, 'meta-css_attr_data-qa');
  await cdpSession.detach();
  await page.close();
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

test('CueCast CDP click promotes a same-level label for hidden table checkbox', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`
    <style>
      .cell { width: 50px; height: 30px; }
      .header-center { display: inline-block; width: 18px; height: 18px; }
      input.header-center { display: none; }
      label.checkbox-inner { border: 1px solid #999; }
    </style>
    <table class="el-table"><thead><tr><th><div class="cell"><div class="header-center header-frist-child">
      <input type="checkbox" id="1-select-all" class="header-center">
      <label for="1-select-all" class="header-center checkbox-inner"></label>
    </div></div></th></tr></thead></table>
  `);

  const selector = '.el-table:nth-of-type(1) thead > tr:nth-of-type(1) > th:nth-of-type(1) div.cell > div.header-center.header-frist-child > input.header-center';
  const expression = PlayerManager.prototype._buildFindCode.call({}, selector, '//*[@id="1-select-all"]');
  const box = await page.evaluate(expression);

  assert.equal(box.ok, true);
  assert.equal(box.hitOk, true);
  const checkbox = page.locator('input[id="1-select-all"]');
  assert.equal(await checkbox.isChecked(), false);
  await page.mouse.click(box.x, box.y);
  assert.equal(await checkbox.isChecked(), true);
  await page.close();
});

test('CueCast CDP click waits for a temporary covering mask to disappear', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`
    <style>
      #target, #cover { position: fixed; left: 20px; top: 20px; width: 140px; height: 40px; }
      #target { z-index: 1; }
      #cover { z-index: 2; background: rgba(0, 0, 0, 0.2); }
    </style>
    <button id="target">扩展配置</button><div id="cover"></div>
    <script>setTimeout(() => document.getElementById('cover').remove(), 220);</script>
  `);

  const cdpSession = await page.context().newCDPSession(page);
  const startedAt = Date.now();
  const result = await PlayerManager.prototype._getElementBoxResult.call({
    _buildFindCode: PlayerManager.prototype._buildFindCode.bind({}),
    _getEffectiveWaitTimeout: () => 1000,
    _isPageLoadingUi: async () => false,
    _throwIfPageError: async () => {},
    _sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    _cdpSend: (_tabId, method, params) => cdpSession.send(method, params),
  }, 1, '#target', '', '', 1000, false, null, true);

  assert.equal(result.ok, true);
  assert.equal(result.box.hitOk, true);
  assert.equal(Date.now() - startedAt >= 200, true);
  await cdpSession.detach();
  await page.close();
});

test('hidden file input is accepted for certificate upload', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      input[type="file"] { display: none; }
    </style>
    <input id="certificate" type="file" accept=".lic">
  `);
  const step = {
    id: 6,
    step_index: 5,
    action_type: 'certificate_upload',
    target_selector: '#certificate',
  };
  const meta = {
    version: 1,
    candidates: [{ type: 'css_id', value: '#certificate', score: 1 }],
    context: { control_kind: 'input:file' },
  };

  const resolved = await resolveSemanticLocator(page, step, { timeoutMs: 500 }, meta);

  assert.equal(await resolved.locator.getAttribute('type'), 'file');
  assert.equal(resolved.visibleCount, 1);
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

test('Element Message fixed overlay remains eligible for an element assertion', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="el-message" style="position: fixed; top: 20px; left: 20px; display: block;">
      <p class="el-message__content">系统无证书，请上传证书</p>
    </div>
  `);
  const step = {
    action_type: 'assert_element_match',
    target_selector: 'p.el-message__content',
    target_xpath: '/html/body/div[5]/p',
    value: '系统无证书，请上传证书',
    read_mode: 'text',
    match_mode: 'contains',
  };
  const meta = {
    version: 1,
    candidates: [
      { type: 'css_fallback', value: 'p.el-message__content', score: 0.72 },
      { type: 'xpath_fallback', value: '/html/body/div[6]/p', score: 0.42 },
    ],
    context: { overlay: true, tag: 'p' },
  };

  const resolved = await resolveSemanticLocator(page, step, { timeoutMs: 500 }, meta);

  assert.equal(resolved.matchedCount, 1);
  assert.equal(resolved.visibleCount, 1);
  assert.equal(await resolved.locator.textContent(), '系统无证书，请上传证书');
  assert.equal(resolved.diagnostics.selected.source, 'locator_meta.candidates[0]');
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

test('element assertion failure preserves the selected locator diagnostics', async () => {
  const page = await browser.newPage();
  await page.setContent('<div id="message">实际页面内容</div>');
  const step = {
    id: 2,
    step_index: 0,
    action_type: 'assert_element_match',
    target_selector: '#message',
    target_xpath: '',
    locator_meta: { candidates: [{ type: 'css_id', value: '#message', score: 1 }], context: {} },
    read_mode: 'text',
    match_mode: 'contains',
    expect: '期望页面内容',
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
    (error) => error?.code === 'ASSERTION_FAILED'
      && error.details?.source === 'locator_meta.candidates[0]'
      && error.details?.locatorType === 'css_id'
      && error.details?.locatorValue === '#message'
      && error.details?.locator_diagnostics?.selected?.source === 'locator_meta.candidates[0]',
  );
  await page.close();
});
