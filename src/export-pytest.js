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
  const outputPath = config.output || path.resolve(process.cwd(), config.artifactDir, 'exports', `test_case_${config.caseId}_${timestampForPath()}.py`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, await renderPytest(testCase, config), 'utf8');
  console.log(`[export] pytest case=${config.caseId} output=${outputPath}`);
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

async function renderPytest(testCase, config) {
  const preparedSteps = await Promise.all(testCase.steps.map(prepareStepForExport));
  const bodyLines = [
    `api_base = os.environ.get("CUECAST_API_BASE") or ${quotePy(config.apiBase)}`,
    `start_url = os.environ.get("CUECAST_START_URL") or ${quotePy(testCase.start_url)}`,
    `storage_state = os.environ.get("CUECAST_STORAGE_STATE") or ${quotePy(config.storageState)}`,
    'context = browser.new_context(storage_state=storage_state) if storage_state else browser.new_context()',
    'page = context.new_page()',
    'try:',
    '    cuecast_pages = [page]',
    '    network_events = []',
    '',
    '    def attach_network_recorder(target_page):',
    '        target_page.on("request", lambda request: network_events.append(cuecast_request_event(request)))',
    '',
    '    attach_network_recorder(page)',
    '    page.goto(start_url)',
  ];
  for (const prepared of preparedSteps) {
    const step = prepared.step;
    bodyLines.push('', `    # step ${step.step_index}: ${escapeComment(step.description || step.action_type)}`);
    bodyLines.push(...renderStep(prepared));
  }
  bodyLines.push('finally:', '    context.close()');

  const lines = [
    'import hashlib',
    'import json',
    'import os',
    'import re',
    'import time',
    'from playwright.sync_api import expect',
    '',
    '',
    `def test_cuecast_case_${safeIdentifier(testCase.id)}(browser):`,
    `    """CueCast case ${escapeDoc(testCase.id)}: ${escapeDoc(testCase.name || '')}"""`,
    ...bodyLines.map((line) => (line ? `    ${line}` : '')),
  ];
  lines.push('', `# Generated from ${quotePy(config.apiBase)} at ${formatPlatformDateTime()}.`, '');
  lines.push(...PYTEST_HELPERS);
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
    return [`    # TODO: unsupported locator metadata for action ${quotePy(action)}.`];
  }
  switch (action) {
    case 'navigate':
      return [`    page.goto(${quotePy(String(value || step.url || ''))})`];
    case 'click':
      return [`    ${locator}.click()`];
    case 'double_click':
      return [`    ${locator}.dblclick()`];
    case 'right_click':
      return [`    ${locator}.click(button="right")`];
    case 'input':
      return [`    ${locator}.fill(${quotePy(String(value ?? ''))})`];
    case 'key':
      return locator ? [`    ${locator}.press(${quotePy(String(value || 'Enter'))})`] : [`    page.keyboard.press(${quotePy(String(value || 'Enter'))})`];
    case 'hover':
      return [`    ${locator}.hover()`];
    case 'assert_text':
      return locator
        ? [`    expect(${locator}).to_contain_text(${quotePy(String(value ?? ''))})`]
        : [`    expect(page.locator("body")).to_contain_text(${quotePy(String(value ?? ''))})`];
    case 'file_upload':
      return renderFileUpload(locator, value);
    case 'assert_download':
      return [`    cuecast_assert_download(page, ${locator}, ${pyValue(parseJsonLoose(value))})`];
    case 'assert_json':
      return renderAssertJson(step, locator, suffix);
    case 'assert_request':
      return locator
        ? [
          `    with page.expect_request(lambda request: cuecast_request_matches(request, ${pyValue(parseJsonLoose(value))})) as request_info:`,
          `        ${locator}.click()`,
          '    request_info.value',
        ]
        : [`    page.wait_for_request(lambda request: cuecast_request_matches(request, ${pyValue(parseJsonLoose(value))}))`];
    case 'assert_response':
      return locator
        ? [
          `    cuecast_assert_response(page, ${pyValue(parseJsonLoose(value))}, lambda: ${locator}.click())`,
        ]
        : [`    cuecast_assert_response(page, ${pyValue(parseJsonLoose(value))})`];
    case 'assert_request_count':
      return [`    cuecast_assert_request_count(network_events, ${pyValue(parseJsonLoose(value))})`];
    case 'network_mock':
      return [`    cuecast_register_network_mock(page, ${pyValue(parseJsonLoose(value))})`];
    case 'network_replay':
      return [`    cuecast_register_network_replay(page, ${pyValue(prepared.replayEntries || [])})`];
    case 'switch_page':
      return [`    page = cuecast_switch_page(page, cuecast_pages, ${pyValue(parseJsonLoose(value))})`];
    case 'close_page':
      return [`    page = cuecast_close_page(page, cuecast_pages, ${pyValue(parseJsonLoose(value))})`];
    case 'click_open_page':
      return [
        '    with page.expect_popup() as popup_info:',
        `        ${locator}.click()`,
        '    page = popup_info.value',
        '    page.wait_for_load_state("domcontentloaded")',
        '    cuecast_track_page(cuecast_pages, page)',
        '    attach_network_recorder(page)',
      ];
    default:
      return [`    # TODO: action ${quotePy(action)} requires custom export handling.`];
  }
}

function renderAssertJson(step, locator, suffix) {
  const config = parseJsonLoose(step.value);
  const expected = config && typeof config === 'object' && Object.hasOwn(config, 'expected') ? config.expected : config;
  if (locator) {
    return [
      `    json_text_${suffix} = ${locator}.text_content() or "{}"`,
      `    actual_json_${suffix} = json.loads(json_text_${suffix})`,
      `    assert cuecast_json_contains(actual_json_${suffix}, ${pyValue(expected)})`,
    ];
  }
  return [
    `    actual_json_${suffix} = cuecast_fetch_json(page, api_base, ${pyValue(config)})`,
    `    assert cuecast_json_contains(actual_json_${suffix}, ${pyValue(expected)})`,
  ];
}

function renderFileUpload(locator, rawValue) {
  const config = parseFileUploadConfig(rawValue);
  if (config.inputSelector) {
    return [`    page.locator(${quotePy(config.inputSelector)}).set_input_files(${pyValue(config.files)})`];
  }
  return [`    ${locator}.set_input_files(${pyValue(config.files)})`];
}

function renderLocator(step) {
  const meta = parseMeta(step.locator_meta);
  const context = meta?.context || {};
  const root = renderRoot(context);
  const locator = renderLocatorFromMeta(meta, root);
  if (locator) return locator;

  const selector = String(step.target_selector || '').trim();
  if (selector) return `${root}.locator(${quotePy(selector)})`;
  const xpath = String(step.target_xpath || '').trim();
  if (xpath) return `${root}.locator(${quotePy(`xpath=${xpath}`)})`;
  return '';
}

function renderRoot(context) {
  const frame = context?.frame || context?.iframe;
  const selector = String(frame?.selector || frame?.target_selector || frame?.css || '').trim();
  return selector ? `page.frame_locator(${quotePy(selector)})` : 'page';
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
      return `${root}.locator(${quotePy(treeSelector)}).first.locator(${quotePy(itemSelector)}).filter(has_text=${quotePy(value)})`;
    }
    if (type === 'table_cell_css' || type === 'table_cell_xpath') {
      const table = context.table || candidate.context?.table || {};
      const wrapper = tableWrapperSelector(table);
      const rowIndex = Number(table.row_index ?? table.rowIndex ?? 0) || 0;
      const colIndex = Number(table.col_index ?? table.colIndex ?? 0) || 0;
      const wrapperIndex = Number(table.wrapper_index ?? table.wrapperIndex ?? 0) || 0;
      const cell = `${root}.locator(${quotePy(wrapper)}).nth(${wrapperIndex}).locator(${quotePy('tbody tr, .el-table__body tbody tr, .ant-table-tbody tr, .ivu-table-tbody tr')}).nth(${rowIndex}).locator(${quotePy('td, th, .el-table__cell, .ant-table-cell, .ivu-table-cell')}).nth(${colIndex})`;
      return type === 'table_cell_xpath' ? `${cell}.locator(${quotePy(`xpath=${value}`)})` : `${cell}.locator(${quotePy(value)})`;
    }
    if (type === 'text_exact') return `${root}.get_by_text(${quotePy(value)}, exact=True)`;
    if (type === 'text_exact_tag') {
      const { tag, text } = parseTextTagValue(value);
      if (tag && text) return `${root}.locator(${quotePy(tag)}).filter(has_text=${quotePy(text)})`;
    }
    if (type.startsWith('css_')) return `${root}.locator(${quotePy(value)})`;
    if (type === 'xpath_fallback') return `${root}.locator(${quotePy(`xpath=${value}`)})`;
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

function safeIdentifier(value) {
  return String(value ?? 'unknown').replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function quotePy(value) {
  return JSON.stringify(String(value ?? ''));
}

function pyValue(value) {
  if (value == null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return quotePy(value);
  if (Array.isArray(value)) return `[${value.map(pyValue).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${quotePy(key)}: ${pyValue(item)}`).join(', ')}}`;
  }
  return quotePy(String(value));
}

function escapeComment(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').slice(0, 300);
}

function escapeDoc(value) {
  return String(value ?? '').replace(/"""/g, '\\"\\"\\"').replace(/\r?\n/g, ' ');
}

const PYTEST_HELPERS = [
  'def cuecast_track_page(pages, target_page):',
  '    if target_page and target_page not in pages:',
  '        pages.append(target_page)',
  '    return target_page',
  '',
  '',
  'def cuecast_open_pages(pages):',
  '    return [candidate for candidate in pages if candidate and not candidate.is_closed()]',
  '',
  '',
  'def cuecast_switch_page(current_page, pages, raw_config):',
  '    config = cuecast_page_config(raw_config)',
  '    target_page = cuecast_select_page(current_page, cuecast_open_pages(pages), config)',
  '    try:',
  '        target_page.bring_to_front()',
  '    except Exception:',
  '        pass',
  '    try:',
  '        target_page.wait_for_load_state("domcontentloaded")',
  '    except Exception:',
  '        pass',
  '    return target_page',
  '',
  '',
  'def cuecast_close_page(current_page, pages, raw_config):',
  '    config = cuecast_page_config(raw_config)',
  '    open_pages = cuecast_open_pages(pages)',
  '    target_page = cuecast_select_page(current_page, open_pages, config)',
  '    if len(open_pages) <= 1:',
  '        raise AssertionError("close_page requires at least one remaining page")',
  '    closed_current = target_page == current_page',
  '    target_page.close(run_before_unload=False)',
  '    pages[:] = cuecast_open_pages(pages)',
  '    fallback = config.get("fallback") or config.get("fallbackTarget") or config.get("fallback_target") or ("main" if closed_current else "current")',
  '    return cuecast_select_page(current_page, cuecast_open_pages(pages), cuecast_page_config(fallback), {"default_to_first": True})',
  '',
  '',
  'def cuecast_page_config(raw_value):',
  '    if isinstance(raw_value, dict):',
  '        return raw_value',
  '    value = str(raw_value or "").strip()',
  '    if not value:',
  '        return {}',
  '    try:',
  '        parsed = json.loads(value)',
  '        return parsed if isinstance(parsed, dict) else {"target": str(parsed or "")}',
  '    except Exception:',
  '        return {"target": value}',
  '',
  '',
  'def cuecast_select_page(current_page, pages, config, behavior=None):',
  '    behavior = behavior or {}',
  '    if not pages:',
  '        raise AssertionError("No open pages are available")',
  '    target = str(config.get("target") or config.get("page") or config.get("window") or "").strip()',
  '    target_lower = target.lower()',
  '    main_page = pages[0]',
  '    if target_lower in ["main", "original", "root", "first"]:',
  '        return main_page',
  '    if target_lower in ["current", "active"]:',
  '        return current_page if current_page and not current_page.is_closed() else main_page',
  '    if target_lower in ["latest", "last"]:',
  '        return pages[-1]',
  '    if target_lower in ["popup", "new"]:',
  '        return next((candidate for candidate in reversed(pages) if candidate != main_page), pages[-1])',
  '    index = cuecast_page_index(config)',
  '    if index is not None:',
  '        if index < len(pages):',
  '            return pages[index]',
  '        raise AssertionError(f"Page index {index} was not found")',
  '    matched = [candidate for candidate in pages if cuecast_page_matches(candidate, config, target)]',
  '    if matched:',
  '        return matched[-1]',
  '    if not target and not cuecast_has_page_matcher(config):',
  '        return current_page if current_page and not current_page.is_closed() else main_page',
  '    if behavior.get("default_to_first"):',
  '        return main_page',
  '    raise AssertionError(f"No open page matched {target or config}")',
  '',
  '',
  'def cuecast_page_index(config):',
  '    raw = config.get("index") if config.get("index") is not None else config.get("pageIndex") if config.get("pageIndex") is not None else config.get("page_index")',
  '    if raw is None or raw == "":',
  '        return None',
  '    try:',
  '        index = int(raw)',
  '    except Exception:',
  '        return None',
  '    return index if index >= 0 else None',
  '',
  '',
  'def cuecast_page_matches(page, config, plain_target):',
  '    url = page.url',
  '    try:',
  '        title = page.title()',
  '    except Exception:',
  '        title = ""',
  '    url_exact = cuecast_first_string(config.get("urlExact"), config.get("url_exact"))',
  '    url_expected = cuecast_first_string(config.get("urlContains"), config.get("url_contains"), config.get("url"), config.get("pattern"), config.get("urlPattern"), config.get("url_pattern"))',
  '    title_exact = cuecast_first_string(config.get("titleExact"), config.get("title_exact"))',
  '    title_expected = cuecast_first_string(config.get("titleContains"), config.get("title_contains"), config.get("title"), config.get("name"))',
  '    if url_exact and url != url_exact:',
  '        return False',
  '    if url_expected and not cuecast_url_matches(url, url_expected):',
  '        return False',
  '    if title_exact and title != title_exact:',
  '        return False',
  '    if title_expected and not cuecast_text_matches(title, title_expected):',
  '        return False',
  '    if url_exact or url_expected or title_exact or title_expected:',
  '        return True',
  '    value = str(plain_target or "").strip()',
  '    return bool(value) and (cuecast_url_matches(url, value) or cuecast_text_matches(title, value))',
  '',
  '',
  'def cuecast_has_page_matcher(config):',
  '    return cuecast_page_index(config) is not None or bool(cuecast_first_string(config.get("urlExact"), config.get("url_exact"), config.get("urlContains"), config.get("url_contains"), config.get("url"), config.get("pattern"), config.get("urlPattern"), config.get("url_pattern"), config.get("titleExact"), config.get("title_exact"), config.get("titleContains"), config.get("title_contains"), config.get("title"), config.get("name")))',
  '',
  '',
  'def cuecast_first_string(*values):',
  '    for value in values:',
  '        text = str(value or "").strip()',
  '        if text:',
  '            return text',
  '    return ""',
  '',
  '',
  'def cuecast_text_matches(actual, expected):',
  '    value = str(expected or "")',
  '    if not value:',
  '        return True',
  '    if "*" in value:',
  '        return re.match("^" + ".*".join(re.escape(part) for part in value.split("*")) + "$", actual or "") is not None',
  '    return value in (actual or "")',
  '',
  '',
  'def cuecast_request_event(request):',
  '    return {',
  '        "url": request.url,',
  '        "method": request.method,',
  '        "post_data": request.post_data or "",',
  '        "headers": request.headers,',
  '    }',
  '',
  '',
  'def cuecast_url_matches(actual, expected):',
  '    value = str(expected or "")',
  '    if not value:',
  '        return True',
  '    if "*" in value:',
  '        return re.match("^" + ".*".join(re.escape(part) for part in value.split("*")) + "$", actual or "") is not None',
  '    return value in (actual or "")',
  '',
  '',
  'def cuecast_request_matches(request, config):',
  '    url = config.get("url") or config.get("pattern") or ""',
  '    if not cuecast_url_matches(request.url, url):',
  '        return False',
  '    if config.get("method") and request.method.upper() != str(config.get("method")).upper():',
  '        return False',
  '    body_part = config.get("postDataContains") or config.get("post_data_contains") or ""',
  '    if body_part and body_part not in (request.post_data or ""):',
  '        return False',
  '    for key, value in (config.get("headers") or {}).items():',
  '        if str(request.headers.get(str(key).lower(), "")) != str(value):',
  '            return False',
  '    return True',
  '',
  '',
  'def cuecast_response_matches(response, config):',
  '    url = config.get("url") or config.get("pattern") or ""',
  '    if not cuecast_url_matches(response.url, url):',
  '        return False',
  '    if config.get("method") and response.request.method.upper() != str(config.get("method")).upper():',
  '        return False',
  '    if config.get("status") is not None and response.status != int(config.get("status")):',
  '        return False',
  '    return True',
  '',
  '',
  'def cuecast_assert_response(page, config, trigger=None):',
  '    with page.expect_response(lambda response: cuecast_response_matches(response, config)) as response_info:',
  '        if trigger:',
  '            trigger()',
  '    response = response_info.value',
  '    needs_body = any(config.get(key) for key in ["textContains", "text_contains", "bodyContains", "body_contains", "snapshot", "snapshotName", "snapshot_name", "baselinePath", "baseline_path", "baseline"]) or config.get("json") is not None or config.get("expected") is not None',
  '    body = response.text() if needs_body else ""',
  '    text_contains = config.get("textContains") or config.get("text_contains") or config.get("bodyContains") or config.get("body_contains") or ""',
  '    if text_contains:',
  '        assert text_contains in body',
  '    expected_json = config.get("json") if config.get("json") is not None else config.get("expected")',
  '    if expected_json is not None:',
  '        assert cuecast_json_contains(json.loads(body), expected_json)',
  '    if config.get("baselinePath") or config.get("baseline_path") or config.get("baseline"):',
  '        cuecast_assert_response_baseline(response, config, body)',
  '    if config.get("snapshot") or config.get("snapshotName") or config.get("snapshot_name"):',
  '        cuecast_save_response_snapshot(response, config, body)',
  '    return response',
  '',
  '',
  'def cuecast_assert_request_count(events, config):',
  '    matched = [event for event in events if cuecast_request_event_matches(event, config)]',
  '    count = len(matched)',
  '    if config.get("count") is not None:',
  '        assert count == int(config.get("count"))',
  '    if config.get("min") is not None:',
  '        assert count >= int(config.get("min"))',
  '    if config.get("max") is not None:',
  '        assert count <= int(config.get("max"))',
  '',
  '',
  'def cuecast_request_event_matches(event, config):',
  '    url = config.get("url") or config.get("pattern") or ""',
  '    if not cuecast_url_matches(event.get("url"), url):',
  '        return False',
  '    if config.get("method") and str(event.get("method", "")).upper() != str(config.get("method")).upper():',
  '        return False',
  '    body_part = config.get("postDataContains") or config.get("post_data_contains") or ""',
  '    if body_part and body_part not in str(event.get("post_data") or ""):',
  '        return False',
  '    for key, value in (config.get("headers") or {}).items():',
  '        if str((event.get("headers") or {}).get(str(key).lower(), "")) != str(value):',
  '            return False',
  '    return True',
  '',
  '',
  'def cuecast_register_network_mock(page, config):',
  '    page.route(config.get("url") or config.get("pattern"), lambda route: cuecast_fulfill_or_abort_route(route, config))',
  '',
  '',
  'def cuecast_register_network_replay(page, entries):',
  '    for entry in entries:',
  '        page.route(entry.get("url") or entry.get("pattern"), lambda route, entry=entry: cuecast_fulfill_or_abort_route(route, entry))',
  '',
  '',
  'def cuecast_fulfill_or_abort_route(route, config):',
  '    if config.get("method") and route.request.method.upper() != str(config.get("method")).upper():',
  '        route.fallback()',
  '        return',
  '    delay_ms = int(config.get("delayMs") or config.get("delay_ms") or 0)',
  '    if delay_ms > 0:',
  '        time.sleep(delay_ms / 1000)',
  '    if config.get("abort"):',
  '        route.abort(error_code=str(config.get("abort")))',
  '        return',
  '    if "json" in config:',
  '        route.fulfill(status=int(config.get("status") or 200), headers=config.get("headers") or {}, content_type="application/json", body=json.dumps(config.get("json")))',
  '    else:',
  '        route.fulfill(status=int(config.get("status") or 200), headers=config.get("headers") or {}, content_type=config.get("contentType") or config.get("content_type") or "text/plain", body=str(config.get("body") or ""))',
  '',
  '',
  'def cuecast_fetch_json(page, api_base, config):',
  '    raw_url = config.get("url") or config.get("path") or ""',
  '    url = raw_url if str(raw_url).startswith("http") else api_base.rstrip("/") + (raw_url if str(raw_url).startswith("/") else "/" + str(raw_url))',
  '    kwargs = {"method": str(config.get("method") or "GET").upper(), "headers": config.get("headers") or {}}',
  '    if "body" in config or "json" in config:',
  '        kwargs["data"] = config.get("json") if "json" in config else config.get("body")',
  '    response = page.request.fetch(url, **kwargs)',
  '    assert response.ok',
  '    return response.json()',
  '',
  '',
  'def cuecast_assert_download(page, locator, config):',
  '    expected = cuecast_download_expected(config)',
  '    with page.expect_download() as download_info:',
  '        locator.click()',
  '    download = download_info.value',
  '    filename = download.suggested_filename',
  '    if expected.get("filename"):',
  '        assert expected["filename"] in filename',
  '    download_dir = os.path.join(os.getcwd(), "test-results", "cuecast-downloads")',
  '    os.makedirs(download_dir, exist_ok=True)',
  '    save_path = os.path.join(download_dir, cuecast_sanitize_filename(filename or "download"))',
  '    download.save_as(save_path)',
  '    size = os.path.getsize(save_path)',
  '    if expected.get("minBytes") is not None:',
  '        assert size >= int(expected["minBytes"])',
  '    if expected.get("maxBytes") is not None:',
  '        assert size <= int(expected["maxBytes"])',
  '    if expected.get("mime"):',
  '        assert expected["mime"].lower() in cuecast_guess_mime_type(save_path).lower()',
  '    if expected.get("contains"):',
  '        with open(save_path, "r", encoding="utf-8") as handle:',
  '            assert expected["contains"] in handle.read()',
  '    if expected.get("sha256"):',
  '        assert cuecast_file_sha256(save_path) == expected["sha256"].lower()',
  '',
  '',
  'def cuecast_download_expected(config):',
  '    if isinstance(config, str):',
  '        return {"filename": config}',
  '    return {',
  '        "filename": str(config.get("filename") or config.get("name") or ""),',
  '        "contains": str(config.get("contains") or config.get("text") or ""),',
  '        "mime": str(config.get("mime") or config.get("contentType") or config.get("content_type") or ""),',
  '        "minBytes": config.get("minBytes") if config.get("minBytes") is not None else config.get("min_bytes"),',
  '        "maxBytes": config.get("maxBytes") if config.get("maxBytes") is not None else config.get("max_bytes"),',
  '        "sha256": str(config.get("sha256") or "").lower(),',
  '    }',
  '',
  '',
  'def cuecast_assert_response_baseline(response, config, body):',
  '    baseline_path = os.path.abspath(config.get("baselinePath") or config.get("baseline_path") or config.get("baseline"))',
  '    with open(baseline_path, "r", encoding="utf-8") as handle:',
  '        expected_text = handle.read()',
  '    mode = str(config.get("baselineMode") or config.get("baseline_mode") or "exact").lower()',
  '    if mode == "text":',
  '        assert body.replace("\\r\\n", "\\n").rstrip() == expected_text.replace("\\r\\n", "\\n").rstrip()',
  '        return',
  '    expected = json.loads(expected_text)',
  '    actual = json.loads(body)',
  '    if mode == "subset":',
  '        assert cuecast_json_contains(actual, expected)',
  '    else:',
  '        assert json.dumps(actual, sort_keys=True, separators=(",", ":")) == json.dumps(expected, sort_keys=True, separators=(",", ":"))',
  '',
  '',
  'def cuecast_save_response_snapshot(response, config, body):',
  '    name = cuecast_sanitize_filename(config.get("snapshotName") or config.get("snapshot_name") or "response")',
  '    snapshot_dir = os.path.join(os.getcwd(), "test-results", "cuecast-response-snapshots")',
  '    os.makedirs(snapshot_dir, exist_ok=True)',
  '    content_type = str(response.headers.get("content-type", "")).lower()',
  '    ext = "json" if "json" in content_type else "txt"',
  '    body_path = os.path.join(snapshot_dir, f"{name}.{ext}")',
  '    with open(body_path, "w", encoding="utf-8") as handle:',
  '        handle.write(body)',
  '    with open(os.path.join(snapshot_dir, f"{name}.meta.json"), "w", encoding="utf-8") as handle:',
  '        json.dump({"url": response.url, "status": response.status, "method": response.request.method, "headers": response.headers, "body_path": body_path}, handle, indent=2)',
  '',
  '',
  'def cuecast_json_contains(actual, expected):',
  '    if expected is None:',
  '        return True',
  '    if not isinstance(expected, (dict, list)):',
  '        return actual == expected',
  '    if isinstance(expected, list):',
  '        if not isinstance(actual, list) or len(expected) > len(actual):',
  '            return False',
  '        return all(cuecast_json_contains(actual[index], item) for index, item in enumerate(expected))',
  '    if not isinstance(actual, dict):',
  '        return False',
  '    return all(key in actual and cuecast_json_contains(actual[key], value) for key, value in expected.items())',
  '',
  '',
  'def cuecast_guess_mime_type(file_path):',
  '    ext = os.path.splitext(file_path)[1].lower()',
  '    return {',
  '        ".txt": "text/plain",',
  '        ".json": "application/json",',
  '        ".csv": "text/csv",',
  '        ".html": "text/html",',
  '        ".htm": "text/html",',
  '        ".png": "image/png",',
  '        ".jpg": "image/jpeg",',
  '        ".jpeg": "image/jpeg",',
  '        ".pdf": "application/pdf",',
  '    }.get(ext, "application/octet-stream")',
  '',
  '',
  'def cuecast_file_sha256(file_path):',
  '    digest = hashlib.sha256()',
  '    with open(file_path, "rb") as handle:',
  '        digest.update(handle.read())',
  '    return digest.hexdigest()',
  '',
  '',
  'def cuecast_sanitize_filename(value):',
  '    return re.sub(r\'[<>:"/\\\\|?*\\x00-\\x1F]\', "_", str(value or "download.txt"))[:180]',
];

main().catch((error) => {
  console.error(`[export] ${error?.message || error}`);
  process.exitCode = 1;
});
