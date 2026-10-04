/**
 * wholeList — one viewer's (or owner's) list, read WHOLE or reported unreadable.
 *
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the sweep beside the round-23 verifier's B43 and B44).
 *
 * A read filtered to one person (`.eq("follower_id", me)`, `.eq("muter_id", me)`, `.eq("user_id", me)`) with no bound
 * is a read of a list that person can grow without limit. PostgREST cuts every response at db-max-rows (1000 on this
 * deployment) and reports nothing: the cut answer has the shape of a whole one. Whatever is then decided from it — who
 * is hidden from the viewer, whose events fill their Following tab, which of their saves reach the rail — is decided
 * from the first 1000 rows and served as if from all of them.
 *
 * The rule is `lib/feedReads.ts`'s (census-media §47): read the list whole, by key; a list that cannot be read whole
 * is a FAILED read, never the rows that happened to arrive. Each helper first makes the plain request the caller made
 * before, with an exact count, so a list under the cap still costs one round trip; only when the count says rows were
 * left out is it read again.
 *
 * These helpers take the caller's own query builder (`base`), so the table and the columns stay written at the call
 * site, where the schema checks that read `.from("…").select("…")` can see them.
 */
import { readWhole, afterKey, WHOLE_READ_PAGE_SIZE, type Read, type ReadIssue } from "./feedReads.js";
import { readAllPages } from "./pagedRead.js";

/** A PostgREST-shaped answer: the rows, or the error. What a `const { data, error } = await …` site expects. */
export interface WholeListResult<T = Record<string, unknown>> {
  data: T[] | null;
  error: ReadIssue | null;
}

/**
 * Every row `base()` selects, keyed by `column`.
 *
 * `base` must return a FRESH filtered select each call, made with `{ count: "exact" }`, with no order and no limit;
 * `column` must be unique among the rows the filter matches (the other half of the table's unique key, once the filter
 * pins the viewer's half).
 */
export function readKeyedWhole<T = Record<string, unknown>>(base: () => any, column: string): Promise<Read<T[]>> {
  return readWhole<T>(
    (after, size) => afterKey(base().order(column, { ascending: true }).limit(size), column, after),
    (r) => String((r as Record<string, unknown>)[column]),
    { first: base },
  );
}

/**
 * `readKeyedWhole`, answered as `{ data, error }`, and never throwing: a thrown read is an error like any other.
 *
 * This is the drop-in for a `const { data, error } = await sc.from(…).select(…).eq(…)` site, so it changes ONE thing
 * about that site's answer: a list PostgREST cut is read on, or is an error. An answer with neither rows nor an error
 * (which PostgREST does not give a list read) is handed back as it came, `{ data: null, error: null }`, for the call
 * site's own `?? []` or array check to read exactly as it did before.
 */
export async function wholeListResult<T = Record<string, unknown>>(base: () => any, column: string): Promise<WholeListResult<T>> {
  try {
    const first = await base();
    if (first?.error) return { data: null, error: first.error as ReadIssue };
    if (!Array.isArray(first?.data)) return { data: null, error: null };
    const rows = first.data as T[];
    if (typeof first.count === "number" ? rows.length >= first.count : rows.length < WHOLE_READ_PAGE_SIZE) return { data: rows, error: null };
    const read = await readWhole<T>(
      (after, size) => afterKey(base().order(column, { ascending: true }).limit(size), column, after),
      (r) => String((r as Record<string, unknown>)[column]),
    );
    return read.ok ? { data: read.value, error: null } : { data: null, error: read.error };
  } catch (e) {
    return { data: null, error: { message: String((e as { message?: unknown } | null | undefined)?.message ?? e ?? "read threw") } };
  }
}

/**
 * Every row of a list that has NO single unique column to page by, kept in the caller's order.
 *
 * `base` as above. `ordered(q)` applies a TOTAL order (the caller's display order, then tie-breakers down to a unique
 * key). The plain answer is taken when its count proves it whole; otherwise the list is read again by `.range()` pages
 * in that order, each page checked against the exact count (`readAllPages`): a list whose total moves between pages,
 * or that cannot be read to its end, is an error, never a prefix.
 */
export async function wholeOrderedListResult<T = Record<string, unknown>>(base: () => any, ordered: (q: any) => any): Promise<WholeListResult<T>> {
  try {
    const first = await ordered(base());
    if (first?.error) return { data: null, error: first.error as ReadIssue };
    const rows = Array.isArray(first?.data) ? (first.data as T[]) : null;
    if (rows === null) return { data: null, error: null };  // neither rows nor an error: handed back as it came, as above
    const total = typeof first?.count === "number" ? (first.count as number) : null;
    if (total !== null ? rows.length >= total : rows.length < WHOLE_READ_PAGE_SIZE) return { data: rows, error: null };
    const paged = await readAllPages<T>((from, to) => ordered(base()).range(from, to));
    return paged.error || !paged.data ? { data: null, error: (paged.error as ReadIssue | null) ?? { message: "the list could not be read whole" } } : { data: paged.data, error: null };
  } catch (e) {
    return { data: null, error: { message: String((e as { message?: unknown } | null | undefined)?.message ?? e ?? "read threw") } };
  }
}
