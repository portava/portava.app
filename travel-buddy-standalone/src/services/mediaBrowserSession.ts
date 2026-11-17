import { requestDeadline } from '../lib/requestDeadline.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope, onDiscoveryScopeChange, type DiscoveryScope } from './discoveryViewerScope.ts';

type SessionTransport = {
  origin: () => string | null;
  tokenFor: (viewerId: string) => Promise<string | null>;
  fetch: typeof fetch;
  timeoutMs?: number;
  renew?: boolean;
};

/** The cookie is only a transport for native browser media elements, which
 * cannot send Authorization headers. There is no secondary auth/session store.
 * Writes are serialized so a sign-out clear follows pending installation, and
 * current account scope is checked before and after every asynchronous stage. */
export function createMediaBrowserSessionTransport(deps: SessionTransport) {
  let sequence = Promise.resolve<unknown>(undefined);
  let active: AbortController | null = null;
  let attempted = false;
  let disposed = false;
  let lease: { scope: DiscoveryScope; expiresAt: number } | null = null;
  let pending: { key: string; result: Promise<boolean> } | null = null;
  let clearing: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function endpoint(): string | null {
    try {
      const origin = deps.origin();
      if (!origin) return null;
      const api = new URL(process.env.EXPO_PUBLIC_API_BASE_URL || origin);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
      if (api.origin !== origin || api.username || api.password || api.search || api.hash || api.pathname !== '/'
        || api.protocol !== 'https:' && !(api.protocol === 'http:' && local)) return null;
      return `${api.origin}/api/media/file/session`;
    } catch { return null; }
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = sequence.then(work, work);
    sequence = result.catch(() => {});
    return result;
  }

  function clear(): Promise<boolean> {
    clearTimeout(timer); lease = null; active?.abort(); pending = null;
    if (clearing) return clearing;
    if (!attempted) return Promise.resolve(true);
    const result = enqueue(async () => {
      const target = endpoint();
      if (!target) return false;
      const budget = requestDeadline(deps.timeoutMs ?? 10_000);
      try {
        const r = await budget.wait(() => deps.fetch(target, { method: 'DELETE', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: budget.signal }));
        const cleared = r.status === 204 && !r.redirected && (!r.url || r.url === target);
        if (cleared) attempted = false;
        return cleared;
      } catch { return false; }
      finally { budget.dispose(); }
    });
    clearing = result;
    void result.finally(() => { if (clearing === result) clearing = null; });
    return result;
  }

  function ensure(viewerId: string): Promise<boolean> {
    const scope = currentDiscoveryScope();
    const target = endpoint();
    if (disposed || !target || scope.viewer !== `u:${viewerId}`) return Promise.resolve(false);
    if (lease && isCurrentDiscoveryScope(lease.scope) && lease.expiresAt > Date.now() + 15_000) return Promise.resolve(true);
    const key = JSON.stringify(scope);
    if (pending?.key === key) return pending.result;
    const result = enqueue(async () => {
      if (disposed || !isCurrentDiscoveryScope(scope)) return false;
      const cancellation = new AbortController();
      active = cancellation;
      const budget = requestDeadline(deps.timeoutMs ?? 10_000, cancellation.signal);
      const current = () => !disposed && !cancellation.signal.aborted && isCurrentDiscoveryScope(scope);
      try {
        const token = await budget.wait(() => deps.tokenFor(viewerId));
        if (!token || !current()) return false;
        attempted = true;
        const startedAt = Date.now();
        const r = await budget.wait(() => deps.fetch(target, {
          method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: budget.signal,
          headers: { Authorization: `Bearer ${token}` },
        }));
        if (!current() || !r.ok || r.redirected || r.url && r.url !== target) return false;
        const value: unknown = await budget.wait(() => r.json());
        if (!current() || !value || typeof value !== 'object' || !('viewerId' in value) || value.viewerId !== viewerId
          || !('ttlSeconds' in value) || typeof value.ttlSeconds !== 'number' || !Number.isInteger(value.ttlSeconds)
          || value.ttlSeconds <= 0 || value.ttlSeconds > 90) return false;
        const expiresAt = startedAt + value.ttlSeconds * 1000;
        if (expiresAt <= Date.now()) return false;
        lease = { scope, expiresAt };
        clearTimeout(timer);
        if (deps.renew !== false) {
          timer = setTimeout(() => { lease = null; void ensure(viewerId); }, Math.max(1000, (expiresAt - Date.now()) / 2));
        }
        return true;
      } catch { return false; }
      finally { budget.dispose(); if (active === cancellation) active = null; }
    });
    pending = { key, result };
    void result.finally(() => { if (pending?.result === result) pending = null; });
    return result;
  }

  const unsubscribe = onDiscoveryScopeChange(() => { void clear(); });
  return {
    ensure, clear,
    dispose() { disposed = true; unsubscribe(); clearTimeout(timer); active?.abort(); lease = null; },
  };
}

export function mediaBrowserOrigin(): string | null {
  return typeof window !== 'undefined' && typeof document !== 'undefined' ? window.location.origin : null;
}

const session = createMediaBrowserSessionTransport({
  origin: mediaBrowserOrigin,
  fetch: (...args) => fetch(...args),
  async tokenFor(viewerId) {
    const { freshToken, isCurrentSessionToken } = require('./apiToken.ts') as typeof import('./apiToken.ts');
    const token = await freshToken();
    return token && await isCurrentSessionToken(viewerId, token) ? token : null;
  },
});

export const ensureMediaBrowserSession = session.ensure;
export const clearMediaBrowserSession = session.clear;
