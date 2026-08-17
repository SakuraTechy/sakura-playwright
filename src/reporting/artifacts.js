import fs from 'node:fs/promises';
import path from 'node:path';
import { timestampForPath } from '../shared/utils.js';

export async function createRunArtifacts({ artifactDir, caseId, testCase, runId: requestedRunId, timestamp = timestampForPath() }) {
  // 平台任务使用用例 executionId 关联 artifact；旧 CLI 未传值时再生成兼容 runId。
  const safeCaseKey = toSafePathPart(caseId);
  const requestedExecutionId = String(requestedRunId || '').trim();
  const runId = requestedExecutionId || `${safeCaseKey}-${timestamp}`;
  const [timestampDate = 'unknown-date', timestampTime = 'unknown-time'] = String(timestamp).split('-', 2);
  const platformExecutionId = /^\d{14}$/.test(requestedExecutionId) ? requestedExecutionId : '';
  // 平台执行时以 executionId 作为末级目录，保证日志、历史记录和本地产物可以直接对应。
  // 未传 executionId 的旧 CLI 仍沿用 HHmmss 目录，保持 test-lab 和手工命令兼容。
  const runDate = platformExecutionId ? platformExecutionId.slice(0, 8) : timestampDate;
  const runDirectory = requestedExecutionId || timestampTime;
  const pathMetadata = resolveRunPathMetadata(testCase, caseId);
  const runDir = path.resolve(
    process.cwd(),
    artifactDir,
    'runs',
    pathMetadata.projectShortName,
    pathMetadata.versionName,
    pathMetadata.sceneId,
    pathMetadata.caseId,
    toSafePathPart(runDate),
    toSafePathPart(runDirectory),
  );
  const screenshotsDir = path.join(runDir, 'screenshots');
  const logsDir = path.join(runDir, 'logs');
  const domDir = path.join(runDir, 'dom');
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(domDir, { recursive: true });
  return {
    runId,
    runDir,
    screenshotsDir,
    logsDir,
    domDir,
    resultPath: path.join(runDir, 'result.json'),
    reportPath: path.join(runDir, 'report.html'),
    consoleLogPath: path.join(logsDir, 'console.json'),
    executionLogPath: path.join(logsDir, 'execution-log.json'),
    failureScreenshotPath: path.join(screenshotsDir, 'failure.png'),
    failureHtmlPath: path.join(runDir, 'failure.html'),
    failureTextPath: path.join(domDir, 'failure-text.txt'),
    tracePath: path.join(runDir, 'trace.zip'),
    videoPath: path.join(runDir, 'video.webm'),
  };
}

export function resolveRunPathMetadata(testCase, caseKey) {
  const [caseKeyScene = '', ...caseKeyParts] = String(caseKey ?? '').split(':');
  const caseKeyCase = caseKeyParts.join(':');
  return {
    projectShortName: toSafePathPart(firstText(testCase?.project_short_name, testCase?.projectShortName, 'project')),
    versionName: toSafePathPart(firstText(testCase?.version_name, testCase?.versionName, 'version')),
    sceneId: toSafePathPart(firstText(testCase?.scene_id, testCase?.sceneId, caseKeyScene, 'scene')),
    caseId: toSafePathPart(firstText(testCase?.case_id, testCase?.caseId, caseKeyCase, caseKey, 'case')),
  };
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function toSafePathPart(value) {
  const safe = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[ .]+$/g, '')
    .slice(0, 160);
  return safe || 'case';
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function writeText(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, String(data ?? ''), 'utf8');
}

export async function collectFailureArtifacts(page, artifacts, result) {
  if (!page) return result;
  try {
    await page.screenshot({ path: artifacts.failureScreenshotPath, fullPage: true });
    result.artifacts.failure_screenshot = artifacts.failureScreenshotPath;
    result.artifacts.screenshots.push(artifacts.failureScreenshotPath);
  } catch (error) {
    result.artifacts.failure_screenshot_error = error?.message || String(error);
  }
  try {
    const html = await page.content();
    await fs.writeFile(artifacts.failureHtmlPath, html, 'utf8');
    result.artifacts.failure_html = artifacts.failureHtmlPath;
  } catch (error) {
    result.artifacts.failure_html_error = error?.message || String(error);
  }
  try {
    const text = await page.locator('body').innerText({ timeout: 1000 });
    await fs.writeFile(artifacts.failureTextPath, text, 'utf8');
    result.artifacts.failure_text = artifacts.failureTextPath;
    result.artifacts.dom_snapshots.push(artifacts.failureTextPath);
  } catch (error) {
    result.artifacts.failure_text_error = error?.message || String(error);
  }
  return result;
}

export async function collectVideoArtifact(page, result, keep) {
  const video = page?.video?.();
  if (!video) return result;
  const videoPath = await video.path().catch(() => '');
  if (!videoPath) return result;
  if (keep) {
    result.artifacts.video = videoPath;
    result.artifacts.videos.push(videoPath);
    return result;
  }
  await fs.unlink(videoPath).catch(() => {});
  return result;
}

export async function collectScreencastArtifact(videoPath, result, keep) {
  if (!videoPath) return result;
  const stat = await fs.stat(videoPath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0) return result;
  if (keep) {
    result.artifacts.video = videoPath;
    result.artifacts.videos.push(videoPath);
    return result;
  }
  await fs.unlink(videoPath).catch(() => {});
  return result;
}

export async function writeConsoleLog(artifacts, result, consoleEvents) {
  const events = Array.isArray(consoleEvents) ? consoleEvents : [];
  await writeJson(artifacts.consoleLogPath, events);
  result.artifacts.console_log = artifacts.consoleLogPath;
  result.artifacts.logs.push(artifacts.consoleLogPath);
  result.raw.console_event_count = events.length;
  return result;
}

export async function writeExecutionLog(artifacts, result, executionEvents) {
  const events = Array.isArray(executionEvents) ? executionEvents : [];
  await writeJson(artifacts.executionLogPath, events);
  result.artifacts.execution_log = artifacts.executionLogPath;
  result.artifacts.logs.push(artifacts.executionLogPath);
  return result;
}

export async function writeHtmlReport(artifacts, result) {
  const html = renderHtmlReport(result);
  await writeText(artifacts.reportPath, html);
  result.artifacts.report_html = artifacts.reportPath;
  return result;
}

export async function uploadRunArtifacts(api, artifacts, result) {
  if (!api?.adminApi) return result;
  const localArtifacts = result.artifacts || {};
  const candidates = collectRunArtifactCandidates(artifacts, result, localArtifacts);
  const uploadedArtifacts = {};
  const uploadedFileIds = {};
  const errors = [];
  for (const candidate of candidates) {
    try {
      const artifact = await api.uploadArtifact(
        result.run_id,
        candidate.artifactType,
        candidate.filePath,
        candidate.relativePath,
      );
      if (!artifact?.url) throw new Error('Admin 未返回产物访问地址');
      applyUploadedArtifact(candidate, artifact, uploadedArtifacts, uploadedFileIds);
    } catch (error) {
      clearStepLocalArtifactPath(candidate);
      errors.push({
        artifact_type: candidate.artifactType,
        file_name: path.basename(candidate.filePath),
        relative_path: candidate.relativePath,
        error: error?.message || String(error),
      });
    }
  }

  // 上传完成后统一替换为鉴权 URL，避免 Runner 节点绝对路径进入 admin 结果和报告。
  result.artifacts = uploadedArtifacts;
  result.artifact_file_ids = uploadedFileIds;
  if (localArtifacts.report_html) {
    // 报告最后生成并上传，确保 HTML 中展示的是 admin URL，而不是 Runner 节点绝对路径。
    await writeHtmlReport(artifacts, result);
    delete result.artifacts.report_html;
    try {
      const relativePath = artifactRelativePath(artifacts.runDir, localArtifacts.report_html, 'report.html');
      const report = await api.uploadArtifact(result.run_id, 'report', localArtifacts.report_html, relativePath);
      if (!report?.url) throw new Error('Admin 未返回产物访问地址');
      result.artifacts.report_html = report.url;
      if (report?.fileId) result.artifact_file_ids.report_html = String(report.fileId);
    } catch (error) {
      errors.push({
        artifact_type: 'report',
        file_name: path.basename(localArtifacts.report_html),
        relative_path: 'report.html',
        error: error?.message || String(error),
      });
    }
  }

  // result.json 是远端归档的执行事实快照；自身 URL 在上传后才产生，因此只写入 Runner 本地最终副本。
  result.artifact_upload_errors = errors;
  await writeJson(artifacts.resultPath, result);
  try {
    const relativePath = artifactRelativePath(artifacts.runDir, artifacts.resultPath, 'result.json');
    const artifact = await api.uploadArtifact(result.run_id, 'result', artifacts.resultPath, relativePath);
    if (!artifact?.url) throw new Error('Admin 未返回产物访问地址');
    result.artifacts.result_json = artifact.url;
    if (artifact.fileId) result.artifact_file_ids.result_json = String(artifact.fileId);
  } catch (error) {
    errors.push({
      artifact_type: 'result',
      file_name: path.basename(artifacts.resultPath),
      relative_path: 'result.json',
      error: error?.message || String(error),
    });
  }
  result.artifact_upload_errors = errors;
  return result;
}

function collectRunArtifactCandidates(artifacts, result, localArtifacts) {
  const candidates = [];
  addArtifactCandidate(candidates, artifacts, 'console', localArtifacts.console_log, 'console_log', 'logs/console.json');
  addArtifactCandidate(candidates, artifacts, 'execution-log', localArtifacts.execution_log, 'execution_log', 'logs/execution-log.json');
  addArtifactCandidate(candidates, artifacts, 'video', localArtifacts.video, 'video', 'video.webm');
  addArtifactCandidate(candidates, artifacts, 'trace', localArtifacts.trace, 'trace', 'trace.zip');
  addArtifactCandidate(candidates, artifacts, 'screenshot', localArtifacts.failure_screenshot, 'failure_screenshot', 'screenshots/failure.png');
  addArtifactCandidate(candidates, artifacts, 'dom', localArtifacts.failure_html, 'failure_html', 'failure.html');
  addArtifactCandidate(candidates, artifacts, 'dom', localArtifacts.failure_text, 'failure_text', 'dom/failure-text.txt');

  for (const step of result.steps || []) {
    addArtifactCandidate(candidates, artifacts, 'download', step.downloaded_file, 'downloads', 'downloads/download.bin', {
      step,
      stepPathKey: 'downloaded_file',
      stepFileIdKey: 'downloaded_file_id',
    });
    addArtifactCandidate(candidates, artifacts, 'response', step.response_snapshot, 'response_snapshots', 'responses/response.txt', {
      step,
      stepPathKey: 'response_snapshot',
      stepFileIdKey: 'response_snapshot_file_id',
    });
    addArtifactCandidate(candidates, artifacts, 'response', step.response_snapshot_meta, 'response_snapshots', 'responses/response.meta.json', {
      step,
      stepPathKey: 'response_snapshot_meta',
      stepFileIdKey: 'response_snapshot_meta_file_id',
    });
  }
  return candidates;
}

function addArtifactCandidate(candidates, artifacts, artifactType, filePath, resultKey, fallbackRelativePath, stepBinding = {}) {
  if (typeof filePath !== 'string' || !filePath || /^https?:\/\//i.test(filePath)) return;
  candidates.push({
    artifactType,
    filePath,
    resultKey,
    relativePath: artifactRelativePath(artifacts.runDir, filePath, fallbackRelativePath),
    ...stepBinding,
  });
}

function artifactRelativePath(runDir, filePath, fallback) {
  const relative = path.relative(path.resolve(runDir), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return fallback;
  return relative.split(path.sep).join('/');
}

function applyUploadedArtifact(candidate, artifact, uploadedArtifacts, uploadedFileIds) {
  if (candidate.step && candidate.stepPathKey) {
    candidate.step[candidate.stepPathKey] = artifact.url;
    candidate.step[`${candidate.stepPathKey}_relative_path`] = candidate.relativePath;
    if (artifact.fileId) candidate.step[candidate.stepFileIdKey] = String(artifact.fileId);
  }
  if (candidate.resultKey === 'downloads' || candidate.resultKey === 'response_snapshots') {
    (uploadedArtifacts[candidate.resultKey] ||= []).push(artifact.url);
    if (artifact.fileId) (uploadedFileIds[candidate.resultKey] ||= []).push(String(artifact.fileId));
    return;
  }
  uploadedArtifacts[candidate.resultKey] = artifact.url;
  if (artifact.fileId) uploadedFileIds[candidate.resultKey] = String(artifact.fileId);
}

function clearStepLocalArtifactPath(candidate) {
  if (!candidate.step || !candidate.stepPathKey) return;
  candidate.step[candidate.stepPathKey] = '';
  candidate.step[`${candidate.stepPathKey}_relative_path`] = candidate.relativePath;
}

/**
 * 清理已经完整上报的历史本地产物。平台模式只删除 artifactDir/runs 内的 run 目录，
 * 上传或结果回传失败的目录会保留，供后续人工或运维重试。
 */
export async function cleanupLocalRunArtifacts(config) {
  if (!config?.adminApi || config.localArtifactCleanupEnabled !== true) return;
  const runsRoot = path.resolve(process.cwd(), config.artifactDir, 'runs');
  const candidates = await findRunDirectories(runsRoot);
  const now = Date.now();
  for (const runDir of candidates) {
    const resultPath = path.join(runDir, 'result.json');
    const result = await readJson(resultPath);
    if (!isSafeToDelete(result)) continue;
    const retentionMs = result.success === true
      ? Number(config.localArtifactSuccessRetentionHours) * 60 * 60 * 1000
      : Number(config.localArtifactFailureRetentionDays) * 24 * 60 * 60 * 1000;
    const stat = await fs.stat(resultPath).catch(() => null);
    if (!stat || now - stat.mtimeMs < retentionMs || !isRunDirectory(runsRoot, runDir)) continue;
    await fs.rm(runDir, { recursive: true, force: false });
  }
}

async function findRunDirectories(runsRoot) {
  const entries = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsRoot, entry.name);
    if ((await fs.stat(path.join(candidate, 'result.json')).catch(() => null))?.isFile()) {
      result.push(candidate);
      continue;
    }
    result.push(...await findRunDirectories(candidate));
  }
  return result;
}

function isSafeToDelete(result) {
  return result
    && result.artifact_delivery?.upload_completed === true
    && result.artifact_delivery?.result_reported === true
    && Array.isArray(result.artifact_upload_errors)
    && result.artifact_upload_errors.length === 0;
}

function isRunDirectory(runsRoot, candidate) {
  const relative = path.relative(runsRoot, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function renderHtmlReport(result) {
  const steps = (result.steps || []).map((step) => `
    <tr data-status="${escapeHtml(step.status)}">
      <td>${escapeHtml(step.step_index)}</td>
      <td>${escapeHtml(step.action_type)}</td>
      <td>${escapeHtml(step.status)}</td>
      <td>${escapeHtml(step.duration_ms)} ms</td>
      <td>${escapeHtml(step.locator_source || '')}</td>
      <td>${escapeHtml(step.error || '')}</td>
    </tr>
  `).join('');
  const artifactItems = Object.entries(result.artifacts || {})
    .filter(([, value]) => value && !Array.isArray(value))
    .map(([key, value]) => `<li><strong>${escapeHtml(key)}</strong><code>${escapeHtml(value)}</code></li>`)
    .join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>CueCast Runner Report ${escapeHtml(result.run_id)}</title>
  <style>
    body { margin: 0; padding: 28px; background: #f6f8fb; color: #172033; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
    h1, h2 { margin: 0 0 12px; }
    .summary, table, .artifacts { margin-top: 18px; border: 1px solid #dfe4ee; border-radius: 8px; background: #fff; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 1px; overflow: hidden; }
    .metric { padding: 14px; background: #fff; }
    .metric span { display: block; color: #677085; font-size: 12px; font-weight: 700; }
    .metric strong { display: block; margin-top: 5px; font-size: 18px; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { padding: 10px; border-bottom: 1px solid #dfe4ee; text-align: left; vertical-align: top; }
    th { color: #677085; font-size: 12px; text-transform: uppercase; }
    tr[data-status="failed"] td { background: #fff2f2; }
    code { display: block; margin-top: 4px; color: #42526b; font-family: Consolas, monospace; word-break: break-all; }
    .artifacts { padding: 14px; }
    .artifacts li { margin: 8px 0; }
  </style>
</head>
<body>
  <h1>CueCast Runner Report</h1>
  <div class="summary">
    <div class="metric"><span>Run</span><strong>${escapeHtml(result.run_id)}</strong></div>
    <div class="metric"><span>Status</span><strong>${escapeHtml(result.status)}</strong></div>
    <div class="metric"><span>Case</span><strong>${escapeHtml(result.case_id)}</strong></div>
    <div class="metric"><span>Duration</span><strong>${escapeHtml(result.duration_ms)} ms</strong></div>
  </div>
  <h2>Steps</h2>
  <table>
    <thead><tr><th>#</th><th>Action</th><th>Status</th><th>Duration</th><th>Locator</th><th>Error</th></tr></thead>
    <tbody>${steps}</tbody>
  </table>
  <section class="artifacts">
    <h2>Artifacts</h2>
    <ul>${artifactItems}</ul>
  </section>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
