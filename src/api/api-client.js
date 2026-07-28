import fs from 'node:fs';
import path from 'node:path';
import { RunnerError } from '../shared/utils.js';

export class ApiClient {
  constructor({ apiBase, token = '', timeoutMs = 30000, adminApi = false, projectEnvironmentId = '' }) {
    this.apiBase = apiBase;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.adminApi = adminApi;
    this.projectEnvironmentId = projectEnvironmentId;
  }

  async request(method, path, body = undefined) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      // admin 使用 Sa-Token 的 Bearer 认证；旧 test-lab API 继续使用原始 token 兼容协议。
      headers.Authorization = this.adminApi && !/^Bearer\s+/i.test(this.token)
        ? `Bearer ${this.token}`
        : this.token;
    }

    try {
      const bases = [this.apiBase];
      // 前端开发代理常使用 /api，但当前 Spring 服务本身没有该 context-path。
      // 配置未及时更新时，404 自动回退到直连地址，避免 Runner 被代理前缀阻断。
      if (this.adminApi && /\/api$/i.test(this.apiBase)) {
        bases.push(this.apiBase.slice(0, -4));
      }
      for (let index = 0; index < bases.length; index += 1) {
        const base = bases[index];
        const res = await fetch(`${base}${path}`, {
          method,
          headers,
          signal: controller.signal,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          if (res.status === 404 && index < bases.length - 1) continue;
          throw new RunnerError('INFRA_API_FAILED', `API ${method} ${path} failed with HTTP ${res.status}`, { payload });
        }
        const success = payload && (payload.success === true || payload.code === 0 || payload.code === '0');
        if (!success) {
          if ((res.status === 404 || String(payload?.code) === '404') && index < bases.length - 1) continue;
          const message = payload?.message || payload?.msg || payload?.error || `API ${method} ${path} failed`;
          throw new RunnerError('INFRA_API_FAILED', `${message} (code=${payload?.code ?? 'unknown'})`, { payload });
        }
        return payload;
      }
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
    let path = this.adminApi
      ? `/automation/playwright/testcases/${encodeAdminCasePath(caseId)}`
      : `/testcases/${encodeURIComponent(caseId)}?raw_values=1`;
    if (this.adminApi && this.projectEnvironmentId) {
      path += `?projectEnvironmentId=${encodeURIComponent(this.projectEnvironmentId)}`;
    }
    const res = await this.request('GET', path);
    return res.data;
  }

  async saveResult(caseId, result) {
    const path = this.adminApi
      ? `/automation/playwright/testcases/${encodeAdminCasePath(caseId)}/results`
      : `/testcases/${encodeURIComponent(caseId)}/results`;
    const res = await this.request('POST', path, result);
    return res.data;
  }

  async uploadArtifact(runId, artifactType, filePath) {
    if (!this.adminApi) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 120000));
    const form = new FormData();
    form.append('runId', runId);
    form.append('artifactType', artifactType);
    form.append('file', await fs.openAsBlob(filePath), path.basename(filePath));
    const headers = {};
    if (this.token) {
      headers.Authorization = !/^Bearer\s+/i.test(this.token) ? `Bearer ${this.token}` : this.token;
    }
    try {
      const bases = [this.apiBase];
      if (/\/api$/i.test(this.apiBase)) bases.push(this.apiBase.slice(0, -4));
      for (let index = 0; index < bases.length; index += 1) {
        const res = await fetch(`${bases[index]}/automation/playwright/artifacts`, {
          method: 'POST',
          headers,
          body: form,
          signal: controller.signal,
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !(payload && (payload.success === true || payload.code === 0 || payload.code === '0'))) {
          if ((res.status === 404 || String(payload?.code) === '404') && index < bases.length - 1) continue;
          const message = payload?.message || payload?.msg || `artifact upload failed with HTTP ${res.status}`;
          throw new RunnerError('INFRA_ARTIFACT_UPLOAD_FAILED', message, { payload, artifactType });
        }
        return payload.data;
      }
      return null;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new RunnerError('INFRA_ARTIFACT_UPLOAD_FAILED', `artifact upload timed out: ${artifactType}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async pushLiveFrame(jobId, frame) {
    if (!this.adminApi || !jobId) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 10000));
    const headers = { 'Content-Type': 'image/jpeg' };
    if (this.token) {
      headers.Authorization = !/^Bearer\s+/i.test(this.token) ? `Bearer ${this.token}` : this.token;
    }
    try {
      const bases = [this.apiBase];
      if (/\/api$/i.test(this.apiBase)) bases.push(this.apiBase.slice(0, -4));
      for (let index = 0; index < bases.length; index += 1) {
        const res = await fetch(`${bases[index]}/automation/playwright/runner/jobs/${encodeURIComponent(jobId)}/live-frame`, {
          method: 'PUT',
          headers,
          body: frame,
          signal: controller.signal,
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !(payload && (payload.success === true || payload.code === 0 || payload.code === '0'))) {
          if ((res.status === 404 || String(payload?.code) === '404') && index < bases.length - 1) continue;
          const message = payload?.message || payload?.msg || `live frame upload failed with HTTP ${res.status}`;
          throw new RunnerError('INFRA_LIVE_FRAME_FAILED', message, { payload });
        }
        return payload.data;
      }
      return null;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new RunnerError('INFRA_LIVE_FRAME_FAILED', 'live frame upload timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function encodeAdminCasePath(caseKey) {
  // 使用两个 URL 路径段，避免 sceneId:caseId 中的冒号被网关或 Spring 路由编码后无法匹配。
  const parts = String(caseKey ?? '').split(':');
  if (parts.length < 2) return encodeURIComponent(caseKey);
  const sceneKey = parts.shift();
  return `${encodeURIComponent(sceneKey)}/${encodeURIComponent(parts.join(':'))}`;
}

