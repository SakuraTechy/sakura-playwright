import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { normalizeSteps } from '../../src/runner/case-loader.js';
import { runStep } from '../../src/runner/step-runner.js';
import { createVariableContext } from '../../src/runner/variable-context.js';

let browser;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
});

test('CueCast 保存变量从运行时 input value 抽取，不使用录制快照', async () => {
  const page = await browser.newPage();
  await page.setContent('<input id="order" value="ORD-20260807">');
  const variableContext = createVariableContext();
  const [step] = normalizeSteps([{
    id: 'RECORDED_VARIABLE',
    action_type: 'set_variable',
    target_selector: '#order',
    value: 'order_number',
    value_text: 'STALE-SNAPSHOT',
    locator_meta: {
      context: {
        variable: {
          name: 'order_number',
          source: 'value',
          extract: { mode: 'regex', pattern: 'ORD-(\\d+)', group: 1 },
        },
      },
    },
  }]);

  await runStep(page, {}, step, runnerOptions({ variableContext }));

  assert.equal(variableContext.get('order_number'), '20260807');
  await page.close();
});

test('CueCast 五种元素断言读取文本或表单值并输出结构化结果', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <h1 id="title">防统方系统 - 系统管理平台</h1>
    <input id="account" value="admin-user">
  `);
  const cases = [
    { selector: '#title', match: 'contains', source: 'text', expected: '系统管理平台' },
    { selector: '#title', match: 'equals', source: 'text', expected: '防统方系统 - 系统管理平台' },
    { selector: '#title', match: 'not_contains', source: 'text', expected: '登录失败' },
    { selector: '#title', match: 'regex', source: 'text', expected: '^防统方系统.*平台$' },
    { selector: '#account', match: 'equals', source: 'auto', expected: 'admin-user' },
    { selector: '#title', match: 'visible', source: 'auto', expected: '' },
  ];

  for (const [index, item] of cases.entries()) {
    const [step] = normalizeSteps([recordedAssertion(index, item)]);
    const result = await runStep(page, {}, step, runnerOptions());
    assert.equal(result.operation_assertion.passed, true);
    assert.equal(result.operation_assertion.operator, item.match);
  }
  await page.close();
});

test('CueCast 可见断言对唯一隐藏元素返回断言失败而不是误判通过', async () => {
  const page = await browser.newPage();
  await page.setContent('<div id="hidden" style="display:none">secret</div>');
  const [step] = normalizeSteps([recordedAssertion(1, {
    selector: '#hidden',
    match: 'visible',
    source: 'auto',
    expected: '',
  })]);

  await assert.rejects(() => runStep(page, {}, step, runnerOptions()), { code: 'ASSERTION_FAILED' });
  await page.close();
});

function recordedAssertion(index, { selector, match, source, expected }) {
  return {
    id: `RECORDED_ASSERTION_${index}`,
    step_index: index,
    action_type: 'assert_text',
    target_selector: selector,
    value: expected,
    locator_meta: {
      assertion: { target: 'element', match },
      context: { assertion: { target: 'element', match, source } },
    },
  };
}

function runnerOptions(extra = {}) {
  return {
    timeoutMs: 500,
    afterStepDelayMs: 0,
    pageErrorCheckEnabled: false,
    ...extra,
  };
}
