const FOCUS_SCALE = 1.75;
const RESET_FOCUS_ACTIONS = new Set(['navigate', 'switch_page', 'close_page']);
const POINTER_ACTIONS = new Set([
  'click',
  'click_open_page',
  'double_click',
  'right_click',
  'input',
  'file_upload',
  'assert_download',
  'hover',
]);
const RIPPLE_ACTIONS = new Set([
  'click',
  'click_open_page',
  'double_click',
  'right_click',
  'input',
  'file_upload',
  'assert_download',
]);
const ACTION_NAMES = Object.freeze({
  navigate: '打开页面',
  click: '点击',
  click_open_page: '点击并打开新页面',
  switch_page: '切换页面',
  close_page: '关闭页面',
  close_all_pages: '关闭全部页面',
  reload: '刷新页面',
  frame_switch: '切换 Iframe',
  frame_parent: '返回上级 Iframe',
  frame_main: '返回主页面',
  evaluate: '执行页面脚本',
  double_click: '双击',
  right_click: '右键点击',
  select_option: '选择选项',
  combo_select: '搜索并选择选项',
  dialog_accept: '确认浏览器弹窗',
  dialog_dismiss: '取消浏览器弹窗',
  dialog_prompt: '输入浏览器弹窗',
  input: '输入',
  input_date: '输入时间',
  file_upload: '上传文件',
  certificate_upload: '上传证书',
  clear: '清空输入',
  assert_download: '下载并校验',
  assert_json: '校验 JSON',
  assert_request: '校验请求',
  assert_response: '校验响应',
  assert_request_count: '校验请求次数',
  network_mock: '注册网络模拟',
  network_replay: '回放网络响应',
  key: '按键',
  hover: '悬停',
  wait: '等待',
  scroll: '滚动页面',
  scroll_to_element: '滚动到元素',
  assert_text: '校验文本',
  assert_text_not: '校验文本不相等',
  assert_attribute: '校验元素属性',
  assert_script: '校验脚本返回值',
  assert_text_regex: '校验文本正则',
  implicit_wait: '设置定位等待',
  pointer_move: '移动浏览器指针',
});

/**
 * Playwright 的页面截图不会包含操作系统鼠标，因此把目标坐标随实时帧发送给前端绘制光标。
 * Canvas 不包含可检索文本且不接收指针事件，避免影响后续元素定位和页面交互。
 */
export async function showStepAction(page, step, locator, options = {}) {
  if (typeof options.onActionPreview !== 'function') return;

  if (locator) {
    await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs }).catch(() => {});
  }

  const target = locator || page.locator('body');
  const rendered = await target.evaluate(renderActionCanvas, {
    highlightTarget: Boolean(locator),
  }).then(() => true).catch((error) => {
    options.onActionPreviewError?.(error);
    return false;
  });

  if (!rendered) return;
  const boundingBox = locator ? await locator.boundingBox().catch(() => null) : null;
  const viewport = page.viewportSize?.() || await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  })).catch(() => null);
  await options.onActionPreview(page, step, buildStepActionPresentation(step, boundingBox, viewport));
}

export function buildStepActionPresentation(step, boundingBox, viewport) {
  const action = String(step?.action_type || '').toLowerCase();
  const presentation = {
    label: formatStepActionLabel(step),
    focusScale: 1,
    pointer: false,
    ripple: false,
  };
  if (!isValidRect(boundingBox) || !isValidViewport(viewport)) {
    return {
      ...presentation,
      preserveFocus: !RESET_FOCUS_ACTIONS.has(action),
    };
  }

  return {
    ...presentation,
    focusX: clamp((boundingBox.x + boundingBox.width / 2) / viewport.width, 0, 1),
    focusY: clamp((boundingBox.y + boundingBox.height / 2) / viewport.height, 0, 1),
    focusScale: FOCUS_SCALE,
    pointer: POINTER_ACTIONS.has(action),
    ripple: RIPPLE_ACTIONS.has(action),
  };
}

export function formatStepActionLabel(step) {
  const action = String(step?.action_type || '').toLowerCase();
  const rawIndex = Number(step?.step_index);
  const sequence = Number.isFinite(rawIndex) ? rawIndex + 1 : '';
  const name = firstText(
    step?.description,
    step?.operation_name,
    step?.operationName,
    step?.name,
    ACTION_NAMES[action],
    action,
    '执行操作',
  );
  return sequence ? `步骤 ${sequence} · ${name}` : name;
}

function isValidRect(rect) {
  return rect
    && Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

function isValidViewport(viewport) {
  return viewport
    && Number.isFinite(viewport.width)
    && Number.isFinite(viewport.height)
    && viewport.width > 0
    && viewport.height > 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function renderActionCanvas(element, payload) {
  const documentRef = element.ownerDocument;
  const windowRef = documentRef.defaultView;
  if (!windowRef) return;

  const canvasId = 'sakura-runner-action-visualizer';
  let canvas = documentRef.getElementById(canvasId);
  if (!canvas) {
    canvas = documentRef.createElement('canvas');
    canvas.id = canvasId;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.setAttribute('data-sakura-runner-overlay', 'true');
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '2147483647',
    });
    documentRef.documentElement.appendChild(canvas);
  }

  const width = Math.max(1, windowRef.innerWidth);
  const height = Math.max(1, windowRef.innerHeight);
  // 8K 页面仍保持原始截图分辨率；覆盖层限制为 2 倍像素，避免额外占用约 130MB Canvas 内存。
  const pixelRatio = Math.min(2, Math.max(1, Number(windowRef.devicePixelRatio) || 1));
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const rect = payload.highlightTarget ? element.getBoundingClientRect() : null;
  const hasVisibleTarget = rect && rect.width > 0 && rect.height > 0;
  if (hasVisibleTarget) {
    const highlightX = Math.max(2, rect.left - 4);
    const highlightY = Math.max(2, rect.top - 4);
    const highlightWidth = Math.min(width - highlightX - 2, rect.width + 8);
    const highlightHeight = Math.min(height - highlightY - 2, rect.height + 8);
    context.save();
    context.fillStyle = 'rgba(255, 107, 0, 0.2)';
    context.strokeStyle = 'rgba(255, 107, 0, 0.9)';
    context.lineWidth = 2;
    roundRect(context, highlightX, highlightY, highlightWidth, highlightHeight, 6);
    context.fill();
    context.stroke();
    context.restore();
  }

  function roundRect(contextRef, x, y, rectWidth, rectHeight, radius) {
    const safeWidth = Math.max(1, rectWidth);
    const safeHeight = Math.max(1, rectHeight);
    const safeRadius = Math.min(radius, safeWidth / 2, safeHeight / 2);
    contextRef.beginPath();
    contextRef.moveTo(x + safeRadius, y);
    contextRef.lineTo(x + safeWidth - safeRadius, y);
    contextRef.arcTo(x + safeWidth, y, x + safeWidth, y + safeRadius, safeRadius);
    contextRef.lineTo(x + safeWidth, y + safeHeight - safeRadius);
    contextRef.arcTo(x + safeWidth, y + safeHeight, x + safeWidth - safeRadius, y + safeHeight, safeRadius);
    contextRef.lineTo(x + safeRadius, y + safeHeight);
    contextRef.arcTo(x, y + safeHeight, x, y + safeHeight - safeRadius, safeRadius);
    contextRef.lineTo(x, y + safeRadius);
    contextRef.arcTo(x, y, x + safeRadius, y, safeRadius);
    contextRef.closePath();
  }
}
