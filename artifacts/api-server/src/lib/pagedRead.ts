/**
 * census-discovery §117 (DV-83 round 20, B21): read EVERY row a filter matches, never a page PostgREST cut.
 *
 * PostgREST caps every response at `db-max-rows` (1000 on this deployment) and says nothing: a capped answer and a
 * complete one are the same shape. A count, a rank or a "none" computed from one unbounded read of a set that can pass
 * the cap is therefore a cut read served as measured. GET /events' live going recount was one such read over up to 201
 * events (the round-19 verifier's GC1/GC2): every event whose rows fell past the cap was served `goingCount: 0`.
 *
 * `readAllPages` pages a read with `.range()` and stops only when the rows are whole:
 *   - the caller asks for `{ count: "exact" }`, so each page carries the total the filter matches. Paging continues
 *     from the rows actually received until that total is reached, so a server whose max-rows is BELOW the page size
 *     (a short page that is not the last) is paged through, not taken as the end;
 *   - an answer that carries no count (a client that ignores the option) falls back to "a short page is the last";
 *   - an error on any page fails the whole read: `{ data: null, error }`;
 *   - a page that comes back empty while the total says rows remain, a page that is not an array, or more rows than
 *     `maxRows` is a CUT read, answered as an error (`code: "PAGED_READ_CUT"`), never as the rows received so far.
 *
 * So a caller's existing `if (error || !Array.isArray(data))` arm keeps the cached value and names the read, and a
 * healthy answer is the same rows the unbounded read returned when it was under the cap.
 */

/** Rows asked for per page: PostgREST's db-max-rows on this deployment, so a whole page is one request. */
export const PAGED_READ_PAGE_SIZE = 1_000;
/** Rows a paged read may gather before it is a cut read. Far past any one event's RSVPs or a list pool's. */
export const PAGED_READ_MAX_ROWS = 100_000;
/** The error code of a read that could not be read whole. */
export const PAGED_READ_CUT = "PAGED_READ_CUT";

export interface PagedReadError { message: string; code?: string }
export interface PagedRead<T> { data: T[] | null; error: PagedReadError | null }

/** One page of the read: rows `from`..`to` inclusive, as `.range(from, to)` asks; a KEYED read (`opts.key`) asks instead for up to `to - from + 1` rows after `after`, the last row received (§118, B23: `keysetAfter`). */
export type PageFn<T = any> = (from: number, to: number, after: T | null) => PromiseLike<{ data?: unknown; error?: unknown; count?: number | null }>;

function cut(message: string): PagedRead<never> {
  return { data: null, error: { message, code: PAGED_READ_CUT } };
}

export async function readAllPages<T = any>(
  page: PageFn<T>,
  opts: { pageSize?: number; maxRows?: number; key?: (row: T) => readonly string[] } = {},
): Promise<PagedRead<T>> {
  const pageSize = opts.pageSize ?? PAGED_READ_PAGE_SIZE;
  const maxRows = opts.maxRows ?? PAGED_READ_MAX_ROWS;
  const out: T[] = []; let after: T | null = null; let firstTotal: number | null = null;  // §118 (B23): the keyset cursor, and an unkeyed read's first total
  for (;;) {
    const from = opts.key ? 0 : out.length;  // §118 (B23): a keyed page starts after the last row received, never at an offset a write can shift
    const res = await page(from, from + pageSize - 1, after);
    if (res?.error) return { data: null, error: res.error as PagedReadError };
    if (!Array.isArray(res?.data)) return cut("a page answered without rows");
    const rows = res.data as T[]; if (opts.key && after !== null && rows.length > 0 && !keyAfter(opts.key(rows[0]), opts.key(after))) return cut("a page repeated a row the read already received");
    out.push(...rows);
    if (out.length > maxRows) return cut(`more than ${maxRows} rows`); if (rows.length > 0) after = rows[rows.length - 1];
    const total = typeof res.count === "number" ? res.count : null; if (total !== null && !opts.key) { if (firstTotal === null) firstTotal = total; else if (total !== firstTotal) return cut(`the total moved from ${firstTotal} to ${total} between pages`); }
    if (total !== null) {
      if ((opts.key ? rows.length : out.length) >= total) return { data: out, error: null };  // §118 (B23): a keyed page's count is the rows from its cursor on
      if (rows.length === 0) return cut(`${out.length} of ${total} rows read`);
    } else if (rows.length < pageSize) {
      return { data: out, error: null };
    }
  }
}

/**
 * census-discovery §118 (DV-83 round 21, B23): whether key `a` sorts strictly after key `b`, column by column, as
 * PostgreSQL orders the uuid keys these reads page on (lowercase hex, so string order is byte order).
 */
function keyAfter(a: readonly string[], b: readonly string[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? "", y = b[i] ?? "";
    if (x !== y) return x > y;
  }
  return false;
}

/** A filter value as PostgREST's logic-tree grammar reads it: double-quoted, with `"` and `\` escaped, when it holds a reserved character. */
function pgrstValue(v: string): string {
  return /^[A-Za-z0-9_-]+$/.test(v) ? v : `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * census-discovery §118 (DV-83 round 21, B23): narrow query `q` to the rows whose key `(cols[0], cols[1], …)` sorts
 * after `after`'s, so a keyed `readAllPages` page starts where the last one ended whatever was written meanwhile. One
 * column is `.gt(col, v)`; a composite key is PostgREST's row comparison spelt as a logic tree, for two columns
 * `.or("a.gt.v,and(a.eq.v,b.gt.w)")`. `after === null` (the first page) leaves `q` as it is.
 */
export function keysetAfter<Q>(q: Q, cols: readonly string[], after: Record<string, unknown> | null): Q {
  if (after === null) return q;
  const v = cols.map((c) => String(after[c] ?? ""));
  if (cols.length === 1) return (q as any).gt(cols[0], v[0]);
  const terms = cols.map((c, i) => {
    const eqs = cols.slice(0, i).map((p, j) => `${p}.eq.${pgrstValue(v[j])}`);
    const gt = `${c}.gt.${pgrstValue(v[i])}`;
    return eqs.length === 0 ? gt : `and(${[...eqs, gt].join(",")})`;
  });
  return (q as any).or(terms.join(","));
}

/**
 * census-discovery §118 (DV-83 round 21, sweep SW22): `keysetAfter` for a read ordered DESCENDING by `cols` — narrow
 * `q` to the rows whose key sorts BEFORE `after`'s (`.lt()` for one column, the logic tree with `lt` for several), so an
 * offset-paged read ordered newest first (where every concurrent insert lands ahead of the cursor) can page by key.
 */
export function keysetBefore<Q>(q: Q, cols: readonly string[], after: Record<string, unknown> | null): Q {
  if (after === null) return q;
  const v = cols.map((c) => String(after[c] ?? ""));
  if (cols.length === 1) return (q as any).lt(cols[0], v[0]);
  const terms = cols.map((c, i) => {
    const eqs = cols.slice(0, i).map((p, j) => `${p}.eq.${pgrstValue(v[j])}`);
    const lt = `${c}.lt.${pgrstValue(v[i])}`;
    return eqs.length === 0 ? lt : `and(${[...eqs, lt].join(",")})`;
  });
  return (q as any).or(terms.join(","));
}

/** §118 (SW22): whether `row`'s key, over `cols`, sorts strictly before `after`'s — the next row of a descending keyed read. */
export function keySortsBefore(row: Record<string, unknown>, after: Record<string, unknown>, cols: readonly string[]): boolean {
  return keyAfter(cols.map((c) => String(after[c] ?? "")), cols.map((c) => String(row[c] ?? "")));
}

/** census-discovery §119 (DV-83 round 22): the logic-tree quoting, for a caller that spells its own keyset (GET /events/following and /circles page by `(starts_at, id)` with undated events last). */
export { pgrstValue };
