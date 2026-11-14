import {
  currentDiscoveryScope, isCurrentDiscoveryScope, onDiscoveryScopeChange, viewerKeyForToken,
} from '../../../services/discoveryViewerScope.ts';

export const SUGGEST_TIMEOUT_MS = 5000;

function abortError() {
  const error = new Error('Input request cancelled');
  error.name = 'AbortError';
  return error;
}

// The whole interaction has one deadline, including session refresh and JSON reads.
// Some native promises ignore AbortSignal, so race each step with cancellation.
export function withInputBudget(outer?: AbortSignal) {
  const controller = new AbortController();
  const { signal } = controller;
  const scope = currentDiscoveryScope();
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, SUGGEST_TIMEOUT_MS);
  const cancel = () => controller.abort();
  const unsubscribe = onDiscoveryScopeChange(cancel);
  if (outer?.aborted) cancel();
  else outer?.addEventListener('abort', cancel);
  const budget = {
    signal,
    timedOut: () => expired,
    current(token?: string) {
      return !signal.aborted && isCurrentDiscoveryScope(scope)
        && (!token || !scope.viewer || viewerKeyForToken(token) === scope.viewer);
    },
    async wait<T>(start: () => Promise<T>): Promise<T> {
      if (signal.aborted || !isCurrentDiscoveryScope(scope)) throw abortError();
      let rejectAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(abortError()); });
      signal.addEventListener('abort', rejectAbort);
      try {
        const value = await Promise.race([start(), aborted]);
        if (signal.aborted || !isCurrentDiscoveryScope(scope)) throw abortError();
        return value;
      } finally {
        signal.removeEventListener('abort', rejectAbort);
      }
    },
    /** Private drafts and learning events stay on the configured API origin. */
    async fetch(base: string, path: string, token: string, init: RequestInit = {}, fetchImpl = fetch): Promise<Response> {
      if (!budget.current(token)) throw abortError();
      if (!base || /[\s\\?#@]/.test(base)) throw new Error('Invalid API origin');
      const origin = new URL(base);
      if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password
        || !path.startsWith('/api/input-assistance/') || /[\\?#]/.test(path)) throw new Error('Invalid input endpoint');
      const endpoint = `${base.replace(/\/$/, '')}${path}`;
      const response = await budget.wait(() => fetchImpl(endpoint, {
        ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      }));
      if (response.redirected || response.url && response.url !== endpoint) throw new Error('Input request redirected');
      return response;
    },
    done() { clearTimeout(timer); unsubscribe(); outer?.removeEventListener('abort', cancel); },
  };
  return budget;
}
