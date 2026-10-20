import type { SupabaseClient } from "@supabase/supabase-js";
import { boundedMediaQueueOperation } from "../../lib/media/jobs/queue.js";

export function mediaCleanupClient(client: SupabaseClient, signal: AbortSignal, timeoutMs = 5000): SupabaseClient {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid cleanup transport timeout");
  function wrap(target: any): any {
    if (!target || (typeof target !== "object" && typeof target !== "function")) return target;
    return new Proxy(target, {
      get(object, key) {
        if (key === "then" && typeof object.then === "function") {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => boundedMediaQueueOperation(
            transport => typeof object.abortSignal === "function" ? object.abortSignal(transport) : object,
            signal, timeoutMs,
          ).then(value => { signal.throwIfAborted(); return value; }).then(resolve, reject);
        }
        const value = Reflect.get(object, key, object);
        if (typeof value !== "function") return wrap(value);
        return (...args: unknown[]) => { signal.throwIfAborted(); return wrap(value.apply(object, args)); };
      },
    });
  }
  return {
    from: (...args: Parameters<SupabaseClient["from"]>) => { signal.throwIfAborted(); return wrap(client.from(...args)); },
    rpc: (...args: Parameters<SupabaseClient["rpc"]>) => { signal.throwIfAborted(); return wrap(client.rpc(...args)); },
    storage: wrap(client.storage),
  } as unknown as SupabaseClient;
}

export async function withMediaCleanup<Value>(client: SupabaseClient, run: (sc: SupabaseClient, signal: AbortSignal) => Promise<Value>, options: {
  signal?: AbortSignal; timeoutMs?: number; operationTimeoutMs?: number;
} = {}): Promise<Value> {
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid cleanup deadline");
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Media cleanup cancelled"));
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Media cleanup timeout")), timeoutMs);
  try {
    controller.signal.throwIfAborted();
    return await run(mediaCleanupClient(client, controller.signal, options.operationTimeoutMs), controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener("abort", stop);
  }
}
