import {
  currentDiscoveryScope, isCurrentDiscoveryScope, viewerKeyForToken,
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
  if (outer?.aborted) cancel();
  else outer?.addEventListener('abort', cancel);
  return {
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
        if (!isCurrentDiscoveryScope(scope)) throw abortError();
        return value;
      } finally {
        signal.removeEventListener('abort', rejectAbort);
      }
    },
    done() { clearTimeout(timer); outer?.removeEventListener('abort', cancel); },
  };
}
