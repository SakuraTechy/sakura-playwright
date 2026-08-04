import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../../src/api/api-client.js';
import {
  getPlaywrightCapabilities,
  isPlaywrightActionSupported,
  OPERATION_CATALOG_VERSION,
  PLAYWRIGHT_ACTION_TYPES,
} from '../../src/runner/action-registry.js';

test('canonical registry reports every action currently dispatched by the Playwright Runner', () => {
  assert.deepEqual([...PLAYWRIGHT_ACTION_TYPES].sort(), [
    'assert_attribute', 'assert_database_value', 'assert_download', 'assert_json', 'assert_request', 'assert_request_count', 'assert_response',
    'assert_script', 'assert_text', 'assert_text_not', 'assert_text_regex', 'assert_variable_list',
    'assert_variable_list_not', 'captcha_ocr', 'certificate_upload', 'clear', 'click',
    'click_open_page', 'close_all_pages', 'close_page', 'combo_select', 'database_native', 'database_sql',
    'dialog_accept', 'dialog_dismiss', 'dialog_prompt', 'double_click', 'evaluate', 'file_upload', 'frame_main',
    'frame_parent', 'frame_switch', 'global_variable_available_ip', 'global_variable_date',
    'global_variable_formula', 'global_variable_property', 'global_variable_set', 'global_variable_system_info',
    'host_command', 'host_file_delete', 'host_file_lookup', 'host_pointer_move', 'hover', 'implicit_wait', 'input', 'input_date', 'key', 'navigate',
    'network_mock', 'network_replay', 'pointer_move', 'reload', 'right_click', 'scroll', 'scroll_to_element',
    'select_option', 'server_command', 'server_file_upload', 'switch_page', 'wait',
  ]);
  assert.equal(isPlaywrightActionSupported('  ASSERT_TEXT '), true);
  assert.equal(isPlaywrightActionSupported('frame_switch'), true);
  assert.equal(isPlaywrightActionSupported('host_pointer_move'), true);

  const capabilities = getPlaywrightCapabilities();
  assert.equal(capabilities.executor, 'playwright');
  assert.equal(capabilities.catalogVersion, OPERATION_CATALOG_VERSION);
  assert.deepEqual(capabilities.actions, [...PLAYWRIGHT_ACTION_TYPES]);
});

test('capability registration is admin-only and sends the canonical capability payload', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { accepted: true } }),
    };
  };
  try {
    const capabilities = getPlaywrightCapabilities({
      executorVersion: 'test-version',
      executorInstanceId: 'runner-node-1',
      projectEnvironmentId: '47',
      features: ['browser'],
    });
    const adminClient = new ApiClient({
      apiBase: 'http://127.0.0.1:8000',
      adminApi: true,
      token: 'runner-token',
    });
    assert.deepEqual(await adminClient.registerOperationCapabilities(capabilities), { accepted: true });

    const legacyClient = new ApiClient({ apiBase: 'http://127.0.0.1:4173/api' });
    assert.equal(await legacyClient.registerOperationCapabilities(capabilities), null);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://127.0.0.1:8000/automation/operation-catalog/capabilities/playwright');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer runner-token');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      executor_instance_id: capabilities.executorInstanceId,
      executor_version: capabilities.executorVersion,
      catalog_version: capabilities.catalogVersion,
      project_environment_id: capabilities.projectEnvironmentId,
      actions: capabilities.actions,
      features: capabilities.features,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
