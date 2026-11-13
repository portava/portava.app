/** Bounded server-only transport. Never include provider bodies or credentials in errors/logs. */
export class ManagedMediaError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) { super(code); }
}

export async function managedMediaJson(input: {
  url: string; authorization: string; body: Uint8Array | string; contentType: string;
  signal: AbortSignal; timeoutMs: number; maxResponseBytes: number; fetch?: typeof fetch;
}): Promise<unknown> {
  input.signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(new ManagedMediaError("managed_cancelled"));
  input.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new ManagedMediaError("managed_timeout", true)), input.timeoutMs);
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener("abort", rejectAbort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const options = {
      method: "POST", headers: { Authorization: input.authorization, "Content-Type": input.contentType },
      body: typeof input.body === "string" ? input.body : Buffer.from(input.body), signal: controller.signal, redirect: "error" as const, credentials: "omit" as const, cache: "no-store" as const,
    };
    const response = await Promise.race([(input.fetch ?? fetch)(input.url, options), cancelled]);
    if (response.redirected || response.url && response.url !== input.url) throw new ManagedMediaError("managed_redirect_refused");
    if (!response.ok) throw new ManagedMediaError("managed_request_failed", response.status === 429 || response.status >= 500);
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > input.maxResponseBytes)) throw new ManagedMediaError("managed_response_budget");
    if (!response.body) throw new ManagedMediaError("managed_empty_response");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), cancelled]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > input.maxResponseBytes) throw new ManagedMediaError("managed_response_budget");
      chunks.push(chunk.value);
    }
    controller.signal.throwIfAborted();
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ManagedMediaError("managed_invalid_json"); }
  } catch (error) {
    if (error instanceof ManagedMediaError) throw error;
    throw new ManagedMediaError("managed_transport_failed", !input.signal.aborted);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
    void reader?.cancel().catch(() => {});
    controller.abort();
  }
}
