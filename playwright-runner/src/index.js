#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { ApiClient } from './api-client.js';
import { normalizeCase, resolveViewport, shouldLaunchMaximized } from './case-loader.js';
import { runStep } from './step-runner.js';
import {
  collectFailureArtifacts,
  collectVideoArtifact,
  createRunArtifacts,
  writeConsoleLog,
  writeHtmlReport,
  writeJson,
} from './artifacts.js';
import {
  attachCaseInfo,
  createRunResult,
  finalizeRunResult,
  markRunFailed,
  markRunPassed,
  markStepFailed,
  reportRunResult,
} from './result-reporter.js';
import { parseArgs, RunnerError, serializeError, sleep, withTimeout } from './utils.js';

const browserTypes = { chromium, firefox, webkit };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const focusExtensionPath = path.resolve(__dirname, '..', 'focus-extension');

async function main() {
  const config = parseArgs();
  const startedAt = Date.now();
  const artifacts = await createRunArtifacts({ artifactDir: config.artifactDir, caseId: config.caseId });
  const api = new ApiClient({ apiBase: config.apiBase, token: config.token });
  const result = createRunResult({ config, artifacts, startedAt });

  let browser;
  let context;
  let page;
  let activePage;
  const consoleEvents = [];
  const networkEvents = [];

  try {
    const testCaseRaw = await api.getTestCase(config.caseId);
    const testCase = normalizeCase(testCaseRaw, { caseId: config.caseId, startStep: config.startStep });
    attachCaseInfo(result, testCase);

    const launchArgs = [];
    if (shouldLaunchMaximized(testCase, { headed: config.headed })) {
      launchArgs.push('--start-maximized');
    }
    const contextOptions = {
      viewport: resolveViewport(testCase, { headed: config.headed }),
      acceptDownloads: true,
      recordVideo: shouldRecordVideo(config.video) ? { dir: artifacts.runDir } : undefined,
    };

    if (shouldUseFocusExtension(config)) {
      await fs.mkdir(path.join(artifacts.runDir, 'browser-profile'), { recursive: true });
      launchArgs.push(
        `--disable-extensions-except=${focusExtensionPath}`,
        `--load-extension=${focusExtensionPath}`,
        '--new-window',
      );
      context = await chromium.launchPersistentContext(path.join(artifacts.runDir, 'browser-profile'), {
        ...contextOptions,
        headless: false,
        slowMo: config.slowMoMs,
        args: launchArgs,
      });
    } else {
      const launchOptions = { headless: !config.headed, slowMo: config.slowMoMs };
      if (launchArgs.length) launchOptions.args = launchArgs;
      browser = await browserTypes[config.browser].launch(launchOptions);
      context = await browser.newContext(contextOptions);
    }
    if (shouldStartTrace(config.trace)) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    }
    page = context.pages().find((candidate) => !candidate.isClosed()) || await context.newPage();
    attachPageDiagnostics(page, consoleEvents);
    attachNetworkRecorder(page, networkEvents);
    activePage = page;

    await withTimeout(page.goto(testCase.start_url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs }), config.timeoutMs, 'Initial navigation');
    if (config.headed) {
      await page.bringToFront().catch(() => {});
      console.log('[runner] headed page ready');
    }

    for (const step of testCase.steps) {
      const stepStartedAt = Date.now();
      try {
        const stepResult = await withTimeout(runStep(activePage, testCase, step, {
          timeoutMs: config.timeoutMs,
          artifacts,
          apiBase: config.apiBase,
          networkEvents,
          mainPage: page,
          activePage,
          getPages: () => context.pages(),
          onPageOpened: (openedPage) => {
            attachPageDiagnostics(openedPage, consoleEvents);
            attachNetworkRecorder(openedPage, networkEvents);
          },
        }), config.timeoutMs + Math.max(0, step.wait_before), `Step ${step.step_index}`);
        if (stepResult._activePage) {
          activePage = stepResult._activePage;
          delete stepResult._activePage;
          if (config.headed) await activePage.bringToFront().catch(() => {});
        }
        result.steps.push(stepResult);
      } catch (error) {
        markStepFailed(result, step, error, stepStartedAt);
        throw error;
      }
    }

    markRunPassed(result);
  } catch (error) {
    markRunFailed(result, error);
    await collectFailureArtifacts(activePage || page, artifacts, result);
  } finally {
    if (config.finishDelayMs > 0 && context) {
      await sleep(config.finishDelayMs).catch(() => {});
    }
    if (context && shouldStartTrace(config.trace)) {
      const keepTrace = shouldKeepArtifact(config.trace, result.success);
      await context.tracing.stop(keepTrace ? { path: artifacts.tracePath } : {}).catch(() => {});
      if (keepTrace) result.artifacts.trace = artifacts.tracePath;
    }
    if (context) await context.close().catch(() => {});
    await collectVideoArtifact(activePage || page, result, shouldKeepArtifact(config.video, result.success)).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    finalizeRunResult(result, startedAt);
    await writeConsoleLog(artifacts, result, consoleEvents).catch(() => {});
    await writeHtmlReport(artifacts, result).catch(() => {});
    await writeJson(artifacts.resultPath, result);
    await reportRunResult(api, config.caseId, result).catch((error) => {
      console.warn('[runner] failed to report result:', error?.message || error);
    });
  }

  console.log(`[runner] ${result.status} case=${config.caseId} duration=${result.duration_ms}ms artifacts=${artifacts.runDir}`);
  if (!result.success) {
    process.exitCode = 1;
  }
}

function shouldStartTrace(mode) {
  return ['on', 'retain-on-failure'].includes(String(mode || '').toLowerCase());
}

function shouldRecordVideo(mode) {
  return ['on', 'retain-on-failure'].includes(String(mode || '').toLowerCase());
}

function shouldUseFocusExtension(config) {
  return config.headed && config.browser === 'chromium';
}

function shouldKeepArtifact(mode, success) {
  const raw = String(mode || '').toLowerCase();
  if (raw === 'on') return true;
  if (raw === 'retain-on-failure') return !success;
  return false;
}

function attachPageDiagnostics(page, events) {
  page.on('console', (message) => {
    events.push({
      type: 'console',
      level: message.type(),
      text: message.text().slice(0, 2000),
      location: message.location(),
      timestamp: new Date().toISOString(),
    });
  });
  page.on('pageerror', (error) => {
    events.push({
      type: 'pageerror',
      level: 'error',
      text: (error?.message || String(error)).slice(0, 2000),
      timestamp: new Date().toISOString(),
    });
  });
  page.on('requestfailed', (request) => {
    events.push({
      type: 'requestfailed',
      level: 'warn',
      text: request.url().slice(0, 2000),
      failure: request.failure()?.errorText || '',
      timestamp: new Date().toISOString(),
    });
  });
}

function attachNetworkRecorder(page, events) {
  page.on('request', (request) => {
    events.push({
      url: request.url(),
      method: request.method(),
      post_data: request.postData() || '',
      headers: request.headers(),
      timestamp: new Date().toISOString(),
    });
  });
}

main().catch((error) => {
  const serialized = serializeError(error instanceof Error ? error : new RunnerError('UNKNOWN_ERROR', String(error)));
  console.error(`[runner] ${serialized.code}: ${serialized.message}`);
  process.exitCode = 1;
});
