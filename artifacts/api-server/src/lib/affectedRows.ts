/**
 * How many rows a mutation ACTUALLY touched.
 *
 * supabase-js does not report an affected-row count unless the statement is
 * made RETURNING with `.select()`; without it, `data` is null on success and a
 * statement that matched NOTHING is indistinguishable from one that matched
 * everything — both resolve `{ data: null, error: null }`. PostgREST answers a
 * zero-row UPDATE with 204, exactly as it answers a successful one, so a
 * handler that reads only `error` cannot tell "applied" from "matched nothing".
 *
 * This is the shared twin of the file-private helper the appeals lane added in
 * services/appeals/resolveAppeal.ts — same contract, same semantics, exported
 * so the sites outside that file do not each re-derive it:
 *
 *   null / undefined  -> 0   (either no rows matched, or `.select()` was
 *                             forgotten — both mean "this code does not know
 *                             that anything happened", which is the answer a
 *                             caller must act on)
 *   array             -> its length
 *   a single object   -> 1   (`.maybeSingle()` / `.single()` shape)
 *
 * A caller that treats 0 as success must be able to say WHY: what upstream read
 * or foreign key already proved the row exists, or why its assertion is about
 * the end state rather than about having changed something.
 */
export function affectedRows(data: unknown): number {
  if (data == null) return 0;
  return Array.isArray(data) ? data.length : 1;
}

/**
 * The ids a mutation actually touched, for the case where a count is not
 * enough: when per-row side effects (a notification, an event row, a counter)
 * are driven by the rows a WRITE changed rather than by the rows an earlier
 * READ selected. A partial match is the failure mode this exists for — telling
 * N people their booking expired when the update only moved M < N of them.
 */
export function affectedIds(data: unknown, key = "id"): Set<string> {
  if (data == null) return new Set();
  const rows = Array.isArray(data) ? data : [data];
  const out = new Set<string>();
  for (const r of rows) {
    const v = (r as Record<string, unknown> | null)?.[key];
    if (typeof v === "string") out.add(v);
  }
  return out;
}
