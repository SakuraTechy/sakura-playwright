import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserActionContext, runStep } from '../../src/runner/step-runner.js';

const testCase = { id: 'SCENE:CASE', start_url: 'http://example.test/' };
const stepOptions = (browserContext, extra = {}) => ({
  browserContext,
  timeoutMs: 1200,
  afterStepDelayMs: 0,
  ...extra,
});

test('browser context applies implicit timeout, browser evaluation and relative pointer movement', async () => {
  const page = new FakePage();
  const browserContext = createBrowserActionContext({ defaultTimeoutMs: 1200 });

  const implicit = await runStep(page, testCase, {
    id: 'WAIT', step_index: 0, action_type: 'implicit_wait', duration_ms: 2500, source: 'admin-manual',
  }, stepOptions(browserContext));
  assert.equal(implicit.implicit_wait_ms, 2500);
  assert.equal(browserContext.defaultTimeoutMs, 2500);

  await runStep(page, testCase, {
    id: 'MOVE', step_index: 1, action_type: 'pointer_move', x: 12, y: -4,
  }, stepOptions(browserContext));
  assert.deepEqual(page.mouse.moves, [{ x: 12, y: -4, steps: 1 }]);

  const evaluated = await runStep(page, testCase, {
    id: 'EVAL', step_index: 2, action_type: 'evaluate', script: 'return 7;',
  }, stepOptions(browserContext));
  assert.equal(evaluated.evaluated, true);
  assert.equal(evaluated.evaluation_result_type, 'number');

  await runStep(page, testCase, {
    id: 'RELOAD', step_index: 3, action_type: 'reload',
  }, stepOptions(browserContext));
  assert.equal(page.reloadOptions.timeout, 2500);
});

test('canonical input, selection, upload and assertion actions use Playwright primitives', async () => {
  const page = new FakePage({
    '#select': new FakeLocator({ tag: 'select' }),
    '#combo': new FakeLocator({ tag: 'select' }),
    '#clear': new FakeLocator({ tag: 'input' }),
    '#date': new FakeLocator({ tag: 'input' }),
    '#certificate': new FakeLocator({ tag: 'input', attributes: { type: 'file' } }),
    '#text': new FakeLocator({ tag: 'div', text: 'actual result' }),
    '#attribute': new FakeLocator({ tag: 'div', attributes: { title: 'expected title' } }),
    '#regex': new FakeLocator({ tag: 'div', text: 'order-2026' }),
  });
  const browserContext = createBrowserActionContext();

  await runStep(page, testCase, { id: 'SELECT', step_index: 0, action_type: 'select_option', target_selector: '#select', option: 'blue' }, stepOptions(browserContext));
  await runStep(page, testCase, { id: 'COMBO', step_index: 1, action_type: 'combo_select', target_selector: '#combo', value: 'green', option: 'green' }, stepOptions(browserContext));
  await runStep(page, testCase, { id: 'CLEAR', step_index: 2, action_type: 'clear', target_selector: '#clear' }, stepOptions(browserContext));
  const dateResult = await runStep(page, testCase, { id: 'DATE', step_index: 3, action_type: 'input_date', target_selector: '#date', format: 'yyyy' }, stepOptions(browserContext));
  const certificateResult = await runStep(page, testCase, {
    id: 'CERT', step_index: 4, action_type: 'certificate_upload', target_selector: '#certificate', certificate_ref: { path: 'cert.pem' },
  }, stepOptions(browserContext));
  await runStep(page, testCase, { id: 'NOT', step_index: 5, action_type: 'assert_text_not', target_selector: '#text', expect: 'other result' }, stepOptions(browserContext));
  await runStep(page, testCase, { id: 'ATTR', step_index: 6, action_type: 'assert_attribute', target_selector: '#attribute', attribute: 'title', expect: 'expected title' }, stepOptions(browserContext));
  await runStep(page, testCase, { id: 'REGEX', step_index: 7, action_type: 'assert_text_regex', target_selector: '#regex', regex: '^order-\\d{4}$' }, stepOptions(browserContext));
  await runStep(page, testCase, { id: 'SCRIPT', step_index: 8, action_type: 'assert_script', script: "return 'ok';", expect: 'ok' }, stepOptions(browserContext));

  assert.equal(page.locator('#select').selectedOption, 'blue');
  assert.equal(page.locator('#combo').selectedOption, 'green');
  assert.deepEqual(page.locator('#clear').fillCalls, ['']);
  assert.match(dateResult.input_date_value, /^\d{4}$/);
  assert.deepEqual(certificateResult.uploaded_certificate_files, ['cert.pem']);
  assert.equal(certificateResult.filename, 'cert.pem');
  assert.equal(certificateResult.file_count, 1);
  assert.equal(certificateResult.upload_status, '上传控件已设置');
  assert.equal(page.locator('#certificate').inputFiles[0].endsWith('cert.pem'), true);
});

test('legacy locator assertion failure preserves the selected locator', async () => {
  const page = new FakePage({ '#message': new FakeLocator({ tag: 'div', text: '实际内容' }) });
  const browserContext = createBrowserActionContext();

  await assert.rejects(
    runStep(page, testCase, {
      id: 'ASSERT_FAIL',
      step_index: 0,
      action_type: 'assert_text',
      target_selector: '#message',
      expect: '期望内容',
    }, stepOptions(browserContext)),
    (error) => error?.code === 'ASSERTION_FAILED'
      && error.details?.source === 'target_selector'
      && error.details?.locatorType === 'css'
      && error.details?.locatorValue === '#message',
  );
});

test('frame stack, pre-armed dialog and close-all-page actions retain browser-only safety boundaries', async () => {
  const page = new FakePage();
  const childFrame = new FakeFrame('http://example.test/frame', page.mainFrame());
  page.mainFrame().children.push(childFrame);
  page.addLocator('#frame', new FakeLocator({ tag: 'iframe', frame: childFrame }));
  const dialog = new FakeDialog('prompt');
  page.addLocator('#trigger', new FakeLocator({ tag: 'button', onClick: () => page.emitDialog(dialog) }));
  const browserContext = createBrowserActionContext();

  const frameResult = await runStep(page, testCase, {
    id: 'FRAME', step_index: 0, action_type: 'frame_switch', target_selector: '#frame',
  }, stepOptions(browserContext));
  assert.equal(frameResult.frame_depth, 1);
  assert.equal(browserContext.activeFrame, childFrame);

  await runStep(page, testCase, { id: 'PARENT', step_index: 1, action_type: 'frame_parent' }, stepOptions(browserContext));
  assert.equal(browserContext.activeFrame, null);

  await runStep(page, testCase, {
    id: 'TRIGGER', step_index: 2, action_type: 'click', target_selector: '#trigger',
  }, stepOptions(browserContext, { nextStep: { action_type: 'dialog_prompt', value: 'approved' } }));
  const dialogResult = await runStep(page, testCase, {
    id: 'DIALOG', step_index: 3, action_type: 'dialog_prompt', value: 'approved',
  }, stepOptions(browserContext));
  assert.equal(dialogResult.dialog_handled, true);
  assert.equal(dialog.acceptedValue, 'approved');

  const otherPage = new FakePage();
  const closed = await runStep(page, testCase, { id: 'QUIT', step_index: 4, action_type: 'close_all_pages' }, stepOptions(browserContext, {
    getPages: () => [page, otherPage],
  }));
  assert.equal(closed.closed_page_count, 2);
  assert.equal(closed._activePage, null);
  assert.equal(page.closed, true);
  assert.equal(otherPage.closed, true);
});

class FakePage {
  constructor(locatorMap = {}) {
    this.locatorMap = new Map(Object.entries(locatorMap));
    this.closed = false;
    this.events = new Map();
    this.reloadOptions = null;
    this.mouse = {
      moves: [],
      move: async (x, y, options = {}) => this.mouse.moves.push({ x, y, steps: options.steps }),
      wheel: async () => {},
    };
    this.keyboard = {
      press: async () => {},
      insertText: async () => {},
    };
    this.main = new FakeFrame('http://example.test/', null);
  }

  addLocator(selector, locator) {
    this.locatorMap.set(selector, locator);
  }

  locator(selector) {
    const locator = this.locatorMap.get(selector);
    if (!locator) throw new Error(`Unknown selector: ${selector}`);
    return locator;
  }

  async evaluate(pageFunction, argument) {
    return pageFunction(argument);
  }

  async reload(options) {
    this.reloadOptions = options;
  }

  async goto() {}

  isClosed() {
    return this.closed;
  }

  async close() {
    this.closed = true;
  }

  url() {
    return 'http://example.test/';
  }

  mainFrame() {
    return this.main;
  }

  once(event, listener) {
    this.events.set(event, listener);
  }

  off(event, listener) {
    if (this.events.get(event) === listener) this.events.delete(event);
  }

  async emitDialog(dialog) {
    const listener = this.events.get('dialog');
    this.events.delete('dialog');
    if (listener) await listener(dialog);
  }
}

class FakeFrame {
  constructor(url, parent) {
    this.frameUrl = url;
    this.parent = parent;
    this.children = [];
  }

  url() {
    return this.frameUrl;
  }

  parentFrame() {
    return this.parent;
  }

  childFrames() {
    return this.children;
  }

  isDetached() {
    return false;
  }
}

class FakeLocator {
  constructor({ tag, text = '', attributes = {}, frame = null, onClick = null }) {
    this.tag = tag;
    this.text = text;
    this.attributes = attributes;
    this.frame = frame;
    this.onClick = onClick;
    this.fillCalls = [];
    this.inputFiles = [];
    this.selectedOption = null;
  }

  locator() {
    return this;
  }

  first() {
    return this;
  }

  filter() {
    return this;
  }

  nth() {
    return this;
  }

  async count() {
    return 1;
  }

  async isVisible() {
    return true;
  }

  async evaluate(pageFunction, argument) {
    return pageFunction({
      tagName: this.tag.toUpperCase(),
      className: '',
      isContentEditable: false,
      closest: () => null,
      getAttribute: (name) => this.attributes[name] ?? null,
      querySelector: () => null,
    }, argument);
  }

  async click() {
    await this.onClick?.();
  }

  async dblclick() {}

  async fill(value) {
    this.fillCalls.push(value);
  }

  async selectOption(value) {
    this.selectedOption = value;
  }

  async setInputFiles(files) {
    this.inputFiles = files;
  }

  async getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  async textContent() {
    return this.text;
  }

  async hover() {}

  async press() {}

  async scrollIntoViewIfNeeded() {}

  async elementHandle() {
    return {
      contentFrame: async () => this.frame,
      dispose: async () => {},
    };
  }
}

class FakeDialog {
  constructor(type) {
    this.dialogType = type;
    this.acceptedValue = null;
    this.dismissed = false;
  }

  type() {
    return this.dialogType;
  }

  async accept(value) {
    this.acceptedValue = value ?? '';
  }

  async dismiss() {
    this.dismissed = true;
  }
}
