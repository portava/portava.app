/**
 * Whole-set reads past PostgREST's row cap, by keyset on `id`.
 *
 * A range-less PostgREST read is cut at db-max-rows (1000 on hosted) with no
 * error, and an explicit `.limit(n)` cannot lift that cap. A caller that needs
 * EVERY row a filter matches — to aggregate it, or to decide what is NOT in it —
 * must page, and must not take a short page as the end (see readAllByIdKeyset).
 */
/**
 * Keyset page size. NOT the end-of-set test: a page shorter than this proves
 * nothing, because the server's db-max-rows (Supabase "Max rows") caps every
 * response — an explicit .limit() cannot raise it, and a deployment that sets it
 * below this number makes EVERY page short. Only an EMPTY page ends a read.
 */
export const KEYSET_PAGE = 1000;

/**
 * Read every row a filter matches, ordered by `id` and paged by keyset
 * (`id > last`), until a page comes back EMPTY — or until `maxRows` rows have
 * been read, which is reported as `truncated` rather than passed off as the set.
 *
 * WHY NOT OFFSET. lib/intelProjectionScheduler read with `.range(offset, …)` and
 * no ORDER BY. Without one PostgreSQL promises no order, so two OFFSET windows may
 * each see a different order and the pages overlap and skip; and the loop ended on
 * the first page shorter than 1000, so a server cap below 1000 ended it after one
 * page. Its live-key read decides a DELETE-shaped action (expire every servable
 * snapshot whose key it did not see), so a skipped key force-expired live
 * intelligence. A keyset walk over a unique key sees each row at most once and,
 * ending only on an empty page, cannot mistake a capped page for the last one.
 *
 * `build` must return a FRESH filtered select each call (no order, no limit);
 * this function adds ORDER BY id, the cursor and the page size. The rows must
 * carry `id`.
 *
 * Any page error returns `{ ok: false }` and NO rows: a caller must not act on a
 * prefix of the set.
 */
export async function readAllByIdKeyset(
  build: () => any,
  maxRows = Number.POSITIVE_INFINITY,
): Promise<{ ok: true; rows: any[]; truncated: boolean } | { ok: false; error: unknown }> {
  const rows: any[] = [];
  let last: string | null = null;
  for (;;) {
    let q = build().order("id", { ascending: true });
    if (last !== null) q = q.gt("id", last);
    const { data, error } = await q.limit(KEYSET_PAGE);
    if (error) return { ok: false, error };
    const page = (data as any[]) ?? [];
    if (page.length === 0) return { ok: true, rows, truncated: false };
    for (const r of page) {
      if (rows.length >= maxRows) return { ok: true, rows, truncated: true };
      rows.push(r);
    }
    const tail = page[page.length - 1]?.id;
    // A row without an id cannot advance the cursor; looping on it would re-read
    // the same page forever, and stopping would pass a prefix off as the set.
    if (typeof tail !== "string" && typeof tail !== "number") return { ok: false, error: new Error("keyset read: row without an id") };
    last = String(tail);
  }
}
