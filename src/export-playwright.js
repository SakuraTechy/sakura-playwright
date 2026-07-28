#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiClient } from './api/api-client.js';
import { normalizeCase } from './runner/case-loader.js';
import { formatPlatformDateTime, loadRunnerEnv, parseCliArgs, timestampForPath, trimTrailingSlash } from './shared/utils.js';

async function main() {
  const config = parseExportArgs();
  const api = new ApiClient({ apiBase: config.apiBase, token: config.token });
  const testCase = normalizeCase(await api.getTestCase(config.caseId), { caseId: config.caseId });
  const outputPath = config.output || path.resolve(process.cwd(), config.artifactDir, 'exports', `case-${config.caseId}-${timestampForPath()}.spec.js`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, await renderSpec(testCase, config), 'utf8');
  console.log(`[export] playwright case=${config.caseId} output=${outputPath}`);
}

function parseExportArgs(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv);
  const mergedEnv = loadRunnerEnv(argv, env);
  const caseId = args['case-id'] || mergedEnv.CUECAST_CASE_ID || '';
  if (!caseId) throw new Error('Missing required --case-id');
  return {
    caseId,
    apiBase: trimTrailingSlash(args['api-base'] || mergedEnv.CUECAST_API_BASE || 'http://127.0.0.1:4173/api'),
    token: args.token || mergedEnv.CUECAST_TOKEN || '',
    output: args.output ? path.resolve(process.cwd(), args.output) : '',
    artifactDir: args['artifact-dir'] || mergedEnv.RUNNER_ARTIFACT_DIR || 'artifacts',
    storageState: args['storage-state'] || mergedEnv.CUECAST_STORAGE_STATE || mergedEnv.RUNNER_STORAGE_STATE || '',
  };
}

async function renderSpec(testCase, config) {
  const preparedSteps = await Promise.all(testCase.steps.map(prepareStepForExport));
  const lines = [
    "import { test, expect } from 'playwright/test';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { createHash } from 'node:crypto';",
    '',
    `const cuecastStorageState = process.env.CUECAST_STORAGE_STATE || ${quoteJs(config.storageState)};`,
    'if (cuecastStorageState) test.use({ storageState: cuecastStorageState });',
    '',
    `test(${quoteJs(`CueCast case ${testCase.id}: ${testCase.name || ''}`)}, async ({ page: initialPage }) => {`,
    '  let page = initialPage;',
    '  const cuecastPages = [page];',
    `  const apiBase = process.env.CUECAST_API_BASE || ${quoteJs(config.apiBase)};`,
    `  const startUrl = process.env.CUECAST_START_URL || ${quoteJs(testCase.start_url)};`,
    '  const networkEvents = [];',
    '  const attachNetworkRecorder = (targetPage) => {',
    '    targetPage.on(\'request\', (request) => networkEvents.push(cuecastRequestEvent(request)));',
    '  };',
    '  attachNetworkRecorder(page);',
    '  await page.goto(startUrl);',
  ];
  for (const prepared of preparedSteps) {
    const step = prepared.step;
    lines.push('', `  // step ${step.step_index}: ${escapeComment(step.description || step.action_type)}`);
    lines.push(...renderStep(prepared));
  }
  lines.push('});', '');
  lines.push(`// Generated from ${quoteJs(config.apiBase)} at ${formatPlatformDateTime()}.`, '');
  lines.push(...PLAYWRIGHT_HELPERS);
  return `${lines.join('\n')}\n`;
}

async function prepareStepForExport(step) {
  const action = String(step.action_type || '').toLowerCase();
  if (action !== 'network_replay') return { step };
  const config = parseJsonLoose(step.value);
  return {
    step,
    replayEntries: await loadReplayEntries(config),
  };
}

async function loadReplayEntries(config) {
  const rawEntries = Array.isArray(config?.entries) ? config.entries : [];
  const fixturePath = String(config?.path || config?.fixture || config?.har || '').trim();
  if (!fixturePath) return rawEntries;
  const resolvedPath = path.isAbsolute(fixturePath) ? fixturePath : path.resolve(process.cwd(), fixturePath);
  const content = await fs.readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : parsed.entries || [];
}

function renderStep(prepared) {
  const { step } = prepared;
  const action = String(step.action_type || '').toLowerCase();
  const locator = renderLocator(step);
  const value = step.value ?? '';
  const suffix = safeIdentifier(step.step_index ?? step.id ?? action);
  if (!locator && needsLocator(action)) {
    return [`  // TODO: unsupported locator metadata for action ${quoteJs(action)}.`];
  }
  switch (action) {
    case 'navigate':
      return [`  await page.goto(${quoteJs(String(value || step.url || ''))});`];
    case 'click':
      return [`  await ${locator}.click();`];
    case 'double_click':
      return [`  await ${locator}.dblclick();`];
    case 'right_click':
      return [`  await ${locator}.click({ button: 'right' });`];
    case 'input':
      return [`  await ${locator}.fill(${quoteJs(String(value ?? ''))});`];
    case 'key':
      return locator ? [`  await ${locator}.press(${quoteJs(String(value || 'Enter'))});`] : [`  await page.keyboard.press(${quoteJs(String(value || 'Enter'))});`];
    case 'hover':
      return [`  await ${locator}.hover();`];
    case 'assert_text':
      return locator
        ? [`  await expect(${locator}).toContainText(${quoteJs(String(value ?? ''))});`]
        : [`  await expect(page.locator('body')).toContainText(${quoteJs(String(value ?? ''))});`];
    case 'file_upload':
      return renderFileUpload(locator, value);
    case 'assert_download':
      return [`  await cuecastAssertDownload(page, ${locator}, ${jsValue(parseJsonLoose(value))});`];
    case 'assert_json':
      return renderAssertJson(step, locator, suffix);
    case 'assert_request':
      return locator
        ? [`  await cuecastWaitForRequest(page, ${jsValue(parseJsonLoose(value))}, async () => ${locator}.click());`]
        : [`  await cuecastWaitForRequest(page, ${jsValue(parseJsonLoose(value))});`];
    case 'assert_response':
      return locator
        ? [`  await cuecastAssertResponse(page, ${jsValue(parseJsonLoose(value))}, async () => ${locator}.click());`]
        : [`  await cuecastAssertResponse(page, ${jsValue(parseJsonLoose(value))});`];
    case 'assert_request_count':
      return [`  cuecastAssertRequestCount(networkEvents, ${jsValue(parseJsonLoose(value))});`];
    case 'network_mock':
      return [`  await cuecastRegisterNetworkMock(page, ${jsValue(parseJsonLoose(value))});`];
    case 'network_replay':
      return [`  await cuecastRegisterNetworkReplay(page, ${jsValue(prepared.replayEntries || [])});`];
    case 'switch_page':
      return [`  page = await cuecastSwitchPage(page, cuecastPages, ${jsValue(parseJsonLoose(value))});`];
    case 'close_page':
      return [`  page = await cuecastClosePage(page, cuecastPages, ${jsValue(parseJsonLoose(value))});`];
    case 'click_open_page':
      return [
        '  const [openedPage] = await Promise.all([',
        '    page.waitForEvent(\'popup\'),',
        `    ${locator}.click(),`,
        '  ]);',
        '  await openedPage.waitForLoadState(\'domcontentloaded\');',
        '  cuecastTrackPage(cuecastPages, openedPage);',
        '  page = openedPage;',
        '  attachNetworkRecorder(page);',
      ];
    default:
      return [`  // TODO: action ${quoteJs(action)} requires custom export handling.`];
  }
}

function renderAssertJson(step, locator, suffix) {
  const config = parseJsonLoose(step.value);
  const expected = config && typeof config === 'object' && Object.hasOwn(config, 'expected') ? config.expected : config;
  if (locator) {
    return [
      `  const jsonText${suffix} = await ${locator}.textContent();`,
      `  const actualJson${suffix} = JSON.parse(jsonText${suffix} || '{}');`,
      `  expect(cuecastJsonContains(actualJson${suffix}, ${jsValue(expected)})).toBeTruthy();`,
    ];
  }
  return [
    `  const actualJson${suffix} = await cuecastFetchJson(page, apiBase, ${jsValue(config)});`,
    `  expect(cuecastJsonContains(actualJson${suffix}, ${jsValue(expected)})).toBeTruthy();`,
  ];
}

function renderFileUpload(locator, rawValue) {
  const config = parseFileUploadConfig(rawValue);
  if (config.inputSelector) {
    return [`  await page.locator(${quoteJs(config.inputSelector)}).setInputFiles(${jsValue(config.files)});`];
  }
  return [`  await ${locator}.setInputFiles(${jsValue(config.files)});`];
}

function renderLocator(step) {
  const meta = parseMeta(step.locator_meta);
  const context = meta?.context || {};
  const root = renderRoot(context);
  const locator = renderLocatorFromMeta(meta, root);
  if (locator) return locator;

  const selector = String(step.target_selector || '').trim();
  if (selector) return `${root}.locator(${quoteJs(selector)})`;
  const xpath = String(step.target_xpath || '').trim();
  if (xpath) return `${root}.locator(${quoteJs(`xpath=${xpath}`)})`;
  return '';
}

function renderRoot(context) {
  const frame = context?.frame || context?.iframe;
  const selector = String(frame?.selector || frame?.target_selector || frame?.css || '').trim();
  return selector ? `page.frameLocator(${quoteJs(selector)})` : 'page';
}

function renderLocatorFromMeta(meta, root) {
  const candidates = [...(meta?.candidates || [])].sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));
  const context = meta?.context || {};
  for (const candidate of candidates) {
    const type = String(candidate?.type || '');
    const value = String(candidate?.value || '').trim();
    if (!value) continue;
    if (type === 'tree_item_text') {
      const tree = context.tree || candidate.context?.tree || {};
      const treeSelector = String(tree.selector || tree.target_selector || '[role="tree"], .el-tree, .ant-tree, [data-tree="true"]').trim();
      const itemSelector = String(tree.item_selector || '[role="treeitem"], .el-tree-node, .ant-tree-treenode, [data-tree-node="true"]').trim();
      return `${root}.locator(${quoteJs(treeSelector)}).first().locator(${quoteJs(itemSelector)}, { hasText: ${quoteJs(value)} })`;
    }
    if (type === 'table_cell_css' || type === 'table_cell_xpath') {
      const table = context.table || candidate.context?.table || {};
      const wrapper = tableWrapperSelector(table);
      const rowIndex = Number(table.row_index ?? table.rowIndex ?? 0) || 0;
      const colIndex = Number(table.col_index ?? table.colIndex ?? 0) || 0;
      const cell = `${root}.locator(${quoteJs(wrapper)}).nth(${Number(table.wrapper_index ?? table.wrapperIndex ?? 0) || 0}).locator(${quoteJs('tbody tr, .el-table__body tbody tr, .ant-table-tbody tr, .ivu-table-tbody tr')}).nth(${rowIndex}).locator(${quoteJs('td, th, .el-table__cell, .ant-table-cell, .ivu-table-cell')}).nth(${colIndex})`;
      return type === 'table_cell_xpath' ? `${cell}.locator(${quoteJs(`xpath=${value}`)})` : `${cell}.locator(${quoteJs(value)})`;
    }
    if (type === 'text_exact') return `${root}.getByText(${quoteJs(value)}, { exact: true })`;
    if (type === 'text_exact_tag') {
      const { tag, text } = parseTextTagValue(value);
      if (tag && text) return `${root}.locator(${quoteJs(tag)}, { hasText: ${quoteJs(text)} })`;
    }
    if (type.startsWith('css_')) return `${root}.locator(${quoteJs(value)})`;
    if (type === 'xpath_fallback') return `${root}.locator(${quoteJs(`xpath=${value}`)})`;
  }
  return '';
}

function tableWrapperSelector(table) {
  const framework = String(table.framework || table.type || 'table').toLowerCase();
  if (framework === 'el' || framework === 'element') return '.el-table';
  if (framework === 'ant' || framework === 'ant-table') return '.ant-table';
  if (framework === 'ivu') return '.ivu-table';
  return 'table';
}

function parseTextTagValue(value) {
  const raw = String(value || '');
  const idx = raw.indexOf('::');
  if (idx > 0) return { tag: raw.slice(0, idx).trim(), text: raw.slice(idx + 2).trim() };
  const match = raw.match(/^([a-zA-Z][\w-]*)\[(.*)\]$/);
  if (match) return { tag: match[1], text: match[2] };
  return { tag: '', text: '' };
}

function parseFileList(rawValue) {
  if (Array.isArray(rawValue)) return rawValue.map(String);
  const parsed = parseJsonLoose(rawValue);
  if (Array.isArray(parsed)) return parsed.map(String);
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.files)) return parsed.files.map(String);
  const value = String(rawValue ?? '').trim();
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function parseFileUploadConfig(rawValue) {
  const parsed = parseJsonLoose(rawValue);
  if (Array.isArray(parsed)) return { files: parsed.map(String), inputSelector: '' };
  if (parsed && typeof parsed === 'object') {
    const files = Array.isArray(parsed.files) ? parsed.files.map(String) : parsed.file ? [String(parsed.file)] : [];
    return {
      files,
      inputSelector: String(parsed.inputSelector || parsed.input_selector || '').trim(),
    };
  }
  return { files: parseFileList(rawValue), inputSelector: '' };
}

function needsLocator(action) {
  return ['click', 'double_click', 'right_click', 'input', 'hover', 'assert_text', 'file_upload', 'assert_download', 'click_open_page'].includes(action);
}

function parseMeta(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseJsonLoose(raw) {
  if (raw && typeof raw === 'object') return raw;
  const value = String(raw ?? '').trim();
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsValue(value) {
  return JSON.stringify(value);
}

function quoteJs(value) {
  return JSON.stringify(String(value ?? ''));
}

function safeIdentifier(value) {
  const id = String(value ?? 'step').replace(/\W+/g, '_').replace(/^_+|_+$/g, '');
  return id ? `_${id}` : '_step';
}

function escapeComment(value) {
  return String(value ?? '').replace(/\*\//g, '* /').replace(/\r?\n/g, ' ').slice(0, 300);
}

const PLAYWRIGHT_HELPERS = [
  'function cuecastTrackPage(pages, targetPage) {',
  '  if (targetPage && !pages.includes(targetPage)) pages.push(targetPage);',
  '  return targetPage;',
  '}',
  '',
  'function cuecastOpenPages(pages) {',
  '  return pages.filter((candidate) => candidate && !candidate.isClosed());',
  '}',
  '',
  'async function cuecastSwitchPage(currentPage, pages, rawConfig) {',
  '  const config = cuecastPageConfig(rawConfig);',
  '  const targetPage = await cuecastSelectPage(currentPage, cuecastOpenPages(pages), config);',
  '  await targetPage.bringToFront().catch(() => {});',
  '  await targetPage.waitForLoadState(\'domcontentloaded\').catch(() => {});',
  '  return targetPage;',
  '}',
  '',
  'async function cuecastClosePage(currentPage, pages, rawConfig) {',
  '  const config = cuecastPageConfig(rawConfig);',
  '  const openPages = cuecastOpenPages(pages);',
  '  const targetPage = await cuecastSelectPage(currentPage, openPages, config);',
  '  if (openPages.length <= 1) throw new Error(\'close_page requires at least one remaining page\');',
  '  const closedCurrent = targetPage === currentPage;',
  '  await targetPage.close({ runBeforeUnload: false });',
  '  for (let index = pages.length - 1; index >= 0; index -= 1) {',
  '    if (!pages[index] || pages[index].isClosed()) pages.splice(index, 1);',
  '  }',
  '  const fallback = config.fallback ?? config.fallbackTarget ?? config.fallback_target ?? (closedCurrent ? \'main\' : \'current\');',
  '  return cuecastSelectPage(currentPage, cuecastOpenPages(pages), cuecastPageConfig(fallback), { defaultToFirst: true });',
  '}',
  '',
  'function cuecastPageConfig(rawValue) {',
  '  if (rawValue && typeof rawValue === \'object\') return rawValue;',
  '  const value = String(rawValue ?? \'\').trim();',
  '  if (!value) return {};',
  '  try {',
  '    const parsed = JSON.parse(value);',
  '    return parsed && typeof parsed === \'object\' ? parsed : { target: String(parsed ?? \'\') };',
  '  } catch {',
  '    return { target: value };',
  '  }',
  '}',
  '',
  'async function cuecastSelectPage(currentPage, pages, config, behavior = {}) {',
  '  if (!pages.length) throw new Error(\'No open pages are available\');',
  '  const target = String(config.target || config.page || config.window || \'\').trim();',
  '  const targetLower = target.toLowerCase();',
  '  const mainPage = pages[0];',
  '  if ([\'main\', \'original\', \'root\', \'first\'].includes(targetLower)) return mainPage;',
  '  if ([\'current\', \'active\'].includes(targetLower)) return currentPage && !currentPage.isClosed() ? currentPage : mainPage;',
  '  if ([\'latest\', \'last\'].includes(targetLower)) return pages[pages.length - 1];',
  '  if ([\'popup\', \'new\'].includes(targetLower)) return pages.findLast((candidate) => candidate !== mainPage) || pages[pages.length - 1];',
  '  const index = cuecastPageIndex(config);',
  '  if (index != null) {',
  '    if (pages[index]) return pages[index];',
  '    throw new Error(`Page index ${index} was not found`);',
  '  }',
  '  const matched = [];',
  '  for (const candidate of pages) {',
  '    if (await cuecastPageMatches(candidate, config, target)) matched.push(candidate);',
  '  }',
  '  if (matched.length) return matched[matched.length - 1];',
  '  if (!target && !cuecastHasPageMatcher(config)) return currentPage && !currentPage.isClosed() ? currentPage : mainPage;',
  '  if (behavior.defaultToFirst) return mainPage;',
  '  throw new Error(`No open page matched ${target || JSON.stringify(config)}`);',
  '}',
  '',
  'function cuecastPageIndex(config) {',
  '  const raw = config.index ?? config.pageIndex ?? config.page_index;',
  '  if (raw == null || raw === \'\') return null;',
  '  const index = Number(raw);',
  '  return Number.isInteger(index) && index >= 0 ? index : null;',
  '}',
  '',
  'async function cuecastPageMatches(page, config, plainTarget) {',
  '  const url = page.url();',
  '  const title = await page.title().catch(() => \'\');',
  '  const urlExact = cuecastFirstString(config.urlExact, config.url_exact);',
  '  const urlExpected = cuecastFirstString(config.urlContains, config.url_contains, config.url, config.pattern, config.urlPattern, config.url_pattern);',
  '  const titleExact = cuecastFirstString(config.titleExact, config.title_exact);',
  '  const titleExpected = cuecastFirstString(config.titleContains, config.title_contains, config.title, config.name);',
  '  if (urlExact && url !== urlExact) return false;',
  '  if (urlExpected && !cuecastUrlMatches(url, urlExpected)) return false;',
  '  if (titleExact && title !== titleExact) return false;',
  '  if (titleExpected && !cuecastTextMatches(title, titleExpected)) return false;',
  '  if (urlExact || urlExpected || titleExact || titleExpected) return true;',
  '  const value = String(plainTarget || \'\').trim();',
  '  return Boolean(value) && (cuecastUrlMatches(url, value) || cuecastTextMatches(title, value));',
  '}',
  '',
  'function cuecastHasPageMatcher(config) {',
  '  return cuecastPageIndex(config) != null || Boolean(cuecastFirstString(config.urlExact, config.url_exact, config.urlContains, config.url_contains, config.url, config.pattern, config.urlPattern, config.url_pattern, config.titleExact, config.title_exact, config.titleContains, config.title_contains, config.title, config.name));',
  '}',
  '',
  'function cuecastFirstString(...values) {',
  '  for (const value of values) {',
  '    const text = String(value ?? \'\').trim();',
  '    if (text) return text;',
  '  }',
  '  return \'\';',
  '}',
  '',
  'function cuecastTextMatches(actual, expected) {',
  '  const value = String(expected || \'\');',
  '  if (!value) return true;',
  '  if (value.includes(\'*\')) {',
  '    const escaped = value.split(\'*\').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, \'\\\\$&\')).join(\'.*\');',
  '    return new RegExp(`^${escaped}$`).test(String(actual || \'\'));',
  '  }',
  '  return String(actual || \'\').includes(value);',
  '}',
  '',
  'function cuecastRequestEvent(request) {',
  '  return {',
  '    url: request.url(),',
  '    method: request.method(),',
  '    postData: request.postData() || \'\',',
  '    headers: request.headers(),',
  '  };',
  '}',
  '',
  'function cuecastUrlMatches(actual, expected) {',
  '  const value = String(expected || \'\');',
  '  if (!value) return true;',
  '  if (value.includes(\'*\')) {',
  '    const escaped = value.split(\'*\').map((part) => part.replace(/[.*+?^${}()|[\\]\\\\]/g, \'\\\\$&\')).join(\'.*\');',
  '    return new RegExp(`^${escaped}$`).test(actual);',
  '  }',
  '  return String(actual || \'\').includes(value);',
  '}',
  '',
  'function cuecastRequestMatches(request, config) {',
  '  const url = config.url || config.pattern || \'\';',
  '  if (!cuecastUrlMatches(request.url(), url)) return false;',
  '  if (config.method && request.method().toUpperCase() !== String(config.method).toUpperCase()) return false;',
  '  const bodyPart = config.postDataContains || config.post_data_contains || \'\';',
  '  if (bodyPart && !String(request.postData() || \'\').includes(bodyPart)) return false;',
  '  for (const [key, value] of Object.entries(config.headers || {})) {',
  '    if (String(request.headers()[String(key).toLowerCase()] || \'\') !== String(value)) return false;',
  '  }',
  '  return true;',
  '}',
  '',
  'function cuecastResponseMatches(response, config) {',
  '  const url = config.url || config.pattern || \'\';',
  '  if (!cuecastUrlMatches(response.url(), url)) return false;',
  '  if (config.method && response.request().method().toUpperCase() !== String(config.method).toUpperCase()) return false;',
  '  if (config.status != null && response.status() !== Number(config.status)) return false;',
  '  return true;',
  '}',
  '',
  'async function cuecastWaitForRequest(page, config, trigger) {',
  '  const waiter = page.waitForRequest((request) => cuecastRequestMatches(request, config));',
  '  if (trigger) {',
  '    const [request] = await Promise.all([waiter, trigger()]);',
  '    return request;',
  '  }',
  '  return waiter;',
  '}',
  '',
  'async function cuecastAssertResponse(page, config, trigger) {',
  '  const waiter = page.waitForResponse((response) => cuecastResponseMatches(response, config));',
  '  const response = trigger ? (await Promise.all([waiter, trigger()]))[0] : await waiter;',
  '  const needsBody = config.textContains || config.text_contains || config.bodyContains || config.body_contains || config.json != null || config.expected != null || config.snapshot || config.snapshotName || config.snapshot_name || config.baselinePath || config.baseline_path || config.baseline;',
  '  const body = needsBody ? await response.text() : \'\';',
  '  const textContains = config.textContains || config.text_contains || config.bodyContains || config.body_contains || \'\';',
  '  if (textContains) expect(body).toContain(textContains);',
  '  const expectedJson = config.json ?? config.expected;',
  '  if (expectedJson != null) expect(cuecastJsonContains(JSON.parse(body), expectedJson)).toBeTruthy();',
  '  if (config.baselinePath || config.baseline_path || config.baseline) cuecastAssertResponseBaseline(response, config, body);',
  '  if (config.snapshot || config.snapshotName || config.snapshot_name) cuecastSaveResponseSnapshot(response, config, body);',
  '  return response;',
  '}',
  '',
  'function cuecastAssertRequestCount(events, config) {',
  '  const matched = events.filter((event) => cuecastRequestEventMatches(event, config));',
  '  const count = matched.length;',
  '  if (config.count != null) expect(count).toBe(Number(config.count));',
  '  if (config.min != null) expect(count).toBeGreaterThanOrEqual(Number(config.min));',
  '  if (config.max != null) expect(count).toBeLessThanOrEqual(Number(config.max));',
  '}',
  '',
  'function cuecastRequestEventMatches(event, config) {',
  '  const url = config.url || config.pattern || \'\';',
  '  if (!cuecastUrlMatches(event.url, url)) return false;',
  '  if (config.method && String(event.method || \'\').toUpperCase() !== String(config.method).toUpperCase()) return false;',
  '  const bodyPart = config.postDataContains || config.post_data_contains || \'\';',
  '  if (bodyPart && !String(event.postData || \'\').includes(bodyPart)) return false;',
  '  for (const [key, value] of Object.entries(config.headers || {})) {',
  '    if (String(event.headers?.[String(key).toLowerCase()] || \'\') !== String(value)) return false;',
  '  }',
  '  return true;',
  '}',
  '',
  'async function cuecastRegisterNetworkMock(page, config) {',
  '  const url = config.url || config.pattern;',
  '  await page.route(url, async (route) => {',
  '    if (config.method && route.request().method().toUpperCase() !== String(config.method).toUpperCase()) {',
  '      await route.fallback();',
  '      return;',
  '    }',
  '    if (Number(config.delayMs || config.delay_ms || 0) > 0) await new Promise((resolve) => setTimeout(resolve, Number(config.delayMs || config.delay_ms)));',
  '    if (config.abort) {',
  '      await route.abort(String(config.abort));',
  '      return;',
  '    }',
  '    await cuecastFulfillRoute(route, config);',
  '  });',
  '}',
  '',
  'async function cuecastRegisterNetworkReplay(page, entries) {',
  '  for (const entry of entries) {',
  '    await page.route(entry.url || entry.pattern, async (route) => {',
  '      if (entry.method && route.request().method().toUpperCase() !== String(entry.method).toUpperCase()) {',
  '        await route.fallback();',
  '        return;',
  '      }',
  '      if (Number(entry.delayMs || entry.delay_ms || 0) > 0) await new Promise((resolve) => setTimeout(resolve, Number(entry.delayMs || entry.delay_ms)));',
  '      if (entry.abort) {',
  '        await route.abort(String(entry.abort));',
  '        return;',
  '      }',
  '      await cuecastFulfillRoute(route, entry);',
  '    });',
  '  }',
  '}',
  '',
  'async function cuecastFulfillRoute(route, config) {',
  '  const fulfill = {',
  '    status: Number(config.status) || 200,',
  '    headers: config.headers || {},',
  '  };',
  '  if (config.json !== undefined) {',
  '    fulfill.contentType = \'application/json\';',
  '    fulfill.body = JSON.stringify(config.json);',
  '  } else {',
  '    fulfill.contentType = config.contentType || config.content_type || \'text/plain\';',
  '    fulfill.body = String(config.body ?? \'\');',
  '  }',
  '  await route.fulfill(fulfill);',
  '}',
  '',
  'async function cuecastFetchJson(page, apiBase, config) {',
  '  const rawUrl = config.url || config.path || \'\';',
  '  const url = String(rawUrl).startsWith(\'http\') ? rawUrl : `${apiBase}${String(rawUrl).startsWith(\'/\') ? rawUrl : `/${rawUrl}`}`;',
  '  const request = {',
  '    method: String(config.method || \'GET\').toUpperCase(),',
  '    headers: config.headers || {},',
  '  };',
  '  if (config.body !== undefined || config.json !== undefined) request.data = config.json !== undefined ? config.json : config.body;',
  '  const response = await page.request.fetch(url, request);',
  '  expect(response.ok()).toBeTruthy();',
  '  return response.json();',
  '}',
  '',
  'async function cuecastAssertDownload(page, locator, config) {',
  '  const expected = cuecastDownloadExpected(config);',
  '  const [download] = await Promise.all([page.waitForEvent(\'download\'), locator.click()]);',
  '  const filename = download.suggestedFilename();',
  '  if (expected.filename) expect(filename).toContain(expected.filename);',
  '  const downloadDir = path.resolve(process.cwd(), \'test-results\', \'cuecast-downloads\');',
  '  fs.mkdirSync(downloadDir, { recursive: true });',
  '  const savePath = path.join(downloadDir, cuecastSanitizeFilename(filename || `download-${Date.now()}`));',
  '  await download.saveAs(savePath);',
  '  const stat = fs.statSync(savePath);',
  '  if (expected.minBytes != null) expect(stat.size).toBeGreaterThanOrEqual(Number(expected.minBytes));',
  '  if (expected.maxBytes != null) expect(stat.size).toBeLessThanOrEqual(Number(expected.maxBytes));',
  '  if (expected.mime) expect(cuecastGuessMimeType(savePath).toLowerCase()).toContain(String(expected.mime).toLowerCase());',
  '  if (expected.contains) expect(fs.readFileSync(savePath, \'utf8\')).toContain(expected.contains);',
  '  if (expected.sha256) expect(cuecastFileSha256(savePath)).toBe(String(expected.sha256).toLowerCase());',
  '}',
  '',
  'function cuecastDownloadExpected(config) {',
  '  if (typeof config === \'string\') return { filename: config };',
  '  return {',
  '    filename: String(config.filename || config.name || \'\'),',
  '    contains: String(config.contains || config.text || \'\'),',
  '    mime: String(config.mime || config.contentType || config.content_type || \'\'),',
  '    minBytes: config.minBytes ?? config.min_bytes ?? null,',
  '    maxBytes: config.maxBytes ?? config.max_bytes ?? null,',
  '    sha256: String(config.sha256 || \'\').toLowerCase(),',
  '  };',
  '}',
  '',
  'function cuecastAssertResponseBaseline(response, config, body) {',
  '  const baselinePath = path.resolve(process.cwd(), config.baselinePath || config.baseline_path || config.baseline);',
  '  const expectedText = fs.readFileSync(baselinePath, \'utf8\');',
  '  const mode = String(config.baselineMode || config.baseline_mode || \'exact\').toLowerCase();',
  '  if (mode === \'text\') {',
  '    expect(body.replace(/\\r\\n/g, \'\\n\').trimEnd()).toBe(expectedText.replace(/\\r\\n/g, \'\\n\').trimEnd());',
  '    return;',
  '  }',
  '  const expected = JSON.parse(expectedText);',
  '  const actual = JSON.parse(body);',
  '  if (mode === \'subset\') expect(cuecastJsonContains(actual, expected)).toBeTruthy();',
  '  else expect(cuecastStableJson(actual)).toBe(cuecastStableJson(expected));',
  '}',
  '',
  'function cuecastSaveResponseSnapshot(response, config, body) {',
  '  const name = cuecastSanitizeFilename(config.snapshotName || config.snapshot_name || `response-${Date.now()}`);',
  '  const dir = path.resolve(process.cwd(), \'test-results\', \'cuecast-response-snapshots\');',
  '  fs.mkdirSync(dir, { recursive: true });',
  '  const contentType = String(response.headers()[\'content-type\'] || \'\').toLowerCase();',
  '  const ext = contentType.includes(\'json\') ? \'json\' : \'txt\';',
  '  const bodyPath = path.join(dir, `${name}.${ext}`);',
  '  fs.writeFileSync(bodyPath, body, \'utf8\');',
  '  fs.writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify({ url: response.url(), status: response.status(), method: response.request().method(), headers: response.headers(), body_path: bodyPath }, null, 2));',
  '}',
  '',
  'function cuecastJsonContains(actual, expected) {',
  '  if (expected == null) return true;',
  '  if (typeof expected !== \'object\') return Object.is(actual, expected);',
  '  if (Array.isArray(expected)) {',
  '    if (!Array.isArray(actual) || expected.length > actual.length) return false;',
  '    return expected.every((item, index) => cuecastJsonContains(actual[index], item));',
  '  }',
  '  if (!actual || typeof actual !== \'object\') return false;',
  '  return Object.entries(expected).every(([key, value]) => cuecastJsonContains(actual[key], value));',
  '}',
  '',
  'function cuecastStableJson(value) {',
  '  if (Array.isArray(value)) return `[${value.map(cuecastStableJson).join(\',\')}]`;',
  '  if (!value || typeof value !== \'object\') return JSON.stringify(value);',
  '  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${cuecastStableJson(value[key])}`).join(\',\')}}`;',
  '}',
  '',
  'function cuecastGuessMimeType(filePath) {',
  '  const ext = path.extname(filePath).toLowerCase();',
  '  if (ext === \'.txt\') return \'text/plain\';',
  '  if (ext === \'.json\') return \'application/json\';',
  '  if (ext === \'.csv\') return \'text/csv\';',
  '  if (ext === \'.html\' || ext === \'.htm\') return \'text/html\';',
  '  if (ext === \'.png\') return \'image/png\';',
  '  if (ext === \'.jpg\' || ext === \'.jpeg\') return \'image/jpeg\';',
  '  if (ext === \'.pdf\') return \'application/pdf\';',
  '  return \'application/octet-stream\';',
  '}',
  '',
  'function cuecastFileSha256(filePath) {',
  '  return createHash(\'sha256\').update(fs.readFileSync(filePath)).digest(\'hex\');',
  '}',
  '',
  'function cuecastSanitizeFilename(value) {',
  '  return String(value || \'download.txt\').replace(/[<>:"/\\\\|?*\\x00-\\x1F]/g, \'_\').slice(0, 180);',
  '}',
];

main().catch((error) => {
  console.error(`[export] ${error?.message || error}`);
  process.exitCode = 1;
});
