import { RunnerError } from './utils.js';

const CANDIDATE_TYPES = new Set([
  'css_attr_data-testid',
  'css_attr_data-test',
  'css_attr_name',
  'css_attr_aria-label',
  'css_attr_placeholder',
  'css_id',
  'css_fallback',
  'xpath_fallback',
  'table_cell_css',
  'table_cell_xpath',
  'tree_item_text',
  'text_exact',
  'text_exact_tag',
]);

const OVERLAY_SELECTORS = [
  'dialog[open]',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '.el-dialog',
  '.el-overlay',
  '.el-popper',
  '.el-select-dropdown',
  '.ant-modal',
  '.ant-modal-root',
  '.ant-popover',
  '.ant-dropdown',
  '.ant-select-dropdown',
  '.ivu-modal',
  '.ivu-select-dropdown',
  '.n-modal',
  '.n-popover',
  '.n-dropdown',
  '[data-overlay="true"]',
].join(', ');

const TABLE_WRAPPERS = {
  el: '.el-table',
  element: '.el-table',
  ant: '.ant-table',
  'ant-table': '.ant-table',
  ivu: '.ivu-table',
  table: 'table',
  native: 'table',
};

export async function resolveLocator(page, step, options = {}) {
  const meta = parseLocatorMeta(step.locator_meta);
  const candidates = sortCandidates(meta?.candidates || []);
  let lastAmbiguous = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!CANDIDATE_TYPES.has(String(candidate?.type || ''))) continue;
    const resolved = await tryCandidate(page, candidate, `locator_meta.candidates[${index}]`, options, meta?.context || {});
    if (resolved.ok) return resolved;
    if (resolved.error?.code === 'LOCATOR_AMBIGUOUS') lastAmbiguous = resolved.error;
  }

  const bySelector = await tryCss(page, step.target_selector, 'target_selector', options, meta?.context || {});
  if (bySelector.ok) return bySelector;
  if (bySelector.error?.code === 'LOCATOR_AMBIGUOUS') lastAmbiguous = bySelector.error;

  const byXpath = await tryXpath(page, step.target_xpath, 'target_xpath', options, meta?.context || {});
  if (byXpath.ok) return byXpath;
  if (byXpath.error?.code === 'LOCATOR_AMBIGUOUS') lastAmbiguous = byXpath.error;

  const byText = await tryTextFallback(page, step, options, meta?.context || {});
  if (byText.ok) return byText;
  if (byText.error?.code === 'LOCATOR_AMBIGUOUS') lastAmbiguous = byText.error;

  if (lastAmbiguous) throw lastAmbiguous;

  throw new RunnerError('LOCATOR_NOT_FOUND', 'No usable locator found for step', {
    step_id: step.id,
    step_index: step.step_index,
    action_type: step.action_type,
    target_selector: maskIfNeeded(step.target_selector),
    target_xpath: maskIfNeeded(step.target_xpath),
    candidate_count: candidates.length,
  });
}

export function parseLocatorMeta(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));
}

async function tryCandidate(page, candidate, source, options, context) {
  const type = String(candidate?.type || '');
  const value = String(candidate?.value || '').trim();
  if (!value) return { ok: false };

  if (type === 'table_cell_css') return tryTableCandidate(page, candidate, source, options, context, 'css');
  if (type === 'table_cell_xpath') return tryTableCandidate(page, candidate, source, options, context, 'xpath');
  if (type === 'tree_item_text') return tryTreeCandidate(page, candidate, source, options, context);
  if (type.startsWith('css_')) return tryCss(page, value, source, options, context, type);
  if (type === 'xpath_fallback') return tryXpath(page, value, source, options, context, type);
  if (type === 'text_exact') {
    const root = rootForContext(page, context);
    return settleLocator({
      page,
      locator: getByText(root, value),
      source,
      locatorType: type,
      locatorValue: value,
      options,
      context,
      makeScopedLocator: (scope) => scope.getByText(value, { exact: true }),
    });
  }
  if (type === 'text_exact_tag') {
    const { tag, text } = parseTextTagValue(value);
    if (!tag || !text) return { ok: false };
    const root = rootForContext(page, context);
    return settleLocator({
      page,
      locator: root.locator(tag).filter({ hasText: text }),
      source,
      locatorType: type,
      locatorValue: value,
      options,
      context,
      makeScopedLocator: (scope) => scope.locator(tag).filter({ hasText: text }),
    });
  }
  return { ok: false };
}

async function tryTreeCandidate(page, candidate, source, options, context) {
  const treeContext = candidate?.context?.tree || context?.tree || {};
  const value = String(candidate.value || '').trim();
  if (!value) return { ok: false };
  const root = rootForContext(page, context);
  const treeSelector = String(treeContext.selector || treeContext.target_selector || '[role="tree"], .el-tree, .ant-tree, [data-tree="true"]').trim();
  const tree = root.locator(treeSelector).first();
  const itemSelector = String(treeContext.item_selector || '[role="treeitem"], .el-tree-node, .ant-tree-treenode, [data-tree-node="true"]').trim();
  const item = tree.locator(itemSelector).filter({ hasText: value });
  return settleLocator({
    page,
    locator: item,
    source: `tree:${source}`,
    locatorType: 'tree_item_text',
    locatorValue: value,
    options,
    context,
  });
}

async function tryCss(page, selector, source, options, context, type = 'css') {
  const value = String(selector || '').trim();
  if (!value) return { ok: false };
  try {
    const root = rootForContext(page, context);
    return await settleLocator({
      page,
      locator: root.locator(value),
      source,
      locatorType: type,
      locatorValue: value,
      options,
      context,
      makeScopedLocator: (scope) => scope.locator(value),
    });
  } catch (error) {
    if (error instanceof RunnerError) return { ok: false, error };
    return { ok: false };
  }
}

async function tryXpath(page, xpath, source, options, context, type = 'xpath') {
  const value = String(xpath || '').trim();
  if (!value) return { ok: false };
  try {
    const root = rootForContext(page, context);
    return await settleLocator({
      page,
      locator: root.locator(`xpath=${value}`),
      source,
      locatorType: type,
      locatorValue: value,
      options,
      context,
      makeScopedLocator: (scope) => scope.locator(`xpath=${value}`),
    });
  } catch (error) {
    if (error instanceof RunnerError) return { ok: false, error };
    return { ok: false };
  }
}

async function tryTextFallback(page, step, options, context) {
  const value = String(step.value || step.description || '').trim();
  if (!value) return { ok: false };
  const root = rootForContext(page, context);
  return settleLocator({
    page,
    locator: getByText(root, value),
    source: 'text_fallback',
    locatorType: 'text_exact',
    locatorValue: value,
    options,
    context,
    makeScopedLocator: (scope) => scope.getByText(value, { exact: true }),
  });
}

function rootForContext(page, context) {
  const frame = context?.frame || context?.iframe;
  if (!frame) return page;
  const selector = String(frame.selector || frame.target_selector || frame.css || '').trim();
  if (selector) return page.frameLocator(selector);
  throw new RunnerError('LOCATOR_NOT_FOUND', 'iframe context requires frame.selector', { context: frame });
}

function getByText(root, value) {
  if (typeof root.getByText === 'function') return root.getByText(value, { exact: true });
  return root.locator(`text=${value}`);
}

async function tryTableCandidate(page, candidate, source, options, context, mode) {
  const tableContext = candidate?.context?.table || context?.table;
  if (!tableContext) return mode === 'css'
    ? tryCss(page, candidate.value, source, options, context, candidate.type)
    : tryXpath(page, candidate.value, source, options, context, candidate.type);

  const cellInfo = await resolveTableCell(page, tableContext, options);
  if (!cellInfo.ok) {
    return mode === 'css'
      ? tryCss(page, candidate.value, source, options, context, candidate.type)
      : tryXpath(page, candidate.value, source, options, context, candidate.type);
  }

  const value = String(candidate.value || '').trim();
  const locator = mode === 'css' ? cellInfo.cell.locator(value) : cellInfo.cell.locator(`xpath=${value}`);
  const settled = await settleLocator({
    page,
    locator,
    source: `table:${source}`,
    locatorType: candidate.type,
    locatorValue: value,
    options,
    context: {},
  });
  if (settled.ok) return settled;

  const text = String(candidate.text || context?.text || '').trim();
  if (text) {
    return settleLocator({
      page,
      locator: cellInfo.cell.getByText(text, { exact: true }),
      source: `table_text:${source}`,
      locatorType: candidate.type,
      locatorValue: text,
      options,
      context: {},
    });
  }
  return settled;
}

async function resolveTableCell(page, tableContext, options) {
  const framework = String(tableContext.framework || tableContext.type || 'table').toLowerCase();
  const wrapperSelector = TABLE_WRAPPERS[framework] || TABLE_WRAPPERS.table;
  const wrapperIndex = Number(tableContext.wrapper_index ?? tableContext.wrapperIndex ?? 0) || 0;
  const rowIndex = Number(tableContext.row_index ?? tableContext.rowIndex ?? 0);
  const colIndex = Number(tableContext.col_index ?? tableContext.colIndex ?? 0);
  const wrapper = page.locator(wrapperSelector).nth(Math.max(0, wrapperIndex));
  if (!(await wrapper.isVisible({ timeout: Math.min(options.timeoutMs || 6000, 1000) }).catch(() => false))) {
    return { ok: false };
  }

  const rows = wrapper.locator('tbody tr, .el-table__body tbody tr, .ant-table-tbody tr, .ivu-table-tbody tr');
  const rowCount = await rows.count().catch(() => 0);
  if (rowCount < 1) return { ok: false };

  let row = rows.nth(Math.max(0, rowIndex));
  const rowText = String(tableContext.row_text || tableContext.rowText || '').trim();
  if (rowText) {
    const best = await findBestRowByText(rows, rowText, rowCount);
    if (best != null) row = rows.nth(best);
  }

  const cells = row.locator('td, th, .el-table__cell, .ant-table-cell, .ivu-table-cell');
  const cellCount = await cells.count().catch(() => 0);
  if (cellCount < 1 || colIndex >= cellCount) return { ok: false };
  return { ok: true, cell: cells.nth(Math.max(0, colIndex)) };
}

async function findBestRowByText(rows, rowText, rowCount) {
  const expected = normalizeText(rowText);
  for (let i = 0; i < Math.min(rowCount, 50); i += 1) {
    const text = normalizeText(await rows.nth(i).textContent().catch(() => ''));
    if (text && (text.includes(expected) || expected.includes(text))) return i;
  }
  return null;
}

async function settleLocator({ page, locator, source, locatorType, locatorValue, options, context, makeScopedLocator }) {
  const timeout = options.timeoutMs || 6000;
  const scopedSource = sourceForContext(source, context);
  const count = await locator.count().catch(() => 0);
  if (count < 1) return { ok: false };

  const visibleIndexes = await collectVisibleIndexes(locator, count, timeout);
  if (visibleIndexes.length === 1) {
    return makeSuccess(locator.nth(visibleIndexes[0]), scopedSource, locatorType, locatorValue, count, 1);
  }

  if (visibleIndexes.length > 1) {
    const overlayResult = await tryOverlayScopedLocator({
      page,
      makeScopedLocator,
      source,
      locatorType,
      locatorValue,
      options,
    });
    if (overlayResult.ok) return overlayResult;

    const tableResult = await tryTableNarrowing({
      page,
      context,
      source,
      locatorType,
      locatorValue,
      options,
      makeScopedLocator,
    });
    if (tableResult.ok) return tableResult;

    return {
      ok: false,
      error: new RunnerError('LOCATOR_AMBIGUOUS', 'Locator resolved to multiple visible elements', {
        source: scopedSource,
        locatorType,
        locatorValue: maskIfNeeded(locatorValue),
        matchedCount: count,
        visibleCount: visibleIndexes.length,
        candidates: await summarizeCandidates(locator, visibleIndexes),
      }),
    };
  }
  return { ok: false };
}

function sourceForContext(source, context) {
  return context?.frame || context?.iframe ? `frame:${source}` : source;
}

async function tryOverlayScopedLocator({ page, makeScopedLocator, source, locatorType, locatorValue, options }) {
  if (!makeScopedLocator) return { ok: false };
  const overlays = await visibleOverlayScopes(page, options);
  for (const overlay of overlays) {
    const scoped = makeScopedLocator(overlay);
    const count = await scoped.count().catch(() => 0);
    if (count < 1) continue;
    const visibleIndexes = await collectVisibleIndexes(scoped, count, options.timeoutMs || 6000);
    if (visibleIndexes.length === 1) {
      return makeSuccess(scoped.nth(visibleIndexes[0]), `overlay:${source}`, locatorType, locatorValue, count, 1);
    }
  }
  return { ok: false };
}

async function tryTableNarrowing({ page, context, source, locatorType, locatorValue, options, makeScopedLocator }) {
  if (!context?.table || !makeScopedLocator) return { ok: false };
  const cellInfo = await resolveTableCell(page, context.table, options);
  if (!cellInfo.ok) return { ok: false };
  const scoped = makeScopedLocator(cellInfo.cell);
  const count = await scoped.count().catch(() => 0);
  if (count < 1) return { ok: false };
  const visibleIndexes = await collectVisibleIndexes(scoped, count, options.timeoutMs || 6000);
  if (visibleIndexes.length === 1) {
    return makeSuccess(scoped.nth(visibleIndexes[0]), `table:${source}`, locatorType, locatorValue, count, 1);
  }
  return { ok: false };
}

async function visibleOverlayScopes(page, options) {
  const overlays = page.locator(OVERLAY_SELECTORS);
  const count = await overlays.count().catch(() => 0);
  const visible = [];
  for (let i = 0; i < Math.min(count, 20); i += 1) {
    const item = overlays.nth(i);
    if (await item.isVisible({ timeout: Math.min(options.timeoutMs || 6000, 1000) }).catch(() => false)) {
      visible.push(item);
    }
  }
  return visible.reverse();
}

async function collectVisibleIndexes(locator, count, timeout) {
  const visibleIndexes = [];
  const maxScan = Math.min(count, 25);
  for (let i = 0; i < maxScan; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible({ timeout: Math.min(timeout, 1000) }).catch(() => false)) {
      visibleIndexes.push(i);
    }
  }
  return visibleIndexes;
}

async function summarizeCandidates(locator, visibleIndexes) {
  const candidates = [];
  for (const index of visibleIndexes.slice(0, 5)) {
    candidates.push({
      index,
      text: maskIfNeeded(normalizeText(await locator.nth(index).textContent().catch(() => ''))),
      visible: true,
    });
  }
  return candidates;
}

function makeSuccess(locator, source, locatorType, locatorValue, matchedCount, visibleCount) {
  return {
    ok: true,
    locator,
    source,
    locatorType,
    locatorValue,
    matchedCount,
    visibleCount,
  };
}

function parseTextTagValue(value) {
  const raw = String(value || '');
  const idx = raw.indexOf('::');
  if (idx > 0) return { tag: raw.slice(0, idx).trim(), text: raw.slice(idx + 2).trim() };
  const match = raw.match(/^([a-zA-Z][\w-]*)\[(.*)\]$/);
  if (match) return { tag: match[1], text: match[2] };
  return { tag: '', text: '' };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function maskIfNeeded(value) {
  return value == null ? '' : String(value).slice(0, 500);
}
