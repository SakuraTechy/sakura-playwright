import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSteps } from '../../src/runner/case-loader.js';

test('duplicate source step ids receive stable unique execution ids', () => {
  const steps = normalizeSteps([
    { id: 1, step_index: 0, action_type: 'click' },
    { id: 2, step_index: 1, action_type: 'input' },
    { id: 1, step_index: 4, action_type: 'click' },
  ]);

  assert.deepEqual(steps.map((step) => step.id), [1, 2, '1__4']);
  assert.equal(steps[2].original_step_id, 1);
});

test('partial execution keeps the same unique id generated from the full case', () => {
  const steps = normalizeSteps([
    { id: 1, step_index: 0, action_type: 'click' },
    { id: 1, step_index: 4, action_type: 'click' },
  ], 1);

  assert.equal(steps[0].id, '1__4');
  assert.equal(steps[0].original_step_id, 1);
});

test('admin execution id keeps the original recorded id for result tracing', () => {
  const steps = normalizeSteps([
    { id: 'CASE_STEP_005', original_step_id: 1, step_index: 4, action_type: 'click' },
  ]);

  assert.equal(steps[0].id, 'CASE_STEP_005');
  assert.equal(steps[0].original_step_id, 1);
});
