import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const finalizerEntry = path.join(projectRoot, 'src', 'batch-video-finalizer.js');

test('batch video finalizer exits non-zero when ffmpeg cannot slice a case', async () => {
  const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-batch-video-'));
  try {
    const casesDirectory = path.join(sessionDirectory, 'cases');
    const artifactDirectory = path.join(sessionDirectory, 'artifacts', 'case-1');
    const resultPath = path.join(artifactDirectory, 'result.json');
    await fs.mkdir(casesDirectory, { recursive: true });
    await fs.mkdir(artifactDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionDirectory, 'recording.json'), JSON.stringify({
      video_path: path.join(sessionDirectory, 'batch.webm'),
      started_at: 1000,
    }));
    await fs.writeFile(resultPath, JSON.stringify({ case_id: 'case-1', success: false }));
    await fs.writeFile(path.join(casesDirectory, 'case-1.json'), JSON.stringify({
      case_id: 'case-1',
      success: false,
      video_policy: 'on',
      artifact_dir: artifactDirectory,
      result_json: resultPath,
      started_at: 1000,
      finished_at: 2000,
    }));

    const output = await runFinalizer(sessionDirectory, path.join(sessionDirectory, 'missing-ffmpeg'));
    assert.equal(output.exitCode, 1);
    assert.match(output.stdout, /case=case-1 failed/);
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    assert.match(result.raw.batch_video_error, /批次视频切片需要 ffmpeg/);
  } finally {
    await fs.rm(sessionDirectory, { recursive: true, force: true });
  }
});

function runFinalizer(sessionDirectory, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      finalizerEntry,
      '--session-dir', sessionDirectory,
      '--ffmpeg-path', ffmpegPath,
      '--admin-api', 'false',
    ], { cwd: projectRoot, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stdout += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout }));
  });
}
