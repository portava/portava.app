/**
 * exclusionSet — the definition of record for READING an exclusion table.
 *
 * ── THE DEFECT THIS EXISTS TO END ───────────────────────────────────────────
 * An exclusion table (`blocks`, `user_mutes`, `trust_caps`, `user_restrictions`
 * …) is one where a ROW means DENY. Emptiness means ALLOW. supabase-js RESOLVES
 * on a database error rather than throwing, so
 *
 *     const { data } = await sc.from("blocks").select(…).or(…);
 *     const blocked = new Set((data ?? []).map(…));      // ← the defect
 *
 * produces the SAME empty set when nobody is blocked and when the table could
 * not be read. Every downstream `!blocked.has(id)` then answers "allowed", and
 * blocked users are shown each other's content during a transient DB blip. The
 * check-unchecked-supabase-reads ledger classified 31 sites of exactly this
 * shape as FAIL-OPEN; this module is where the rule is stated once.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 * A read returns an `ExclusionSet`, a discriminated union — NOT a nullable Set.
 * That is deliberate: `Set | null` invites `?? new Set()`, which reintroduces
 * the exact coercion this module exists to prevent. `{ ok: false }` has no
 * accidental spelling that means "nobody is excluded".
 *
 * The membership test, `isExcluded`, answers **true for an unreadable set**. So
 * any site that only asks "is this id excluded?" — a filter predicate, a loop
 * `continue`, a boolean gate — degrades to fail-CLOSED *by construction*, with
 * no per-site error handling to forget. A site that wants a different answer
 * must branch on `.ok` explicitly, which makes the exception visible in review.
 *
 * ── CHOOSING THE FAIL-CLOSED ANSWER (this is a judgement, not a sweep) ───────
 * Three shapes, three right answers. The wrong answer at every one of them is
 * the unfiltered result; the wrong answer at MOST of them is a blanket 500.
 *
 *   1. The set gates ONE interaction (may A read B's post, book B, translate
 *      B's bio). Deny that interaction — 403/404, exactly as a real block does.
 *      For the two-party case use `isBlockedBetween` in ./blockGuard.js, which
 *      already fails closed; this module's `readPairExclusion` is its
 *      set-shaped sibling for callers that want one uniform type.
 *
 *   2. The set filters PART of a response whose other parts are not
 *      block-scoped (a badge count beside three others, entity suggestions
 *      beside user suggestions, mention decoration inside rendered text).
 *      Drop or neutralize that part only. `isExcluded` gives this for free:
 *      every candidate tests as excluded, the block-scoped part empties, and
 *      the rest of the response is untouched and still correct.
 *
 *   3. The response is ENTIRELY a block-scoped roster of other people (a likes
 *      list, an invite picker, a stories feed, a viewer list). There is no
 *      narrower honest answer: an empty list here is not "safe", it is a false
 *      statement that nobody liked the post / has stories / may be invited, and
 *      the client caches and renders it as fact. Refuse — `sendExclusionsUnavailable`
 *      answers `degraded_unavailable` (503, `retryable: true`), the code this
 *      codebase already uses in `requireUser` for "the check could not be
 *      PERFORMED", as distinct from "it was performed and you failed". A 503
 *      the client retries is not the blanket 500 that shape invites.
 *
 * ── RELATIONSHIP TO THE OTHER TWO BLOCK HELPERS ─────────────────────────────
 *   ./blockGuard.ts  `isBlockedBetween(sc, a, b)` — the two-party gate, already
 *                    fail-closed (returns true on error). Shape 1 above uses it
 *                    directly; it is not duplicated here.
 *   ./blocks.ts      `fetchBlockedSet(sc, userId)` — the older `Set | null`
 *                    form, still used by the discovery surfaces via
 *                    `submitterIsVisible`. It is fail-closed for callers that
 *                    honour the null, but the null is precisely the coercible
 *                    shape, so NEW callers use this module instead.
 */
import type { Request, Response } from "express";
import { sendError } from "./http.js";
import { readAllByIdKeyset } from "./keysetRead.js";

/**
 * The result of reading an exclusion table.
 *
 * `ok: true`  — the table was read; `ids` is the complete exclusion set for the
 *               scope that was asked for (possibly empty, meaning "allow all").
 * `ok: false` — the table could NOT be read. `ids` deliberately does not exist:
 *               there is no set to consult and no default that is safe to
 *               invent. `reason` is for logs, never for the client.
 */
export type ExclusionSet =
  | { readonly ok: true; readonly ids: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: string };

/** Construct the unreadable result. Exported so tests and adapters can build one. */
export function exclusionsUnavailable(reason: unknown): ExclusionSet {
  const r = reason as { message?: unknown; code?: unknown } | null;
  return {
    ok: false,
    reason: String(r?.message ?? r?.code ?? reason ?? "exclusion table unreadable"),
  };
}

/** Construct a readable result. */
export function exclusions(ids: Iterable<string>): ExclusionSet {
  return { ok: true, ids: new Set(ids) };
}

/**
 * Is `id` excluded?
 *
 * **An unreadable set excludes everybody.** This is the whole point of the
 * module: the default answer to "may I show this person" when block state is
 * unknown is no. Sites that need to distinguish "excluded" from "unknown" must
 * branch on `set.ok` themselves.
 */
export function isExcluded(set: ExclusionSet, id: string | null | undefined): boolean {
  if (!set.ok) return true;
  if (!id) return false;
  return set.ids.has(id);
}

/**
 * EVERY failure of a `blocks` read is `ok: false` — census-telegraph §94.
 *
 * The readers below used to answer `ok: false` for ONE failure, a RETURNED
 * `{ error }`, and let every other failure through as something else:
 *
 *   THROWN     a torn-down or misconfigured client, a builder bug, a fetch that
 *              rejects. It escaped as an exception, so the answer depended on
 *              whether the CALLER remembered a `catch` — and on what that catch
 *              defaulted to. A verifier's mutant that turned
 *              services/telegraph/identityAcrossBlocks.ts's catch into "nobody
 *              is blocked" survived every suite (V-RH V6). A thrown read is now
 *              answered here, the same way as a returned error, so no caller has
 *              to remember anything.
 *   NOT ROWS   `data: null` with no error, a string, an object. `data ?? []`
 *              read it as "nobody is blocked". Only an actual row list is an
 *              answer.
 *   NO ID      a row that does not name its counter-party was skipped. A row is
 *              a DENY; one we cannot attribute must not be dropped as if it were
 *              absent.
 *   CUT        a scoped read over more candidates than PostgREST's `db-max-rows`
 *              (1000 hosted) was ONE `.in()` read, cut at the cap with no error,
 *              and every block past the cap was missed. See BLOCK_AMONG_CHUNK.
 *
 * The WHOLE-LIST read (no `among`) and the group read used to be one range-less
 * read each, cut at the same cap: they are keyset-paged to the END of the set
 * (census-telegraph §98, pagedBlockRows), unreadable past BLOCK_LIST_CEILING.
 */
const NOT_ROWS = "blocks read answered something other than a row list";
const NO_COUNTERPARTY = "a blocks row did not name its counter-party";

/** A non-empty id, or null. A block row is keyed by two NOT NULL uuids. */
function idOf(v: unknown): string | null {
  return (typeof v === "string" && v.length > 0) || typeof v === "number" ? String(v) : null;
}

/**
 * One direction's answer, as the counter-party ids it names, or the unreadable
 * result. `res` is whatever the awaited builder resolved to.
 */
function counterParties(res: any, col: "blocked_id" | "blocker_id"): string[] | Extract<ExclusionSet, { ok: false }> {
  if (res?.error) return exclusionsUnavailable(res.error) as Extract<ExclusionSet, { ok: false }>;
  if (!Array.isArray(res?.data)) return exclusionsUnavailable(NOT_ROWS) as Extract<ExclusionSet, { ok: false }>;
  const ids: string[] = [];
  for (const r of res.data as any[]) {
    const id = idOf(r?.[col]);
    if (id === null) return exclusionsUnavailable(NO_COUNTERPARTY) as Extract<ExclusionSet, { ok: false }>;
    ids.push(id);
  }
  return ids;
}

/**
 * Ids per `.in()` read on the scoped (`among`) path. `blocks` is UNIQUE per
 * (blocker_id, blocked_id), so one direction's read over N candidates returns at
 * most N rows; at 150 a read can never reach PostgREST's `db-max-rows` (1000
 * hosted), so no scoped answer is silently cut, and no `.in()` list grows past
 * a URL PostgREST accepts. The same size as identityAcrossBlocks's
 * IDENTITY_BLOCK_CHUNK, so that helper's chunks are read in one pass here.
 */
export const BLOCK_AMONG_CHUNK = 150;

/**
 * Bidirectional block set for one viewer: every user id that blocked `viewerId`
 * or was blocked by them.
 *
 * `among` scopes the read to a candidate list (two `.in()` reads per chunk
 * instead of one `.or()` over the viewer's whole block list) — use it when the
 * candidate set is already known and bounded, which is most list surfaces.
 *
 * A block is symmetric for visibility: if A blocked B then neither may see the
 * other, so both directions are collapsed into one set of counter-party ids.
 *
 * NEVER REJECTS: every failure — returned, thrown, malformed — is `ok: false`.
 */
export async function readBlockExclusions(
  sc: any,
  viewerId: string,
  opts?: { among?: readonly string[] },
): Promise<ExclusionSet> {
  if (!sc || !viewerId) return exclusionsUnavailable("no client or viewer");
  try {
    return await readBlockExclusionsOnce(sc, viewerId, opts?.among);
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}

async function readBlockExclusionsOnce(sc: any, viewerId: string, among: readonly string[] | undefined): Promise<ExclusionSet> {
  if (among) {
    // An empty candidate list has an empty answer — and asking PostgREST for
    // `.in("x", [])` is a wasted round trip, not a safety question.
    if (among.length === 0) return exclusions([]);
    const ids = new Set<string>();
    for (let i = 0; i < among.length; i += BLOCK_AMONG_CHUNK) {
      const chunk = among.slice(i, i + BLOCK_AMONG_CHUNK) as string[];
      const [out, inb] = await Promise.all([
        sc.from("blocks").select("blocked_id").eq("blocker_id", viewerId).in("blocked_id", chunk),
        sc.from("blocks").select("blocker_id").eq("blocked_id", viewerId).in("blocker_id", chunk),
      ]);
      const outIds = counterParties(out, "blocked_id");
      if (!Array.isArray(outIds)) return outIds;
      const inbIds = counterParties(inb, "blocker_id");
      if (!Array.isArray(inbIds)) return inbIds;
      for (const id of outIds) ids.add(id);
      for (const id of inbIds) ids.add(id);
    }
    return { ok: true, ids };
  }

  const rows = await pagedBlockRows( // the read callers always made; then, only if it may be cut, the keyset walk whose rows carry the key
    () => sc.from("blocks").select("blocker_id, blocked_id").or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`),
    () => sc.from("blocks").select("id, blocker_id, blocked_id").or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`));
  // The whole list read to its end, every page a row list — or no list at all
  // (pagedBlockRows, below): never a prefix of it.
  if (!Array.isArray(rows)) return rows;
  const ids = new Set<string>();
  for (const r of rows) {
    const blocker = idOf(r?.blocker_id);
    const blocked = idOf(r?.blocked_id);
    if (blocker === null || blocked === null) return exclusionsUnavailable(NO_COUNTERPARTY);
    ids.add(blocker === viewerId ? blocked : blocker);
  }
  return { ok: true, ids };
}

/**
 * The two-party case expressed as an `ExclusionSet`: `ids` holds `b` when the
 * pair is blocked in either direction, and is empty when it is not.
 *
 * Prefer `isBlockedBetween` from ./blockGuard.js when a boolean is all the site
 * wants; this exists so a site holding several `ExclusionSet`s can treat the
 * pair check the same way as the rest, and so "unreadable" stays distinguishable
 * from "blocked" for callers that log the difference.
 *
 * NEVER REJECTS: a thrown read, and an answer that is not a row list, are
 * `ok: false` exactly as a returned error is.
 */
export async function readPairExclusion(sc: any, a: string, b: string): Promise<ExclusionSet> {
  if (!sc || !a || !b) return exclusionsUnavailable("no client or user pair");
  try {
    const res = await sc
      .from("blocks")
      .select("blocker_id")
      .or(`and(blocker_id.eq.${a},blocked_id.eq.${b}),and(blocker_id.eq.${b},blocked_id.eq.${a})`)
      // `.limit(1)`, never `.maybeSingle()`: a MUTUAL block is two rows, both
      // permitted by UNIQUE(blocker_id, blocked_id), and maybeSingle raises on
      // >1 — so the STRONGEST block state used to error into `data: null` and
      // read as "not blocked". Same trap ./blockGuard.ts documents.
      .limit(1);
    if (res?.error) return exclusionsUnavailable(res.error);
    // Any row is the block; the row's columns are not needed to know that.
    if (!Array.isArray(res?.data)) return exclusionsUnavailable(NOT_ROWS);
    return { ok: true, ids: new Set(res.data.length > 0 ? [b] : []) };
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}

/**
 * Union of every block relationship touching ANY id in `memberIds`, minus the
 * members themselves. Used where a recommendation or roster is built FOR a
 * group rather than for one viewer: anybody a member blocked, or who blocked a
 * member, is excluded for the whole group.
 *
 * NEVER REJECTS: every failure — returned, thrown, malformed — is `ok: false`.
 */
export async function readGroupBlockExclusions(
  sc: any,
  memberIds: readonly string[],
): Promise<ExclusionSet> {
  if (!sc) return exclusionsUnavailable("no client");
  if (memberIds.length === 0) return exclusions([]);
  try {
    const [asBlocker, asBlocked] = await Promise.all([
      pagedBlockRows(() => sc.from("blocks").select("blocker_id, blocked_id").in("blocker_id", memberIds as string[]), () => sc.from("blocks").select("id, blocker_id, blocked_id").in("blocker_id", memberIds as string[])),
      pagedBlockRows(() => sc.from("blocks").select("blocker_id, blocked_id").in("blocked_id", memberIds as string[]), () => sc.from("blocks").select("id, blocker_id, blocked_id").in("blocked_id", memberIds as string[])),
    ]);
    const outIds = Array.isArray(asBlocker) ? counterParties({ data: asBlocker }, "blocked_id") : asBlocker;
    if (!Array.isArray(outIds)) return outIds;
    const inbIds = Array.isArray(asBlocked) ? counterParties({ data: asBlocked }, "blocker_id") : asBlocked;
    if (!Array.isArray(inbIds)) return inbIds;
    const ids = new Set<string>([...outIds, ...inbIds]);
    for (const id of memberIds) ids.delete(id); // members themselves stay
    return { ok: true, ids };
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}

/**
 * The most rows ONE paged `blocks` read walks: ten full pages of KEYSET_PAGE
 * (lib/keysetRead). A viewer — or, for the group read, a group's members — with
 * more block relationships than this is answered UNREADABLE, which every caller
 * already serves fail-closed; never the first 10,000 passed off as the list.
 */
export const BLOCK_LIST_CEILING = 10_000;
const OVER_CEILING = `more than ${BLOCK_LIST_CEILING} block relationships: the list is not read past its ceiling`;

/**
 * Every row a `blocks` filter matches — census-telegraph §98. A range-less read
 * is cut at PostgREST's `db-max-rows` (1000 hosted) with no error, so a viewer
 * with more block relationships than that was answered with a PREFIX, read as
 * the whole list: everyone past row 1,000 shown as "not blocked".
 *
 * FIRST `first`: the range-less read every caller always made, byte for byte
 * (the same columns, so a recording of the old read still matches). An answer shorter than
 * BLOCK_AMONG_CHUNK cannot have been cut: this module is only correct where
 * `db-max-rows` is at least that (the scoped read's chunking already rests on
 * it; hosted is 1000), so a viewer with fewer than 150 relationships — nearly
 * everyone — still costs ONE round trip. An answer that long MAY be a prefix,
 * and the set is then read again from the start by keyset on the primary key
 * `id` (lib/keysetRead) to an EMPTY page: at the hosted cap, 1 + ⌈rows/1000⌉ + 1
 * round trips, at most 12 below the ceiling.
 *
 * `keyed` returns a FRESH select with the same filter whose rows also carry `id`. A returned
 * error, an answer that is not a row list (on any page), a cursor the server did
 * not honour, a row without an id, and a list past BLOCK_LIST_CEILING are each
 * the unreadable result. Rejects only when a read throws: every reader of record
 * calls it under its own catch.
 */
async function pagedBlockRows(first: () => any, keyed: () => any): Promise<any[] | Extract<ExclusionSet, { ok: false }>> {
  const res = await first();
  if (res?.error) return exclusionsUnavailable(res.error) as Extract<ExclusionSet, { ok: false }>;
  if (!Array.isArray(res?.data)) return exclusionsUnavailable(NOT_ROWS) as Extract<ExclusionSet, { ok: false }>;
  if (res.data.length < BLOCK_AMONG_CHUNK) return res.data;
  const read = await readAllByIdKeyset(keyed, BLOCK_LIST_CEILING);
  if (!read.ok) return exclusionsUnavailable(read.error) as Extract<ExclusionSet, { ok: false }>;
  if (read.truncated) return exclusionsUnavailable(OVER_CEILING) as Extract<ExclusionSet, { ok: false }>;
  return read.rows;
}

/**
 * ONE direction of `userId`'s block list, read to its END — for the sites that
 * keep the two directions apart (Compass's profile and its per-tool hidden-user
 * refresh), which read each direction range-less and so held a prefix past
 * 1,000 rows. It resolves the shape of the supabase read it replaces,
 * `{ data, error }`, so each caller's error handling is unchanged; but `data` is
 * the WHOLE direction (rows naming the counter-party: `blocked_id` for the
 * `blocker_id` side, `blocker_id` for the other), or `null` WITH an `error` (any unreadable result of
 * pagedBlockRows): never a prefix, never `null` without one. A thrown read still
 * rejects, as the read it replaces could, into the caller's own catch.
 */
export async function readBlockDirection(
  sc: any,
  side: "blocker_id" | "blocked_id",
  userId: string,
): Promise<{ data: any[]; error: null } | { data: null; error: { message: string } }> {
  if (!sc || !userId) return { data: null, error: { message: "no client or user" } };
  // The first read is the one each site made, byte for byte: only the counter-party column.
  const rows = side === "blocker_id"
    ? await pagedBlockRows(() => sc.from("blocks").select("blocked_id").eq("blocker_id", userId), () => sc.from("blocks").select("id, blocked_id").eq("blocker_id", userId))
    : await pagedBlockRows(() => sc.from("blocks").select("blocker_id").eq("blocked_id", userId), () => sc.from("blocks").select("id, blocker_id").eq("blocked_id", userId));
  return Array.isArray(rows) ? { data: rows, error: null } : { data: null, error: { message: rows.reason } };
}

/**
 * Refuse a request whose entire response is a block-scoped roster (shape 3
 * above), with the code that means "the check could not be performed".
 *
 * `degraded_unavailable` → 503 + `retryable: true`. Deliberately NOT `db_error`
 * (500): nothing is broken about the request, a transient read failed, and the
 * client should offer a retry rather than surface a hard failure. `requireUser`
 * already answers exactly this way when `profiles.account_status` is
 * unreadable, so the client already understands the code.
 *
 * The `reason` is logged and NEVER sent: it is a PostgREST message that can
 * name tables and columns.
 */
export function sendExclusionsUnavailable(
  req: Request,
  res: Response,
  set: Extract<ExclusionSet, { ok: false }>,
  where: string,
): void {
  (req as any).log?.error?.(
    { reason: set.reason, where },
    "block/exclusion list unreadable — refusing rather than serving an unfiltered roster",
  );
  sendError(
    res,
    "degraded_unavailable",
    "Could not verify who is blocked. Please try again.",
  );
}
