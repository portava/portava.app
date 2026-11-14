/** A single deadline for token acquisition, fetch and response decoding.
 * Race each stage because native work does not always honor AbortSignal. */
export function requestDeadline(timeoutMs: number, outer?: AbortSignal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid request deadline');
  const controller = new AbortController();
  const endsAt = Date.now() + timeoutMs;
  let cancelled = false;
  const timeout = () => Object.assign(new Error('Request timed out. Try again.'), { name: 'TimeoutError' });
  const failure = () => cancelled
    ? Object.assign(new Error('Request cancelled.'), { name: 'AbortError' }) : timeout();
  const cancel = () => { cancelled = true; controller.abort(); };
  if (outer?.aborted) cancel();
  else outer?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    async wait<T>(start: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted || Date.now() >= endsAt) throw failure();
      let rejectExpired = () => {};
      const expired = new Promise<never>((_, reject) => { rejectExpired = () => reject(failure()); });
      controller.signal.addEventListener('abort', rejectExpired);
      try {
        const value = await Promise.race([expired, start()]);
        if (controller.signal.aborted || Date.now() >= endsAt) throw failure();
        return value;
      } finally { controller.signal.removeEventListener('abort', rejectExpired); }
    },
    dispose() { clearTimeout(timer); outer?.removeEventListener('abort', cancel); },
  };
}
