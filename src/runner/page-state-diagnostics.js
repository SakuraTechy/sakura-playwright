import { RunnerError } from '../shared/utils.js';

export const LOADING_WAIT_WALL_MS = 180000;

const PAGE_LOADING_SELECTOR = [
  '[aria-busy="true"]',
  '.ivu-spin-fix .ivu-spin-main',
  '.ivu-table-wrapper .ivu-spin-main',
  '.ivu-table-with-loading .ivu-spin',
  '.ivu-spin.ivu-spin-fix .ivu-spin-main',
  '.ivu-load-loop',
  '.ant-spin-spinning',
  '.ant-spin-nested-loading .ant-spin',
  '.el-loading-mask',
  '.el-loading-spinner',
  '.el-icon-loading',
  '.v-loading-parent--relative .v-loading',
  '[data-loading="true"]',
].join(', ');

const PAGE_ERROR_SELECTOR = [
  '.ivu-message-error',
  '.ivu-notice-error',
  '.el-message--error',
  '.ant-message-error',
  '.ant-message-error .ant-message-content',
  '.arco-message-error',
  '.alert-danger',
  '.alert-error',
  '.ivu-alert-error',
  '.t-message--error',
].join(', ');

export const DEFAULT_PAGE_ERROR_KEYWORDS = [
  '请求失败', '加载失败', '网络错误', '网络异常', '系统异常', '操作失败', '登录失败',
  '权限不足', '无权限', '访问被拒绝', '服务异常', '服务器错误', '请稍后重试', '接口异常',
  'Internal Server Error', 'Bad Gateway', 'Network Error', 'Failed to fetch', 'Gateway Timeout',
];

export function resolvePageErrorCheckEnabled(configValue, testCase) {
  if (typeof configValue === 'boolean') return configValue;
  const caseValue = testCase?.page_error_check_enabled ?? testCase?.pageErrorCheckEnabled;
  if (caseValue == null || caseValue === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(caseValue).trim().toLowerCase());
}

export async function isPageLoadingUi(page) {
  if (!page || page.isClosed?.()) return false;
  return page.evaluate((selector) => {
    try {
      return Array.from(document.querySelectorAll(selector)).some((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.opacity || '1') >= 0.05;
      });
    } catch {
      return false;
    }
  }, PAGE_LOADING_SELECTOR).catch(() => false);
}

export async function detectPageError(page) {
  if (!page || page.isClosed?.()) return null;
  return page.evaluate(({ keywords, errorSelector }) => {
    try {
      const text = document.body?.innerText?.slice(0, 24000) || '';
      const lowerText = text.toLowerCase();
      for (const keyword of keywords) {
        const index = lowerText.indexOf(String(keyword).toLowerCase());
        if (index < 0) continue;
        return {
          hit: true,
          keyword,
          snippet: text
            .slice(Math.max(0, index - 40), Math.min(text.length, index + keyword.length + 120))
            .replace(/\s+/g, ' ')
            .trim(),
          source: 'body-keyword',
        };
      }
      for (const element of document.querySelectorAll(errorSelector)) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity || '1') < 0.05) {
          continue;
        }
        const snippet = String(element.innerText || element.textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 400);
        if (snippet) {
          return {
            hit: true,
            keyword: '[页面错误提示]',
            snippet,
            source: 'visible-error-message',
          };
        }
      }
    } catch {
      return null;
    }
    return null;
  }, {
    keywords: DEFAULT_PAGE_ERROR_KEYWORDS,
    errorSelector: PAGE_ERROR_SELECTOR,
  }).catch(() => null);
}

export async function throwIfPageError(page, enabled, details = {}) {
  if (!enabled) return;
  const signal = await detectPageError(page);
  if (!signal?.hit) return;
  throw new RunnerError(
    'PAGE_ERROR_DETECTED',
    `页面出现错误提示，已中止回放：${signal.keyword}${signal.snippet ? `；摘录：${signal.snippet}` : ''}`,
    {
      ...details,
      page_error: signal,
      page: await collectPageSummary(page),
    },
  );
}

export async function collectPageSummary(page) {
  if (!page || page.isClosed?.()) return { url: '', title: '' };
  const [title, bodyText, domExcerpt, visibleErrors] = await Promise.all([
    page.title().catch(() => ''),
    page.locator('body').innerText({ timeout: 500 }).catch(() => ''),
    page.locator('html').evaluate((element) => element.outerHTML.slice(0, 24000)).catch(() => ''),
    collectVisibleErrorMessages(page),
  ]);
  return {
    url: String(page.url?.() || '').slice(0, 2000),
    title: String(title || '').slice(0, 500),
    body_text_excerpt: String(bodyText || '').slice(0, 8000),
    dom_excerpt: String(domExcerpt || '').slice(0, 24000),
    visible_errors: visibleErrors,
  };
}

async function collectVisibleErrorMessages(page) {
  return page.locator(PAGE_ERROR_SELECTOR).evaluateAll((elements) => elements
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') >= 0.05;
    })
    .map((element) => String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 10)).catch(() => []);
}
