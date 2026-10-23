/**
 * One more try for an idempotent PostgREST call that got NO HTTP answer.
 *
 * supabase-js does not throw for a failed fetch: postgrest-js resolves
 * `{ error: { message: "TypeError: fetch failed" }, status: 0 }`. An Autoscale
 * container freezes its event loop while idle, and the first requests after a
 * thaw can land on a pooled socket that died meanwhile. Production, 2026-10-22,
 * twice: the daily-brief and suggestion-seen purges failed without reaching the
 * database (absent from the edge log) while ~200 other requests a minute did,
 * and each job read "failing" on /api/healthz/schedulers until its next run a
 * day later.
 *
 * A PostgREST error is an HTTP answer and is returned as it is: it is a real
 * failure, and repeating it would only hide it. Only for calls that are safe to
 * repeat — a read, or a DELETE by filter.
 */
/** What a supabase-js query resolves to, as far as the retry and its callers read it. */
export interface PostgrestAnswer { data?: unknown; error: unknown; count?: number | null; status?: number | null }

export async function onceMoreOnTransportFailure<T extends PostgrestAnswer>(call: () => PromiseLike<T>): Promise<T> {
  const first = await call();
  return first.error && !first.status ? call() : first;
}
