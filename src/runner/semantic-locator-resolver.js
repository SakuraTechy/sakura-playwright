import { RunnerError, sleep } from '../shared/utils.js';
import {
  collectPageSummary,
  isPageLoadingUi,
  LOADING_WAIT_WALL_MS,
  throwIfPageError,
} from './page-state-diagnostics.js';

export const SEMANTIC_CANDIDATE_TYPES = new Set([
  'css_attr_data-testid',
  'css_attr_data-test',
  'css_attr_data-qa',
  'css_attr_data-cy',
  'css_attr_name',
  'css_attr_aria-label',
  'css_attr_placeholder',
  'css_attr_title',
  'css_attr_role',
  'css_id',
  'css_fallback',
  'xpath_fallback',
  'component_root_class',
  'component_root_combo',
  'component_root_sibling',
  'table_cell_css',
  'table_cell_xpath',
  'tree_interaction',
  'tree_node_text',
  // 兼容早期 test-lab 数据；录制器当前使用 tree_node_text。
  'tree_item_text',
  'text_exact',
  'text_exact_tag',
]);

const POINTER_ACTIONS = new Set([
  'click',
  'click_open_page',
  'double_click',
  'right_click',
  'hover',
  'assert_download',
  'assert_request',
  'assert_response',
]);
const FILE_UPLOAD_ACTIONS = new Set(['file_upload', 'certificate_upload']);
const DISABLED_SENSITIVE_ACTIONS = new Set([
  'click',
  'click_open_page',
  'double_click',
  'right_click',
  'assert_download',
  'assert_request',
  'assert_response',
  'input',
  'file_upload',
  'certificate_upload',
  'key',
]);
const POLL_INTERVAL_MS = 120;
const MAX_CANDIDATES = 16;
const MAX_MATCH_SCAN = 25;
const MIN_AUTO_SELECT_SCORE = 155;
const MIN_AUTO_SELECT_MARGIN = 30;

export async function resolveSemanticLocator(page, step, options = {}, meta = null) {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 6000);
  const wallTimeoutMs = Math.max(timeoutMs, Number(options.locatorWallTimeoutMs) || LOADING_WAIT_WALL_MS);
  const context = buildSemanticContext(step, meta?.context || {});
  const descriptors = buildDescriptors(page, step, meta, context);
  const attempts = new Map();
  let remainingMs = timeoutMs;
  let loadingPauseMs = 0;
  let strongestFailure = null;

  const reveal = context.reveal;
  const revealResult = reveal ? await activateRevealTrigger(page, reveal, options) : null;

  while (remainingMs > 0 && Date.now() - startedAt < wallTimeoutMs) {
    const iterationStartedAt = Date.now();
    let iterationFailure = null;
    await throwIfPageError(page, options.pageErrorCheckEnabled, {
      locator_diagnostics: createDiagnostics({
        outcome: 'page-error',
        meta,
        attempts,
        startedAt,
        remainingMs,
        loadingPauseMs,
        revealResult,
      }),
    });
    const loading = await isPageLoadingUi(page);

    for (const descriptor of descriptors) {
      const result = await tryDescriptor(page, step, descriptor, options, context);
      attempts.set(descriptor.key, result.attempt);
      if (result.ok) {
        const diagnostics = createDiagnostics({
          outcome: 'resolved',
          meta,
          attempts,
          selected: result.selected,
          startedAt,
          remainingMs,
          loadingPauseMs,
          revealResult,
        });
        return {
          ok: true,
          locator: result.locator,
          source: descriptor.source,
          locatorType: descriptor.type,
          locatorValue: descriptor.value,
          matchedCount: result.matchedCount,
          visibleCount: result.visibleCount,
          diagnostics,
        };
      }
      iterationFailure = preferFailure(iterationFailure, result.failure);
    }
    strongestFailure = iterationFailure || strongestFailure;

    await sleep(POLL_INTERVAL_MS);
    const elapsed = Math.max(1, Date.now() - iterationStartedAt);
    if (loading) loadingPauseMs += elapsed;
    else remainingMs -= elapsed;
  }

  const failure = strongestFailure || { code: 'LOCATOR_NOT_FOUND', message: 'No usable locator found for step' };
  const diagnostics = createDiagnostics({
    outcome: errorOutcome(failure.code),
    meta,
    attempts,
    startedAt,
    remainingMs,
    loadingPauseMs,
    revealResult,
  });
  const details = {
    step_id: step.id,
    step_index: step.step_index,
    action_type: step.action_type,
    source: failure.source || '',
    locatorType: failure.locatorType || '',
    locatorValue: maskValue(failure.locatorValue || ''),
    matchedCount: failure.matchedCount ?? 0,
    visibleCount: failure.visibleCount ?? 0,
    target_selector: maskValue(step.target_selector),
    target_xpath: maskValue(step.target_xpath),
    candidate_count: Array.isArray(meta?.candidates) ? meta.candidates.length : 0,
    locator_diagnostics: diagnostics,
    page: await collectPageSummary(page),
    recent_resource_failures: recentResourceFailures(options),
  };
  throw new RunnerError(failure.code, failure.message, details);
}

export function scoreSemanticCandidate(snapshot, context = {}) {
  let score = snapshot.visible ? 100 : 0;
  const strongSignals = [];
  const expectedKind = normalizeText(context.control_kind).toLowerCase();
  const actualKind = normalizeText(snapshot.controlKind).toLowerCase();
  if (expectedKind && expectedKind === actualKind) score += 16;

  const expectedLabel = normalizeText(context.label_text).toLowerCase();
  const actualLabel = normalizeText(snapshot.labelText).toLowerCase();
  const actualContainer = normalizeText(snapshot.containerText).toLowerCase();
  if (expectedLabel) {
    if (actualLabel === expectedLabel) {
      score += 80;
      strongSignals.push('label_exact');
    } else if (actualLabel && (actualLabel.includes(expectedLabel) || expectedLabel.includes(actualLabel))) {
      score += 45;
    }
    if (actualContainer.includes(expectedLabel)) score += 30;
  }

  const expectedContainer = normalizeText(context.container_text).toLowerCase();
  if (expectedContainer) {
    if (actualContainer === expectedContainer) score += 45;
    else score += Math.min(35, matchingTokenCount(expectedContainer, actualContainer, 10) * 7);
  }

  const expectedIndex = Number(context.sibling_index);
  if (Number.isInteger(expectedIndex) && expectedIndex >= 0) {
    if (snapshot.siblingIndex === expectedIndex) {
      score += 55;
      strongSignals.push('sibling_index');
    } else if (snapshot.siblingIndex >= 0) {
      score -= Math.min(24, Math.abs(snapshot.siblingIndex - expectedIndex) * 8);
    }
  }

  const expectedRowIndex = Number(context?.table?.row_index);
  if (Number.isInteger(expectedRowIndex) && expectedRowIndex >= 0) {
    if (snapshot.rowIndex === expectedRowIndex) {
      score += 85;
      strongSignals.push('table_row_index');
    } else if (snapshot.rowIndex >= 0) {
      score -= Math.min(40, Math.abs(snapshot.rowIndex - expectedRowIndex) * 12);
    }
  }

  const expectedRowText = normalizeText(context?.table?.row_text).toLowerCase();
  const actualRowText = normalizeText(snapshot.rowText).toLowerCase();
  if (expectedRowText && actualRowText) {
    if (actualRowText === expectedRowText) {
      score += 70;
      strongSignals.push('table_row_text');
    } else {
      score += Math.min(50, matchingTokenCount(expectedRowText, actualRowText, 8) * 12);
    }
  }

  if (context.rect && snapshot.rect) {
    const expectedCenterX = Number(context.rect.left || 0) + Number(context.rect.width || 0) / 2;
    const expectedCenterY = Number(context.rect.top || 0) + Number(context.rect.height || 0) / 2;
    const actualCenterX = Number(snapshot.rect.left || 0) + Number(snapshot.rect.width || 0) / 2;
    const actualCenterY = Number(snapshot.rect.top || 0) + Number(snapshot.rect.height || 0) / 2;
    const viewportWidth = Math.max(1, Number(context.rect.viewportWidth || snapshot.rect.viewportWidth || 1));
    const viewportHeight = Math.max(1, Number(context.rect.viewportHeight || snapshot.rect.viewportHeight || 1));
    const distance = Math.hypot(
      (actualCenterX - expectedCenterX) / viewportWidth,
      (actualCenterY - expectedCenterY) / viewportHeight,
    );
    score += Math.max(0, 28 - distance * 80);
  }

  const expectedStates = Array.isArray(context.state_classes) ? context.state_classes : [];
  if (expectedStates.length) {
    const classes = new Set(snapshot.stateClasses || []);
    const hits = expectedStates.filter((item) => classes.has(item)).length;
    score += Math.min(12, hits * 4);
  }

  return { score: Math.round(score * 100) / 100, strongSignals };
}

/**
 * 与 CueCast/CDP 保持同一套下拉选项识别规则，避免 Element Select 选项
 * 被页面表格中的同名文本抢先命中。
 */
export function isOverlayStep(step, context = {}) {
  const action = String(step?.action_type || '').toLowerCase();
  if (!['click', 'click_open_page', 'double_click', 'right_click'].includes(action)) return false;
  const value = String(step?.value ?? '').trim();
  if (!value) return false;
  const selector = String(step?.target_selector || '').trim();
  const xpath = String(step?.target_xpath || '').trim();
  return Boolean(
    context?.overlay === true
    || step?.is_overlay === true
    || Number(step?.is_overlay) === 1
    || (!selector && !xpath)
    || xpath.includes('normalize-space('),
  );
}

export function chooseHighConfidenceCandidate(items) {
  if (!Array.isArray(items) || items.length === 0) return { selected: null, reason: 'empty' };
  if (items.length === 1) return { selected: items[0], reason: 'unique', margin: null };
  const sorted = [...items].sort((a, b) => b.score - a.score || a.index - b.index);
  const first = sorted[0];
  const margin = first.score - sorted[1].score;
  if (
    first.score >= MIN_AUTO_SELECT_SCORE
    && margin >= MIN_AUTO_SELECT_MARGIN
    && Array.isArray(first.strongSignals)
    && first.strongSignals.length > 0
  ) {
    return { selected: first, reason: 'high-confidence', margin };
  }
  return { selected: null, reason: 'low-confidence', margin, ranked: sorted };
}

function buildDescriptors(page, step, meta, context = buildSemanticContext(step, meta?.context || {})) {
  const root = rootForContext(page, context);
  const descriptors = [];
  const seen = new Set();
  const push = (type, value, source, score = 0, candidateContext = null) => {
    const normalizedType = String(type || '').trim();
    const normalizedValue = String(value || '').trim();
    if (!SEMANTIC_CANDIDATE_TYPES.has(normalizedType) || !normalizedValue) return;
    const key = `${normalizedType}::${normalizedValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    descriptors.push({
      key,
      type: normalizedType,
      value: normalizedValue,
      source: sourceForContext(source, context),
      score: Number(score || 0),
      candidateContext,
      root,
    });
  };

  [...(Array.isArray(meta?.candidates) ? meta.candidates : [])]
    .map((candidate, originalIndex) => ({ candidate, originalIndex }))
    .sort((a, b) => Number(b.candidate?.score || 0) - Number(a.candidate?.score || 0))
    .slice(0, MAX_CANDIDATES)
    .forEach(({ candidate, originalIndex }) => push(
      candidate?.type,
      candidate?.value,
      `locator_meta.candidates[${originalIndex}]`,
      candidate?.score,
      candidate?.context,
    ));
  push('css_fallback', step.target_selector, 'target_selector');
  push('xpath_fallback', step.target_xpath, 'target_xpath');
  const text = String(step.value || '').trim();
  if (
    text
    && [...POINTER_ACTIONS, 'assert_text'].includes(String(step.action_type || '').toLowerCase())
    && !seen.has(`text_exact::${text}`)
  ) {
    push('text_exact', text, 'text_fallback');
  }
  return descriptors;
}

async function tryDescriptor(page, step, descriptor, options, context) {
  let locator;
  try {
    locator = createDescriptorLocator(descriptor);
  } catch (error) {
    const code = classifyLookupError(descriptor, error);
    return failedAttempt(descriptor, code, 'lookup_error', { lookupError: error?.message || String(error) });
  }

  let matchedCount;
  try {
    matchedCount = await locator.count();
  } catch (error) {
    const code = classifyLookupError(descriptor, error);
    return failedAttempt(descriptor, code, 'lookup_error', { lookupError: error?.message || String(error) });
  }
  if (matchedCount < 1) return failedAttempt(descriptor, 'LOCATOR_NOT_FOUND', 'not_found', { matchedCount: 0 });

  const scanned = [];
  const limit = Math.min(matchedCount, MAX_MATCH_SCAN);
  for (let index = 0; index < limit; index += 1) {
    const originalLocator = locator.nth(index);
    const normalized = await normalizeActionTarget(descriptor.root, originalLocator, step.action_type);
    const renderedVisible = await normalized.locator.isVisible({ timeout: 0 }).catch(() => false);
    // Playwright 的 setInputFiles 允许操作隐藏 file input，其余动作仍要求可见目标。
    const visible = FILE_UPLOAD_ACTIONS.has(String(step.action_type || '').toLowerCase()) ? true : renderedVisible;
    const disabledInfo = DISABLED_SENSITIVE_ACTIONS.has(String(step.action_type || '').toLowerCase())
      ? await readDisabledInfo(normalized.locator)
      : { disabled: false, reason: '', by: '' };
    const snapshot = await readSemanticSnapshot(originalLocator, normalized.locator).catch(() => ({}));
    const scoring = scoreSemanticCandidate({ ...snapshot, visible }, context);
    scanned.push({
      index,
      locator: normalized.locator,
      visible,
      renderedVisible,
      disabled: disabledInfo.disabled,
      disabledInfo,
      normalizationRule: normalized.rule,
      originalBrief: snapshot.originalBrief || '',
      effectiveBrief: snapshot.effectiveBrief || '',
      inOverlay: Boolean(snapshot.inOverlay),
      overlayZ: Number(snapshot.overlayZ || 0),
      score: scoring.score,
      strongSignals: scoring.strongSignals,
      snapshot,
    });
  }

  const visibleMatches = scanned.filter((item) => item.visible);
  const actionableMatches = visibleMatches.filter((item) => !item.disabled);
  if (actionableMatches.length > 0) {
    const narrowed = narrowDeterministically(actionableMatches, context);
    if (context.overlay && narrowed.length === 0) {
      return failedAttempt(descriptor, 'LOCATOR_AMBIGUOUS', 'overlay_not_found', {
        matchedCount,
        visibleCount: visibleMatches.length,
        candidates: summarizeScanned(actionableMatches),
      });
    }
    if (narrowed.length === 1) {
      return successfulAttempt(descriptor, narrowed[0], matchedCount, visibleMatches.length, actionableMatches.length === 1 ? 'unique' : 'semantic-narrowing');
    }
    if (actionableMatches.length > 1) {
      const selection = chooseHighConfidenceCandidate(narrowed);
      if (selection.selected) {
        return successfulAttempt(
          descriptor,
          selection.selected,
          matchedCount,
          visibleMatches.length,
          selection.reason,
          selection.margin,
        );
      }
      return failedAttempt(descriptor, 'LOCATOR_AMBIGUOUS', 'ambiguous', {
        matchedCount,
        visibleCount: visibleMatches.length,
        candidates: summarizeScanned(narrowed),
        scoreMargin: selection.margin,
      });
    }
  }
  if (visibleMatches.some((item) => item.disabled)) {
    const disabled = visibleMatches.find((item) => item.disabled);
    return failedAttempt(descriptor, 'LOCATOR_DISABLED', 'disabled', {
      matchedCount,
      visibleCount: visibleMatches.length,
      disabled: disabled.disabledInfo,
      candidates: summarizeScanned(visibleMatches),
    });
  }
  return failedAttempt(descriptor, 'LOCATOR_HIDDEN', 'hidden', {
    matchedCount,
    visibleCount: 0,
    candidates: summarizeScanned(scanned),
  });
}

function createDescriptorLocator(descriptor) {
  const { root, type, value } = descriptor;
  if (type === 'tree_interaction') return createTreeInteractionLocator(root, value);
  if (type === 'tree_node_text' || type === 'tree_item_text') return createTreeNodeLocator(root, value, descriptor.candidateContext);
  if (type === 'text_exact') return root.getByText(value, { exact: true });
  if (type === 'text_exact_tag') {
    const { tag, text } = parseTextTagValue(value);
    if (!tag || !text) throw new Error('text_exact_tag 格式无效');
    return root.locator(tag).filter({ hasText: exactTextRegex(text) });
  }
  if (type === 'xpath_fallback' || type === 'table_cell_xpath') return root.locator(`xpath=${value}`);
  return root.locator(value);
}

function classifyLookupError(descriptor, error) {
  if (!['xpath_fallback', 'table_cell_xpath'].includes(String(descriptor?.type || ''))) {
    return 'LOCATOR_LOOKUP_ERROR';
  }
  const message = String(error?.message || error || '');
  if (/not a node set|does not resolve to a node|non-node/i.test(message)) return 'LOCATOR_XPATH_UNSUPPORTED';
  return 'LOCATOR_XPATH_INVALID';
}

function createTreeNodeLocator(root, rawValue, candidateContext) {
  const parsed = parseJsonObject(rawValue);
  const title = normalizeText(parsed?.title || rawValue);
  const sameTitleIndex = Math.max(0, Number(parsed?.sameTitleIndex ?? parsed?.same_title_index ?? candidateContext?.sameTitleIndex ?? 0) || 0);
  const nodes = root.locator([
    '.el-tree-node__content',
    '.ivu-tree-title',
    '.arco-tree-node-title',
    '.arco-tree-node',
    '.n-tree-node-content',
    '.n-tree-node',
    '.ant-tree-treenode',
    '.vtree-tree-node__indent-wrapper',
    '[role="treeitem"]',
  ].join(', ')).filter({ hasText: title });
  return nodes.nth(sameTitleIndex);
}

function createTreeInteractionLocator(root, rawValue) {
  const config = parseJsonObject(rawValue);
  if (!config?.title) throw new Error('tree_interaction 缺少 title');
  const sameTitleIndex = Math.max(0, Number(config.sameTitleIndex ?? config.same_title_index ?? 0) || 0);
  if (config.framework === 'vtree') {
    const node = root.locator('.vtree-tree-node__indent-wrapper').filter({ hasText: config.title }).nth(sameTitleIndex);
    if (config.kind === 'expand_toggle') return node.locator('.vtree-tree-node__square.vtree-tree-node__expand').first();
    return node.locator('.vtree-tree-node__title, .vtree-tree-node__node-body').first();
  }
  const node = root.locator('.ant-tree-treenode, .ant-tree-node-content-wrapper, [role="treeitem"]')
    .filter({ hasText: config.title })
    .nth(sameTitleIndex);
  if (config.kind === 'expand_toggle') return node.locator('.ant-tree-switcher').first();
  if (config.kind === 'node_action') {
    return node.locator([
      '.tree-node-actions .data-source-icon',
      '.tree-node-actions [class*="data-source-icon"]',
      '.tree-node-actions .action-icon-wrapper',
      '.tree-node-actions [class*="action-icon"]',
    ].join(', ')).nth(Math.max(0, Number(config.actionIndex || 0) || 0));
  }
  return node.locator('.ant-tree-node-content-wrapper, .ant-tree-title').first();
}

async function normalizeActionTarget(root, locator, actionType) {
  if (!POINTER_ACTIONS.has(String(actionType || '').toLowerCase())) return { locator, rule: '' };
  const kind = await locator.evaluate((element) => ({
    tag: String(element.tagName || '').toLowerCase(),
    type: String(element.getAttribute?.('type') || '').toLowerCase(),
    role: String(element.getAttribute?.('role') || '').toLowerCase(),
    componentRoot: Boolean(element.matches?.('.ivu-select,.ant-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"]')),
  })).catch(() => null);
  if (!kind) return { locator, rule: '' };

  if (['path', 'use'].includes(kind.tag)) {
    const svg = locator.locator('xpath=ancestor::svg[1]');
    if (await svg.isVisible({ timeout: 0 }).catch(() => false)) return { locator: svg, rule: 'svg-ancestor' };
  }

  if (kind.tag === 'input' && ['checkbox', 'radio'].includes(kind.type)) {
    if (await locator.isVisible({ timeout: 0 }).catch(() => false)) return { locator, rule: '' };
    const wrapper = locator.locator(
      'xpath=ancestor::*[self::label or contains(concat(" ",normalize-space(@class)," ")," ivu-radio-wrapper ") or contains(concat(" ",normalize-space(@class)," ")," ant-radio-wrapper ") or contains(concat(" ",normalize-space(@class)," ")," el-radio ") or contains(concat(" ",normalize-space(@class)," ")," ivu-checkbox-wrapper ") or contains(concat(" ",normalize-space(@class)," ")," ant-checkbox-wrapper ") or contains(concat(" ",normalize-space(@class)," ")," el-checkbox ")][1]',
    );
    if (await wrapper.isVisible({ timeout: 0 }).catch(() => false)) return { locator: wrapper, rule: `${kind.type}-visible-wrapper` };
    const id = await locator.getAttribute('id').catch(() => '');
    if (id) {
      const label = root.locator(`label[for="${escapeCssAttribute(id)}"]`).first();
      if (await label.isVisible({ timeout: 0 }).catch(() => false)) return { locator: label, rule: `${kind.type}-associated-label` };
    }
  }

  if (kind.componentRoot || kind.role === 'combobox') {
    const inner = locator.locator([
      '.ivu-select-selection',
      '.ant-select-selector',
      '.el-input',
      '.el-select__wrapper',
      '.vs__dropdown-toggle',
      '[role="textbox"]',
      'input',
    ].join(', ')).first();
    if (await inner.isVisible({ timeout: 0 }).catch(() => false)) return { locator: inner, rule: 'combobox-visible-inner' };
  }
  return { locator, rule: '' };
}

async function readDisabledInfo(locator) {
  return locator.evaluate((element) => {
    const brief = (node) => {
      if (!node) return '';
      const tag = String(node.tagName || '').toLowerCase();
      const id = node.id ? `#${node.id}` : '';
      const cls = typeof node.className === 'string' && node.className.trim()
        ? `.${node.className.trim().replace(/\s+/g, '.')}`
        : '';
      return `${tag}${id}${cls}`.slice(0, 300);
    };
    const disabledClass = /(?:^|\s)(?:[a-z]+-)?disabled(?:\s|$)/i;
    if (element.matches?.(':disabled') || element.hasAttribute?.('disabled')) {
      return { disabled: true, reason: 'native-disabled', by: brief(element) };
    }
    if (element.getAttribute?.('aria-disabled') === 'true') {
      return { disabled: true, reason: 'aria-disabled', by: brief(element) };
    }
    const fieldset = element.closest?.('fieldset[disabled]');
    if (fieldset) return { disabled: true, reason: 'fieldset-disabled', by: brief(fieldset) };
    const component = element.closest?.(
      '.ivu-select,.ant-select,.el-select,.ivu-checkbox-wrapper,.ant-checkbox-wrapper,.el-checkbox,.ivu-radio-wrapper,.ant-radio-wrapper,.el-radio,button,[role="button"]',
    );
    if (component) {
      if (component.matches?.(':disabled') || component.hasAttribute?.('disabled')) {
        return { disabled: true, reason: 'component-native-disabled', by: brief(component) };
      }
      if (component.getAttribute?.('aria-disabled') === 'true') {
        return { disabled: true, reason: 'component-aria-disabled', by: brief(component) };
      }
      if (disabledClass.test(String(component.className || ''))) {
        return { disabled: true, reason: 'component-disabled-class', by: brief(component) };
      }
    }
    return { disabled: false, reason: '', by: '' };
  }).catch(() => ({ disabled: false, reason: '', by: '' }));
}

async function readSemanticSnapshot(originalLocator, effectiveLocator) {
  const original = await readElementSnapshot(originalLocator);
  const effective = await readElementSnapshot(effectiveLocator);
  return {
    ...effective,
    controlKind: original.controlKind || effective.controlKind,
    labelText: original.labelText || effective.labelText,
    containerText: original.containerText || effective.containerText,
    siblingIndex: original.siblingIndex >= 0 ? original.siblingIndex : effective.siblingIndex,
    stateClasses: [...new Set([...(original.stateClasses || []), ...(effective.stateClasses || [])])],
    originalBrief: original.brief,
    effectiveBrief: effective.brief,
  };
}

async function readElementSnapshot(locator) {
  return locator.evaluate((element) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => {
      if (!node) return false;
      let current = node;
      while (current) {
        const style = window.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity || '1') < 0.02) return false;
        if (current.getAttribute?.('aria-hidden') === 'true') return false;
        current = current.parentElement;
      }
      const rect = node.getBoundingClientRect();
      return rect.width >= 1 || rect.height >= 1;
    };
    const controlRoot = (node) => node.closest?.('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"]')
      || node.closest?.('select,textarea,input,button,a,[role="button"]')
      || node;
    const controlKind = (node) => {
      const root = controlRoot(node);
      const tag = String(root?.tagName || '').toLowerCase();
      if (tag === 'select' || root?.getAttribute?.('role') === 'combobox' || root?.matches?.('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle')) return 'combobox';
      if (tag === 'input') return `input:${String(root.type || 'text').toLowerCase()}`;
      if (tag === 'textarea') return 'textarea';
      if (tag === 'button' || root?.getAttribute?.('role') === 'button') return 'button';
      if (tag === 'a') return 'link';
      return tag;
    };
    const labelText = (node) => {
      const parts = [];
      const push = (value) => {
        const text = normalize(value);
        if (text && !parts.includes(text)) parts.push(text);
      };
      try {
        Array.from(node.labels || []).forEach((label) => push(label.textContent));
        String(node.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean)
          .forEach((id) => push(document.getElementById(id)?.textContent));
        push(node.getAttribute?.('aria-label'));
        push(node.closest?.('label')?.textContent);
        const formItem = node.closest?.('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,.mapping-row,.map-row,[class*="mapping-row"],[class*="map-row"]');
        push(formItem?.querySelector?.('label,.ant-form-item-label,.ivu-form-item-label,.el-form-item__label,.form-label,[class*="label"]')?.textContent);
      } catch { /* 页面结构不完整时忽略标签补充。 */ }
      return parts.join(' | ').slice(0, 200);
    };
    const container = element.closest?.('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,td,th,tr,[role="row"],.mapping-row,.map-row,[class*="mapping-row"],[class*="map-row"]');
    const root = controlRoot(element);
    let siblingIndex = -1;
    if (root?.parentElement) {
      const selector = controlKind(root) === 'combobox'
        ? '.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"],select'
        : String(root.tagName || '').toLowerCase();
      try {
        siblingIndex = Array.from(root.parentElement.querySelectorAll(`:scope > ${selector}`)).indexOf(root);
      } catch { siblingIndex = -1; }
    }
    const row = element.closest?.('tr,.ant-table-row,.el-table__row,.ivu-table-row,[role="row"]');
    let rowIndex = -1;
    if (row) {
      const section = row.closest('tbody,thead');
      if (section) rowIndex = Array.from(section.querySelectorAll(':scope > tr')).indexOf(row);
    }
    let overlay = element.closest?.('[role="dialog"],[role="alertdialog"],dialog,.ant-modal,.ant-modal-wrap,.el-dialog,.el-overlay,.el-popper,.el-message,.ivu-select-dropdown,.ivu-message-notice,.ant-select-dropdown,.ant-message-notice,.n-modal,.n-message,[data-overlay="true"]');
    if (!overlay) {
      // Element UI Message 等通知直接挂在 body 且使用 fixed/absolute，录制端也按此规则标记浮层。
      let current = element;
      while (current && current !== document.body) {
        if (current.parentElement === document.body) {
          const style = window.getComputedStyle(current);
          if (['fixed', 'absolute'].includes(style.position)) {
            overlay = current;
            break;
          }
        }
        current = current.parentElement;
      }
    }
    let overlayZ = 0;
    let current = overlay;
    while (current && current !== document.documentElement) {
      const z = Number.parseInt(window.getComputedStyle(current).zIndex, 10);
      if (Number.isFinite(z)) overlayZ = Math.max(overlayZ, z);
      current = current.parentElement;
    }
    const rect = (root || element).getBoundingClientRect();
    const brief = `${String(element.tagName || '').toLowerCase()}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className.trim() ? `.${element.className.trim().replace(/\s+/g, '.')}` : ''}`;
    return {
      brief: brief.slice(0, 300),
      visible: visible(element),
      controlKind: controlKind(element),
      labelText: labelText(element),
      containerText: normalize(container?.innerText || container?.textContent || '').slice(0, 300),
      siblingIndex,
      rowIndex,
      rowText: normalize(row?.innerText || row?.textContent || '').slice(0, 500),
      inOverlay: Boolean(overlay),
      overlayZ,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      },
      stateClasses: [
        ...String(element.className || '').split(/\s+/),
        ...String(root?.className || '').split(/\s+/),
      ].filter(Boolean).slice(0, 30),
    };
  });
}

function narrowDeterministically(items, context) {
  let narrowed = [...items];
  const apply = (predicate, required = false) => {
    const matching = narrowed.filter(predicate);
    if (matching.length > 0 || required) narrowed = matching;
  };
  if (context.overlay) {
    apply((item) => item.inOverlay, true);
    const maxZ = Math.max(...narrowed.map((item) => item.overlayZ || 0));
    if (narrowed.length > 0 && maxZ > 0) apply((item) => item.overlayZ === maxZ);
  }
  const expectedKind = normalizeText(context.control_kind).toLowerCase();
  if (expectedKind) apply((item) => normalizeText(item.snapshot.controlKind).toLowerCase() === expectedKind);
  const expectedLabel = normalizeText(context.label_text).toLowerCase();
  if (expectedLabel) apply((item) => normalizeText(item.snapshot.labelText).toLowerCase() === expectedLabel);
  const expectedIndex = Number(context.sibling_index);
  if (Number.isInteger(expectedIndex) && expectedIndex >= 0) apply((item) => item.snapshot.siblingIndex === expectedIndex);
  const expectedRow = Number(context?.table?.row_index);
  if (Number.isInteger(expectedRow) && expectedRow >= 0) apply((item) => item.snapshot.rowIndex === expectedRow);
  const expectedRowText = normalizeText(context?.table?.row_text).toLowerCase();
  if (expectedRowText) apply((item) => normalizeText(item.snapshot.rowText).toLowerCase() === expectedRowText);
  return narrowed;
}

function buildSemanticContext(step, context = {}) {
  const effective = { ...context };
  if (isOverlayStep(step, context)) effective.overlay = true;
  return effective;
}

async function activateRevealTrigger(page, reveal, options) {
  const trigger = reveal?.trigger;
  if (!trigger) return { attempted: false, activated: false };
  const candidates = [];
  const meta = parseJsonObject(trigger.locator_meta) || trigger.locator_meta;
  for (const candidate of Array.isArray(meta?.candidates) ? meta.candidates : []) {
    if (String(candidate?.type || '').startsWith('css_') || String(candidate?.type || '').startsWith('component_root_')) {
      candidates.push({ type: 'css', value: candidate.value });
    } else if (['xpath_fallback', 'table_cell_xpath'].includes(String(candidate?.type || ''))) {
      candidates.push({ type: 'xpath', value: candidate.value });
    }
  }
  if (trigger.target_selector) candidates.push({ type: 'css', value: trigger.target_selector });
  if (trigger.target_xpath) candidates.push({ type: 'xpath', value: trigger.target_xpath });
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      const locator = candidate.type === 'xpath'
        ? page.locator(`xpath=${candidate.value}`).first()
        : page.locator(String(candidate.value)).first();
      if (!(await locator.isVisible({ timeout: 0 }).catch(() => false))) continue;
      if (String(trigger.action || 'hover').toLowerCase() === 'click') {
        await locator.click({ timeout: Math.min(Number(reveal.max_wait_ms || 3200), Number(options.timeoutMs || 6000)) });
      } else {
        await locator.hover({ timeout: Math.min(Number(reveal.max_wait_ms || 3200), Number(options.timeoutMs || 6000)) });
      }
      await sleep(220);
      return { attempted: true, activated: true, action: trigger.action || 'hover' };
    } catch { /* 继续尝试下一种录制定位。 */ }
  }
  return { attempted: true, activated: false, action: trigger.action || 'hover' };
}

function successfulAttempt(descriptor, item, matchedCount, visibleCount, decision, scoreMargin = null) {
  return {
    ok: true,
    locator: item.locator,
    matchedCount,
    visibleCount,
    attempt: {
      source: descriptor.source,
      type: descriptor.type,
      value: maskValue(descriptor.value),
      status: 'resolved',
      matched_count: matchedCount,
      visible_count: visibleCount,
    },
    selected: {
      source: descriptor.source,
      type: descriptor.type,
      value: maskValue(descriptor.value),
      index: item.index,
      decision,
      score: item.score,
      score_margin: scoreMargin,
      strong_signals: item.strongSignals,
      original_target: item.originalBrief,
      effective_target: item.effectiveBrief,
      normalization_rule: item.normalizationRule,
    },
  };
}

function failedAttempt(descriptor, code, status, extra = {}) {
  const failure = {
    code,
    message: failureMessage(code),
    source: descriptor.source,
    locatorType: descriptor.type,
    locatorValue: descriptor.value,
    matchedCount: extra.matchedCount ?? 0,
    visibleCount: extra.visibleCount ?? 0,
  };
  return {
    ok: false,
    failure,
    attempt: {
      source: descriptor.source,
      type: descriptor.type,
      value: maskValue(descriptor.value),
      status,
      matched_count: extra.matchedCount ?? 0,
      visible_count: extra.visibleCount ?? 0,
      ...(extra.disabled ? { disabled: extra.disabled } : {}),
      ...(extra.lookupError ? { lookup_error: maskValue(extra.lookupError) } : {}),
      ...(extra.scoreMargin != null ? { score_margin: extra.scoreMargin } : {}),
      ...(extra.candidates ? { candidates: extra.candidates } : {}),
    },
  };
}

function createDiagnostics({ outcome, meta, attempts, selected, startedAt, remainingMs, loadingPauseMs, revealResult }) {
  return {
    version: 1,
    mode: 'semantic-v1',
    outcome,
    configured_candidate_count: Array.isArray(meta?.candidates) ? meta.candidates.length : 0,
    attempts: [...attempts.values()].slice(0, MAX_CANDIDATES + 3),
    ...(selected ? { selected } : {}),
    wait: {
      wall_ms: Date.now() - startedAt,
      active_ms: Math.max(0, Date.now() - startedAt - loadingPauseMs),
      loading_pause_ms: loadingPauseMs,
    },
    ...(revealResult ? { reveal: revealResult } : {}),
  };
}

function summarizeScanned(items) {
  return items.slice(0, 8).map((item) => ({
    index: item.index,
    visible: item.visible,
    rendered_visible: item.renderedVisible,
    disabled: item.disabled,
    score: item.score,
    strong_signals: item.strongSignals,
    original_target: item.originalBrief,
    effective_target: item.effectiveBrief,
    normalization_rule: item.normalizationRule,
  }));
}

function preferFailure(current, next) {
  if (!next) return current;
  if (!current) return next;
  const priority = {
    LOCATOR_XPATH_INVALID: 7,
    LOCATOR_XPATH_UNSUPPORTED: 6,
    LOCATOR_DISABLED: 5,
    LOCATOR_AMBIGUOUS: 4,
    LOCATOR_HIDDEN: 3,
    LOCATOR_LOOKUP_ERROR: 2,
    LOCATOR_NOT_FOUND: 1,
  };
  return (priority[next.code] || 0) > (priority[current.code] || 0) ? next : current;
}

function failureMessage(code) {
  if (code === 'LOCATOR_XPATH_INVALID') return 'XPath 语法无效，浏览器无法解析';
  if (code === 'LOCATOR_XPATH_UNSUPPORTED') return 'XPath 返回非节点结果，请改用 XPath 1.0 节点表达式';
  if (code === 'LOCATOR_DISABLED') return '目标元素在等待超时后仍处于禁用状态';
  if (code === 'LOCATOR_AMBIGUOUS') return '定位命中多个元素，且没有满足阈值的高置信目标';
  if (code === 'LOCATOR_HIDDEN') return '已找到元素，但没有可见或可操作的目标';
  if (code === 'LOCATOR_LOOKUP_ERROR') return '定位策略执行失败';
  return 'No usable locator found for step';
}

function errorOutcome(code) {
  return String(code || '').replace(/^LOCATOR_/, '').toLowerCase().replaceAll('_', '-');
}

function rootForContext(page, context) {
  const frame = context?.frame || context?.iframe;
  if (!frame) return page;
  const selector = String(frame.selector || frame.target_selector || frame.css || '').trim();
  if (selector) return page.frameLocator(selector);
  throw new RunnerError('LOCATOR_NOT_FOUND', 'iframe context requires frame.selector', { context: frame });
}

function sourceForContext(source, context) {
  return context?.frame || context?.iframe ? `frame:${source}` : source;
}

function parseTextTagValue(value) {
  const raw = String(value || '');
  const separator = raw.indexOf('::');
  if (separator > 0) return { tag: raw.slice(0, separator).trim(), text: raw.slice(separator + 2).trim() };
  const match = raw.match(/^([a-zA-Z][\w-]*)\[(.*)\]$/);
  return match ? { tag: match[1], text: match[2] } : { tag: '', text: '' };
}

function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function exactTextRegex(value) {
  return new RegExp(`^\\s*${escapeRegExp(normalizeText(value)).replace(/\\ /g, '\\s+')}\\s*$`);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeCssAttribute(value) {
  return String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function matchingTokenCount(expected, actual, limit) {
  return expected.split(/\s+/).filter((token) => token.length >= 2).slice(0, limit)
    .filter((token) => actual.includes(token)).length;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function maskValue(value) {
  return value == null ? '' : String(value).slice(0, 500);
}

function recentResourceFailures(options) {
  return (Array.isArray(options.diagnosticEvents) ? options.diagnosticEvents : [])
    .filter((event) => event?.type === 'requestfailed')
    .slice(-10)
    .map((event) => ({
      url: maskValue(event.text),
      failure: maskValue(event.failure),
      timestamp: event.timestamp || '',
    }));
}
