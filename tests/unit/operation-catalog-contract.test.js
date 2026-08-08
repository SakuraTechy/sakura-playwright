import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { getPlaywrightCapabilities } from '../../src/runner/action-registry.js';

const fixturePath = new URL(
  '../../../sakura-admin/continew-automation/src/test/resources/automation/automation-operation-63-fixture.json',
  import.meta.url,
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('Playwright capability registry covers every canonical action in the 63-method fixture', () => {
  assert.equal(fixture.catalog_version, '2026-08-07.1');
  assert.equal(fixture.methods.length, 63);
  const capabilities = getPlaywrightCapabilities({
    executorInstanceId: 'fixture-runner',
    projectEnvironmentId: 'fixture-environment',
  });
  const supportedActions = new Set(capabilities.actions);
  const missing = [...new Set(fixture.methods.map((method) => method.action_type))]
    .filter((actionType) => !supportedActions.has(actionType));
  assert.deepEqual(missing, []);
});
