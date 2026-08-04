import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageInfo = require('../../package.json');
const configuredCatalogVersion = String(process.env.AUTOMATION_OPERATION_CATALOG_VERSION || '').trim();
const configuredRunnerVersion = String(process.env.PLAYWRIGHT_RUNNER_VERSION || '').trim();

// 与 Admin automation-operation-catalog.json 保持一致；目录版本不一致时 Admin 会拒绝覆盖能力快照。
export const OPERATION_CATALOG_VERSION = configuredCatalogVersion || '2026-07-30.1';
export const PLAYWRIGHT_RUNNER_VERSION = configuredRunnerVersion || String(packageInfo.version || '').trim() || 'unknown';

/**
 * Runner 实际可调度的 canonical action 清单。
 * browser 类型由官方 Playwright API 直接执行，admin-infrastructure 类型由 Runner 以冻结步骤身份
 * 委派给 Admin/Agent；两者都属于 Runner 的可执行能力，不能只按前端目录声明推断。
 */
export const PLAYWRIGHT_ACTION_REGISTRY = Object.freeze([
  { actionType: 'navigate', execution: 'browser' },
  { actionType: 'click', execution: 'browser' },
  { actionType: 'click_open_page', execution: 'browser' },
  { actionType: 'switch_page', execution: 'browser' },
  { actionType: 'close_page', execution: 'browser' },
  { actionType: 'close_all_pages', execution: 'browser' },
  { actionType: 'reload', execution: 'browser' },
  { actionType: 'captcha_ocr', execution: 'browser' },
  { actionType: 'frame_switch', execution: 'browser' },
  { actionType: 'frame_parent', execution: 'browser' },
  { actionType: 'frame_main', execution: 'browser' },
  { actionType: 'evaluate', execution: 'browser' },
  { actionType: 'double_click', execution: 'browser' },
  { actionType: 'right_click', execution: 'browser' },
  { actionType: 'select_option', execution: 'browser' },
  { actionType: 'combo_select', execution: 'browser' },
  { actionType: 'dialog_accept', execution: 'browser' },
  { actionType: 'dialog_dismiss', execution: 'browser' },
  { actionType: 'dialog_prompt', execution: 'browser' },
  { actionType: 'input', execution: 'browser' },
  { actionType: 'input_date', execution: 'browser' },
  { actionType: 'file_upload', execution: 'browser' },
  { actionType: 'certificate_upload', execution: 'browser' },
  { actionType: 'clear', execution: 'browser' },
  { actionType: 'assert_download', execution: 'browser' },
  { actionType: 'assert_json', execution: 'browser' },
  { actionType: 'assert_request', execution: 'browser' },
  { actionType: 'assert_response', execution: 'browser' },
  { actionType: 'assert_request_count', execution: 'browser' },
  { actionType: 'network_mock', execution: 'browser' },
  { actionType: 'network_replay', execution: 'browser' },
  { actionType: 'key', execution: 'browser' },
  { actionType: 'hover', execution: 'browser' },
  { actionType: 'wait', execution: 'browser' },
  { actionType: 'scroll', execution: 'browser' },
  { actionType: 'scroll_to_element', execution: 'browser' },
  { actionType: 'assert_text', execution: 'browser' },
  { actionType: 'assert_text_not', execution: 'browser' },
  { actionType: 'assert_attribute', execution: 'browser' },
  { actionType: 'assert_script', execution: 'browser' },
  { actionType: 'assert_text_regex', execution: 'browser' },
  { actionType: 'implicit_wait', execution: 'browser' },
  { actionType: 'pointer_move', execution: 'browser' },
  { actionType: 'global_variable_set', execution: 'runner-local' },
  { actionType: 'global_variable_date', execution: 'runner-local' },
  { actionType: 'global_variable_formula', execution: 'runner-local' },
  { actionType: 'assert_variable_list', execution: 'runner-local' },
  { actionType: 'assert_variable_list_not', execution: 'runner-local' },
  { actionType: 'assert_database_value', execution: 'runner-local' },
  { actionType: 'server_command', execution: 'admin-infrastructure' },
  { actionType: 'database_sql', execution: 'admin-infrastructure' },
  { actionType: 'database_native', execution: 'admin-infrastructure' },
  { actionType: 'host_command', execution: 'admin-infrastructure' },
  { actionType: 'host_file_lookup', execution: 'admin-infrastructure' },
  { actionType: 'host_file_delete', execution: 'admin-infrastructure' },
  { actionType: 'host_pointer_move', execution: 'admin-infrastructure' },
  { actionType: 'server_file_upload', execution: 'admin-infrastructure' },
  { actionType: 'global_variable_system_info', execution: 'admin-infrastructure' },
  { actionType: 'global_variable_available_ip', execution: 'admin-infrastructure' },
  { actionType: 'global_variable_property', execution: 'admin-infrastructure' },
].map((entry) => Object.freeze(entry)));

export const PLAYWRIGHT_ACTION_TYPES = new Set(
  PLAYWRIGHT_ACTION_REGISTRY.map((entry) => entry.actionType),
);

export function normalizeActionType(actionType) {
  return String(actionType || '').trim().toLowerCase();
}

export function isPlaywrightActionSupported(actionType) {
  return PLAYWRIGHT_ACTION_TYPES.has(normalizeActionType(actionType));
}

/**
 * 每次 Runner 启动向 Admin 上报当前二进制真正支持的 action。
 * 返回新对象，调用方不可修改模块内的固定能力清单。
 */
export function getPlaywrightCapabilities({
  executorVersion = PLAYWRIGHT_RUNNER_VERSION,
  catalogVersion = OPERATION_CATALOG_VERSION,
  executorInstanceId = '',
  projectEnvironmentId = '',
  features = ['browser'],
} = {}) {
  return {
    executor: 'playwright',
    executorInstanceId: String(executorInstanceId || '').trim(),
    executorVersion: String(executorVersion || PLAYWRIGHT_RUNNER_VERSION).trim(),
    catalogVersion: String(catalogVersion || OPERATION_CATALOG_VERSION).trim(),
    projectEnvironmentId: String(projectEnvironmentId || '').trim(),
    actions: [...PLAYWRIGHT_ACTION_TYPES],
    features: [...features],
  };
}
