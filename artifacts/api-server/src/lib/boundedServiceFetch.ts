/** An operation-wide deadline, including response bodies. Used only by bounded
 * media-copy/retention jobs; ordinary clients keep their existing transport. */
export function boundedServiceFetch(totalMs = 300_000, requestMs = 30_000, transport: typeof fetch = fetch): typeof fetch {
  const deadline = Date.now() + totalMs;
  return async (input, init) => {
    const remaining = Math.min(requestMs, deadline - Date.now());
    if (remaining <= 0) throw new Error('service_operation_deadline');
    const controller = new AbortController();
    const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (parent?.aborted) throw new Error('service_operation_aborted');
    let timer: ReturnType<typeof setTimeout>;
    let onAbort = () => {};
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(new Error('service_operation_aborted')); };
      timer = setTimeout(() => { controller.abort(); reject(new Error('service_operation_deadline')); }, remaining);
      parent?.addEventListener('abort', onAbort, { once: true });
      if (parent?.aborted) onAbort();
    });
    try {
      return await Promise.race([expired, (async () => {
        const response = await transport(input, { ...init, signal: controller.signal });
        const bytes = await response.arrayBuffer();
        return new Response(bytes.byteLength ? bytes : null, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
      })()]);
    } finally {
      clearTimeout(timer!);
      parent?.removeEventListener('abort', onAbort);
    }
  };
}
