import { DependencyUnavailableError, ValidationError } from '@hmn/shared';

/** Server-side engine adapter. The endpoint is configured by the operator, never by a tenant. */
export class SchedulingEngine {
  private readonly base: URL;

  constructor(url: string, private readonly transport: typeof fetch = fetch) {
    this.base = new URL(url);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) {
      throw new Error('Invalid scheduling engine URL');
    }
    if (this.base.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(this.base.hostname)) {
      throw new Error('Non-local scheduling engines require HTTPS');
    }
    this.base.pathname = this.base.pathname.replace(/\/$/, '') + '/';
  }

  async request<T>(path: string, options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; token?: string } = {}): Promise<T> {
    if (!/^[a-z0-9][a-z0-9/?=&%._-]*$/i.test(path) || path.includes('..')) throw new Error('Invalid engine path');
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.base), {
        method: options.method ?? 'GET',
        headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(8_000), redirect: 'error',
      });
    } catch {
      throw new DependencyUnavailableError('Scheduling engine is unavailable');
    }
    if (!response.ok) {
      if (response.status === 400 || response.status === 409) throw new ValidationError('Scheduling request was rejected', { code: 'SCHEDULING_REJECTED' });
      throw new DependencyUnavailableError('Scheduling engine request failed');
    }
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== 'object' || payload === null || !('data' in payload)) throw new DependencyUnavailableError('Scheduling engine returned an invalid response');
    return (payload as { data: T }).data;
  }
}
