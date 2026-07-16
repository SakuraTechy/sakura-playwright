#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatPlatformDateTime, loadRunnerEnv, parseBoolean, parseCliArgs, parsePositiveInt, timestampForPath, trimTrailingSlash } from './shared/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runnerPath = path.join(__dirname, 'index.js');

async function main() {
  const config = parseBatchArgs();
  const startedAt = Date.now();
  const batchId = `batch-${timestampForPath()}`;
  const batchDir = path.resolve(process.cwd(), config.artifactDir, 'batches', batchId);
  await fs.mkdir(batchDir, { recursive: true });

  const results = await runCasePool(config);
  const summary = createSummary({ batchId, batchDir, config, results, startedAt });
  const summaryPath = path.join(batchDir, 'summary.json');
  const reportPath = path.join(batchDir, 'report.html');
  summary.artifacts.summary_json = summaryPath;
  summary.artifacts.report_html = reportPath;
  await writeJson(summaryPath, summary);
  await fs.writeFile(reportPath, renderBatchReport(summary), 'utf8');

  console.log(`[batch] ${summary.status} total=${summary.total} passed=${summary.passed} failed=${summary.failed} artifacts=${batchDir}`);
  if (summary.failed > 0) process.exitCode = 1;
}

function parseBatchArgs(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv);
  const mergedEnv = loadRunnerEnv(argv, env);

  const caseIds = splitCaseIds(args['case-ids'] || mergedEnv.CUECAST_CASE_IDS || '');
  if (!caseIds.length) {
    throw new Error('Missing required --case-ids or CUECAST_CASE_IDS');
  }

  const workers = Math.min(parsePositiveInt(args.workers || mergedEnv.RUNNER_WORKERS, 1), caseIds.length);
  return {
    caseIds,
    apiBase: trimTrailingSlash(args['api-base'] || mergedEnv.CUECAST_API_BASE || 'http://127.0.0.1:4173/api'),
    adminApi: parseBoolean(args['admin-api'] ?? (args['api-base'] == null ? mergedEnv.CUECAST_ADMIN_API : false), false),
    token: args.token || mergedEnv.CUECAST_TOKEN || '',
    browser: args.browser || mergedEnv.RUNNER_BROWSER || 'chromium',
    headed: parseBoolean(args.headed ?? mergedEnv.RUNNER_HEADED, false),
    slowMo: args['slow-mo'] || mergedEnv.RUNNER_SLOW_MO_MS || '',
    finishDelay: args['finish-delay'] || mergedEnv.RUNNER_FINISH_DELAY_MS || '',
    trace: args.trace || mergedEnv.RUNNER_TRACE || 'retain-on-failure',
    video: args.video || mergedEnv.RUNNER_VIDEO || 'retain-on-failure',
    timeout: args.timeout || mergedEnv.RUNNER_STEP_TIMEOUT_MS || '',
    caseTimeout: args['case-timeout'] || mergedEnv.RUNNER_CASE_TIMEOUT_MS || '',
    startStep: args['start-step'] || '',
    workers,
    artifactDir: args['artifact-dir'] || mergedEnv.RUNNER_ARTIFACT_DIR || 'playwright-runner-artifacts',
  };
}

function splitCaseIds(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function runCasePool(config) {
  const queue = [...config.caseIds];
  const results = [];
  const workerCount = Math.max(1, config.workers);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const caseId = queue.shift();
      const result = await runOneCase(caseId, config);
      results.push(result);
    }
  }));
  const order = new Map(config.caseIds.map((caseId, index) => [String(caseId), index]));
  return results.sort((a, b) => order.get(String(a.case_id)) - order.get(String(b.case_id)));
}

function runOneCase(caseId, config) {
  const startedAt = Date.now();
  const args = [
    runnerPath,
    '--case-id', String(caseId),
    '--api-base', config.apiBase,
    '--admin-api', String(config.adminApi),
    '--browser', config.browser,
    '--headed', String(config.headed),
    '--trace', config.trace,
    '--video', config.video,
    '--artifact-dir', config.artifactDir,
  ];
  if (config.token) args.push('--token', config.token);
  if (config.timeout) args.push('--timeout', String(config.timeout));
  if (config.caseTimeout) args.push('--case-timeout', String(config.caseTimeout));
  if (config.startStep) args.push('--start-step', String(config.startStep));
  if (config.slowMo) args.push('--slow-mo', String(config.slowMo));
  if (config.finishDelay) args.push('--finish-delay', String(config.finishDelay));

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      stderr += error.message || String(error);
    });
    child.on('close', async (code) => {
      const artifactDir = parseArtifactDir(stdout);
      const resultPath = artifactDir ? path.join(artifactDir, 'result.json') : '';
      const resultJson = await readJson(resultPath);
      resolve({
        case_id: Number(caseId) || caseId,
        status: code === 0 ? 'passed' : 'failed',
        success: code === 0,
        exit_code: code,
        duration_ms: Date.now() - startedAt,
        artifact_dir: artifactDir,
        result_json: resultPath,
        error: resultJson?.error || stderr.trim(),
        failed_step_index: resultJson?.failed_step_index ?? null,
        artifacts: resultJson?.artifacts || {},
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function parseArtifactDir(stdout) {
  const match = String(stdout || '').match(/artifacts=(.+)$/m);
  return match ? match[1].trim() : '';
}

async function readJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function createSummary({ batchId, batchDir, config, results, startedAt }) {
  const passed = results.filter((item) => item.success).length;
  const failed = results.length - passed;
  return {
    batch_id: batchId,
    status: failed > 0 ? 'failed' : 'passed',
    started_at: formatPlatformDateTime(startedAt),
    finished_at: formatPlatformDateTime(),
    duration_ms: Date.now() - startedAt,
    total: results.length,
    passed,
    failed,
    workers: config.workers,
    case_ids: config.caseIds,
    api_base: config.apiBase,
    trace: config.trace,
    video: config.video,
    artifacts: {
      batch_dir: batchDir,
    },
    results,
  };
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function renderBatchReport(summary) {
  const rows = summary.results.map((item) => `
    <tr data-status="${escapeHtml(item.status)}">
      <td>${escapeHtml(item.case_id)}</td>
      <td>${escapeHtml(item.status)}</td>
      <td>${escapeHtml(item.duration_ms)} ms</td>
      <td>${escapeHtml(item.failed_step_index ?? '-')}</td>
      <td>${artifactLink('result.json', item.result_json)}${artifactLink('report.html', item.artifacts?.report_html)}${artifactLink('screenshot', item.artifacts?.failure_screenshot)}${artifactLink('trace', item.artifacts?.trace)}${artifactLink('video', item.artifacts?.video)}</td>
      <td>${escapeHtml(item.error || '')}</td>
    </tr>
  `).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>CueCast Batch Report ${escapeHtml(summary.batch_id)}</title>
  <style>
    body { margin: 0; padding: 28px; background: #f6f8fb; color: #172033; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
    h1 { margin: 0 0 14px; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 1px; overflow: hidden; margin-bottom: 18px; border: 1px solid #dfe4ee; border-radius: 8px; background: #dfe4ee; }
    .metric { padding: 14px; background: #fff; }
    .metric span { display: block; color: #677085; font-size: 12px; font-weight: 700; }
    .metric strong { display: block; margin-top: 5px; font-size: 18px; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; border: 1px solid #dfe4ee; border-radius: 8px; background: #fff; }
    th, td { padding: 10px; border-bottom: 1px solid #dfe4ee; text-align: left; vertical-align: top; }
    th { color: #677085; font-size: 12px; text-transform: uppercase; }
    tr[data-status="failed"] td { background: #fff2f2; }
    a { display: inline-block; margin: 0 6px 6px 0; color: #2457d6; font-weight: 700; text-decoration: none; }
  </style>
</head>
<body>
  <h1>CueCast Batch Report</h1>
  <section class="summary">
    <div class="metric"><span>Batch</span><strong>${escapeHtml(summary.batch_id)}</strong></div>
    <div class="metric"><span>Status</span><strong>${escapeHtml(summary.status)}</strong></div>
    <div class="metric"><span>Total</span><strong>${escapeHtml(summary.total)}</strong></div>
    <div class="metric"><span>Passed</span><strong>${escapeHtml(summary.passed)}</strong></div>
    <div class="metric"><span>Failed</span><strong>${escapeHtml(summary.failed)}</strong></div>
  </section>
  <table>
    <thead><tr><th>Case</th><th>Status</th><th>Duration</th><th>Failed Step</th><th>Artifacts</th><th>Error</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function artifactLink(label, filePath) {
  if (!filePath) return '';
  return `<a href="${escapeHtml(toArtifactHref(filePath))}">${escapeHtml(label)}</a>`;
}

function toArtifactHref(filePath) {
  const raw = String(filePath || '').replaceAll('\\', '/');
  const marker = 'playwright-runner-artifacts/';
  const index = raw.indexOf(marker);
  if (index >= 0) {
    const relative = raw.slice(index + marker.length);
    return `../../${relative}`;
  }
  return raw;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

main().catch((error) => {
  console.error(`[batch] ${error?.message || error}`);
  process.exitCode = 1;
});
