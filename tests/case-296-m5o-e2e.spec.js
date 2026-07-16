import { test, expect } from 'playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

test("CueCast case 296: M5-O export e2e smoke mock", async ({ page: initialPage }) => {
  let page = initialPage;
  const cuecastPages = [page];
  const apiBase = "http://127.0.0.1:4205/api";
  const networkEvents = [];
  const attachNetworkRecorder = (targetPage) => {
    targetPage.on('request', (request) => networkEvents.push(cuecastRequestEvent(request)));
  };
  attachNetworkRecorder(page);
  await page.goto("http://127.0.0.1:4205/test-lab/target.html");

  // step 0: Input username for export e2e smoke
  await page.locator("[data-testid=\"username\"]").fill("export-smoke");

  // step 1: Submit form in export e2e smoke
  await page.locator("[data-testid=\"submit-login\"]").click();

  // step 2: Assert export e2e smoke result
  await expect(page.locator("#statusText")).toContainText("Submitted");
});

// Generated from "http://127.0.0.1:4205/api" at 2026-07-06T13:38:18.571Z.

function cuecastTrackPage(pages, targetPage) {
  if (targetPage && !pages.includes(targetPage)) pages.push(targetPage);
  return targetPage;
}

function cuecastOpenPages(pages) {
  return pages.filter((candidate) => candidate && !candidate.isClosed());
}

async function cuecastSwitchPage(currentPage, pages, rawConfig) {
  const config = cuecastPageConfig(rawConfig);
  const targetPage = await cuecastSelectPage(currentPage, cuecastOpenPages(pages), config);
  await targetPage.bringToFront().catch(() => {});
  await targetPage.waitForLoadState('domcontentloaded').catch(() => {});
  return targetPage;
}

async function cuecastClosePage(currentPage, pages, rawConfig) {
  const config = cuecastPageConfig(rawConfig);
  const openPages = cuecastOpenPages(pages);
  const targetPage = await cuecastSelectPage(currentPage, openPages, config);
  if (openPages.length <= 1) throw new Error('close_page requires at least one remaining page');
  const closedCurrent = targetPage === currentPage;
  await targetPage.close({ runBeforeUnload: false });
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    if (!pages[index] || pages[index].isClosed()) pages.splice(index, 1);
  }
  const fallback = config.fallback ?? config.fallbackTarget ?? config.fallback_target ?? (closedCurrent ? 'main' : 'current');
  return cuecastSelectPage(currentPage, cuecastOpenPages(pages), cuecastPageConfig(fallback), { defaultToFirst: true });
}

function cuecastPageConfig(rawValue) {
  if (rawValue && typeof rawValue === 'object') return rawValue;
  const value = String(rawValue ?? '').trim();
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : { target: String(parsed ?? '') };
  } catch {
    return { target: value };
  }
}

async function cuecastSelectPage(currentPage, pages, config, behavior = {}) {
  if (!pages.length) throw new Error('No open pages are available');
  const target = String(config.target || config.page || config.window || '').trim();
  const targetLower = target.toLowerCase();
  const mainPage = pages[0];
  if (['main', 'original', 'root', 'first'].includes(targetLower)) return mainPage;
  if (['current', 'active'].includes(targetLower)) return currentPage && !currentPage.isClosed() ? currentPage : mainPage;
  if (['latest', 'last'].includes(targetLower)) return pages[pages.length - 1];
  if (['popup', 'new'].includes(targetLower)) return pages.findLast((candidate) => candidate !== mainPage) || pages[pages.length - 1];
  const index = cuecastPageIndex(config);
  if (index != null) {
    if (pages[index]) return pages[index];
    throw new Error(`Page index ${index} was not found`);
  }
  const matched = [];
  for (const candidate of pages) {
    if (await cuecastPageMatches(candidate, config, target)) matched.push(candidate);
  }
  if (matched.length) return matched[matched.length - 1];
  if (!target && !cuecastHasPageMatcher(config)) return currentPage && !currentPage.isClosed() ? currentPage : mainPage;
  if (behavior.defaultToFirst) return mainPage;
  throw new Error(`No open page matched ${target || JSON.stringify(config)}`);
}

function cuecastPageIndex(config) {
  const raw = config.index ?? config.pageIndex ?? config.page_index;
  if (raw == null || raw === '') return null;
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

async function cuecastPageMatches(page, config, plainTarget) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const urlExact = cuecastFirstString(config.urlExact, config.url_exact);
  const urlExpected = cuecastFirstString(config.urlContains, config.url_contains, config.url, config.pattern, config.urlPattern, config.url_pattern);
  const titleExact = cuecastFirstString(config.titleExact, config.title_exact);
  const titleExpected = cuecastFirstString(config.titleContains, config.title_contains, config.title, config.name);
  if (urlExact && url !== urlExact) return false;
  if (urlExpected && !cuecastUrlMatches(url, urlExpected)) return false;
  if (titleExact && title !== titleExact) return false;
  if (titleExpected && !cuecastTextMatches(title, titleExpected)) return false;
  if (urlExact || urlExpected || titleExact || titleExpected) return true;
  const value = String(plainTarget || '').trim();
  return Boolean(value) && (cuecastUrlMatches(url, value) || cuecastTextMatches(title, value));
}

function cuecastHasPageMatcher(config) {
  return cuecastPageIndex(config) != null || Boolean(cuecastFirstString(config.urlExact, config.url_exact, config.urlContains, config.url_contains, config.url, config.pattern, config.urlPattern, config.url_pattern, config.titleExact, config.title_exact, config.titleContains, config.title_contains, config.title, config.name));
}

function cuecastFirstString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function cuecastTextMatches(actual, expected) {
  const value = String(expected || '');
  if (!value) return true;
  if (value.includes('*')) {
    const escaped = value.split('*').map((part) => part.replace(/[.*+?^${}()|[]\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(String(actual || ''));
  }
  return String(actual || '').includes(value);
}

function cuecastRequestEvent(request) {
  return {
    url: request.url(),
    method: request.method(),
    postData: request.postData() || '',
    headers: request.headers(),
  };
}

function cuecastUrlMatches(actual, expected) {
  const value = String(expected || '');
  if (!value) return true;
  if (value.includes('*')) {
    const escaped = value.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(actual);
  }
  return String(actual || '').includes(value);
}

function cuecastRequestMatches(request, config) {
  const url = config.url || config.pattern || '';
  if (!cuecastUrlMatches(request.url(), url)) return false;
  if (config.method && request.method().toUpperCase() !== String(config.method).toUpperCase()) return false;
  const bodyPart = config.postDataContains || config.post_data_contains || '';
  if (bodyPart && !String(request.postData() || '').includes(bodyPart)) return false;
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (String(request.headers()[String(key).toLowerCase()] || '') !== String(value)) return false;
  }
  return true;
}

function cuecastResponseMatches(response, config) {
  const url = config.url || config.pattern || '';
  if (!cuecastUrlMatches(response.url(), url)) return false;
  if (config.method && response.request().method().toUpperCase() !== String(config.method).toUpperCase()) return false;
  if (config.status != null && response.status() !== Number(config.status)) return false;
  return true;
}

async function cuecastWaitForRequest(page, config, trigger) {
  const waiter = page.waitForRequest((request) => cuecastRequestMatches(request, config));
  if (trigger) {
    const [request] = await Promise.all([waiter, trigger()]);
    return request;
  }
  return waiter;
}

async function cuecastAssertResponse(page, config, trigger) {
  const waiter = page.waitForResponse((response) => cuecastResponseMatches(response, config));
  const response = trigger ? (await Promise.all([waiter, trigger()]))[0] : await waiter;
  const needsBody = config.textContains || config.text_contains || config.bodyContains || config.body_contains || config.json != null || config.expected != null || config.snapshot || config.snapshotName || config.snapshot_name || config.baselinePath || config.baseline_path || config.baseline;
  const body = needsBody ? await response.text() : '';
  const textContains = config.textContains || config.text_contains || config.bodyContains || config.body_contains || '';
  if (textContains) expect(body).toContain(textContains);
  const expectedJson = config.json ?? config.expected;
  if (expectedJson != null) expect(cuecastJsonContains(JSON.parse(body), expectedJson)).toBeTruthy();
  if (config.baselinePath || config.baseline_path || config.baseline) cuecastAssertResponseBaseline(response, config, body);
  if (config.snapshot || config.snapshotName || config.snapshot_name) cuecastSaveResponseSnapshot(response, config, body);
  return response;
}

function cuecastAssertRequestCount(events, config) {
  const matched = events.filter((event) => cuecastRequestEventMatches(event, config));
  const count = matched.length;
  if (config.count != null) expect(count).toBe(Number(config.count));
  if (config.min != null) expect(count).toBeGreaterThanOrEqual(Number(config.min));
  if (config.max != null) expect(count).toBeLessThanOrEqual(Number(config.max));
}

function cuecastRequestEventMatches(event, config) {
  const url = config.url || config.pattern || '';
  if (!cuecastUrlMatches(event.url, url)) return false;
  if (config.method && String(event.method || '').toUpperCase() !== String(config.method).toUpperCase()) return false;
  const bodyPart = config.postDataContains || config.post_data_contains || '';
  if (bodyPart && !String(event.postData || '').includes(bodyPart)) return false;
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (String(event.headers?.[String(key).toLowerCase()] || '') !== String(value)) return false;
  }
  return true;
}

async function cuecastRegisterNetworkMock(page, config) {
  const url = config.url || config.pattern;
  await page.route(url, async (route) => {
    if (config.method && route.request().method().toUpperCase() !== String(config.method).toUpperCase()) {
      await route.fallback();
      return;
    }
    if (Number(config.delayMs || config.delay_ms || 0) > 0) await new Promise((resolve) => setTimeout(resolve, Number(config.delayMs || config.delay_ms)));
    if (config.abort) {
      await route.abort(String(config.abort));
      return;
    }
    await cuecastFulfillRoute(route, config);
  });
}

async function cuecastRegisterNetworkReplay(page, entries) {
  for (const entry of entries) {
    await page.route(entry.url || entry.pattern, async (route) => {
      if (entry.method && route.request().method().toUpperCase() !== String(entry.method).toUpperCase()) {
        await route.fallback();
        return;
      }
      if (Number(entry.delayMs || entry.delay_ms || 0) > 0) await new Promise((resolve) => setTimeout(resolve, Number(entry.delayMs || entry.delay_ms)));
      if (entry.abort) {
        await route.abort(String(entry.abort));
        return;
      }
      await cuecastFulfillRoute(route, entry);
    });
  }
}

async function cuecastFulfillRoute(route, config) {
  const fulfill = {
    status: Number(config.status) || 200,
    headers: config.headers || {},
  };
  if (config.json !== undefined) {
    fulfill.contentType = 'application/json';
    fulfill.body = JSON.stringify(config.json);
  } else {
    fulfill.contentType = config.contentType || config.content_type || 'text/plain';
    fulfill.body = String(config.body ?? '');
  }
  await route.fulfill(fulfill);
}

async function cuecastFetchJson(page, apiBase, config) {
  const rawUrl = config.url || config.path || '';
  const url = String(rawUrl).startsWith('http') ? rawUrl : `${apiBase}${String(rawUrl).startsWith('/') ? rawUrl : `/${rawUrl}`}`;
  const request = {
    method: String(config.method || 'GET').toUpperCase(),
    headers: config.headers || {},
  };
  if (config.body !== undefined || config.json !== undefined) request.data = config.json !== undefined ? config.json : config.body;
  const response = await page.request.fetch(url, request);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function cuecastAssertDownload(page, locator, config) {
  const expected = cuecastDownloadExpected(config);
  const [download] = await Promise.all([page.waitForEvent('download'), locator.click()]);
  const filename = download.suggestedFilename();
  if (expected.filename) expect(filename).toContain(expected.filename);
  const downloadDir = path.resolve(process.cwd(), 'test-results', 'cuecast-downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  const savePath = path.join(downloadDir, cuecastSanitizeFilename(filename || `download-${Date.now()}`));
  await download.saveAs(savePath);
  const stat = fs.statSync(savePath);
  if (expected.minBytes != null) expect(stat.size).toBeGreaterThanOrEqual(Number(expected.minBytes));
  if (expected.maxBytes != null) expect(stat.size).toBeLessThanOrEqual(Number(expected.maxBytes));
  if (expected.mime) expect(cuecastGuessMimeType(savePath).toLowerCase()).toContain(String(expected.mime).toLowerCase());
  if (expected.contains) expect(fs.readFileSync(savePath, 'utf8')).toContain(expected.contains);
  if (expected.sha256) expect(cuecastFileSha256(savePath)).toBe(String(expected.sha256).toLowerCase());
}

function cuecastDownloadExpected(config) {
  if (typeof config === 'string') return { filename: config };
  return {
    filename: String(config.filename || config.name || ''),
    contains: String(config.contains || config.text || ''),
    mime: String(config.mime || config.contentType || config.content_type || ''),
    minBytes: config.minBytes ?? config.min_bytes ?? null,
    maxBytes: config.maxBytes ?? config.max_bytes ?? null,
    sha256: String(config.sha256 || '').toLowerCase(),
  };
}

function cuecastAssertResponseBaseline(response, config, body) {
  const baselinePath = path.resolve(process.cwd(), config.baselinePath || config.baseline_path || config.baseline);
  const expectedText = fs.readFileSync(baselinePath, 'utf8');
  const mode = String(config.baselineMode || config.baseline_mode || 'exact').toLowerCase();
  if (mode === 'text') {
    expect(body.replace(/\r\n/g, '\n').trimEnd()).toBe(expectedText.replace(/\r\n/g, '\n').trimEnd());
    return;
  }
  const expected = JSON.parse(expectedText);
  const actual = JSON.parse(body);
  if (mode === 'subset') expect(cuecastJsonContains(actual, expected)).toBeTruthy();
  else expect(cuecastStableJson(actual)).toBe(cuecastStableJson(expected));
}

function cuecastSaveResponseSnapshot(response, config, body) {
  const name = cuecastSanitizeFilename(config.snapshotName || config.snapshot_name || `response-${Date.now()}`);
  const dir = path.resolve(process.cwd(), 'test-results', 'cuecast-response-snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const contentType = String(response.headers()['content-type'] || '').toLowerCase();
  const ext = contentType.includes('json') ? 'json' : 'txt';
  const bodyPath = path.join(dir, `${name}.${ext}`);
  fs.writeFileSync(bodyPath, body, 'utf8');
  fs.writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify({ url: response.url(), status: response.status(), method: response.request().method(), headers: response.headers(), body_path: bodyPath }, null, 2));
}

function cuecastJsonContains(actual, expected) {
  if (expected == null) return true;
  if (typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length > actual.length) return false;
    return expected.every((item, index) => cuecastJsonContains(actual[index], item));
  }
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => cuecastJsonContains(actual[key], value));
}

function cuecastStableJson(value) {
  if (Array.isArray(value)) return `[${value.map(cuecastStableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${cuecastStableJson(value[key])}`).join(',')}}`;
}

function cuecastGuessMimeType(filePath) {
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

function cuecastFileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cuecastSanitizeFilename(value) {
  return String(value || 'download.txt').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}
