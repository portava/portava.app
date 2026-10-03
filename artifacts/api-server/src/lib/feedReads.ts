/**
 * feedReads — the counts and the viewer's own state that the media and post
 * feeds attach to an item, read so that "could not read" stays itself.
 *
 * census-media §47. The DV-83 verifiers (census-discovery §118.13) left three
 * defects with one root to this census:
 *
 *   - POST/DELETE /posts/:postId/save stamped `save_count: count ?? 0` over a
 *     count read that had FAILED, so an outage wrote a measured 0 into the
 *     cached counter and answered `saveCount: 0`;
 *   - every feed's per-viewer state — saved, stamped, follow request pending,
 *     following — read as `false` when its read failed;
 *   - counts were made by fetching one row per stamp or reaction and counting
 *     them in memory, an unbounded read PostgREST cuts at db-max-rows (1,000 on
 *     this deployment) without saying so.
 *
 * supabase-js RESOLVES `{ data: null, error }` on a failure; it does not throw.
 * So each of those looked exactly like "no rows", and a `try/catch` around the
 * read never ran. The rule every helper here keeps:
 *
 *   - a read that fails answers `{ ok: false }`, and the caller serves `null`
 *     (unknown) for whatever it would have measured — never 0, never false;
 *   - the table goes into the request's `FailedSources`, which the response
 *     carries as `failedSources` (census-discovery §118's wire name), so the
 *     unknown is NAMED, not only absent;
 *   - a count is exact or it is not given: rows are read whole, by key, and a
 *     read that cannot be read whole is a failure, never the rows it got;
 *   - nothing here falls back to a cached counter column.
 *
 * The keyed whole-read mirrors `readAllPages` from PR #530 (`lib/pagedRead.ts`,
 * census-discovery §117–§118), which is not on this branch's base. Same
 * contract, so the two can be folded into one once both land.
 */

/** What a failed read reports. `code` is PostgREST's, or WHOLE_READ_CUT. */
export interface ReadIssue {
  message: string;
  code?: string;
}

/** A read's outcome: the value, or the reason there is none. Never both. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: ReadIssue };

/** The logger shape routes hold (`req.log`); optional everywhere. */
export type FeedReadLog = { warn?: (obj: unknown, msg?: string) => void } | undefined;

/** Rows asked for per page: PostgREST's db-max-rows here, so a whole page is one request. */
export const WHOLE_READ_PAGE_SIZE = 1_000;
/** Rows a whole read may gather before it is a cut read rather than an answer. */
export const WHOLE_READ_MAX_ROWS = 100_000;
/** The code of a read that could not be read whole. */
export const WHOLE_READ_CUT = "WHOLE_READ_CUT";

function issue(error: unknown): ReadIssue {
  const e = error as { message?: unknown; code?: unknown } | null | undefined;
  return {
    message: String(e?.message ?? e ?? "read failed"),
    ...(e?.code != null ? { code: String(e.code) } : {}),
  };
}

function cut(message: string): { ok: false; error: ReadIssue } {
  return { ok: false, error: { message, code: WHOLE_READ_CUT } };
}

/**
 * The sources (tables) one request could not read, in the order first met.
 * The response spreads `body()`: `{ failedSources: [...] }` when anything
 * failed and `{}` otherwise, so a healthy response's shape is unchanged.
 */
export class FailedSources {
  private readonly names: string[] = [];

  constructor(
    private readonly log?: FeedReadLog,
    private readonly where: string = "feed",
  ) {}

  /** Record that `source` could not be read, and say so in the log. */
  note(source: string, error?: unknown): void {
    if (!this.names.includes(source)) this.names.push(source);
    this.log?.warn?.(
      { err: error, source, where: this.where },
      `${this.where}: ${source} could not be read — served as unknown (null), never as zero or false`,
    );
  }

  has(source: string): boolean {
    return this.names.includes(source);
  }

  get any(): boolean {
    return this.names.length > 0;
  }

  list(): string[] {
    return [...this.names];
  }

  body(): { failedSources?: string[] } {
    return this.names.length > 0 ? { failedSources: [...this.names] } : {};
  }
}

/** Narrow one keyed page to the rows after `after`; the first page (`after === null`) is left as it is. */
export function afterKey<Q>(q: Q, column: string, after: string | null): Q {
  return after === null ? q : (q as any).gt(column, after);
}

/** One page of a keyed read: up to `pageSize` rows whose key sorts after `after` (all rows when `after` is null). */
export type KeyedPage = (
  after: string | null,
  pageSize: number,
) => PromiseLike<{ data?: unknown; error?: unknown; count?: number | null }>;

/**
 * Read EVERY row a keyed read matches, one page at a time, never a page
 * PostgREST cut.
 *
 * The caller's page function orders by the key, narrows to rows after `after`
 * and asks for `{ count: "exact" }`, so each page carries how many rows remain
 * from its cursor on. Paging stops only when a page holds all that remain, so a
 * server whose max-rows is BELOW the page size is paged through rather than
 * taken as the end. A page with no count falls back to "a short page is the
 * last". Any error fails the whole read; a page that is not an array, that
 * repeats a key already read, that comes back empty while rows remain, or a
 * read past `maxRows`, is a CUT read — answered as a failure, never as the rows
 * gathered so far.
 */
export async function readWhole<T>(
  page: KeyedPage,
  key: (row: T) => string,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<Read<T[]>> {
  const pageSize = opts.pageSize ?? WHOLE_READ_PAGE_SIZE;
  const maxRows = opts.maxRows ?? WHOLE_READ_MAX_ROWS;
  const out: T[] = [];
  let after: string | null = null;
  for (;;) {
    const res = await page(after, pageSize);
    if (res?.error) return { ok: false, error: issue(res.error) };
    if (!Array.isArray(res?.data)) return cut("a page answered without rows");
    const rows = res.data as T[];
    if (after !== null && rows.length > 0 && !(key(rows[0]) > after)) {
      return cut("a page repeated a row the read had already received");
    }
    out.push(...rows);
    if (out.length > maxRows) return cut(`more than ${maxRows} rows`);
    if (rows.length > 0) after = key(rows[rows.length - 1]);
    const remaining = typeof res.count === "number" ? res.count : null;
    if (remaining !== null) {
      if (rows.length >= remaining) return { ok: true, value: out };
      if (rows.length === 0) return cut(`${out.length} rows read and ${remaining} still to come, but the page was empty`);
    } else if (rows.length < pageSize) {
      return { ok: true, value: out };
    }
  }
}

/**
 * How many rows of `table` each id has, exactly, for one page of ids — e.g.
 * stamps per post. Rows are read whole by their `id` key, so no count is cut
 * at PostgREST's row cap. Every id in `ids` gets an entry; an id with no rows
 * is a measured 0. `scope` adds the read's own filters (entity type,
 * not-deleted, …). A failed or cut read is `{ ok: false }`: no count at all.
 */
export async function countRowsPerId(
  sc: any,
  table: string,
  idColumn: string,
  ids: readonly string[],
  scope: (q: any) => any = (q) => q,
): Promise<Read<Map<string, number>>> {
  const unique = [...new Set(ids)];
  const counts = new Map<string, number>(unique.map((id) => [id, 0]));
  if (unique.length === 0) return { ok: true, value: counts };
  const rows = await readWhole<Record<string, unknown>>(
    (after, size) => {
      let q = scope(
        sc.from(table).select(`id, ${idColumn}`, { count: "exact" }).in(idColumn, unique),
      )
        .order("id", { ascending: true })
        .limit(size);
      if (after !== null) q = q.gt("id", after);
      return q;
    },
    (r) => String(r.id),
  );
  if (!rows.ok) return rows;
  for (const r of rows.value) {
    const id = String(r[idColumn]);
    if (counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return { ok: true, value: counts };
}

/**
 * Which of `ids` the viewer has a row for — the posts they saved, the items
 * they stamped, the creators they have a pending request to. `scope` narrows
 * to the viewer (and any other filter); rows are read whole, keyed by
 * `idColumn`, so the answer cannot be cut. A failed read is `{ ok: false }`:
 * the caller serves the state as unknown, never as "not saved".
 */
export async function viewerRowIds(
  sc: any,
  table: string,
  idColumn: string,
  ids: readonly string[],
  scope: (q: any) => any,
): Promise<Read<Set<string>>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, value: new Set() };
  const rows = await readWhole<Record<string, unknown>>(
    (after, size) => {
      let q = scope(sc.from(table).select(idColumn, { count: "exact" }).in(idColumn, unique))
        .order(idColumn, { ascending: true })
        .limit(size);
      if (after !== null) q = q.gt(idColumn, after);
      return q;
    },
    (r) => String(r[idColumn]),
  );
  if (!rows.ok) return rows;
  return { ok: true, value: new Set(rows.value.map((r) => String(r[idColumn]))) };
}

/**
 * Every value of `column` over the rows `scope` selects — the viewer's whole
 * follow graph, their whole saved list, their whole hide list — read by key so
 * a viewer past the row cap is not silently cut to their first 1,000.
 */
export async function readWholeColumn(
  sc: any,
  table: string,
  column: string,
  scope: (q: any) => any,
): Promise<Read<string[]>> {
  const rows = await readWhole<Record<string, unknown>>(
    (after, size) => {
      let q = scope(sc.from(table).select(column, { count: "exact" }))
        .order(column, { ascending: true })
        .limit(size);
      if (after !== null) q = q.gt(column, after);
      return q;
    },
    (r) => String(r[column]),
  );
  if (!rows.ok) return rows;
  return { ok: true, value: rows.value.map((r) => String(r[column])) };
}

/**
 * One exact count. Pass a HEAD read made with `{ count: "exact", head: true }`:
 * Postgres counts, so PostgREST's row cap does not apply. A failure — or an
 * answer with no count in it — is `{ ok: false }`, never `count ?? 0`.
 */
export async function exactCount(
  read: PromiseLike<{ count?: number | null; error?: unknown }>,
): Promise<Read<number>> {
  const res = await read;
  if (res?.error) return { ok: false, error: issue(res.error) };
  if (typeof res?.count !== "number") return { ok: false, error: { message: "the count read answered without a count" } };
  return { ok: true, value: res.count };
}

/** A Read in the `{ data, error }` shape PostgREST callers already branch on. */
export function asResult<T>(read: Read<T>): { data: T | null; error: ReadIssue | null } {
  return read.ok ? { data: read.value, error: null } : { data: null, error: read.error };
}

/**
 * The value of an `ok` read, else `null` with the source noted. The one line
 * every caller writes: `const saved = known(await viewerRowIds(…), failed, "post_saves")`.
 */
export function known<T>(read: Read<T>, failed: FailedSources, source: string): T | null {
  if (read.ok) return read.value;
  failed.note(source, read.error);
  return null;
}
