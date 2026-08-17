#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { parseBoolean, parseCliArgs, parseNonNegativeInt } from './shared/utils.js';

const browserTypes = { chromium, firefox, webkit };

async function main() {
  const args = parseCliArgs();
  const browserName = args.browser || 'chromium';
  const endpointFile = String(args['endpoint-file'] || '').trim();
  const headed = parseBoolean(args.headed, false);
  const ignoreHTTPSErrors = parseBoolean(args['ignore-https-errors'], false);
  const slowMo = parseNonNegativeInt(args['slow-mo'], 0);
  const video = String(args.video || 'off').trim().toLowerCase();
  const recordingManifestFile = String(args['recording-manifest-file'] || '').trim();
  if (!browserTypes[browserName]) throw new Error(`Unsupported browser: ${browserName}`);
  if (!endpointFile) throw new Error('Missing required --endpoint-file');

  const launchArgs = headed && browserName === 'chromium' ? ['--start-maximized'] : [];
  const browser = await browserTypes[browserName].launch({
    headless: !headed,
    slowMo,
    ...(launchArgs.length ? { args: launchArgs } : {}),
  });
  const recordingStartedAt = Date.now();
  const recordVideo = video === 'on' || video === 'retain-on-failure';
  const context = await browser.newContext({
    ignoreHTTPSErrors,
    ...(headed ? { viewport: null } : {}),
    ...(recordVideo ? {
      recordVideo: {
        dir: path.dirname(path.resolve(recordingManifestFile || endpointFile)),
        ...(headed && browserName === 'chromium'
          ? { size: { width: 1920, height: 991 } }
          : {}),
      },
    } : {}),
  });
  const page = await context.newPage();

  // Context 由宿主持有；各用例 Runner 只连接并断开，不能关闭共享页面。
  const { endpoint } = await browser.bind('sakura-reuse-browser', { host: '127.0.0.1', port: 0 });
  await writeEndpoint(endpointFile, {
    endpoint,
    browser: browserName,
    pid: process.pid,
    recording_started_at: recordingStartedAt,
  });
  console.log('[browser-session] ready');

  await new Promise((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const videoHandle = page.video?.();
      await context.close().catch(() => {});
      const videoPath = videoHandle ? await videoHandle.path().catch(() => '') : '';
      if (recordingManifestFile) {
        await writeEndpoint(recordingManifestFile, {
          video_path: videoPath || null,
          started_at: recordingStartedAt,
          finished_at: Date.now(),
          video_size: headed && browserName === 'chromium' ? { width: 1920, height: 991 } : null,
        }).catch(() => {});
      }
      await browser.close().catch(() => {});
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (String(chunk).includes('stop')) stop();
    });
    browser.once('disconnected', resolve);
  });
}

async function writeEndpoint(filePath, value) {
  const resolved = path.resolve(filePath);
  const temporary = `${resolved}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, resolved);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(`[browser-session] ${error?.message || error}`);
  process.exitCode = 1;
});
