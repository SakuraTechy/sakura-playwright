#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ApiClient } from './api/api-client.js';
import { reportRunResult } from './reporting/result-reporter.js';
import { loadRunnerEnv, parseBoolean, parseCliArgs, resolveAdminApiBase, resolveAdminApiEnabled, trimTrailingSlash } from './shared/utils.js';

async function main() {
  const args = parseCliArgs();
  const sessionDirectory = path.resolve(String(args['session-dir'] || '').trim());
  if (!sessionDirectory) throw new Error('Missing required --session-dir');
  const env = loadRunnerEnv(process.argv.slice(2), process.env);
  const videoPolicy = String(args.video || env.RUNNER_VIDEO || 'retain-on-failure').trim();
  const ffmpegPath = args['ffmpeg-path'] || env.FFMPEG_PATH || 'ffmpeg';
  const recording = await readJson(path.join(sessionDirectory, 'recording.json'));
  if (!recording?.video_path) {
    console.warn('[batch-video] 未找到批次原生录屏清单，跳过切片');
    return;
  }
  const casesDirectory = path.join(sessionDirectory, 'cases');
  const caseEntries = (await fs.readdir(casesDirectory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  let failedCount = 0;
  const api = parseBoolean(args['admin-api'] ?? resolveAdminApiEnabled(env), false)
    ? new ApiClient({
        apiBase: trimTrailingSlash(args['api-base'] || resolveAdminApiBase(env)),
        token: args.token || env.CUECAST_TOKEN || '',
        accessKey: env.SAKURA_ADMIN_ACCESS_KEY || env.CUECAST_ACCESS_KEY || '',
        secretKey: env.SAKURA_ADMIN_SECRET_KEY || env.CUECAST_SECRET_KEY || '',
        adminApi: true,
        executionCapability: args['execution-capability'] || env.CUECAST_EXECUTION_CAPABILITY || '',
      })
    : null;
  for (const entry of caseEntries) {
    const metadata = await readJson(path.join(casesDirectory, entry.name));
    if (!metadata || !shouldKeepVideo(metadata.video_policy || videoPolicy, metadata.success) || !metadata.artifact_dir) continue;
    const result = await readJson(metadata.result_json);
    if (!result) continue;
    const outputPath = path.join(metadata.artifact_dir, 'video.webm');
    try {
      await sliceVideo(recording.video_path, outputPath, recording.started_at, metadata.started_at, metadata.finished_at, ffmpegPath);
      result.artifacts = { ...(result.artifacts || {}), video: outputPath, videos: [outputPath] };
      result.raw = {
        ...(result.raw || {}),
        batch_video_pending: false,
        ...(recording.video_size ? { video_capture_size: recording.video_size } : {}),
        batch_video_source: recording.video_path,
        batch_video_slice: {
          started_at_epoch_ms: metadata.started_at,
          finished_at_epoch_ms: metadata.finished_at,
        },
      };
      if (api && result.run_id != null) {
        const uploaded = await api.uploadArtifact(result.run_id, 'video', outputPath);
        if (uploaded?.url) result.artifacts.video = uploaded.url;
        if (uploaded?.fileId) {
          result.artifact_file_ids = { ...(result.artifact_file_ids || {}), video: uploaded.fileId };
        }
        await reportRunResult(api, String(result.case_id ?? metadata.case_id), result);
      }
      await writeJson(metadata.result_json, result);
      console.log(`[batch-video] sliced case=${metadata.case_id} output=${outputPath}`);
    } catch (error) {
      failedCount += 1;
      result.raw = { ...(result.raw || {}), batch_video_error: error?.message || String(error) };
      await writeJson(metadata.result_json, result);
      console.error(`[batch-video] case=${metadata.case_id} failed: ${error?.message || error}`);
    }
  }
  // 每个用例失败都会被记录，最终仍需用非零退出码通知 Admin 批次切片未完成。
  if (failedCount > 0) process.exitCode = 1;
}

function shouldKeepVideo(policy, success) {
  return policy === 'on' || (policy === 'retain-on-failure' && !success);
}

async function sliceVideo(sourcePath, outputPath, recordingStartedAt, startedAt, finishedAt, ffmpegPath) {
  const startSeconds = Math.max(0, (Number(startedAt) - Number(recordingStartedAt)) / 1000 - 0.2);
  const durationSeconds = Math.max(0.2, (Number(finishedAt) - Number(startedAt)) / 1000 + 0.4);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runFfmpeg(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', startSeconds.toFixed(3), '-i', sourcePath,
    '-t', durationSeconds.toFixed(3), '-map', '0:v:0', '-an',
    '-c', 'copy', '-avoid_negative_ts', 'make_zero', outputPath,
  ]);
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath || 'ffmpeg', args, { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => reject(new Error(`批次视频切片需要 ffmpeg：${error.message}`)));
    child.once('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg 视频切片失败（退出码=${code}）：${stderr.trim()}`));
    });
  });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  console.error(`[batch-video] ${error?.message || error}`);
  process.exitCode = 1;
});
