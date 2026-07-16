import { defineConfig } from 'playwright/test';
import { loadRunnerEnv } from './src/shared/utils.js';

const env = loadRunnerEnv();

export default defineConfig({
  testDir: './tests',
  timeout: 600000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    browserName: env.RUNNER_BROWSER || 'chromium',
    headless: env.RUNNER_HEADED !== 'true',
    trace: env.RUNNER_TRACE || 'retain-on-failure',
    video: env.RUNNER_VIDEO || 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1920, height: 1080 },
  },
  outputDir: './artifacts/test-results',
});
