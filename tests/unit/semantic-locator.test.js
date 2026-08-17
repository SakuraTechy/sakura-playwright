import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { CANDIDATE_TYPES } from '../../src/runner/locator-resolver.js';
import { resolvePageErrorCheckEnabled } from '../../src/runner/page-state-diagnostics.js';
import {
  chooseHighConfidenceCandidate,
  scoreSemanticCandidate,
  SEMANTIC_CANDIDATE_TYPES,
} from '../../src/runner/semantic-locator-resolver.js';
import { parseArgs } from '../../src/shared/utils.js';

const locatorContract = JSON.parse(fs.readFileSync(new URL(
  '../../../sakura-cuecast/tests/fixtures/locator-contract-v1.json',
  import.meta.url,
), 'utf8'));

test('semantic-v1 supports every locator type emitted by the recorder', () => {
  const recordedTypes = locatorContract.recorder_candidate_types;
  assert.deepEqual(recordedTypes.filter((type) => !SEMANTIC_CANDIDATE_TYPES.has(type)), []);
  assert.deepEqual(recordedTypes.filter((type) => !CANDIDATE_TYPES.has(type)), []);
});

test('shared locator fixture is supported by both Playwright resolver modes', () => {
  const fixtureTypes = locatorContract.candidates.map((candidate) => candidate.type);

  assert.deepEqual(fixtureTypes.filter((type) => !SEMANTIC_CANDIDATE_TYPES.has(type)), []);
  assert.deepEqual(fixtureTypes.filter((type) => !CANDIDATE_TYPES.has(type)), []);
  assert.equal(locatorContract.candidates.find((candidate) => candidate.type === 'xpath_fallback').value, "(//span[@class='user-title'])[1]");
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
