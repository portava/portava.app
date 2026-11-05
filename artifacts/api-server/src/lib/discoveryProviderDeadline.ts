/** Interactive directory lookups must bound both response headers and body.
 * Background warming owns its separate, longer budget. */
export const DISCOVERY_PROVIDER_DEADLINE_MS = 4_000;

export async function readDiscoveryProvider<T>(
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
  timeoutMs = DISCOVERY_PROVIDER_DEADLINE_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid provider deadline');
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  let rejectAbort: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Discovery provider deadline exceeded', 'TimeoutError')), timeoutMs);
  let response: Response | undefined;
  const operation = async () => {
    response = await fetch(url, { ...init, signal });
    // A custom transport that resolves after cancellation cannot revive a read.
    if (signal.aborted) {
      await response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    const result = await read(response);
    signal.throwIfAborted();
    return result;
  };
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    // Release an unread error response too. JSON consumers already used it.
    if (response?.body && !response.bodyUsed && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
