import { OpsError } from './result.js';
import { assertAllowedRequest, type AllowedRoute } from './allowlist.js';

export class BoundedHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes: number,
    private readonly provider: string,
    private readonly allowedRoutes: readonly AllowedRoute[],
  ) {}

  async get(path: string, parameters: Record<string, string> = {}): Promise<{ body: unknown; bytes: number }> {
    return this.request('GET', path, parameters);
  }

  async post(path: string, body: unknown): Promise<{ body: unknown; bytes: number }> {
    return this.request('POST', path, {}, body);
  }

  private async request(method: 'GET' | 'POST', path: string, parameters: Record<string, string>,
    body?: unknown): Promise<{ body: unknown; bytes: number }> {
    const base = new URL(this.baseUrl);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !path.startsWith('/')) {
      throw new OpsError('INVALID_REQUEST', `${this.provider}: invalid request path`);
    }
    assertAllowedRequest(this.provider, method, url.pathname, this.allowedRoutes);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OpsError('NETWORK', `${this.provider}: request timed out or could not connect`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new OpsError('PERMISSION', `${this.provider}: read permission denied; check the provider permission guide`);
    }
    if (response.status === 429) throw new OpsError('RATE_LIMIT', `${this.provider}: rate limited; retry later`);
    if (response.status === 404) throw new OpsError('NOT_FOUND', `${this.provider}: public resource not found`);
    if (!response.ok) throw new OpsError('UPSTREAM', `${this.provider}: upstream returned HTTP ${response.status}`);
    if (this.provider === 'Uptime Kuma' && response.headers.get('content-type')?.includes('text/html')) {
      throw new OpsError('NOT_FOUND', 'Uptime Kuma: public status page not found');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw new OpsError('RESPONSE_LIMIT', `${this.provider}: response exceeds configured byte cap`);
    }
    if (!response.body) throw new OpsError('UPSTREAM', `${this.provider}: empty response body`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.maxResponseBytes) {
          void reader.cancel().catch(() => undefined);
          throw new OpsError('RESPONSE_LIMIT', `${this.provider}: response exceeds configured byte cap`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, bytes };
    } catch {
      throw new OpsError('UPSTREAM', `${this.provider}: invalid JSON response`);
    }
  }
}
