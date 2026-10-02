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

/** One page of the read: rows `from`..`to` inclusive, as `.range(from, to)` asks. */
export type PageFn = (from: number, to: number) => PromiseLike<{ data?: unknown; error?: unknown; count?: number | null }>;

function cut(message: string): PagedRead<never> {
  return { data: null, error: { message, code: PAGED_READ_CUT } };
}

export async function readAllPages<T = any>(
  page: PageFn,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<PagedRead<T>> {
  const pageSize = opts.pageSize ?? PAGED_READ_PAGE_SIZE;
  const maxRows = opts.maxRows ?? PAGED_READ_MAX_ROWS;
  const out: T[] = [];
  for (;;) {
    const from = out.length;
    const res = await page(from, from + pageSize - 1);
    if (res?.error) return { data: null, error: res.error as PagedReadError };
    if (!Array.isArray(res?.data)) return cut("a page answered without rows");
    const rows = res.data as T[];
    out.push(...rows);
    if (out.length > maxRows) return cut(`more than ${maxRows} rows`);
    const total = typeof res.count === "number" ? res.count : null;
    if (total !== null) {
      if (out.length >= total) return { data: out, error: null };
      if (rows.length === 0) return cut(`${out.length} of ${total} rows read`);
    } else if (rows.length < pageSize) {
      return { data: out, error: null };
    }
  }
}
