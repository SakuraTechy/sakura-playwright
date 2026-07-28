const DEFAULT_INTERVAL_MS = 1000;
const LIVE_FRAME_PRESENTATION_PREFIX = 'SAKURA_FOCUS:';
const LIVE_FRAME_QUALITY_PRESETS = Object.freeze({
  smooth: Object.freeze({ deviceScaleFactor: 1, jpegQuality: 65, intervalMs: 1000 }),
  high: Object.freeze({ deviceScaleFactor: 1.5, jpegQuality: 82, intervalMs: 1000 }),
  ultra: Object.freeze({ deviceScaleFactor: 2, jpegQuality: 85, intervalMs: 1500 }),
  '8k': Object.freeze({ deviceScaleFactor: 4, jpegQuality: 90, intervalMs: 3000 }),
});

export function resolveLiveFrameQualityPreset(quality = 'smooth') {
  return LIVE_FRAME_QUALITY_PRESETS[quality] || LIVE_FRAME_QUALITY_PRESETS.smooth;
}

/**
 * 实时帧只保存在 admin 任务内存中，不写入 caseList 或本地产物。
 * 截图和上传严格串行，避免慢网络导致截图任务堆积并干扰步骤执行。
 */
export function startLiveFramePublisher({
  api,
  jobId,
  getPage,
  logger,
  intervalMs = DEFAULT_INTERVAL_MS,
  jpegQuality = 65,
}) {
  if (!api?.adminApi || !jobId) {
    return {
      captureNow: async () => {},
      stop: async () => {},
    };
  }

  let active = true;
  let capturePromise;
  let warningReported = false;
  let presentationSequence = 0;
  let currentPresentation = normalizeLiveFramePresentation();

  const capture = async ({ ensureFresh = false, presentation } = {}) => {
    if (!active) return;
    if (presentation !== undefined) {
      const nextPresentation = presentation?.preserveFocus
        ? {
            ...presentation,
            focusX: currentPresentation.focusX,
            focusY: currentPresentation.focusY,
            focusScale: currentPresentation.focusScale,
            pointer: currentPresentation.pointer,
          }
        : presentation;
      currentPresentation = normalizeLiveFramePresentation(nextPresentation);
      presentationSequence++;
    }
    if (capturePromise) {
      await capturePromise.catch(() => {});
      if (ensureFresh && active) await capture();
      return;
    }
    const page = getPage?.();
    if (!page || page.isClosed()) return;
    const framePresentation = { ...currentPresentation };
    const framePresentationSequence = presentationSequence;

    capturePromise = (async () => {
      try {
        const frame = await page.screenshot({
          type: 'jpeg',
          quality: jpegQuality,
          scale: 'device',
          fullPage: false,
        });
        await api.pushLiveFrame(jobId, appendLiveFramePresentation(frame, framePresentation));
        if (framePresentation.ripple && framePresentationSequence === presentationSequence) {
          // 波纹只随动作帧播放一次，后续定时帧继续保持聚焦但不重复触发动画。
          currentPresentation = { ...currentPresentation, ripple: false };
        }
      } catch (error) {
        if (!warningReported && active) {
          warningReported = true;
          logger?.warning('live', `实时画面暂不可用：${error?.message || String(error)}`);
        }
      } finally {
        capturePromise = undefined;
      }
    })();
    await capturePromise;
  };

  const timer = setInterval(() => {
    capture().catch(() => {});
  }, Math.max(500, intervalMs));
  capture().catch(() => {});

  return {
    // 步骤动作通常短于定时截图间隔；动作前强制抓取新帧，确保虚拟鼠标不会被跳过。
    captureNow: (presentation) => capture({ ensureFresh: true, presentation }),
    stop: async () => {
      active = false;
      clearInterval(timer);
      await capturePromise?.catch(() => {});
    },
  };
}

/**
 * 聚焦信息写入 JPEG 注释段，admin 仍只需按原样暂存 JPEG，避免扩大跨服务 DTO。
 */
export function appendLiveFramePresentation(frame, presentation = {}) {
  const content = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (content.length < 4 || content[content.length - 2] !== 0xFF || content[content.length - 1] !== 0xD9) {
    throw new Error('实时画面不是完整 JPEG，无法附加聚焦信息');
  }
  const payload = Buffer.from(
    `${LIVE_FRAME_PRESENTATION_PREFIX}${JSON.stringify(normalizeLiveFramePresentation(presentation))}\n`,
    'utf8',
  );
  if (payload.length > 65531) throw new Error('实时画面聚焦信息过长');

  const marker = Buffer.alloc(4);
  marker[0] = 0xFF;
  marker[1] = 0xFE;
  marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([content.subarray(0, -2), marker, payload, content.subarray(-2)]);
}

export function extractLiveFramePresentation(frame) {
  const content = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  const tail = content.subarray(Math.max(0, content.length - 2048)).toString('utf8');
  const start = tail.lastIndexOf(LIVE_FRAME_PRESENTATION_PREFIX);
  if (start < 0) return null;
  const jsonStart = start + LIVE_FRAME_PRESENTATION_PREFIX.length;
  const jsonEnd = tail.indexOf('\n', jsonStart);
  if (jsonEnd < 0) return null;
  try {
    return normalizeLiveFramePresentation(JSON.parse(tail.slice(jsonStart, jsonEnd)));
  } catch {
    return null;
  }
}

function normalizeLiveFramePresentation(presentation = {}) {
  const focusX = finiteNumber(presentation.focusX);
  const focusY = finiteNumber(presentation.focusY);
  const hasFocus = focusX != null && focusY != null;
  return {
    label: String(presentation.label || '').trim().slice(0, 200),
    focusX: hasFocus ? clamp(focusX, 0, 1) : null,
    focusY: hasFocus ? clamp(focusY, 0, 1) : null,
    focusScale: hasFocus ? clamp(finiteNumber(presentation.focusScale) ?? 1, 1, 2.5) : 1,
    pointer: hasFocus && presentation.pointer === true,
    ripple: hasFocus && presentation.ripple === true,
  };
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
