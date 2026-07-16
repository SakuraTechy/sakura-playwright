import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseLocatorMeta, resolveLocator } from './locator-resolver.js';
import { formatPlatformDateTime, RunnerError, sleep } from '../shared/utils.js';

export async function runStep(page, testCase, step, options = {}) {
  const startedAt = Date.now();
  if (step.wait_before > 0) await sleep(step.wait_before);

  const action = String(step.action_type || '').toLowerCase();
  let locatorInfo = null;
  let extra = {};

  switch (action) {
    case 'navigate': {
      const url = String(step.value || step.url || testCase.start_url || '').trim();
      if (!url) throw new RunnerError('CASE_INVALID', 'navigate step has no URL');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      break;
    }

    case 'click': {
      locatorInfo = await resolveLocator(page, step, options);
      await locatorInfo.locator.click({ timeout: options.timeoutMs });
      break;
    }

    case 'click_open_page': {
      locatorInfo = await resolveLocator(page, step, options);
      extra = await clickOpenPage(page, locatorInfo.locator, options);
      break;
    }

    case 'switch_page': {
      extra = await switchPage(page, step.value, options);
      break;
    }

    case 'close_page': {
      extra = await closePage(page, step.value, options);
      break;
    }

    case 'double_click': {
      locatorInfo = await resolveLocator(page, step, options);
      await locatorInfo.locator.dblclick({ timeout: options.timeoutMs });
      break;
    }

    case 'right_click': {
      locatorInfo = await resolveLocator(page, step, options);
      await locatorInfo.locator.click({ button: 'right', timeout: options.timeoutMs });
      break;
    }

    case 'input': {
      locatorInfo = await resolveLocator(page, step, options);
      await fillInput(page, locatorInfo.locator, step.value ?? '', options);
      break;
    }

    case 'file_upload': {
      locatorInfo = await resolveLocator(page, step, options);
      extra = await uploadFiles(page, locatorInfo.locator, step.value, options);
      break;
    }

    case 'assert_download': {
      locatorInfo = await resolveLocator(page, step, options);
      extra = await assertDownload(page, locatorInfo.locator, step.value, options);
      break;
    }

    case 'assert_json': {
      locatorInfo = await runAssertJson(page, step, options);
      break;
    }

    case 'assert_request': {
      locatorInfo = hasLocator(step) ? await resolveLocator(page, step, options) : null;
      extra = await assertRequest(page, locatorInfo?.locator || null, step.value, options);
      break;
    }

    case 'assert_response': {
      locatorInfo = hasLocator(step) ? await resolveLocator(page, step, options) : null;
      extra = await assertResponse(page, locatorInfo?.locator || null, step.value, options, step);
      break;
    }

    case 'assert_request_count': {
      extra = assertRequestCount(step.value, options);
      break;
    }

    case 'network_mock': {
      extra = await registerNetworkMock(page, step.value);
      break;
    }

    case 'network_replay': {
      extra = await registerNetworkReplay(page, step.value);
      break;
    }

    case 'key': {
      if (hasLocator(step)) {
        locatorInfo = await resolveLocator(page, step, options);
        await locatorInfo.locator.press(String(step.value || 'Enter'), { timeout: options.timeoutMs });
      } else {
        await page.keyboard.press(String(step.value || 'Enter'));
      }
      break;
    }

    case 'hover': {
      locatorInfo = await resolveLocator(page, step, options);
      await locatorInfo.locator.hover({ timeout: options.timeoutMs });
      break;
    }

    case 'wait': {
      await sleep(Number(step.value) || step.wait_before || 1000);
      break;
    }

    case 'scroll': {
      await runScroll(page, step, options);
      break;
    }

    case 'assert_text': {
      locatorInfo = await runAssertText(page, step, options);
      break;
    }

    default:
      throw new RunnerError('UNSUPPORTED_STEP', `Unsupported action_type: ${step.action_type}`, { action_type: step.action_type });
  }

  await sleep(options.afterStepDelayMs ?? 250);
  return {
    step_index: step.step_index,
    step_id: step.id,
    action_type: action,
    status: 'passed',
    duration_ms: Date.now() - startedAt,
    locator_source: locatorInfo?.source || '',
    locator_type: locatorInfo?.locatorType || '',
    matched_count: locatorInfo?.matchedCount ?? null,
    visible_count: locatorInfo?.visibleCount ?? null,
    ...extra,
  };
}

async function fillInput(page, locator, value, options) {
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (await isMonacoEditor(locator)) {
    await fillMonacoEditor(page, locator, value, options);
    return;
  }
  if (tag === 'select') {
    const raw = String(value ?? '');
    await locator.selectOption(raw, { timeout: options.timeoutMs }).catch(async () => {
      await locator.selectOption({ label: raw }, { timeout: options.timeoutMs });
    });
    return;
  }
  const editable = await locator.evaluate((el) => el.isContentEditable || el.closest('[contenteditable="true"]') != null).catch(() => false);
  if (editable) {
    await locator.click({ timeout: options.timeoutMs });
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await locator.press('Backspace');
    await page.keyboard.insertText(String(value ?? ''));
    return;
  }
  if (await isCustomSelect(locator)) {
    await selectCustomOption(page, locator, value, options);
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    await locator.fill(String(value ?? ''), { timeout: options.timeoutMs });
    return;
  }
  throw new RunnerError('UNSUPPORTED_CONTROL', 'Unsupported input control', {
    tag,
    value_preview: String(value ?? '').slice(0, 200),
  });
}

async function clickOpenPage(page, locator, options) {
  const [openedPage] = await Promise.all([
    page.waitForEvent('popup', { timeout: options.timeoutMs }),
    locator.click({ timeout: options.timeoutMs }),
  ]);
  await openedPage.waitForLoadState('domcontentloaded', { timeout: options.timeoutMs }).catch(() => {});
  await openedPage.bringToFront().catch(() => {});
  if (typeof options.onPageOpened === 'function') options.onPageOpened(openedPage);
  return {
    _activePage: openedPage,
    opened_page_url: openedPage.url(),
  };
}

async function switchPage(currentPage, rawValue, options) {
  const config = parsePageActionConfig(rawValue);
  const pages = await getOpenPages(currentPage, options);
  const targetPage = await selectPage(currentPage, config, options, pages);
  await targetPage.bringToFront().catch(() => {});
  await targetPage.waitForLoadState('domcontentloaded', { timeout: Math.min(options.timeoutMs || 6000, 3000) }).catch(() => {});
  return {
    _activePage: targetPage,
    switched_page_url: targetPage.url(),
    switched_page_title: await safePageTitle(targetPage),
    switched_page_index: pages.indexOf(targetPage),
  };
}

async function closePage(currentPage, rawValue, options) {
  const config = parsePageActionConfig(rawValue);
  const pagesBefore = await getOpenPages(currentPage, options);
  const targetPage = await selectPage(currentPage, config, options, pagesBefore);
  if (pagesBefore.length <= 1) {
    throw new RunnerError('PAGE_NOT_FOUND', 'close_page requires at least one remaining page', {
      target_url: targetPage.url(),
    });
  }

  const closedUrl = targetPage.url();
  const closedTitle = await safePageTitle(targetPage);
  await targetPage.close({ runBeforeUnload: false }).catch((error) => {
    throw new RunnerError('PAGE_CLOSE_FAILED', `Failed to close page: ${error?.message || error}`, {
      target_url: closedUrl,
      target_title: closedTitle,
    });
  });

  const pagesAfter = await getOpenPages(currentPage, options);
  const fallbackConfig = parseFallbackPageConfig(config, targetPage === currentPage);
  const activePage = await selectPage(currentPage, fallbackConfig, options, pagesAfter, { defaultToFirst: true });
  await activePage.bringToFront().catch(() => {});
  return {
    _activePage: activePage,
    closed_page_url: closedUrl,
    closed_page_title: closedTitle,
    active_page_url: activePage.url(),
    active_page_title: await safePageTitle(activePage),
    active_page_index: pagesAfter.indexOf(activePage),
  };
}

function parsePageActionConfig(rawValue) {
  if (rawValue && typeof rawValue === 'object') return rawValue;
  const value = String(rawValue ?? '').trim();
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed;
    return { target: String(parsed ?? '') };
  } catch {
    return { target: value };
  }
}

function parseFallbackPageConfig(config, closedCurrentPage) {
  const fallback = config.fallback ?? config.fallbackTarget ?? config.fallback_target;
  if (fallback != null && fallback !== '') return parsePageActionConfig(fallback);
  return { target: closedCurrentPage ? 'main' : 'current' };
}

async function getOpenPages(currentPage, options) {
  const rawPages = typeof options.getPages === 'function'
    ? await options.getPages()
    : currentPage.context().pages();
  const pages = [];
  const seen = new Set();
  for (const candidate of rawPages || []) {
    if (!candidate || candidate.isClosed()) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    pages.push(candidate);
  }
  return pages;
}

async function selectPage(currentPage, config, options, pages, behavior = {}) {
  if (!pages.length) {
    throw new RunnerError('PAGE_NOT_FOUND', 'No open pages are available');
  }

  const target = String(config.target || config.page || config.window || '').trim();
  const targetLower = target.toLowerCase();
  const mainPage = options.mainPage && !options.mainPage.isClosed() ? options.mainPage : null;
  if (['main', 'original', 'root', 'first'].includes(targetLower)) return mainPage || pages[0];
  if (['current', 'active'].includes(targetLower)) {
    return currentPage && !currentPage.isClosed() ? currentPage : pages[0];
  }
  if (['latest', 'last'].includes(targetLower)) return pages[pages.length - 1];
  if (['popup', 'new'].includes(targetLower)) return pages.findLast((candidate) => candidate !== mainPage) || pages[pages.length - 1];

  const index = pageIndexFromConfig(config);
  if (index != null) {
    const page = pages[index];
    if (page) return page;
    throw new RunnerError('PAGE_NOT_FOUND', `Page index ${index} was not found`, {
      requested_index: index,
      open_pages: await pageDebugList(pages),
    });
  }

  const matched = [];
  for (const candidate of pages) {
    if (await pageMatches(candidate, config, target)) matched.push(candidate);
  }
  if (matched.length) return matched[matched.length - 1];
  if (!target && !hasPageMatcher(config)) {
    return currentPage && !currentPage.isClosed() ? currentPage : pages[0];
  }
  if (behavior.defaultToFirst) return pages[0];

  throw new RunnerError('PAGE_NOT_FOUND', `No open page matched ${target || JSON.stringify(config)}`, {
    target: target || config,
    open_pages: await pageDebugList(pages),
  });
}

function pageIndexFromConfig(config) {
  const raw = config.index ?? config.pageIndex ?? config.page_index;
  if (raw == null || raw === '') return null;
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

async function pageMatches(page, config, plainTarget) {
  const url = page.url();
  const title = await safePageTitle(page);
  const urlExact = firstString(config.urlExact, config.url_exact);
  const urlExpected = firstString(config.urlContains, config.url_contains, config.url, config.pattern, config.urlPattern, config.url_pattern);
  const titleExact = firstString(config.titleExact, config.title_exact);
  const titleExpected = firstString(config.titleContains, config.title_contains, config.title, config.name);

  if (urlExact && url !== urlExact) return false;
  if (urlExpected && !urlMatches(url, urlExpected)) return false;
  if (titleExact && title !== titleExact) return false;
  if (titleExpected && !textMatches(title, titleExpected)) return false;
  if (urlExact || urlExpected || titleExact || titleExpected) return true;

  const value = String(plainTarget || '').trim();
  return Boolean(value) && (urlMatches(url, value) || textMatches(title, value));
}

function hasPageMatcher(config) {
  return pageIndexFromConfig(config) != null
    || Boolean(firstString(
      config.urlExact,
      config.url_exact,
      config.urlContains,
      config.url_contains,
      config.url,
      config.pattern,
      config.urlPattern,
      config.url_pattern,
      config.titleExact,
      config.title_exact,
      config.titleContains,
      config.title_contains,
      config.title,
      config.name,
    ));
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function textMatches(actual, expected) {
  const value = String(expected || '');
  if (!value) return true;
  if (value.includes('*')) {
    const escaped = value.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(String(actual || ''));
  }
  return String(actual || '').includes(value);
}

async function safePageTitle(page) {
  return page.title().catch(() => '');
}

async function pageDebugList(pages) {
  return Promise.all(pages.map(async (candidate, index) => ({
    index,
    url: candidate.url(),
    title: await safePageTitle(candidate),
  })));
}

async function runScroll(page, step, options) {
  if (hasLocator(step)) {
    const info = await resolveLocator(page, step, options);
    await info.locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
    return;
  }
  const y = Number(step.value) || 500;
  await page.mouse.wheel(0, y);
}

async function runAssertText(page, step, options) {
  const expected = String(step.value ?? '');
  if (hasLocator(step)) {
    const info = await resolveLocator(page, step, options);
    const actual = await info.locator.textContent({ timeout: options.timeoutMs });
    assertContains(actual, expected, step);
    return info;
  }
  const bodyText = await page.locator('body').textContent({ timeout: options.timeoutMs });
  assertContains(bodyText, expected, step);
  return null;
}

function hasLocator(step) {
  return Boolean(String(step.target_selector || step.target_xpath || '').trim() || step.locator_meta);
}

function assertContains(actual, expected, step) {
  if (!String(actual ?? '').includes(String(expected ?? ''))) {
    throw new RunnerError('ASSERTION_FAILED', `Expected text was not found: ${String(expected ?? '').slice(0, 200)}`, {
      step_id: step.id,
      step_index: step.step_index,
      expected: String(expected ?? '').slice(0, 500),
      actual_preview: String(actual ?? '').slice(0, 500),
    });
  }
}

async function uploadFiles(page, locator, rawValue, options) {
  const config = parseFileUploadConfig(rawValue);
  const files = config.files;
  if (!files.length) {
    throw new RunnerError('UNSUPPORTED_CONTROL', 'file_upload requires at least one file path');
  }
  const input = await resolveUploadInput(page, locator, config, options);
  await input.setInputFiles(files, { timeout: options.timeoutMs });
  return {
    uploaded_files: files,
    upload_input_selector: config.inputSelector || '',
    upload_via_proxy: Boolean(config.inputSelector),
  };
}

async function resolveUploadInput(page, locator, config, options) {
  if (config.inputSelector) {
    const input = page.locator(config.inputSelector).first();
    if (await input.count().catch(() => 0) > 0) return input;
    throw new RunnerError('LOCATOR_NOT_FOUND', `file_upload inputSelector not found: ${config.inputSelector}`, {
      input_selector: config.inputSelector,
    });
  }

  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  const type = await locator.evaluate((el) => String(el.getAttribute('type') || '').toLowerCase()).catch(() => '');
  if (tag === 'input' && type === 'file') return locator;

  const nested = locator.locator('input[type="file"]').first();
  if (await nested.count().catch(() => 0) > 0) return nested;

  const describedInput = page.locator('input[type="file"]').filter({ has: locator }).first();
  if (await describedInput.count().catch(() => 0) > 0) return describedInput;

  throw new RunnerError('UNSUPPORTED_CONTROL', 'file_upload requires an input[type=file] or value.inputSelector', {
    tag,
    type,
    value_preview: JSON.stringify(config.raw).slice(0, 300),
  });
}

function parseFileUploadConfig(rawValue) {
  if (Array.isArray(rawValue)) return { files: rawValue.map(resolveLocalPath), inputSelector: '', raw: rawValue };
  const value = String(rawValue ?? '').trim();
  if (!value) return { files: [], inputSelector: '', raw: rawValue };
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return { files: parsed.map(resolveLocalPath), inputSelector: '', raw: parsed };
    if (parsed && typeof parsed === 'object') {
      const rawFiles = Array.isArray(parsed.files) ? parsed.files : parsed.file ? [parsed.file] : [];
      return {
        files: rawFiles.map(resolveLocalPath),
        inputSelector: String(parsed.inputSelector || parsed.input_selector || '').trim(),
        raw: parsed,
      };
    }
  } catch {
    // Fall through to comma-separated paths.
  }
  return { files: value.split(',').map((item) => item.trim()).filter(Boolean).map(resolveLocalPath), inputSelector: '', raw: rawValue };
}

function parseFileList(rawValue) {
  if (Array.isArray(rawValue)) return rawValue.map(resolveLocalPath);
  const value = String(rawValue ?? '').trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(resolveLocalPath);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.files)) return parsed.files.map(resolveLocalPath);
  } catch {
    // Fall through to comma-separated paths.
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean).map(resolveLocalPath);
}

function resolveLocalPath(filePath) {
  const value = String(filePath || '').trim();
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

async function assertDownload(page, locator, rawValue, options) {
  const expected = parseDownloadExpected(rawValue);
  const downloadsDir = path.join(options.artifacts?.runDir || process.cwd(), 'downloads');
  await fs.mkdir(downloadsDir, { recursive: true });

  const responseWaiter = expected.mime || expected.url
    ? page.waitForResponse((response) => downloadResponseMatches(response, expected), { timeout: Math.min(options.timeoutMs || 6000, 1500) }).catch(() => null)
    : Promise.resolve(null);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: options.timeoutMs }),
    locator.click({ timeout: options.timeoutMs }),
  ]);
  const response = await responseWaiter;
  const suggestedFilename = download.suggestedFilename();
  if (expected.filename && !suggestedFilename.includes(expected.filename)) {
    throw new RunnerError('ASSERTION_FAILED', `Downloaded filename did not match: ${expected.filename}`, {
      expected_filename: expected.filename,
      actual_filename: suggestedFilename,
    });
  }

  const savePath = path.join(downloadsDir, sanitizeFilename(suggestedFilename || `download-${Date.now()}`));
  await download.saveAs(savePath);
  const downloadedMime = String(response?.headers()['content-type'] || guessMimeType(savePath));
  if (expected.mime) {
    const actualMime = downloadedMime.toLowerCase();
    if (!actualMime.includes(expected.mime.toLowerCase())) {
      throw new RunnerError('ASSERTION_FAILED', `Downloaded MIME did not match: ${expected.mime}`, {
        expected_mime: expected.mime,
        actual_mime: actualMime,
        filename: suggestedFilename,
      });
    }
  }
  const stat = await fs.stat(savePath);
  if (expected.minBytes != null && stat.size < expected.minBytes) {
    throw new RunnerError('ASSERTION_FAILED', `Downloaded file was smaller than expected: ${expected.minBytes}`, {
      expected_min_bytes: expected.minBytes,
      actual_bytes: stat.size,
      filename: suggestedFilename,
    });
  }
  if (expected.maxBytes != null && stat.size > expected.maxBytes) {
    throw new RunnerError('ASSERTION_FAILED', `Downloaded file was larger than expected: ${expected.maxBytes}`, {
      expected_max_bytes: expected.maxBytes,
      actual_bytes: stat.size,
      filename: suggestedFilename,
    });
  }
  if (expected.contains) {
    const content = await fs.readFile(savePath, 'utf8').catch(() => '');
    if (!content.includes(expected.contains)) {
      throw new RunnerError('ASSERTION_FAILED', `Downloaded file did not contain expected text: ${expected.contains}`, {
        expected: expected.contains,
        filename: suggestedFilename,
      });
    }
  }
  const sha256 = expected.sha256 ? await fileSha256(savePath) : '';
  if (expected.sha256 && sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
    throw new RunnerError('ASSERTION_FAILED', 'Downloaded file sha256 did not match', {
      expected_sha256: expected.sha256,
      actual_sha256: sha256,
      filename: suggestedFilename,
    });
  }
  return {
    downloaded_file: savePath,
    downloaded_filename: suggestedFilename,
    downloaded_bytes: stat.size,
    downloaded_sha256: sha256 || null,
    downloaded_mime: downloadedMime,
  };
}

function parseDownloadExpected(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return {
        filename: String(parsed.filename || parsed.name || '').trim(),
        contains: String(parsed.contains || parsed.text || '').trim(),
        mime: String(parsed.mime || parsed.contentType || parsed.content_type || '').trim(),
        url: String(parsed.url || parsed.urlContains || parsed.url_contains || '').trim(),
        minBytes: numberOrNull(parsed.minBytes ?? parsed.min_bytes),
        maxBytes: numberOrNull(parsed.maxBytes ?? parsed.max_bytes),
        sha256: String(parsed.sha256 || '').trim(),
      };
    }
  } catch {
    // Plain value means expected filename substring.
  }
  return { filename: value };
}

function downloadResponseMatches(response, expected) {
  if (expected.url && !urlMatches(response.url(), expected.url)) return false;
  if (!expected.url && expected.filename && !response.url().includes(expected.filename)) return false;
  return response.status() >= 200 && response.status() < 400;
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt') return 'text/plain';
  if (ext === '.json') return 'application/json';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

async function fileSha256(filePath) {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function sanitizeFilename(value) {
  return String(value || 'download.txt').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

async function runAssertJson(page, step, options) {
  const config = parseJsonAssertion(step.value);
  const hasTarget = String(step.target_selector || step.target_xpath || '').trim() || step.locator_meta;
  let info = null;
  let actual;
  if (hasTarget) {
    info = await resolveLocator(page, step, options);
    const text = await info.locator.textContent({ timeout: options.timeoutMs });
    actual = parseJsonStrict(text, step);
  } else {
    actual = await fetchJsonAssertion(config, options);
    info = {
      source: 'api:assert_json',
      locatorType: 'json_api',
      matchedCount: null,
      visibleCount: null,
    };
  }
  const expected = config.expected ?? config;
  if (!compareJsonSubset(expected, actual)) {
    throw new RunnerError('ASSERTION_FAILED', 'JSON assertion failed', {
      expected,
      actual_preview: JSON.stringify(actual).slice(0, 1000),
    });
  }
  return info;
}

function parseJsonAssertion(rawValue) {
  if (rawValue && typeof rawValue === 'object') return rawValue;
  const value = String(rawValue ?? '').trim();
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new RunnerError('CASE_INVALID', 'assert_json value must be valid JSON');
  }
}

function parseJsonStrict(text, step) {
  try {
    return JSON.parse(String(text ?? ''));
  } catch {
    throw new RunnerError('ASSERTION_FAILED', 'Target text is not valid JSON', {
      step_id: step.id,
      step_index: step.step_index,
      actual_preview: String(text ?? '').slice(0, 500),
    });
  }
}

async function fetchJsonAssertion(config, options) {
  const rawUrl = String(config.url || config.path || '').trim();
  if (!rawUrl) {
    throw new RunnerError('CASE_INVALID', 'assert_json without target requires value.url or value.path');
  }
  const url = rawUrl.startsWith('http') ? rawUrl : `${String(options.apiBase || '').replace(/\/+$/, '')}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`;
  const method = String(config.method || 'GET').toUpperCase();
  const headers = config.headers && typeof config.headers === 'object' ? { ...config.headers } : {};
  const request = { method, headers };
  if (config.body !== undefined || config.json !== undefined) {
    const body = config.json !== undefined ? config.json : config.body;
    request.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      request.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(url, request);
  if (!res.ok) {
    throw new RunnerError('INFRA_API_FAILED', `assert_json API failed with HTTP ${res.status}`, { url });
  }
  return res.json();
}

async function registerNetworkMock(page, rawValue) {
  const config = parseNetworkMockConfig(rawValue);
  await page.route(config.url, async (route) => {
    if (config.delayMs > 0) await sleep(config.delayMs);
    if (config.abort) {
      await route.abort(config.abort);
      return;
    }
    await fulfillNetworkRoute(route, config);
  });
  return {
    network_mock_url: config.url,
    network_mock_status: config.status,
    network_mock_abort: config.abort || '',
  };
}

async function registerNetworkReplay(page, rawValue) {
  const config = await parseNetworkReplayConfig(rawValue);
  for (const entry of config.entries) {
    await page.route(entry.url, async (route) => {
      if (entry.method && route.request().method().toUpperCase() !== entry.method) {
        await route.fallback();
        return;
      }
      if (entry.delayMs > 0) await sleep(entry.delayMs);
      if (entry.abort) {
        await route.abort(entry.abort);
        return;
      }
      await fulfillNetworkRoute(route, entry);
    });
  }
  return {
    network_replay_path: config.path,
    network_replay_entries: config.entries.length,
  };
}

async function fulfillNetworkRoute(route, config) {
  const fulfill = {
    status: config.status,
    headers: config.headers,
  };
  if (config.json !== undefined) {
    fulfill.contentType = 'application/json';
    fulfill.body = JSON.stringify(config.json);
  } else {
    fulfill.contentType = config.contentType || 'text/plain';
    fulfill.body = String(config.body ?? '');
  }
  await route.fulfill(fulfill);
}

async function assertRequest(page, triggerLocator, rawValue, options) {
  const config = parseRequestAssertion(rawValue);
  const waiter = page.waitForRequest((request) => requestMatches(request, config), { timeout: options.timeoutMs });
  const request = triggerLocator
    ? await Promise.all([waiter, triggerLocator.click({ timeout: options.timeoutMs })]).then(([matched]) => matched)
    : await waiter;
  return {
    request_url: request.url(),
    request_method: request.method(),
  };
}

async function assertResponse(page, triggerLocator, rawValue, options, step) {
  const config = parseResponseAssertion(rawValue);
  const waiter = page.waitForResponse((response) => responseMatches(response, config), { timeout: options.timeoutMs });
  const response = triggerLocator
    ? await Promise.all([waiter, triggerLocator.click({ timeout: options.timeoutMs })]).then(([matched]) => matched)
    : await waiter;
  const body = await readResponseBodyIfNeeded(response, config);
  await assertResponseBody(response, config, body);
  const baselineResult = await assertResponseBaseline(response, config, body);
  return {
    response_url: response.url(),
    response_status: response.status(),
    response_body_bytes: body == null ? null : Buffer.byteLength(body, 'utf8'),
    ...baselineResult,
    ...await saveResponseSnapshot(response, config, body, options, step),
  };
}

function parseRequestAssertion(rawValue, actionName = 'assert_request') {
  const value = parseJsonAssertion(rawValue);
  const url = String(value.url || value.pattern || '').trim();
  if (!url) {
    throw new RunnerError('CASE_INVALID', `${actionName} requires value.url`);
  }
  return {
    url,
    method: String(value.method || '').trim().toUpperCase(),
    postDataContains: String(value.postDataContains || value.post_data_contains || '').trim(),
    headers: value.headers && typeof value.headers === 'object' ? value.headers : {},
  };
}

function parseResponseAssertion(rawValue) {
  const value = parseJsonAssertion(rawValue);
  const base = parseRequestAssertion(rawValue, 'assert_response');
  return {
    ...base,
    status: Number.isFinite(Number(value.status)) ? Number(value.status) : null,
    textContains: String(value.textContains || value.text_contains || value.bodyContains || value.body_contains || '').trim(),
    json: value.json ?? value.expected ?? null,
    snapshot: value.snapshot === true || value.snapshot === 1 || value.snapshot === 'true' || Boolean(value.snapshotName || value.snapshot_name),
    snapshotName: String(value.snapshotName || value.snapshot_name || '').trim(),
    baselinePath: String(value.baselinePath || value.baseline_path || value.baseline || '').trim(),
    baselineMode: String(value.baselineMode || value.baseline_mode || 'exact').trim().toLowerCase(),
  };
}

function requestMatches(request, config) {
  if (!urlMatches(request.url(), config.url)) return false;
  if (config.method && request.method().toUpperCase() !== config.method) return false;
  if (config.postDataContains && !String(request.postData() || '').includes(config.postDataContains)) return false;
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (String(request.headers()[String(key).toLowerCase()] || '') !== String(value)) return false;
  }
  return true;
}

function responseMatches(response, config) {
  if (!urlMatches(response.url(), config.url)) return false;
  if (config.method && response.request().method().toUpperCase() !== config.method) return false;
  if (config.status != null && response.status() !== config.status) return false;
  return true;
}

async function readResponseBodyIfNeeded(response, config) {
  if (!config.textContains && config.json == null && !config.snapshot && !config.baselinePath) return null;
  return response.text();
}

async function assertResponseBody(response, config, body) {
  if (!config.textContains && config.json == null) return;

  const text = String(body ?? '');
  if (config.textContains && !text.includes(config.textContains)) {
    throw new RunnerError('ASSERTION_FAILED', `Response body did not contain expected text: ${config.textContains}`, {
      expected: config.textContains,
      actual_preview: text.slice(0, 1000),
      url: response.url(),
    });
  }
  if (config.json != null) {
    let actual;
    try {
      actual = JSON.parse(text);
    } catch {
      throw new RunnerError('ASSERTION_FAILED', 'Response body is not valid JSON', {
        actual_preview: text.slice(0, 1000),
        url: response.url(),
      });
    }
    if (!compareJsonSubset(config.json, actual)) {
      throw new RunnerError('ASSERTION_FAILED', 'Response JSON assertion failed', {
        expected: config.json,
        actual_preview: JSON.stringify(actual).slice(0, 1000),
        url: response.url(),
      });
    }
  }
}

async function assertResponseBaseline(response, config, body) {
  if (!config.baselinePath) return {};

  const baselinePath = resolveLocalPath(config.baselinePath);
  const expectedText = await fs.readFile(baselinePath, 'utf8').catch((error) => {
    throw new RunnerError('CASE_INVALID', `Response baseline file not found: ${config.baselinePath}`, {
      baseline_path: baselinePath,
      cause: error?.message || String(error),
    });
  });
  const actualText = String(body ?? '');
  const mode = config.baselineMode || 'exact';

  if (mode === 'text') {
    if (normalizeText(expectedText) !== normalizeText(actualText)) {
      throw new RunnerError('ASSERTION_FAILED', 'Response text baseline assertion failed', {
        baseline_path: baselinePath,
        actual_preview: actualText.slice(0, 1000),
      });
    }
  } else {
    const expected = parseBaselineJson(expectedText, baselinePath);
    const actual = parseBaselineJson(actualText, response.url());
    const matched = mode === 'subset'
      ? compareJsonSubset(expected, actual)
      : JSON.stringify(sortJsonKeys(expected)) === JSON.stringify(sortJsonKeys(actual));
    if (!matched) {
      throw new RunnerError('ASSERTION_FAILED', 'Response JSON baseline assertion failed', {
        baseline_path: baselinePath,
        baseline_mode: mode,
        actual_preview: JSON.stringify(actual).slice(0, 1000),
      });
    }
  }

  return {
    response_baseline: baselinePath,
    response_baseline_mode: mode,
    response_baseline_matched: true,
  };
}

function parseBaselineJson(text, source) {
  try {
    return JSON.parse(String(text ?? ''));
  } catch {
    throw new RunnerError('ASSERTION_FAILED', 'Response baseline comparison requires valid JSON', {
      source,
      actual_preview: String(text ?? '').slice(0, 500),
    });
  }
}

function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortJsonKeys(value[key]);
    return acc;
  }, {});
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trimEnd();
}

async function saveResponseSnapshot(response, config, body, options, step) {
  if (!config.snapshot) return {};

  const text = body == null ? await response.text() : String(body);
  const responsesDir = path.join(options.artifacts?.runDir || process.cwd(), 'responses');
  await fs.mkdir(responsesDir, { recursive: true });
  const baseName = sanitizeFilename(config.snapshotName || `step-${step?.step_index ?? step?.id ?? Date.now()}-response`);
  const contentType = String(response.headers()['content-type'] || '').toLowerCase();
  const ext = contentType.includes('json') ? 'json' : 'txt';
  const bodyPath = path.join(responsesDir, `${baseName}.${ext}`);
  const metaPath = path.join(responsesDir, `${baseName}.meta.json`);
  await fs.writeFile(bodyPath, text, 'utf8');
  await fs.writeFile(metaPath, `${JSON.stringify({
    url: response.url(),
    status: response.status(),
    method: response.request().method(),
    headers: response.headers(),
    content_type: response.headers()['content-type'] || '',
    body_path: bodyPath,
    captured_at: formatPlatformDateTime(),
  }, null, 2)}\n`, 'utf8');
  return {
    response_snapshot: bodyPath,
    response_snapshot_meta: metaPath,
  };
}

function urlMatches(actual, expected) {
  if (expected.includes('*')) {
    const escaped = expected.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(actual);
  }
  return actual.includes(expected);
}

function parseNetworkMockConfig(rawValue) {
  const value = parseJsonAssertion(rawValue);
  const url = String(value.url || value.pattern || '').trim();
  if (!url) {
    throw new RunnerError('CASE_INVALID', 'network_mock requires value.url');
  }
  return {
    url,
    status: Number(value.status) || 200,
    headers: value.headers && typeof value.headers === 'object' ? value.headers : {},
    json: value.json,
    body: value.body,
    contentType: value.contentType || value.content_type || '',
    delayMs: Number(value.delayMs ?? value.delay_ms ?? 0) || 0,
    abort: value.abort ? String(value.abort) : '',
  };
}

async function parseNetworkReplayConfig(rawValue) {
  const value = parseJsonAssertion(rawValue);
  const fixturePath = String(value.path || value.fixture || value.har || '').trim();
  const rawEntries = Array.isArray(value.entries) ? value.entries : [];
  let loadedEntries = rawEntries;
  let resolvedPath = '';
  if (fixturePath) {
    resolvedPath = resolveLocalPath(fixturePath);
    const content = await fs.readFile(resolvedPath, 'utf8').catch((error) => {
      throw new RunnerError('CASE_INVALID', `network_replay fixture not found: ${fixturePath}`, {
        fixture_path: resolvedPath,
        cause: error?.message || String(error),
      });
    });
    const parsed = parseReplayJson(content, resolvedPath);
    loadedEntries = Array.isArray(parsed) ? parsed : parsed.entries;
  }
  if (!Array.isArray(loadedEntries) || !loadedEntries.length) {
    throw new RunnerError('CASE_INVALID', 'network_replay requires entries or value.path with entries');
  }
  return {
    path: resolvedPath,
    entries: loadedEntries.map(normalizeReplayEntry),
  };
}

function parseReplayJson(content, source) {
  try {
    return JSON.parse(content);
  } catch {
    throw new RunnerError('CASE_INVALID', 'network_replay fixture must be valid JSON', {
      source,
    });
  }
}

function normalizeReplayEntry(entry, index) {
  const url = String(entry?.url || entry?.pattern || '').trim();
  if (!url) {
    throw new RunnerError('CASE_INVALID', `network_replay entry ${index + 1} requires url`);
  }
  return {
    url,
    method: String(entry.method || '').trim().toUpperCase(),
    status: Number(entry.status) || 200,
    headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : {},
    json: entry.json,
    body: entry.body,
    contentType: entry.contentType || entry.content_type || '',
    delayMs: Number(entry.delayMs ?? entry.delay_ms ?? 0) || 0,
    abort: entry.abort ? String(entry.abort) : '',
  };
}

function assertRequestCount(rawValue, options) {
  const config = parseRequestCountAssertion(rawValue);
  const matched = (options.networkEvents || []).filter((event) => requestEventMatches(event, config));
  const count = matched.length;
  if (config.count != null && count !== config.count) {
    throw new RunnerError('ASSERTION_FAILED', `Expected request count ${config.count}, got ${count}`, {
      expected_count: config.count,
      actual_count: count,
      url: config.url,
    });
  }
  if (config.min != null && count < config.min) {
    throw new RunnerError('ASSERTION_FAILED', `Expected at least ${config.min} requests, got ${count}`, {
      expected_min: config.min,
      actual_count: count,
      url: config.url,
    });
  }
  if (config.max != null && count > config.max) {
    throw new RunnerError('ASSERTION_FAILED', `Expected at most ${config.max} requests, got ${count}`, {
      expected_max: config.max,
      actual_count: count,
      url: config.url,
    });
  }
  return {
    request_count: count,
    request_count_url: config.url,
  };
}

function parseRequestCountAssertion(rawValue) {
  const value = parseJsonAssertion(rawValue);
  const base = parseRequestAssertion(rawValue);
  return {
    ...base,
    count: numberOrNull(value.count),
    min: numberOrNull(value.min),
    max: numberOrNull(value.max),
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function requestEventMatches(event, config) {
  if (!urlMatches(event.url, config.url)) return false;
  if (config.method && String(event.method || '').toUpperCase() !== config.method) return false;
  if (config.postDataContains && !String(event.post_data || '').includes(config.postDataContains)) return false;
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (String(event.headers?.[String(key).toLowerCase()] || '') !== String(value)) return false;
  }
  return true;
}

function compareJsonSubset(expected, actual) {
  if (expected == null) return true;
  if (typeof expected !== 'object') return Object.is(expected, actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length > actual.length) return false;
    return expected.every((item, index) => compareJsonSubset(item, actual[index]));
  }
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => compareJsonSubset(value, actual[key]));
}

async function isCustomSelect(locator) {
  return locator.evaluate((el) => {
    const root = el.closest('.ant-select, .el-select, [data-control-kind="custom-select"]') || el;
    const className = String(root.className || '');
    return root.getAttribute('role') === 'combobox'
      || root.getAttribute('aria-haspopup') === 'listbox'
      || root.getAttribute('data-control-kind') === 'custom-select'
      || className.includes('ant-select')
      || className.includes('el-select');
  }).catch(() => false);
}

async function isMonacoEditor(locator) {
  return locator.evaluate((el) => {
    const root = el.closest('.monaco-editor, [data-control-kind="monaco"]') || el;
    const className = String(root.className || '');
    return root.getAttribute('data-control-kind') === 'monaco'
      || className.includes('monaco-editor')
      || root.querySelector('.inputarea, textarea[aria-label*="Editor"], [contenteditable="true"]') != null;
  }).catch(() => false);
}

async function fillMonacoEditor(page, locator, value, options) {
  const input = locator.locator('.inputarea, textarea[aria-label*="Editor"], [contenteditable="true"]').first();
  const target = await input.count().catch(() => 0) > 0 ? input : locator;
  await target.click({ timeout: options.timeoutMs });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(String(value ?? ''));
}

async function selectCustomOption(page, locator, value, options) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new RunnerError('UNSUPPORTED_CONTROL', 'Custom select input requires a non-empty value');
  }

  await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs }).catch(() => {});
  await locator.click({ timeout: options.timeoutMs });
  const option = page.locator([
    '.ant-select-dropdown [role="option"]',
    '.ant-select-dropdown .ant-select-item-option',
    '.el-select-dropdown [role="option"]',
    '.el-select-dropdown .el-select-dropdown__item',
    '[data-overlay="true"] [role="option"]',
    '[role="listbox"] [role="option"]',
  ].join(', ')).filter({ hasText: text });

  const exact = option.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`) });
  const target = await exact.count().catch(() => 0) > 0 ? exact.first() : option.first();
  if (!(await target.isVisible({ timeout: options.timeoutMs }).catch(() => false))) {
    throw new RunnerError('LOCATOR_NOT_FOUND', `Custom select option not found: ${text}`, {
      locator_source: 'custom_select_option',
      locator_type: 'text_exact',
      locator_value: text,
    });
  }
  await target.scrollIntoViewIfNeeded({ timeout: Math.min(options.timeoutMs || 6000, 1000) }).catch(() => {});
  await target.click({ timeout: Math.min(options.timeoutMs || 6000, 2000) }).catch(async () => {
    await target.dispatchEvent('click');
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stepControlKind(step) {
  return parseLocatorMeta(step.locator_meta)?.context?.control_kind || '';
}
