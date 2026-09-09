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
 * Bidirectional block set for one viewer: every user id that blocked `viewerId`
 * or was blocked by them.
 *
 * `among` scopes the read to a candidate list (two `.in()` reads instead of one
 * `.or()` over the viewer's whole block list) — use it when the candidate set is
 * already known and bounded, which is most list surfaces.
 *
 * A block is symmetric for visibility: if A blocked B then neither may see the
 * other, so both directions are collapsed into one set of counter-party ids.
 */
export async function readBlockExclusions(
  sc: any,
  viewerId: string,
  opts?: { among?: readonly string[] },
): Promise<ExclusionSet> {
  if (!sc || !viewerId) return exclusionsUnavailable("no client or viewer");

  const among = opts?.among;
  if (among) {
    // An empty candidate list has an empty answer — and asking PostgREST for
    // `.in("x", [])` is a wasted round trip, not a safety question.
    if (among.length === 0) return exclusions([]);
    const [out, inb] = await Promise.all([
      sc.from("blocks").select("blocked_id").eq("blocker_id", viewerId).in("blocked_id", among as string[]),
      sc.from("blocks").select("blocker_id").eq("blocked_id", viewerId).in("blocker_id", among as string[]),
    ]);
    if (out?.error) return exclusionsUnavailable(out.error);
    if (inb?.error) return exclusionsUnavailable(inb.error);
    const ids = new Set<string>();
    for (const r of (out?.data ?? []) as any[]) if (r?.blocked_id) ids.add(String(r.blocked_id));
    for (const r of (inb?.data ?? []) as any[]) if (r?.blocker_id) ids.add(String(r.blocker_id));
    return { ok: true, ids };
  }

  const { data, error } = await sc
    .from("blocks")
    .select("blocker_id, blocked_id")
    .or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`);
  if (error) return exclusionsUnavailable(error);
  const ids = new Set<string>();
  for (const r of (data ?? []) as any[]) {
    if (r?.blocker_id === viewerId) { if (r?.blocked_id) ids.add(String(r.blocked_id)); }
    else if (r?.blocker_id) ids.add(String(r.blocker_id));
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
 */
export async function readPairExclusion(sc: any, a: string, b: string): Promise<ExclusionSet> {
  if (!sc || !a || !b) return exclusionsUnavailable("no client or user pair");
  const { data, error } = await sc
    .from("blocks")
    .select("blocker_id")
    .or(`and(blocker_id.eq.${a},blocked_id.eq.${b}),and(blocker_id.eq.${b},blocked_id.eq.${a})`)
    // `.limit(1)`, never `.maybeSingle()`: a MUTUAL block is two rows, both
    // permitted by UNIQUE(blocker_id, blocked_id), and maybeSingle raises on
    // >1 — so the STRONGEST block state used to error into `data: null` and
    // read as "not blocked". Same trap ./blockGuard.ts documents.
    .limit(1);
  if (error) return exclusionsUnavailable(error);
  return { ok: true, ids: new Set(Array.isArray(data) && data.length > 0 ? [b] : []) };
}

/**
 * Union of every block relationship touching ANY id in `memberIds`, minus the
 * members themselves. Used where a recommendation or roster is built FOR a
 * group rather than for one viewer: anybody a member blocked, or who blocked a
 * member, is excluded for the whole group.
 */
export async function readGroupBlockExclusions(
  sc: any,
  memberIds: readonly string[],
): Promise<ExclusionSet> {
  if (!sc) return exclusionsUnavailable("no client");
  if (memberIds.length === 0) return exclusions([]);
  const [asBlocker, asBlocked] = await Promise.all([
    sc.from("blocks").select("blocker_id, blocked_id").in("blocker_id", memberIds as string[]),
    sc.from("blocks").select("blocker_id, blocked_id").in("blocked_id", memberIds as string[]),
  ]);
  if (asBlocker?.error) return exclusionsUnavailable(asBlocker.error);
  if (asBlocked?.error) return exclusionsUnavailable(asBlocked.error);
  const ids = new Set<string>();
  for (const b of (asBlocker?.data ?? []) as any[]) if (b?.blocked_id) ids.add(String(b.blocked_id));
  for (const b of (asBlocked?.data ?? []) as any[]) if (b?.blocker_id) ids.add(String(b.blocker_id));
  for (const id of memberIds) ids.delete(id); // members themselves stay
  return { ok: true, ids };
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
