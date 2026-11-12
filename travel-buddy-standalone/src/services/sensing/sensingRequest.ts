// Some native operations keep waiting after abort (token refresh and response
// reads in particular). End the caller's wait as well as cancelling the fetch.
export async function runSensingRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  controller = new AbortController(),
  timeoutMs = 10_000,
): Promise<T> {
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Sensing request interrupted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (controller.signal.aborted) throw new Error('Sensing request interrupted');
    return await Promise.race([interrupted, operation(controller.signal)]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
