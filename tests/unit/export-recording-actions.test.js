import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { renderSpec } from '../../src/export-playwright.js';
import { renderPytest } from '../../src/export-pytest.js';

const config = {
  apiBase: 'http://127.0.0.1:4173/api',
  storageState: '',
};

function recordingCase() {
  return {
    id: 'recording-export',
    name: '录制变量与断言',
    start_url: 'http://127.0.0.1:4173/recording-actions.html',
    steps: [
      {
        step_index: 1,
        action_type: 'global_variable_set',
        variable_name: 'title',
        source_type: 'locator',
        read_mode: 'text',
        regex: '系统(管理平台)',
        regex_group: 1,
        target_selector: '#title',
      },
      ...['contains', 'equals', 'not_contains', 'regex', 'visible'].map((matchMode, index) => ({
        step_index: index + 2,
        action_type: 'assert_element_match',
        read_mode: 'text',
        match_mode: matchMode,
        expect: matchMode === 'visible' ? '' : '{{title}}',
        value: '不能读取该字段',
        target_selector: '#title',
      })),
      {
        step_index: 7,
        action_type: 'input',
        value: '${title}',
        target_selector: '#search',
      },
    ],
  };
}

test('Playwright 导出保存变量、五种元素断言和两种变量引用', async () => {
  const output = await renderSpec(recordingCase(), config);

  assert.match(output, /const cuecastVariables = \{\}/);
  assert.match(output, /cuecastVariables\["title"\] = cuecastExtractVariable/);
  assert.match(output, /"regexGroup":1/);
  assert.match(output, /\.toContain\(cuecastAssertionExpected/);
  assert.match(output, /\.toBe\(cuecastAssertionExpected/);
  assert.match(output, /\.not\.toContain\(cuecastAssertionExpected/);
  assert.match(output, /\.toMatch\(new RegExp\(cuecastAssertionExpected/);
  assert.match(output, /\.toBeVisible\(\)/);
  assert.match(output, /cuecastResolveVariables\("\{\{title}}"/);
  assert.match(output, /cuecastResolveVariables\("\$\{title}"/);
  assert.doesNotMatch(output, /不能读取该字段.*toContain/);
  assert.doesNotMatch(output, /TODO: action "(?:global_variable_set|assert_element_match)"/);
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: output,
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('Pytest 导出保存变量、五种元素断言和 expect 字段', async () => {
  const output = await renderPytest(recordingCase(), config);

  assert.match(output, /cuecast_variables = \{\}/);
  assert.match(output, /cuecast_variables\["title"\] = cuecast_extract_variable/);
  assert.match(output, /"regex_group": 1/);
  assert.match(output, /assert cuecast_assertion_expected_\d+ in cuecast_assertion_actual_\d+/);
  assert.match(output, /assert cuecast_assertion_actual_\d+ == cuecast_assertion_expected_\d+/);
  assert.match(output, /assert cuecast_assertion_expected_\d+ not in cuecast_assertion_actual_\d+/);
  assert.match(output, /assert re\.search\(cuecast_assertion_expected_\d+, cuecast_assertion_actual_\d+\) is not None/);
  assert.match(output, /\.to_be_visible\(\)/);
  assert.match(output, /cuecast_resolve_variables\("\{\{title}}"/);
  assert.match(output, /cuecast_resolve_variables\("\$\{title}"/);
  assert.doesNotMatch(output, /TODO: action "(?:global_variable_set|assert_element_match)"/);
  const syntax = spawnSync('python', ['-X', 'utf8', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: output,
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('条件点击导出为状态匹配后才点击', async () => {
  const testCase = {
    id: 'conditional-click',
    start_url: 'http://127.0.0.1:4173/',
    steps: [{ step_index: 0, action_type: 'click', target_selector: '#switch', click_when: 'off' }],
  };
  const playwright = await renderSpec(testCase, config);
  const pytest = await renderPytest(testCase, config);

  assert.match(playwright, /cuecastReadElementState\(page\.locator\("#switch"\)\) === "off"/);
  assert.match(pytest, /if cuecast_read_element_state\(page\.locator\("#switch"\)\) == "off":/);
});

test('条件元素存在时导出为存在性判断后才点击', async () => {
  const testCase = {
    id: 'conditional-click-exists',
    start_url: 'http://127.0.0.1:4173/',
    steps: [{
      step_index: 0,
      action_type: 'click',
      target_selector: '#switch',
      click_when: 'element_exists',
      click_condition_ref: { strategy: 'xpath', value: "(//span[contains(text(),'OFF')])[2]", exact: true },
    }],
  };
  const playwright = await renderSpec(testCase, config);
  const pytest = await renderPytest(testCase, config);

  assert.ok(playwright.includes('if (await page.locator("xpath=(//span[contains(text(),\'OFF\')])[2]").count()) await page.locator("#switch").click();'));
  assert.ok(pytest.includes('if page.locator("xpath=(//span[contains(text(),\'OFF\')])[2]").count():'));
});
