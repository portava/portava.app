import { requestDeadline } from '../lib/requestDeadline.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope, viewerKeyForToken } from './discoveryViewerScope.ts';

export type ServiceResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'json'>;
export interface ServiceRequest {
  signal: AbortSignal;
  wait<T>(start: () => PromiseLike<T>): Promise<T>;
  token(source: () => Promise<string | null>): Promise<string | null>;
  fetch(url: string, init?: RequestInit): Promise<ServiceResponse>;
}

/** One budget for auth, headers and decoding. Never retries a write. The
 * initiating viewer/visibility scope must still own the result at every stage. */
export async function withServiceRequest<T>(
  work: (request: ServiceRequest) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const scope = currentDiscoveryScope();
  const budget = requestDeadline(options.timeoutMs ?? 15_000, options.signal);
  const current = () => {
    if (!isCurrentDiscoveryScope(scope)) throw new Error('The signed-in account or visibility changed. Reload to continue.');
  };
  const wait: ServiceRequest['wait'] = async (start) => {
    current();
    const value = await budget.wait(() => Promise.resolve(start()));
    current();
    return value;
  };
  const request: ServiceRequest = {
    signal: budget.signal,
    wait,
    async token(source) {
      const token = await wait(source);
      if (token && scope.viewer && viewerKeyForToken(token) !== scope.viewer) {
        throw new Error('The signed-in account changed. Reload to continue.');
      }
      return token;
    },
    async fetch(url, init = {}) {
      const response = await wait(() => globalThis.fetch(url, {
        ...init, signal: budget.signal, redirect: 'error',
      }));
      if (response.redirected || response.url && response.url !== url) throw new Error('API request redirected.');
      return {
        ok: response.ok, status: response.status, headers: response.headers,
        json: () => wait(() => response.json()),
      };
    },
  };
  try { return await wait(() => work(request)); }
  finally { budget.dispose(); }
}
