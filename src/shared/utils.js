import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const workspaceRoot = path.resolve(projectRoot, '..');

export class RunnerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.details = details;
  }
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv);
  const mergedEnv = loadRunnerEnv(argv, env);

  const config = {
    caseId: args['case-id'] || mergedEnv.CUECAST_CASE_ID || '',
    batchId: args['batch-id'] || mergedEnv.CUECAST_BATCH_ID || '',
    runId: args['run-id'] || mergedEnv.CUECAST_RUN_ID || '',
    jobId: args['job-id'] || mergedEnv.CUECAST_JOB_ID || '',
    executionId: args['execution-id'] || mergedEnv.CUECAST_EXECUTION_ID || '',
    projectEnvironmentId: args['project-environment-id'] || mergedEnv.CUECAST_PROJECT_ENVIRONMENT_ID || '',
    apiBase: trimTrailingSlash(args['api-base'] || mergedEnv.CUECAST_API_BASE || 'http://127.0.0.1:4173/api'),
    // 平台任务未传 API 地址时使用 .env 的 admin 协议；旧 test-lab 命令显式传入 mock API 时保持原协议。
    // --admin-api 始终拥有最高优先级，可覆盖这两个默认分支。
    adminApi: parseBoolean(args['admin-api'] ?? (args['api-base'] == null ? mergedEnv.CUECAST_ADMIN_API : false), false),
    token: args.token || mergedEnv.CUECAST_TOKEN || '',
    browser: args.browser || mergedEnv.RUNNER_BROWSER || 'chromium',
    liveFrameQuality: args['live-frame-quality'] || mergedEnv.RUNNER_LIVE_FRAME_QUALITY || 'smooth',
    headed: parseBoolean(args.headed ?? mergedEnv.RUNNER_HEADED, false),
    ignoreHttpsErrors: parseBoolean(args['ignore-https-errors'] ?? mergedEnv.RUNNER_IGNORE_HTTPS_ERRORS, false),
    pageErrorCheckEnabled: parseOptionalBoolean(
      args['page-error-check-enabled'] ?? mergedEnv.RUNNER_PAGE_ERROR_CHECK_ENABLED,
    ),
    sessionMode: args['session-mode'] || mergedEnv.RUNNER_SESSION_MODE || 'isolated',
    storageState: args['storage-state'] || mergedEnv.RUNNER_STORAGE_STATE || mergedEnv.CUECAST_STORAGE_STATE || '',
    storageStateOut: args['storage-state-out'] || '',
    locatorMode: args['locator-mode'] || mergedEnv.RUNNER_LOCATOR_MODE || 'legacy',
    slowMoMs: parseIntegerInRange(args['slow-mo'] ?? mergedEnv.RUNNER_SLOW_MO_MS, 0, 0, 10000, 'slow-mo'),
    finishDelayMs: parseIntegerInRange(args['finish-delay'] ?? mergedEnv.RUNNER_FINISH_DELAY_MS, 0, 0, 600000, 'finish-delay'),
    timeoutMs: parseIntegerInRange(args.timeout ?? mergedEnv.RUNNER_STEP_TIMEOUT_MS, 6000, 1000, 300000, 'timeout'),
    infrastructurePollIntervalMs: parseIntegerInRange(
      args['infrastructure-poll-interval'] ?? mergedEnv.RUNNER_INFRASTRUCTURE_POLL_INTERVAL_MS,
      500,
      100,
      10000,
      'infrastructure-poll-interval',
    ),
    caseTimeoutMs: parseIntegerInRange(args['case-timeout'] ?? mergedEnv.RUNNER_CASE_TIMEOUT_MS, 600000, 10000, 3600000, 'case-timeout'),
    startStep: parseNonNegativeInt(args['start-step'], 0),
    trace: args.trace || mergedEnv.RUNNER_TRACE || 'off',
    video: args.video || mergedEnv.RUNNER_VIDEO || 'off',
    artifactDir: args['artifact-dir'] || mergedEnv.RUNNER_ARTIFACT_DIR || 'artifacts',
    logDir: args['log-dir'] || mergedEnv.RUNNER_LOG_DIR || 'logs',
    localArtifactCleanupEnabled: parseBoolean(mergedEnv.RUNNER_LOCAL_ARTIFACT_CLEANUP_ENABLED, true),
    localArtifactSuccessRetentionHours: parseIntegerInRange(
      mergedEnv.RUNNER_LOCAL_ARTIFACT_SUCCESS_RETENTION_HOURS,
      24,
      1,
      24 * 365,
      'local-artifact-success-retention-hours',
    ),
    localArtifactFailureRetentionDays: parseIntegerInRange(
      mergedEnv.RUNNER_LOCAL_ARTIFACT_FAILURE_RETENTION_DAYS,
      7,
      1,
      3650,
      'local-artifact-failure-retention-days',
    ),
  };

  if (!config.caseId) {
    throw new RunnerError('CONFIG_INVALID', 'Missing required --case-id');
  }
  if (!['chromium', 'firefox', 'webkit'].includes(config.browser)) {
    throw new RunnerError('CONFIG_INVALID', `Unsupported browser: ${config.browser}`);
  }
  if (!['smooth', 'high', 'ultra', '8k'].includes(config.liveFrameQuality)) {
    throw new RunnerError('CONFIG_INVALID', `Unsupported live frame quality: ${config.liveFrameQuality}`);
  }
  if (!['legacy', 'semantic-v1'].includes(config.locatorMode)) {
    throw new RunnerError('CONFIG_INVALID', `Unsupported locator mode: ${config.locatorMode}`);
  }
  if (!['isolated', 'reuse-auth'].includes(config.sessionMode)) {
    throw new RunnerError('CONFIG_INVALID', `Unsupported session mode: ${config.sessionMode}`);
  }
  if (config.sessionMode === 'reuse-auth' && !config.batchId) {
    throw new RunnerError('CONFIG_INVALID', 'reuse-auth session mode requires --batch-id');
  }
  if (config.sessionMode === 'reuse-auth' && !config.storageStateOut) {
    throw new RunnerError('CONFIG_INVALID', 'reuse-auth session mode requires --storage-state-out');
  }
  if (!['off', 'on', 'retain-on-failure'].includes(config.trace)) {
    throw new RunnerError('CONFIG_INVALID', `Unsupported trace policy: ${config.trace}`);
  }
  if (!['off', 'on', 'retain-on-failure'].includes(config.video)) {
    throw new RunnerError('CONFIG_INVALID', `Unsupported video policy: ${config.video}`);
  }
  if (config.caseTimeoutMs < config.timeoutMs) {
    throw new RunnerError('CONFIG_INVALID', 'Case timeout cannot be smaller than step timeout');
  }
  return config;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      args[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

export function loadRunnerEnv(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv);
  const configuredEnvFile = args['env-file'] || env.CUECAST_ENV_FILE || '';
  const envFiles = [
    path.join(workspaceRoot, '.env'),
    path.join(projectRoot, '.env'),
    configuredEnvFile,
  ].filter(Boolean);

  const loaded = {};
  for (const filePath of envFiles) {
    Object.assign(loaded, readEnvFile(filePath));
  }
  return { ...loaded, ...env };
}

function readEnvFile(filePath) {
  const resolved = path.resolve(process.cwd(), String(filePath));
  if (!fs.existsSync(resolved)) return {};
  const content = fs.readFileSync(resolved, 'utf8');
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquoteEnvValue(rawValue);
  }
  return values;
}

function unquoteEnvValue(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

export function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function parseNonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function parseOptionalBoolean(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new RunnerError('CONFIG_INVALID', 'Invalid --page-error-check-enabled: expected true or false');
}

function parseIntegerInRange(value, fallback, min, max, name) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    throw new RunnerError('CONFIG_INVALID', `Invalid --${name}: expected an integer between ${min} and ${max}`);
  }
  return number;
}

export function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatPlatformDateTime(date = new Date()) {
  const parts = platformDateTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatPlatformDateTimeWithMillis(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const parts = platformDateTimeParts(value);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${String(value.getMilliseconds()).padStart(3, '0')}`;
}

export function timestampForPath(date = new Date()) {
  const parts = platformDateTimeParts(date);
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

function platformDateTimeParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  const formattedParts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(formattedParts.map((part) => [part.type, part.value]));
}

export function durationMs(startedAt) {
  return Date.now() - startedAt;
}

export function serializeError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || 'UNKNOWN_ERROR',
    message: error?.message || String(error),
    details: error?.details || {},
    stack: error?.stack || '',
  };
}

export async function withTimeout(promise, timeoutMs, label, options = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      try {
        if (typeof options.onTimeout === 'function') await options.onTimeout();
      } finally {
        reject(new RunnerError(options.code || 'ACTION_TIMEOUT', `${label || 'Operation'} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
