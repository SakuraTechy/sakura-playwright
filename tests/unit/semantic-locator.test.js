import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePageErrorCheckEnabled } from '../../src/runner/page-state-diagnostics.js';
import {
  chooseHighConfidenceCandidate,
  scoreSemanticCandidate,
  SEMANTIC_CANDIDATE_TYPES,
} from '../../src/runner/semantic-locator-resolver.js';
import { parseArgs } from '../../src/shared/utils.js';

test('semantic-v1 supports every locator type emitted by the recorder', () => {
  const recordedTypes = [
    'css_attr_data-testid',
    'css_attr_data-test',
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
    'text_exact',
    'text_exact_tag',
  ];
  assert.deepEqual(recordedTypes.filter((type) => !SEMANTIC_CANDIDATE_TYPES.has(type)), []);
});

test('semantic scoring treats exact recorded context as a strong signal', () => {
  const result = scoreSemanticCandidate({
    visible: true,
    controlKind: 'input:text',
    labelText: '用户名',
    containerText: '用户名',
    siblingIndex: 1,
    rowIndex: -1,
    rowText: '',
    rect: null,
    stateClasses: [],
  }, {
    control_kind: 'input:text',
    label_text: '用户名',
    sibling_index: 1,
  });

  assert.equal(result.score >= 251, true);
  assert.deepEqual(result.strongSignals, ['label_exact', 'sibling_index']);
});

test('semantic selection only auto-picks a separated high-confidence target', () => {
  const selected = chooseHighConfidenceCandidate([
    { index: 0, score: 210, strongSignals: ['label_exact'] },
    { index: 1, score: 170, strongSignals: ['sibling_index'] },
  ]);
  assert.equal(selected.selected?.index, 0);
  assert.equal(selected.reason, 'high-confidence');

  const ambiguous = chooseHighConfidenceCandidate([
    { index: 0, score: 210, strongSignals: ['label_exact'] },
    { index: 1, score: 190, strongSignals: ['sibling_index'] },
  ]);
  assert.equal(ambiguous.selected, null);
  assert.equal(ambiguous.reason, 'low-confidence');
});

test('runner keeps legacy by default and parses nullable page error override', () => {
  const legacy = parseArgs(['--case-id', '100:CASE_001', '--admin-api', 'false'], {});
  assert.equal(legacy.locatorMode, 'legacy');
  assert.equal(legacy.pageErrorCheckEnabled, null);

  const semantic = parseArgs([
    '--case-id', '100:CASE_001',
    '--admin-api', 'false',
    '--locator-mode', 'semantic-v1',
    '--page-error-check-enabled', 'false',
  ], {});
  assert.equal(semantic.locatorMode, 'semantic-v1');
  assert.equal(semantic.pageErrorCheckEnabled, false);
  assert.throws(
    () => parseArgs(['--case-id', '1', '--page-error-check-enabled', 'maybe'], {}),
    (error) => error?.code === 'CONFIG_INVALID',
  );
});

test('page error task override has priority over the recorded case value', () => {
  assert.equal(resolvePageErrorCheckEnabled(null, { page_error_check_enabled: 1 }), true);
  assert.equal(resolvePageErrorCheckEnabled(null, { page_error_check_enabled: 0 }), false);
  assert.equal(resolvePageErrorCheckEnabled(false, { page_error_check_enabled: 1 }), false);
  assert.equal(resolvePageErrorCheckEnabled(true, { page_error_check_enabled: 0 }), true);
});
