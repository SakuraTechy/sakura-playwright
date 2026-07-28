import fs from 'node:fs/promises';
import path from 'node:path';
import { RunnerError } from '../shared/utils.js';

const SENSITIVE_CLI_OPTIONS = new Set(['--token', '--storage-state', '--storage-state-out']);

export async function loadStorageState(filePath) {
  return (await loadStorageStateBundle(filePath)).storageState;
}

export async function loadStorageStateBundle(filePath) {
  if (!filePath) {
    return {
      storageState: null,
      metadata: {},
      summary: emptyStorageStateSummary(),
    };
  }
  const state = await readStorageStateDocument(filePath);
  const storageState = {
    cookies: state.cookies || [],
    origins: state.origins || [],
  };
  const metadata = state._sakura && typeof state._sakura === 'object' && !Array.isArray(state._sakura)
    ? {
      lastUrl: String(state._sakura.last_url || ''),
      sessionStorage: normalizeSessionStorageState(
        state._sakura.session_storage,
        'STORAGE_STATE_LOAD_FAILED',
      ),
    }
    : {};
  return {
    storageState,
    metadata,
    summary: summarizeStorageState(storageState, '', metadata.sessionStorage),
  };
}

async function readStorageStateDocument(filePath) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  let raw;
  try {
    raw = await fs.readFile(resolvedPath, 'utf8');
  } catch (error) {
    throw new RunnerError('STORAGE_STATE_LOAD_FAILED', 'Unable to read the configured storage state', {
      reason: error?.code || error?.message || String(error),
    });
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new RunnerError('STORAGE_STATE_LOAD_FAILED', 'The configured storage state is not valid JSON');
  }
  validateStorageState(state, 'STORAGE_STATE_LOAD_FAILED');
  return state;
}

export async function saveStorageState(context, filePath, metadata = {}) {
  if (!filePath) return emptyStorageStateSummary();
  let state;
  try {
    // IndexedDB 可能保存 Firebase 等认证令牌，批次复用时必须与 Cookie、localStorage 一并保留。
    state = await context.storageState({ indexedDB: true });
    const lastUrl = String(metadata.lastUrl || '');
    const sessionStorage = normalizeSessionStorageState(
      metadata.sessionStorage,
      'STORAGE_STATE_SAVE_FAILED',
    );
    if (lastUrl || sessionStorage) {
      // 私有元数据仅随服务端临时状态流转；传入 Playwright Context 前会被剥离。
      state._sakura = {
        version: 2,
        ...(lastUrl ? { last_url: lastUrl } : {}),
        ...(sessionStorage ? { session_storage: sessionStorage } : {}),
      };
    }
    await writeStorageStateAtomically(filePath, state);
    return summarizeStorageState(state, '', sessionStorage);
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('STORAGE_STATE_SAVE_FAILED', 'Unable to save the Runner storage state', {
      reason: error?.code || error?.message || String(error),
    });
  }
}

export async function captureSessionStorage(page) {
  if (!page || page.isClosed()) return null;
  try {
    const state = await page.evaluate(() => ({
      origin: window.location.origin,
      entries: Object.entries(window.sessionStorage).map(([name, value]) => ({ name, value })),
    }));
    return normalizeSessionStorageState(state, 'STORAGE_STATE_SAVE_FAILED');
  } catch (error) {
    throw new RunnerError('STORAGE_STATE_SAVE_FAILED', 'Unable to capture the Runner sessionStorage state', {
      reason: error?.message || String(error),
    });
  }
}

export async function restoreSessionStorage(context, state) {
  const sessionStorage = normalizeSessionStorageState(state, 'STORAGE_STATE_LOAD_FAILED');
  if (!sessionStorage) return 0;
  try {
    await context.addInitScript(({ origin, entries }) => {
      if (window.top !== window || window.location.origin !== origin) return;
      for (const entry of entries) {
        window.sessionStorage.setItem(entry.name, entry.value);
      }
    }, sessionStorage);
    return sessionStorage.entries.length;
  } catch (error) {
    throw new RunnerError('STORAGE_STATE_LOAD_FAILED', 'Unable to restore the Runner sessionStorage state', {
      reason: error?.message || String(error),
    });
  }
}

export async function writeStorageStateAtomically(filePath, state) {
  validateStorageState(state, 'STORAGE_STATE_SAVE_FAILED');
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const directory = path.dirname(resolvedPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, resolvedPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw new RunnerError('STORAGE_STATE_SAVE_FAILED', 'Unable to write the Runner storage state atomically', {
      reason: error?.code || error?.message || String(error),
    });
  }
}

export async function promoteStorageState(candidatePath, currentPath) {
  const state = await readStorageStateDocument(candidatePath);
  await writeStorageStateAtomically(currentPath, state);
  await fs.rm(path.resolve(process.cwd(), candidatePath), { force: true });
}

export function resolveSessionStartUrl(recordedStartUrl, lastUrl, options = {}) {
  const fallback = {
    url: recordedStartUrl,
    resumed: false,
    reason: 'recorded-start-url',
  };
  if (options.sessionMode !== 'reuse-auth' || !options.authStateLoaded || !lastUrl) return fallback;
  try {
    const recorded = new URL(recordedStartUrl);
    const previous = new URL(lastUrl);
    if (recorded.origin !== previous.origin) return { ...fallback, reason: 'different-origin' };
    if (!isAuthenticationUrl(recorded)) {
      return { ...fallback, reason: 'recorded-url-not-authentication' };
    }
    if (isAuthenticationUrl(previous)) return { ...fallback, reason: 'previous-url-still-authentication' };
    return {
      url: previous.href,
      resumed: true,
      reason: 'resume-previous-page',
    };
  } catch {
    return { ...fallback, reason: 'invalid-url' };
  }
}

export function isLikelyAuthenticationUrl(value) {
  try {
    return isAuthenticationUrl(new URL(value));
  } catch {
    return false;
  }
}

export function summarizeStorageState(state, expectedOrigin = '', sessionStorageState = null) {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const origins = Array.isArray(state?.origins) ? state.origins : [];
  const sessionStorageEntries = Array.isArray(sessionStorageState?.entries)
    ? sessionStorageState.entries.length
    : 0;
  const localStorageEntries = origins.reduce(
    (total, item) => total + (Array.isArray(item?.localStorage) ? item.localStorage.length : 0),
    0,
  );
  const indexedDatabases = origins.reduce(
    (total, item) => total + (Array.isArray(item?.indexedDB) ? item.indexedDB.length : 0),
    0,
  );
  return {
    cookies: cookies.length,
    origins: origins.length,
    localStorageEntries,
    indexedDatabases,
    sessionStorageEntries,
    expectedOriginMatched: expectedOrigin
      ? origins.some((item) => String(item?.origin || '') === expectedOrigin)
        || cookies.some((cookie) => cookieMatchesOrigin(cookie, expectedOrigin))
      : null,
  };
}

export function safeUrlForLog(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '-';
  }
}

export function redactSensitiveCliArgs(args) {
  const redacted = [];
  let maskNext = false;
  for (const raw of args || []) {
    const value = String(raw);
    if (maskNext) {
      redacted.push('***');
      maskNext = false;
      continue;
    }
    const eq = value.indexOf('=');
    const option = eq >= 0 ? value.slice(0, eq) : value;
    if (!SENSITIVE_CLI_OPTIONS.has(option)) {
      redacted.push(value);
      continue;
    }
    if (eq >= 0) {
      redacted.push(`${option}=***`);
    } else {
      redacted.push(option);
      maskNext = true;
    }
  }
  return redacted;
}

function validateStorageState(state, errorCode) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new RunnerError(errorCode, 'The Runner storage state must be a JSON object');
  }
  if (state.cookies != null && !Array.isArray(state.cookies)) {
    throw new RunnerError(errorCode, 'The Runner storage state cookies field must be an array');
  }
  if (state.origins != null && !Array.isArray(state.origins)) {
    throw new RunnerError(errorCode, 'The Runner storage state origins field must be an array');
  }
  if (state._sakura != null) {
    if (typeof state._sakura !== 'object' || Array.isArray(state._sakura)) {
      throw new RunnerError(errorCode, 'The Runner private storage state metadata must be an object');
    }
    normalizeSessionStorageState(state._sakura.session_storage, errorCode);
  }
}

function emptyStorageStateSummary() {
  return {
    cookies: 0,
    origins: 0,
    localStorageEntries: 0,
    indexedDatabases: 0,
    sessionStorageEntries: 0,
    expectedOriginMatched: null,
  };
}

function normalizeSessionStorageState(value, errorCode) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerError(errorCode, 'The Runner sessionStorage state must be an object');
  }
  let origin;
  try {
    const parsedOrigin = new URL(String(value.origin || ''));
    if (!['http:', 'https:'].includes(parsedOrigin.protocol)) throw new Error('unsupported protocol');
    origin = parsedOrigin.origin;
  } catch {
    throw new RunnerError(errorCode, 'The Runner sessionStorage state origin is invalid');
  }
  if (!Array.isArray(value.entries)) {
    throw new RunnerError(errorCode, 'The Runner sessionStorage state entries field must be an array');
  }
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
      throw new RunnerError(errorCode, 'Each Runner sessionStorage entry must contain string name and value fields');
    }
    return { name: entry.name, value: entry.value };
  });
  return { origin, entries };
}

function isAuthenticationUrl(url) {
  return /(^|[/#?_.-])(login|logon|signin|sign-in|auth|sso)\d*([/#?_.-]|$)/i
    .test(`${url.pathname}${url.hash}`);
}

function cookieMatchesOrigin(cookie, origin) {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
    return Boolean(domain) && (hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
