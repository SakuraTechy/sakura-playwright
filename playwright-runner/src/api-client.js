import { RunnerError } from './utils.js';

export class ApiClient {
  constructor({ apiBase, token = '', timeoutMs = 30000 }) {
    this.apiBase = apiBase;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body = undefined) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    try {
      const res = await fetch(`${this.apiBase}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new RunnerError('INFRA_API_FAILED', `API ${method} ${path} failed with HTTP ${res.status}`, { payload });
      }
      if (!payload || payload.code !== 0) {
        throw new RunnerError('INFRA_API_FAILED', payload?.message || `API ${method} ${path} failed`, { payload });
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new RunnerError('INFRA_API_FAILED', `API ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async getTestCase(caseId) {
    const res = await this.request('GET', `/testcases/${encodeURIComponent(caseId)}?raw_values=1`);
    return res.data;
  }

  async saveResult(caseId, result) {
    const res = await this.request('POST', `/testcases/${encodeURIComponent(caseId)}/results`, result);
    return res.data;
  }
}

