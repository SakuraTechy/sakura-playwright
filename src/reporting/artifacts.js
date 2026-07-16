import fs from 'node:fs/promises';
import path from 'node:path';
import { timestampForPath } from '../shared/utils.js';

export async function createRunArtifacts({ artifactDir, caseId, testCase, timestamp = timestampForPath() }) {
  // runId 继续使用原始 caseKey，保证 admin artifact 上传和执行记录关联方式不变。
  const safeCaseKey = toSafePathPart(caseId);
  const runId = `${safeCaseKey}-${timestamp}`;
  const [runDate = 'unknown-date', runTime = 'unknown-time'] = String(timestamp).split('-', 2);
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
    toSafePathPart(runTime),
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
    failureScreenshotPath: path.join(screenshotsDir, 'failure.png'),
    failureHtmlPath: path.join(runDir, 'failure.html'),
    failureTextPath: path.join(domDir, 'failure-text.txt'),
    tracePath: path.join(runDir, 'trace.zip'),
  };
}

function resolveRunPathMetadata(testCase, caseKey) {
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

export async function writeConsoleLog(artifacts, result, consoleEvents) {
  const events = Array.isArray(consoleEvents) ? consoleEvents : [];
  await writeJson(artifacts.consoleLogPath, events);
  result.artifacts.console_log = artifacts.consoleLogPath;
  result.artifacts.logs.push(artifacts.consoleLogPath);
  result.raw.console_event_count = events.length;
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
  const candidates = [
    ['console', localArtifacts.console_log],
    ['video', localArtifacts.video],
    ['trace', localArtifacts.trace],
    ['screenshot', localArtifacts.failure_screenshot],
  ].filter(([, filePath]) => typeof filePath === 'string' && filePath);
  const uploaded = {};
  const errors = [];
  for (const [artifactType, filePath] of candidates) {
    try {
      const artifact = await api.uploadArtifact(result.run_id, artifactType, filePath);
      if (artifact?.url) uploaded[artifactType] = artifact.url;
    } catch (error) {
      errors.push({
        artifact_type: artifactType,
        file_name: path.basename(filePath),
        error: error?.message || String(error),
      });
    }
  }

  // admin 结果只保存受鉴权 URL，Runner 节点绝对路径仅保留在本地 result.json 中。
  result.artifacts = {
    ...(uploaded.console ? { console_log: uploaded.console, logs: [uploaded.console] } : { logs: [] }),
    ...(uploaded.video ? { video: uploaded.video, videos: [uploaded.video] } : { videos: [] }),
    ...(uploaded.trace ? { trace: uploaded.trace } : {}),
    ...(uploaded.screenshot ? {
      failure_screenshot: uploaded.screenshot,
      screenshots: [uploaded.screenshot],
    } : { screenshots: [] }),
    dom_snapshots: [],
  };
  if (localArtifacts.report_html) {
    // 报告最后生成并上传，确保 HTML 中展示的是 admin URL，而不是 Runner 节点绝对路径。
    await writeHtmlReport(artifacts, result);
    delete result.artifacts.report_html;
    try {
      const report = await api.uploadArtifact(result.run_id, 'report', localArtifacts.report_html);
      if (report?.url) result.artifacts.report_html = report.url;
    } catch (error) {
      errors.push({
        artifact_type: 'report',
        file_name: path.basename(localArtifacts.report_html),
        error: error?.message || String(error),
      });
    }
  }
  result.artifact_upload_errors = errors;
  return result;
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
