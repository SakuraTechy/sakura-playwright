const ACTION_PROFILES = Object.freeze({
  navigate: 'navigation',
  switch_page: 'navigation',
  close_page: 'navigation',
  close_all_pages: 'navigation',
  reload: 'navigation',
  frame_switch: 'navigation',
  frame_parent: 'navigation',
  frame_main: 'navigation',
  click: 'element_interaction',
  click_open_page: 'element_interaction',
  double_click: 'element_interaction',
  right_click: 'element_interaction',
  select_option: 'element_interaction',
  combo_select: 'element_interaction',
  input: 'element_interaction',
  input_date: 'element_interaction',
  file_upload: 'element_interaction',
  certificate_upload: 'element_interaction',
  clear: 'element_interaction',
  key: 'element_interaction',
  hover: 'element_interaction',
  scroll: 'element_interaction',
  scroll_to_element: 'element_interaction',
  pointer_move: 'element_interaction',
  dialog_accept: 'dialog',
  dialog_dismiss: 'dialog',
  dialog_prompt: 'dialog',
  assert_text: 'assertion',
  assert_text_not: 'assertion',
  assert_attribute: 'assertion',
  assert_script: 'assertion',
  assert_database_value: 'assertion',
  assert_variable_list: 'assertion',
  assert_variable_list_not: 'assertion',
  assert_text_regex: 'assertion',
  assert_element_match: 'assertion',
  assert_download: 'assertion',
  assert_json: 'assertion',
  assert_request: 'assertion',
  assert_response: 'assertion',
  assert_request_count: 'assertion',
  network_mock: 'assertion',
  network_replay: 'assertion',
  wait: 'wait',
  implicit_wait: 'wait',
  captcha_ocr: 'variable',
  global_variable_set: 'variable',
  global_variable_date: 'variable',
  global_variable_formula: 'variable',
  global_variable_system_info: 'variable',
  global_variable_available_ip: 'variable',
  global_variable_property: 'variable',
  evaluate: 'script',
  server_command: 'infrastructure',
  database_sql: 'infrastructure',
  database_native: 'infrastructure',
  host_command: 'infrastructure',
  host_file_lookup: 'infrastructure',
  host_file_delete: 'infrastructure',
  host_pointer_move: 'infrastructure',
  server_file_upload: 'infrastructure',
});

const ACTION_INPUTS = Object.freeze({
  navigate: ['url'],
  switch_page: ['index', 'value'],
  close_page: ['value'],
  frame_switch: ['target_ref', 'index'],
  click: ['target_ref'],
  click_open_page: ['target_ref'],
  double_click: ['target_ref'],
  right_click: ['target_ref'],
  select_option: ['target_ref', 'option'],
  combo_select: ['target_ref', 'option', 'search'],
  input: ['target_ref', 'value'],
  input_date: ['target_ref', 'format'],
  file_upload: ['target_ref', 'file_ref'],
  certificate_upload: ['target_ref', 'certificate_ref'],
  clear: ['target_ref'],
  key: ['key', 'modifier', 'modifiers'],
  hover: ['target_ref'],
  scroll: ['target_ref', 'x', 'y'],
  scroll_to_element: ['target_ref'],
  pointer_move: ['x', 'y'],
  host_pointer_move: ['x', 'y'],
  dialog_prompt: ['value'],
  assert_text: ['target_ref', 'expect'],
  assert_text_not: ['target_ref', 'expect'],
  assert_attribute: ['target_ref', 'attribute', 'expect'],
  assert_script: ['script', 'expect'],
  assert_database_value: ['variable_name', 'expect'],
  assert_variable_list: ['value', 'expect'],
  assert_variable_list_not: ['value', 'expect'],
  assert_text_regex: ['target_ref', 'regex'],
  assert_element_match: ['target_ref', 'read_mode', 'match_mode', 'expect'],
  assert_download: ['target_ref', 'value'],
  assert_json: ['value', 'expect'],
  assert_request: ['target_ref', 'value'],
  assert_response: ['target_ref', 'value'],
  assert_request_count: ['value'],
  network_mock: ['value'],
  network_replay: ['value'],
  wait: ['duration_ms', 'value'],
  implicit_wait: ['duration_ms', 'value'],
  captcha_ocr: ['target_ref', 'variable_name'],
  global_variable_set: ['variable_name', 'source_type', 'value', 'target_ref', 'read_mode', 'regex', 'regex_group', 'replace_from', 'replace_to'],
  global_variable_date: ['variable_name', 'date_mode', 'format', 'datetime', 'offset_seconds', 'timestamp_unit'],
  global_variable_formula: ['variable_name', 'expression', 'scale', 'keep_trailing_zeros'],
  global_variable_system_info: ['variable_name', 'info_type'],
  global_variable_available_ip: ['variable_name', 'ip_prefix', 'start', 'end', 'timeout_ms'],
  global_variable_property: ['variable_name', 'profile', 'property_key'],
  evaluate: ['script'],
  server_command: ['target_ref', 'command'],
  database_sql: ['target_ref', 'sql', 'variable_name'],
  database_native: ['target_ref'],
  host_command: ['command'],
  host_file_lookup: ['path', 'variable_name'],
  host_file_delete: ['path'],
  host_pointer_move: ['x', 'y'],
  server_file_upload: ['target_ref', 'file_ref', 'remote_path'],
});

const ACTION_SUMMARIES = Object.freeze({
  navigate: '页面导航完成',
  switch_page: '窗口切换完成',
  close_page: '标签页关闭完成',
  close_all_pages: '标签页关闭完成',
  reload: '页面刷新完成',
  frame_switch: 'Iframe 切换完成',
  frame_parent: '已返回上一级 Iframe',
  frame_main: '已返回最上级 Iframe',
  click: '点击完成',
  click_open_page: '点击并打开新页面完成',
  double_click: '双击完成',
  right_click: '右键点击完成',
  select_option: '选项选择完成',
  combo_select: '组合框选择完成',
  input: '输入完成',
  input_date: '日期输入完成',
  file_upload: '文件上传完成',
  certificate_upload: '证书上传完成',
  clear: '输入框清空完成',
  key: '按键完成',
  hover: '悬停完成',
  scroll: '滚动完成',
  scroll_to_element: '已滚动到目标元素',
  pointer_move: '鼠标移动完成',
  dialog_accept: '已确认浏览器弹框',
  dialog_dismiss: '已取消浏览器弹框',
  dialog_prompt: '浏览器弹框输入完成',
  assert_text: '文本检查通过',
  assert_text_not: '文本反向检查通过',
  assert_attribute: '属性检查通过',
  assert_script: '脚本结果检查通过',
  assert_database_value: '数据库值检查通过',
  assert_variable_list: '变量列表检查通过',
  assert_variable_list_not: '变量列表反向检查通过',
  assert_text_regex: '正则检查通过',
  assert_element_match: '元素检查通过',
  wait: '固定等待完成',
  implicit_wait: '隐式等待配置完成',
  captcha_ocr: '验证码识别完成',
  global_variable_set: '全局变量设置完成',
  global_variable_date: '日期变量设置完成',
  global_variable_formula: '公式变量设置完成',
  global_variable_system_info: '系统信息变量设置完成',
  global_variable_available_ip: '可用 IP 变量设置完成',
  global_variable_property: '配置属性变量设置完成',
  evaluate: '脚本执行完成',
  server_command: '服务器命令执行完成',
  database_sql: '数据库操作完成',
  database_native: '原生数据库操作完成',
  host_command: '主机命令执行完成',
  host_file_lookup: '主机文件查询完成',
  host_file_delete: '主机文件删除完成',
  host_pointer_move: '主机坐标移动完成',
  server_file_upload: '服务器文件上传完成',
});

const SENSITIVE_KEY = /(password|passwd|pwd|token|secret|authorization|api[_-]?key|private[_-]?key|credential)/i;
const RESTRICTED_KEY = /^(sql|command|script)$/i;
const PATH_KEY = /(^|_)(path|file_ref|certificate_ref|remote_path)$/i;
const URL_KEY = /(^|_)url$/i;
const MAX_PREVIEW_LENGTH = 512;
const SOURCE_LABELS = Object.freeze({
  variable_reference: '引用变量',
  literal: '固定值',
  date: '日期时间',
  formula: '计算公式',
  locator: '元素定位',
  infrastructure: '基础设施',
  runtime: '运行时',
  environment: '执行环境',
  default: '默认值',
  definition_snapshot: '定义快照',
  executor: '执行器返回',
  legacy_step: '旧步骤定义',
});
const RESULT_FACT_LABELS = Object.freeze({
  reloaded: '刷新结果',
  selected_option: '最终选项',
  combo_search: '搜索值',
  opened_page_url: '新页面地址',
  switched_page_url: '当前页面地址',
  switched_page_title: '当前页面标题',
  switched_page_index: '当前窗口序号',
  closed_page_url: '关闭页面地址',
  closed_page_title: '关闭页面标题',
  active_page_url: '当前页面地址',
  active_page_title: '当前页面标题',
  active_page_index: '当前窗口序号',
  frame_url: 'Frame 地址',
  frame_depth: 'Frame 深度',
  evaluated: '脚本执行结果',
  evaluation_result_type: '返回类型',
  input_date_value: '实际日期值',
  wait_duration_ms: '实际等待时长',
  implicit_wait_ms: '隐式等待时长',
  previous_implicit_wait_ms: '原隐式等待时长',
  dialog_action: '弹框处理动作',
  dialog_handled: '弹框处理结果',
  dialog_type: '弹框类型',
  selected: '选择结果',
  target: '执行目标',
  filename: '文件名',
  file_count: '文件数量',
  affected_rows: '影响行数',
  row_count: '返回行数',
  exit_code: '退出码',
});
const RESULT_FACT_KEYS = [
  'reloaded', 'selected_option', 'combo_search', 'opened_page_url', 'switched_page_url', 'switched_page_title',
  'switched_page_index', 'closed_page_url', 'closed_page_title', 'active_page_url', 'active_page_title',
  'active_page_index', 'frame_url', 'frame_depth', 'evaluated', 'evaluation_result_type', 'input_date_value',
  'wait_duration_ms', 'implicit_wait_ms', 'previous_implicit_wait_ms', 'dialog_action', 'dialog_handled',
  'dialog_type', 'selected', 'target', 'filename', 'file_count', 'affected_rows', 'row_count', 'exit_code',
];

export function diagnosticProfileForStep(step = {}) {
  const explicit = String(step.diagnostic_profile || step.diagnosticProfile || '').trim();
  return explicit || ACTION_PROFILES[normalize(step.action_type || step.actionType)] || 'generic';
}

export function buildOperationDiagnostic(definitionStep = {}, runtimeStep = {}, stepResult = {}, options = {}) {
  const actionType = normalize(stepResult.action_type || runtimeStep.action_type || definitionStep.action_type);
  const profile = diagnosticProfileForStep(definitionStep);
  const target = buildTarget(definitionStep, runtimeStep, stepResult);
  const outcome = {
    kind: profile,
    status: stepResult.status || 'unknown',
    summary: ACTION_SUMMARIES[actionType] || '动作执行完成',
    facts: collectFacts(stepResult),
  };
  if (profile === 'assertion') {
    const assertion = buildAssertionDiagnostic(actionType, definitionStep, runtimeStep, stepResult);
    if (assertion) outcome.assertion = assertion;
  }
  const operation = {
    schema_version: 1,
    ...(firstText(definitionStep.catalog_version, runtimeStep.catalog_version)
      ? { catalog_version: firstText(definitionStep.catalog_version, runtimeStep.catalog_version) } : {}),
    profile,
    executor: String(options.executor || 'playwright'),
    method: buildMethodIdentity(definitionStep, runtimeStep, actionType),
    summary: ACTION_SUMMARIES[actionType] || `动作 ${actionType || 'custom'} 执行完成`,
    inputs: collectInputs(definitionStep, runtimeStep, actionType),
    outcome,
  };
  if (target) operation.target = target;
  return operation;
}

export function attachOperationDiagnostic(stepResult, definitionStep, runtimeStep, options = {}) {
  if (!stepResult || typeof stepResult !== 'object') return stepResult;
  const details = stepResult.details && typeof stepResult.details === 'object' ? stepResult.details : {};
  const { operation_assertion: _operationAssertion, ...resultWithoutOperationAssertion } = stepResult;
  return {
    ...resultWithoutOperationAssertion,
    details: {
      ...details,
      operation: buildOperationDiagnostic(definitionStep, runtimeStep, stepResult, options),
    },
  };
}

export function attachOperationDiagnosticIfEnabled(stepResult, definitionStep, runtimeStep, options = {}) {
  const { enabled = true, ...diagnosticOptions } = options;
  if (enabled === false) {
    // operation_assertion 是动作内部临时字段，关闭摘要时也不能把它写入公共结果。
    const { operation_assertion: _operationAssertion, ...cleanResult } = stepResult || {};
    return cleanResult;
  }
  return attachOperationDiagnostic(stepResult, definitionStep, runtimeStep, diagnosticOptions);
}

function buildMethodIdentity(definitionStep, runtimeStep, actionType) {
  const methodCode = firstText(
    definitionStep.method_code,
    definitionStep.methodCode,
    runtimeStep.method_code,
    runtimeStep.methodCode,
  );
  return {
    ...(firstText(definitionStep.type_code, definitionStep.typeCode)
      ? { type_code: firstText(definitionStep.type_code, definitionStep.typeCode) } : {}),
    ...(firstText(definitionStep.type_label, definitionStep.typeLabel, runtimeStep.type_label, runtimeStep.typeLabel)
      ? { type_label: firstText(definitionStep.type_label, definitionStep.typeLabel, runtimeStep.type_label, runtimeStep.typeLabel) } : {}),
    ...(methodCode ? { method_code: methodCode } : {}),
    ...(firstValue(definitionStep.method_version, definitionStep.methodVersion, runtimeStep.method_version)
      != null ? { method_version: firstValue(definitionStep.method_version, definitionStep.methodVersion, runtimeStep.method_version) } : {}),
    ...(firstText(definitionStep.method_label, definitionStep.methodLabel)
      ? { method_label: firstText(definitionStep.method_label, definitionStep.methodLabel) } : {}),
    action_type: actionType || 'custom',
  };
}

function collectInputs(definitionStep, runtimeStep, actionType) {
  const fields = Array.isArray(definitionStep.diagnostic_fields)
    ? definitionStep.diagnostic_fields.filter((field) => field && typeof field === 'object' && field.name)
    : [];
  const descriptors = fields.length
    ? fields.map((field) => ({ key: String(field.name), field }))
    : (ACTION_INPUTS[actionType] || []).map((key) => ({ key, field: null }));
  return descriptors.map(({ key, field }) => {
    const configured = readStepValue(definitionStep, key);
    const effective = readStepValue(runtimeStep, key);
    return buildInput(key, configured, effective, definitionStep, field);
  }).filter(Boolean);
}

function buildInput(key, configured, effective, definitionStep, field = null) {
  if (configured === undefined && effective === undefined) return null;
  const masked = isMasked(definitionStep, key);
  const configuredDisplay = displayValue(key, configured, masked, field);
  const effectiveDisplay = displayValue(key, effective, masked, field);
  const source = inputSource(key, configured, effective, field);
  return {
    key,
    ...(field?.label ? { label: String(field.label) } : {}),
    role: inputRole(key, field),
    ...(configuredDisplay ? { configured: configuredDisplay } : {}),
    ...(effectiveDisplay ? { effective: effectiveDisplay } : {}),
    ...(source ? { source } : {}),
  };
}

function inputSource(key, configured, effective, field = null) {
  if (typeof configured === 'string' && (/\$\{[^{}]+}/.test(configured) || /\{\{[^{}]+}}/.test(configured))) {
    const reference = configured.match(/\$\{([^{}]+)}/)?.[1]
      || configured.match(/\{\{([^{}]+)}}/)?.[1];
    return sourceObject('variable_reference', reference ? `引用变量：${reference}` : null);
  }
  if (configured !== undefined && effective !== undefined) {
    if (JSON.stringify(configured) !== JSON.stringify(effective)) return sourceObject('runtime');
    return sourceObject(isRestrictedField(key, field) ? 'definition_snapshot' : 'literal');
  }
  if (configured !== undefined) return sourceObject(isRestrictedField(key, field) ? 'definition_snapshot' : 'literal');
  if (effective !== undefined) return sourceObject('runtime');
  return '';
}

function sourceObject(code, label = null) {
  return {
    code,
    label: label || SOURCE_LABELS[code] || code,
  };
}

function buildTarget(definitionStep, runtimeStep, result) {
  const configured = firstText(
    definitionStep.target_selector,
    definitionStep.targetSelector,
    definitionStep.target_xpath,
    definitionStep.targetXpath,
    definitionStep.target_ref,
    definitionStep.targetRef,
  );
  const actual = firstText(result.locator_value, result.locatorValue);
  const source = firstText(result.locator_source, result.locatorSource);
  if (!configured && !actual && !source) return null;
  return {
    kind: 'element',
    ...(configured ? { configured_summary: safeText(configured) } : {}),
    ...(actual ? { actual_summary: safeText(actual) } : {}),
    ...(source ? { source } : {}),
    ...(result.matched_count != null ? { matched_count: result.matched_count } : {}),
    ...(result.visible_count != null ? { visible_count: result.visible_count } : {}),
    ...(runtimeStep.frame_index != null ? { frame_index: runtimeStep.frame_index } : {}),
  };
}

function collectFacts(result) {
  return RESULT_FACT_KEYS
    .filter((key) => result[key] !== undefined && result[key] !== null)
    .map((key) => ({
      key,
      ...(RESULT_FACT_LABELS[key] ? { label: RESULT_FACT_LABELS[key] } : {}),
      value: displayValue(key, result[key], false),
    }));
}

function buildAssertionDiagnostic(actionType, definitionStep, runtimeStep, result) {
  const explicit = result.operation_assertion;
  if (explicit && typeof explicit === 'object') return sanitizeAssertion(explicit);
  const details = result.details && typeof result.details === 'object' ? result.details : {};
  const expected = firstValue(
    runtimeStep.expect,
    runtimeStep.expected,
    runtimeStep.regex,
    runtimeStep.value,
    definitionStep.expect,
    definitionStep.expected,
    definitionStep.regex,
    definitionStep.value,
  );
  const actual = firstValue(details.actual, details.actual_preview, details.actualPreview, result.actual_preview);
  const operator = actionType === 'assert_element_match'
    ? String(firstValue(runtimeStep.match_mode, definitionStep.match_mode) || 'equals')
    : assertionOperator(actionType);
  if (expected == null && actual == null && !result.status) return null;
  return {
    subject: assertionSubject(actionType),
    operator,
    ...(expected != null ? { expected: displayValue('expect', expected, isMasked(runtimeStep, 'expect')) } : {}),
    ...(actual != null ? { actual: displayValue('actual', actual, false) } : { actual: { value_state: 'unavailable' } }),
    passed: result.status === 'passed',
  };
}

function sanitizeAssertion(assertion) {
  const result = {
    subject: safeText(assertion.subject || '断言对象'),
    operator: safeText(assertion.operator || 'equals'),
    passed: assertion.passed === true,
  };
  for (const key of ['expected', 'actual']) {
    if (assertion[key] && typeof assertion[key] === 'object') {
      const state = String(assertion[key].value_state || 'visible');
      result[key] = state === 'visible' || state === 'truncated'
        ? { value_state: state, ...(assertion[key].preview != null ? { preview: safeText(assertion[key].preview) } : {}) }
        : { value_state: state };
    }
  }
  return result;
}

function assertionOperator(actionType) {
  return {
    assert_text: 'contains',
    assert_text_not: 'not_contains',
    assert_attribute: 'equals',
    assert_script: 'equals',
    assert_database_value: 'equals',
    assert_variable_list: 'contains',
    assert_variable_list_not: 'not_contains',
    assert_text_regex: 'regex_match',
  }[actionType] || 'equals';
}

function assertionSubject(actionType) {
  return {
    assert_text: '元素文本',
    assert_text_not: '元素文本',
    assert_attribute: '元素属性',
    assert_script: '脚本返回值',
    assert_database_value: '数据库变量',
    assert_variable_list: '变量值',
    assert_variable_list_not: '变量值',
    assert_text_regex: '元素文本',
    assert_element_match: '页面元素',
  }[actionType] || '断言对象';
}

function inputRole(key, field = null) {
  if (field?.diagnostic_role) return String(field.diagnostic_role);
  if (key === 'target_ref' || key === 'target_selector' || key === 'target_xpath') return 'target';
  if (key === 'expect' || key === 'regex' || key === 'attribute') return 'expected';
  if (key === 'variable_name') return 'binding';
  if (RESTRICTED_KEY.test(key)) return 'definition';
  return 'input';
}

function displayValue(key, value, masked, field = null) {
  if (value === undefined || value === null) return null;
  if (masked || SENSITIVE_KEY.test(key)) return { value_state: 'masked' };
  if (field?.result_display === 'basename' || PATH_KEY.test(key)) {
    return { value_state: 'visible', preview: basename(value) };
  }
  if (field?.sensitivity === 'restricted' || field?.result_display === 'definition_endpoint' || RESTRICTED_KEY.test(key)) {
    return { value_state: 'restricted' };
  }
  if (URL_KEY.test(key)) return { value_state: 'visible', preview: safeUrlText(value) };
  if (Array.isArray(value)) return { value_state: 'visible', preview: safeText(value.map(stringify).join(', ')) };
  if (typeof value === 'object') return { value_state: 'visible', preview: safeText(JSON.stringify(value)) };
  return { value_state: 'visible', preview: safeText(value) };
}

function isRestrictedField(key, field = null) {
  return field?.sensitivity === 'restricted'
    || field?.result_display === 'definition_endpoint'
    || RESTRICTED_KEY.test(key);
}

function readStepValue(step, key) {
  const aliases = {
    target_ref: ['target_ref', 'targetRef', 'target_selector', 'targetSelector', 'target_xpath', 'targetXpath'],
    file_ref: ['file_ref', 'fileRef', 'value'],
    certificate_ref: ['certificate_ref', 'certificateRef', 'file_ref', 'fileRef'],
    remote_path: ['remote_path', 'remotePath'],
    duration_ms: ['duration_ms', 'durationMs', 'value'],
    option: ['option', 'option_value', 'optionValue', 'value'],
    search: ['search', 'query'],
    value: ['value', 'input_value', 'inputValue'],
    key: ['key', 'value'],
    variable_name: ['variable_name', 'variableName'],
  }[key] || [key];
  return aliases.reduce((value, name) => value === undefined ? step[name] : value, undefined);
}

function isMasked(step, key) {
  return ['1', 'true'].includes(String(step.value_masked ?? step.valueMasked ?? '').toLowerCase())
    || SENSITIVE_KEY.test(key);
}

function basename(value) {
  const text = String(value);
  return text.split(/[\\/]/).filter(Boolean).at(-1) || text;
}

function safeUrlText(value) {
  const text = String(value);
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key) || /^(code|key)$/i.test(key)) url.searchParams.set(key, '******');
    }
    url.username = '';
    url.password = '';
    return safeText(url.toString());
  } catch {
    return safeText(text.replace(/([?&](?:token|key|code|password|secret)=[^&]*)/gi, '$1******'));
  }
}

function safeText(value) {
  const text = stringify(value).replace(/[\r\n]+/g, ' ');
  return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…` : text;
}

function stringify(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function firstText(...values) {
  return values.find((value) => value != null && String(value).trim() !== '')
    ? String(values.find((value) => value != null && String(value).trim() !== '')).trim()
    : '';
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim?.() !== '') ?? null;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}
