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
import { sendError } from "./http.js"; import { readWhole, afterKey } from "./feedReads.js"; // census-telegraph T220: the per-direction whole-list readers below read whole, by key

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
export function exclusionsUnavailable(reason: unknown): Extract<ExclusionSet, { ok: false }> {
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
 * The WHOLE-LIST read (no `among`) was one range-less read too, so a viewer with
 * more than `db-max-rows` block rows got a prefix (census-telegraph §94, found-not-
 * fixed until T220c). It now reads WHOLE, by key (lib/feedReads.ts readWhole): the same `.or()` read first, with its exact count (T220d) — one round trip under the cap —
 * and an answer shorter than its count was cut (by the hosted db-max-rows, or by a server set BELOW the page size), so it is read again by the primary key, `id`, with counts; a list that cannot be read whole is `ok: false`, never the prefix it got. lib/blocks.ts fetchBlockedSet is this read.
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

  const whole = await readWhole<any>( // census-telegraph §94 (T220c): read WHOLE, by key — one range-less read was cut at db-max-rows with no error and served the prefix
    (after, size) => afterKey(sc.from("blocks").select("id, blocker_id, blocked_id", { count: "exact" }).or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`).order("id", { ascending: true }).limit(size), "id", after),
    (r) => String(r?.id), // the primary key: unique across BOTH directions (a mutual block is two rows naming the same counter-party)
    { first: () => sc.from("blocks").select("blocker_id, blocked_id", { count: "exact" }).or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`) }, // the plain read this path always made, plus its exact count (T220d): an answer short of its count — a db-max-rows below the page size included — is read again by key
  );
  if (!whole.ok) return exclusionsUnavailable(whole.error); // a returned error, an answer that is not a row list, a read that could not be read whole
  const ids = new Set<string>();
  for (const r of whole.value as any[]) {
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
 * NEVER REJECTS: every failure — returned, thrown, malformed, a side that cannot be read whole (T220d) — is `ok: false`.
 */
export async function readGroupBlockExclusions(
  sc: any,
  memberIds: readonly string[],
): Promise<ExclusionSet> {
  if (!sc) return exclusionsUnavailable("no client");
  if (memberIds.length === 0) return exclusions([]);
  try {
    const [asBlocker, asBlocked] = await Promise.all([ // census-telegraph §94 (T220d): each side WHOLE, by the primary key (readGroupSideOnce) — one unpaged `.in()` read was cut at db-max-rows with no error and served the prefix
      readGroupSideOnce(() => sc.from("blocks").select("id, blocker_id, blocked_id", { count: "exact" }).in("blocker_id", memberIds as string[])),
      readGroupSideOnce(() => sc.from("blocks").select("id, blocker_id, blocked_id", { count: "exact" }).in("blocked_id", memberIds as string[])),
    ]);
    const outIds = counterParties(asBlocker, "blocked_id");
    if (!Array.isArray(outIds)) return outIds;
    const inbIds = counterParties(asBlocked, "blocker_id");
    if (!Array.isArray(inbIds)) return inbIds;
    const ids = new Set<string>([...outIds, ...inbIds]);
    for (const id of memberIds) ids.delete(id); // members themselves stay
    return { ok: true, ids };
  } catch (err) {
    return exclusionsUnavailable(err);
  }
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

// ════════════════════════════════════════════════════════════════════════════
// DIRECTION, WHOLE, BATCH, COUNT — census-telegraph T220 part 2 (2026-10-17)
// ════════════════════════════════════════════════════════════════════════════
/**
 * "No subsystem may independently rediscover a blocked relationship." The
 * readers above collapse both directions into one set, and their whole-list
 * path was one range-less read (§94; paged since T220c). The private block reads left after T220
 * part 1 each needed one of four things those readers do not give:
 *
 *   DIRECTION  WHICH way the row points. "You blocked them" and "they blocked
 *              you" are different answers: the passport's `isBlocker`, the
 *              interaction permissions' blocked / blocks_you / mutual_block and
 *              canUnblock, the Compass profile's blockedUserIds vs
 *              blockerUserIds — and compass `surface=passport` reads ONE
 *              direction only.
 *   WHOLE      a per-direction whole list that is never a prefix. A range-less
 *              read is cut at db-max-rows (1,000 hosted) with no error, and
 *              every block past the cut was simply not excluded.
 *   BATCH      a pair read in the shape services/telegraph/coalescedReads.ts
 *              coalesces (`.select().eq().eq().limit(1)`), so resolving fifty
 *              share cards is ONE `blocks` query, not fifty `.or()` replays
 *              (T448, "no N+1").
 *   COUNT      the moderation dossier states how many block ROWS touch a user.
 *
 * The module's contract holds for every one of them: NEVER REJECTS, and every
 * failure — a returned error, a thrown read, an answer that is not a row list,
 * a row that does not name its counter-party, a whole read that could not be
 * read whole, a scoped row outside its own filter, a count read with no count —
 * is the unreadable value (`ok: false`). None has a spelling that means "no
 * block", and every `ok: true` result carries `ids`, so `isExcluded` applies to
 * all of them unchanged.
 */

/** The unreadable value every reader in this module answers. */
type Unreadable = Extract<ExclusionSet, { ok: false }>;

/** Which way a block row points, seen from the viewer: `outgoing` — the viewer blocked them; `incoming` — they blocked the viewer. */
export type BlockDirection = "outgoing" | "incoming";

/** The viewer's own column and the counter-party's, per direction. */
const SIDES: Readonly<Record<BlockDirection, { readonly self: "blocker_id" | "blocked_id"; readonly other: "blocked_id" | "blocker_id" }>> = {
  outgoing: { self: "blocker_id", other: "blocked_id" },
  incoming: { self: "blocked_id", other: "blocker_id" },
};

const OUT_OF_SCOPE = "a blocks row outside the read's own filter";
const SCOPED_CUT = "a scoped blocks read answered a count that does not match its rows";
const NO_COUNT = "a blocks read answered without its count";

/**
 * ONE direction's counter-parties for `viewerId`, as an ExclusionSet:
 * `outgoing` → everyone the viewer blocked; `incoming` → everyone who blocked
 * the viewer. For a site that reads one direction ONLY (compass
 * `surface=passport`) or falls back per direction (CompassTools).
 *
 * WHOLE LIST (no `among`): read whole, by key (lib/feedReads.ts `readWhole`).
 * The first request is the plain read the private sites made —
 * `select(<other>, { count: "exact" }).eq(<self>, viewer)` — so a list under
 * the row cap costs the same one round trip; when its count says rows were
 * cut, the read pages by the counter-party key (unique per direction, since
 * UNIQUE(blocker_id, blocked_id)) until the count is met. A list that cannot be
 * read whole is `ok: false`, never the prefix it got.
 *
 * SCOPED (`among`): one `.in()` read per BLOCK_AMONG_CHUNK candidates, which
 * matches at most one row per candidate. Each answer is held to its own
 * filter, the checks the memory graph made by hand: a row whose viewer column
 * is not the viewer, or whose counter-party is not in the chunk, a count that
 * is missing or disagrees with the rows — each is `ok: false`.
 *
 * NEVER REJECTS.
 */
export async function readBlockDirection(
  sc: any,
  viewerId: string,
  direction: BlockDirection,
  opts?: { among?: readonly string[] },
): Promise<ExclusionSet> {
  if (!sc || !viewerId || !SIDES[direction]) return exclusionsUnavailable("no client, viewer or direction");
  try {
    return await readBlockDirectionOnce(sc, viewerId, direction, opts?.among);
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}

async function readBlockDirectionOnce(
  sc: any,
  viewerId: string,
  direction: BlockDirection,
  among: readonly string[] | undefined,
): Promise<ExclusionSet> {
  // Every column in a query below is a LITERAL, per direction, so the schema scan
  // (schemaColumnProductionScan) checks each against production; `self` / `other`
  // only read the rows that come back.
  const { self, other } = SIDES[direction];
  const outgoing = direction === "outgoing";
  if (among) {
    if (among.length === 0) return exclusions([]);
    const ids = new Set<string>();
    for (let i = 0; i < among.length; i += BLOCK_AMONG_CHUNK) {
      const chunk = among.slice(i, i + BLOCK_AMONG_CHUNK) as string[];
      const scope = new Set(chunk);
      const res = await (outgoing
        ? sc.from("blocks").select("blocker_id, blocked_id", { count: "exact" }).eq("blocker_id", viewerId).in("blocked_id", chunk)
        : sc.from("blocks").select("blocker_id, blocked_id", { count: "exact" }).eq("blocked_id", viewerId).in("blocker_id", chunk));
      if (res?.error) return exclusionsUnavailable(res.error);
      if (!Array.isArray(res?.data)) return exclusionsUnavailable(NOT_ROWS);
      if (typeof res.count !== "number") return exclusionsUnavailable(NO_COUNT);
      if (res.count !== res.data.length) return exclusionsUnavailable(SCOPED_CUT);
      for (const r of res.data as any[]) {
        const id = idOf(r?.[other]);
        if (id === null) return exclusionsUnavailable(NO_COUNTERPARTY);
        if (r?.[self] !== viewerId || !scope.has(id)) return exclusionsUnavailable(OUT_OF_SCOPE);
        ids.add(id);
      }
    }
    return { ok: true, ids };
  }
  const base = () => (outgoing
    ? sc.from("blocks").select("blocked_id", { count: "exact" }).eq("blocker_id", viewerId)
    : sc.from("blocks").select("blocker_id", { count: "exact" }).eq("blocked_id", viewerId));
  const whole = await readWhole<Record<string, unknown>>(
    (after, size) => afterKey((outgoing ? base().order("blocked_id", { ascending: true }) : base().order("blocker_id", { ascending: true })).limit(size), other, after),
    (r) => String(r?.[other]),
    { first: base },
  );
  if (!whole.ok) return exclusionsUnavailable(whole.error);
  const ids = counterParties({ data: whole.value }, other);
  if (!Array.isArray(ids)) return ids;
  return { ok: true, ids: new Set(ids) };
}

/**
 * Both directions for `viewerId`, KEPT APART: `outgoing` (the viewer blocked
 * them), `incoming` (they blocked the viewer) and `ids`, their union — so the
 * result is itself an ExclusionSet and `isExcluded(dirs, id)` reads the block
 * either way. Each direction is read exactly as `readBlockDirection` reads it
 * (whole and by key, or scoped by `among`); either direction failing makes the
 * whole answer `ok: false` — half a block list is not a block list.
 *
 * With `among` this is also the BATCHED pair form: for one viewer and N
 * others, `outgoing.has(o)` / `incoming.has(o)` answer each pair's direction
 * from two reads per chunk instead of 2N.
 *
 * NEVER REJECTS.
 */
export type BlockDirections =
  | { readonly ok: true; readonly outgoing: ReadonlySet<string>; readonly incoming: ReadonlySet<string>; readonly ids: ReadonlySet<string> }
  | Unreadable;

export async function readBlockDirections(
  sc: any,
  viewerId: string,
  opts?: { among?: readonly string[] },
): Promise<BlockDirections> {
  if (!sc || !viewerId) return exclusionsUnavailable("no client or viewer");
  try {
    const [outgoing, incoming] = await Promise.all([
      readBlockDirectionOnce(sc, viewerId, "outgoing", opts?.among),
      readBlockDirectionOnce(sc, viewerId, "incoming", opts?.among),
    ]);
    if (!outgoing.ok) return outgoing;
    if (!incoming.ok) return incoming;
    return { ok: true, outgoing: outgoing.ids, incoming: incoming.ids, ids: new Set([...outgoing.ids, ...incoming.ids]) };
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}

/**
 * One pair, per direction: `aBlockedB` (a row blocker=a, blocked=b) and
 * `bBlockedA`; `ids` holds `b` when either is true, as `readPairExclusion`'s
 * does. Two reads, each `.select("blocker_id").eq("blocker_id", x)
 * .eq("blocked_id", y).limit(1)` — exactly the pair shape
 * services/telegraph/coalescedReads.ts batches, so every pair read issued in
 * one turn through a coalescing client becomes ONE `.in().in()` query (both
 * directions share it). `.limit(1)`, never `.maybeSingle()`, for the reason
 * `readPairExclusion` gives.
 *
 * NEVER REJECTS: a returned error, a thrown read or an answer that is not a row
 * list, in either direction, is `ok: false`.
 */
export type PairDirections =
  | { readonly ok: true; readonly aBlockedB: boolean; readonly bBlockedA: boolean; readonly ids: ReadonlySet<string> }
  | Unreadable;

export async function readPairDirections(sc: any, a: string, b: string): Promise<PairDirections> {
  if (!sc || !a || !b) return exclusionsUnavailable("no client or user pair");
  try {
    const [ab, ba] = await Promise.all([blockRowExistsOnce(sc, a, b), blockRowExistsOnce(sc, b, a)]);
    if (typeof ab !== "boolean") return ab;
    if (typeof ba !== "boolean") return ba;
    return { ok: true, aBlockedB: ab, bBlockedA: ba, ids: new Set(ab || ba ? [b] : []) };
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}

async function blockRowExistsOnce(sc: any, blocker: string, blocked: string): Promise<boolean | Unreadable> {
  const res = await sc.from("blocks").select("blocker_id").eq("blocker_id", blocker).eq("blocked_id", blocked).limit(1);
  if (res?.error) return exclusionsUnavailable(res.error);
  if (!Array.isArray(res?.data)) return exclusionsUnavailable(NOT_ROWS);
  return res.data.length > 0;
}

/**
 * How many block ROWS touch `userId`: `outgoing` (rows they wrote), `incoming`
 * (rows naming them) or `either` (both — a mutual block is two rows). A HEAD
 * read with `{ count: "exact" }`, so Postgres counts and the row cap does not
 * apply. For a record that states a count (the moderation dossier); a site that
 * asks "is anyone blocked" wants the readers above, not a count.
 *
 * NEVER REJECTS: a returned error, a thrown read, or an answer whose count is
 * not a non-negative integer is `ok: false` — never `count ?? 0`.
 */
export type BlockRowCount = { readonly ok: true; readonly count: number } | Unreadable;

export async function countBlockRows(sc: any, userId: string, direction: BlockDirection | "either"): Promise<BlockRowCount> {
  if (!sc || !userId || !(direction === "either" || SIDES[direction])) return exclusionsUnavailable("no client, user or direction");
  try {
    return await countBlockRowsOnce(sc, userId, direction);
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}

async function countBlockRowsOnce(sc: any, userId: string, direction: BlockDirection | "either"): Promise<BlockRowCount> {
  const head = sc.from("blocks").select("id", { count: "exact", head: true });
  const res = await (direction === "either"
    ? head.or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`)
    : direction === "outgoing" ? head.eq("blocker_id", userId) : head.eq("blocked_id", userId));
  if (res?.error) return exclusionsUnavailable(res.error);
  if (typeof res?.count !== "number" || !Number.isSafeInteger(res.count) || res.count < 0) return exclusionsUnavailable(NO_COUNT);
  return { ok: true, count: res.count };
}

// ════════════════════════════════════════════════════════════════════════════
// MUTES — census-telegraph T220c (2026-10-17)
// ════════════════════════════════════════════════════════════════════════════
/**
 * `user_mutes` is the other exclusion table this module's header names: a row
 * (muter_id → muted_id) HIDES the muted person from the muter, and emptiness
 * SHOWS. Its list readers had the edge T220 part 2 closed for `blocks`: each
 * checked a RETURNED error and then wrote `data ?? []` (or skipped a row it
 * could not read), so an answer with no error that is not a row list
 * (`data: null`, a string, an object) — or a row that does not name who was
 * muted — built the SAME empty mute set as a healthy "nobody is muted".
 */
const NO_MUTED = "a user_mutes row did not name who was muted";

/**
 * Everyone `viewerId` MUTED, as an ExclusionSet — the mute list's definition
 * of record. Each caller answers `!ok` with the branch it already took for a
 * returned error (a refusal, a kept snapshot, a degrade, a named soft failure);
 * this decides only that an answer that is not an answer is not one.
 *
 * WHOLE, by key (lib/feedReads.ts readWhole), exactly as lib/mediaEligibility.ts
 * already read it: the first request is the plain read the list sites made
 * plus its exact count — `select("muted_id", { count: "exact" }).eq("muter_id",
 * viewer)` — one round trip under the row cap; past it, pages by `muted_id`
 * (unique per muter: UNIQUE(muter_id, muted_id)). A list that cannot be read
 * whole is `ok: false`, never the prefix it got.
 *
 * NEVER REJECTS: a returned error, a thrown read, an answer that is not a row
 * list, a row that does not name who was muted, a cut read — each `ok: false`.
 */
export async function readMuteExclusions(sc: any, viewerId: string): Promise<ExclusionSet> {
  if (!sc || !viewerId) return exclusionsUnavailable("no client or viewer");
  try {
    const base = () => sc.from("user_mutes").select("muted_id", { count: "exact" }).eq("muter_id", viewerId);
    const whole = await readWhole<any>(
      (after, size) => afterKey(base().order("muted_id", { ascending: true }).limit(size), "muted_id", after),
      (r) => String(r?.muted_id),
      { first: base },
    );
    if (!whole.ok) return exclusionsUnavailable(whole.error);
    const ids = new Set<string>();
    for (const r of whole.value as any[]) {
      const id = idOf(r?.muted_id);
      if (id === null) return exclusionsUnavailable(NO_MUTED);
      ids.add(id);
    }
    return { ok: true, ids };
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}

/**
 * How many people `userId` has muted: a HEAD read with `{ count: "exact" }`, so
 * Postgres counts and the row cap does not apply — for a record that states a
 * count (the moderation dossier), as countBlockRows is for blocks.
 *
 * NEVER REJECTS: a returned error, a thrown read, or an answer whose count is
 * not a non-negative integer is `ok: false` — never `count ?? 0`.
 */
export async function countMuteRows(sc: any, userId: string): Promise<BlockRowCount> {
  if (!sc || !userId) return exclusionsUnavailable("no client or user");
  try {
    const res = await sc.from("user_mutes").select("id", { count: "exact", head: true }).eq("muter_id", userId);
    if (res?.error) return exclusionsUnavailable(res.error);
    if (typeof res?.count !== "number" || !Number.isSafeInteger(res.count) || res.count < 0) return exclusionsUnavailable("a user_mutes count read answered without its count");
    return { ok: true, count: res.count };
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GROUP SIDES — census-telegraph §94 (T220d, 2026-10-18)
// ════════════════════════════════════════════════════════════════════════════
/**
 * One side of readGroupBlockExclusions — every row a member wrote, or every
 * row naming a member — read WHOLE, by the primary key. Each side was one
 * unpaged `.in()` read over the members, which PostgREST cuts at db-max-rows
 * (1,000 hosted) with no error: a large group, or one member blocked by many,
 * got a prefix, and every block past the cut was not excluded for the group.
 *
 * `base` is the side's read with `{ count: "exact" }`. The first request is that
 * read as it is, so a side whose answer is whole by its count is one round
 * trip. An answer short of its count (the hosted cap, or a server set BELOW the
 * page size) is read again by `id`: unique across both directions and across
 * members, which the counter-party column is not (two members may block the
 * same person). A cut it cannot page past, a page that repeats a key, an empty
 * page while rows remain, or an answer that is not a row list is the side's
 * failure — never the rows gathered so far.
 *
 * Answers the `{ data } | { error }` shape `counterParties` reads, so its checks
 * (an error, a non-list, a row not naming its counter-party) hold over the WHOLE
 * side unchanged. A thrown read rejects; readGroupBlockExclusions' catch
 * answers it.
 */
async function readGroupSideOnce(base: () => any): Promise<{ data: unknown[] } | { error: unknown }> {
  const whole = await readWhole<any>(
    (after, size) => afterKey(base().order("id", { ascending: true }).limit(size), "id", after),
    (r) => String(r?.id),
    { first: base },
  );
  return whole.ok ? { data: whole.value } : { error: whole.error };
}

// ════════════════════════════════════════════════════════════════════════════
// RESTRICTIONS — census-telegraph T220d (2026-10-18)
// ════════════════════════════════════════════════════════════════════════════
/**
 * How many people `userId` has restricted (the `user_restrictions` rows they
 * wrote, restrictor_id = userId): a HEAD read with `{ count: "exact" }`, so
 * Postgres counts and the row cap does not apply — for the moderation
 * dossier's `restrictCount`, as countMuteRows is for `muteCount`.
 *
 * The dossier read it inline and rendered `count ?? 0`, so an answer with no
 * error and no count showed a moderator "restricts nobody" for a read that
 * measured nothing, and a thrown read took the whole dossier down with it.
 *
 * NEVER REJECTS: a returned error, a thrown read, or an answer whose count is
 * not a non-negative integer is `ok: false` — never `count ?? 0`.
 */
export async function countRestrictRows(sc: any, userId: string): Promise<BlockRowCount> {
  if (!sc || !userId) return exclusionsUnavailable("no client or user");
  try {
    const res = await sc.from("user_restrictions").select("id", { count: "exact", head: true }).eq("restrictor_id", userId);
    if (res?.error) return exclusionsUnavailable(res.error);
    if (typeof res?.count !== "number" || !Number.isSafeInteger(res.count) || res.count < 0) return exclusionsUnavailable("a user_restrictions count read answered without its count");
    return { ok: true, count: res.count };
  } catch (err) {
    return exclusionsUnavailable(err);
  }
}
