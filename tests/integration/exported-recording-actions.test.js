import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { renderSpec } from '../../src/export-playwright.js';
import { renderPytest } from '../../src/export-pytest.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exportConfig = {
  apiBase: 'http://127.0.0.1:4173/api',
  storageState: '',
};

test('生成的 Playwright 与 Pytest 脚本可在真实 Chromium 执行录制变量和五种断言', async () => {
  const testCase = exportedRecordingCase();
  const javascriptPath = path.join(repositoryRoot, 'tests', `generated-recording-${process.pid}.spec.js`);
  const pythonPath = path.join(os.tmpdir(), `sakura-generated-recording-${process.pid}.py`);
  await fs.writeFile(javascriptPath, await renderSpec(testCase, exportConfig), 'utf8');
  await fs.writeFile(pythonPath, await renderPytest(testCase, exportConfig), 'utf8');

  try {
    const javascript = spawnSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules', 'playwright', 'cli.js'),
      'test',
      path.relative(repositoryRoot, javascriptPath).replace(/\\/g, '/'),
      '--reporter=line',
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, RUNNER_TRACE: 'off', RUNNER_VIDEO: 'off' },
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(javascript.status, 0, `${javascript.error || ''}\n${javascript.stdout || ''}\n${javascript.stderr || ''}`);

    const pythonRunner = [
      'import importlib.util, sys',
      'from playwright.sync_api import sync_playwright',
      'spec = importlib.util.spec_from_file_location("generated_recording", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'with sync_playwright() as playwright:',
      '    browser = playwright.chromium.launch(headless=True, executable_path=sys.argv[2])',
      '    try:',
      '        test_function = next(value for name, value in vars(module).items() if name.startswith("test_cuecast_case_"))',
      '        test_function(browser)',
      '    finally:',
      '        browser.close()',
    ].join('\n');
    const python = spawnSync('python', ['-X', 'utf8', '-c', pythonRunner, pythonPath, chromium.executablePath()], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(python.status, 0, `${python.error || ''}\n${python.stdout || ''}\n${python.stderr || ''}`);
  } finally {
    await Promise.all([
      fs.unlink(javascriptPath).catch(() => {}),
      fs.unlink(pythonPath).catch(() => {}),
    ]);
  }
});

function exportedRecordingCase() {
  const html = [
    '<!doctype html><html><body>',
    '<div id="title">系统管理平台</div>',
    '<input id="account" value="admin-001">',
    '<input id="search">',
    '</body></html>',
  ].join('');
  return {
    id: 'export_runtime',
    name: '导出录制动作真实执行',
    start_url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    steps: [
      {
        step_index: 1,
        action_type: 'global_variable_set',
        variable_name: 'title',
        source_type: 'locator',
        read_mode: 'text',
        regex: '^系统管理平台$',
        regex_group: 0,
        target_selector: '#title',
      },
      assertion(2, '#title', 'text', 'contains', '{{title}}'),
      assertion(3, '#title', 'text', 'equals', '${title}'),
      assertion(4, '#title', 'text', 'not_contains', '登录失败'),
      assertion(5, '#title', 'text', 'regex', '^系统.*平台$'),
      assertion(6, '#title', 'text', 'visible', ''),
      {
        step_index: 7,
        action_type: 'global_variable_set',
        variable_name: 'account',
        source_type: 'locator',
        read_mode: 'value',
        target_selector: '#account',
      },
      assertion(8, '#account', 'value', 'equals', '{{account}}'),
      {
        step_index: 9,
        action_type: 'input',
        value: '${title}',
        target_selector: '#search',
      },
      assertion(10, '#search', 'value', 'equals', '{{title}}'),
    ],
  };
}

function assertion(stepIndex, targetSelector, readMode, matchMode, expect) {
  return {
    step_index: stepIndex,
    action_type: 'assert_element_match',
    target_selector: targetSelector,
    read_mode: readMode,
    match_mode: matchMode,
    expect,
  };
}
