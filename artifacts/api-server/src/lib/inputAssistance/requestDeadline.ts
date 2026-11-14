/** Server typeahead finishes before the client's five-second budget. The
 * signal also cancels opt-in model work; late read results are never served. */
export const INPUT_SERVE_DEADLINE_MS = 4_000;
export async function withInputDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs = INPUT_SERVE_DEADLINE_MS,
  outer?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid input deadline');
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const endsAt = Date.now() + timeoutMs;
  let rejectAbort: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Input request timed out', 'TimeoutError')), timeoutMs);
  try {
    const result = await Promise.race([work(signal), aborted]);
    signal.throwIfAborted();
    if (Date.now() >= endsAt) throw new DOMException('Input request timed out', 'TimeoutError');
    return result;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
