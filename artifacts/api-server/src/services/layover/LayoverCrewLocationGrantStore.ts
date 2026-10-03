/**
 * LayoverCrewLocationGrantStore — the §14 L4 grant store the precision ladder
 * has never had.
 *
 * `services/airport/LayoverCrewService.ts` implements §14's disclosure rules in
 * full and purely: `LOCATION_PRECISIONS`, `CrewLocationGrant`,
 * `CrewShareSignals`, `evaluateCrewLocationShare`, `locationPrecisionFor`, with
 * an exhaustive test sweep asserting that no argument combination yields
 * `precise` without a live, target-issued, crew-scoped grant.
 *
 * Every caller has had to pass `grant: null`, which the ladder reads as
 * `never_granted` — so its only reachable answers were `none` and
 * `meeting_point`, and census L124/L132 stay N. This module is the row source.
 * Storage is migration 3514.
 *
 * ── IT SUPPLIES PERMISSION, AND NOTHING SUPPLIES A POSITION ──────────────────
 * 3514 holds no coordinate and 2984's postcondition asserting the crew tables
 * hold none is left standing. So wiring this in does not put a traveller's
 * position on the wire; it makes the RUNG publishable, which is what the §13
 * map element and every meet-action gate are actually keyed on. Where a
 * position would live is a separate decision with its own retention answer, and
 * this module deliberately does not pre-empt it.
 *
 * ── EVERY READ REFUSES RATHER THAN RETURNING "NOBODY GRANTED ANYTHING" ───────
 * `LayoverCrewStore`'s rule, and it bites harder here. An unreadable grant
 * table and a crew where nobody has shared their location produce the same
 * empty map, and the ladder turns both into `meeting_point`. That is the SAFE
 * direction for disclosure — a failed read discloses less, never more — which
 * is exactly why it must not be silent: it is a feature that degrades to "no
 * one is sharing" and looks correct while doing it, and the traveller who
 * tapped "share my location" is told nothing. So the read returns a
 * discriminated result and the route publishes the degrade.
 *
 * NOTE WHICH WAY ROUND THAT IS, because it is the opposite of the crew roster.
 * There, a failed read must not say "your crew is empty". Here, a failed read
 * MUST NOT say "your crewmate is sharing" — so the fail-closed answer is the
 * absence, and the thing being protected against is the absence passing
 * unreported rather than the absence itself.
 *
 * ── A REVOKED GRANT IS READ, NOT SKIPPED ─────────────────────────────────────
 * The obvious read is "live grants only", `revoked_at IS NULL`. It loses the
 * distinction the ladder exists to make: a skipped revoked row is an absent
 * row, and an absent row is `never_granted`, which
 * `evaluateCrewLocationShare`'s own comment singles out — "An absent grant is
 * `never_granted`, never 'expired' — the two are different answers and only one
 * of them means a traveller once said yes."
 *
 * So `newestGrantsForCrew` reads the newest row per member WHATEVER its
 * revocation state, and hands `revokedAtMs` back beside the grant for the
 * caller to put in `CrewShareSignals`. The ladder then reports `user_revoked`
 * with the instant, which is a true statement about a decision the traveller
 * made.
 *
 * ── STORAGE ──────────────────────────────────────────────────────────────────
 * `layover_crew_location_grants`, created by migration 3514. NOT APPLIED to any
 * shared database as this file lands — see 3514's header; until it is, every
 * read here is a refusal and the ladder answers exactly what it answers today.
 * That is stated rather than assumed because the opposite claim is how
 * `LayoverCrewStore`'s header went stale for three months.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import type {
  CrewLocationGrant,
  CrewShareSignals,
} from "../airport/LayoverCrewService.js";

const logger = rootLogger.child({ service: "LayoverCrewLocationGrantStore" });

/**
 * NOTE FOR ANYONE TIDYING THIS UP: the `.from(...)` call sites below write the
 * table name as a STRING LITERAL rather than using this constant, and replacing
 * them with the constant would be a regression. `check:write-path-columns`
 * resolves a write/read site only when it can see `.from("<literal>")` in the
 * AST; `.from(CONSTANT)` is a `dynamic table name` blind spot it cannot diff
 * against the live schema at all — which is the whole failure class it exists to
 * catch. `LayoverCrewStore` carries the same note for the same reason. This
 * constant stays exported because the tests import it.
 */
export const CREW_LOCATION_GRANT_TABLE = "layover_crew_location_grants";

/**
 * The largest crew 3514's sibling will assemble grants for. Mirrors
 * `LayoverCrewStore.CREW_READ_LIMIT` deliberately: a crew is at most 12 people
 * (2984's `max_members` CHECK), so a read that could return more than one row
 * per member per crew is reading something it did not mean to.
 *
 * Several rows per member is the NORMAL state here — grants accumulate, one per
 * act of consent — so the bound is generous and the newest-per-member fold
 * below is what actually resolves them. The limit's job is only to stop one
 * crew's history from becoming an unbounded read.
 */
export const GRANT_READ_LIMIT = 240;

/** A grant as stored, including the revocation the ladder needs to name a cause. */
export interface CrewLocationGrantRow {
  id: string;
  crewId: string;
  grantedByUserId: string;
  sessionId: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

type Fail = { ok: false; reason: "read_failed" };
export type GrantRead<T> = { ok: true; value: T } | Fail;

const FAILED: Fail = { ok: false, reason: "read_failed" };

const GRANT_COLUMNS =
  "id,crew_id,granted_by_user_id,session_id,granted_at,expires_at,revoked_at";

function toGrantRow(r: Record<string, any>): CrewLocationGrantRow {
  return {
    id: r.id,
    crewId: r.crew_id,
    grantedByUserId: r.granted_by_user_id,
    sessionId: r.session_id,
    grantedAt: r.granted_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at ?? null,
  };
}

/**
 * The newest grant per member, as the ladder wants it.
 *
 * `grant` is `CrewLocationGrant` exactly — the pure solver's own type, built
 * here so the ISO→epoch-milliseconds conversion happens in ONE place. The
 * solver has no clock and no I/O by contract, so the conversion is this layer's
 * job, and doing it per call site is how two surfaces end up disagreeing about
 * when a grant expired.
 *
 * `revokedAtMs` is `null` when the grant has not been revoked. It is carried
 * separately rather than folded into `grant` because `CrewLocationGrant` has no
 * revocation field, on purpose: a grant is what was given, and a revocation is
 * a later and different act. The ladder composes them.
 */
export interface MemberGrant {
  grant: CrewLocationGrant;
  revokedAtMs: number | null;
}

/**
 * A timestamp that must parse. `null` for anything unparseable, and the caller
 * treats that as no grant at all.
 *
 * NOT `Date.parse(x) || fallback`: `||` would take 0 (the epoch) as falsy and
 * substitute, and `NaN` propagates silently through every comparison in
 * `evaluateCrewLocationShare` — `NaN > nowMs` is false and `NaN < first.at` is
 * false, so an unparseable expiry would make a grant look LIVE FOREVER by
 * failing every terminator test. That is the one direction this must not fail,
 * which is why an unparseable row is dropped rather than defaulted.
 */
function instantMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Every member's newest grant for one crew.
 *
 * Returns a Map keyed by `grantedByUserId`. A member absent from the map has
 * never granted anything, which the ladder reads as `never_granted` — and that
 * is a MEASURED absence, only ever returned from a successful read.
 */
export async function newestGrantsForCrew(
  db: SupabaseClient,
  crewId: string,
): Promise<GrantRead<Map<string, MemberGrant>>> {
  const { data, error } = await db
    .from("layover_crew_location_grants")
    .select(GRANT_COLUMNS)
    .eq("crew_id", crewId)
    .order("granted_at", { ascending: false })
    .limit(GRANT_READ_LIMIT);
  if (error) {
    logger.warn(
      { err: error.message, crewId },
      "crew location grant read failed — refusing rather than reporting that nobody is sharing",
    );
    return FAILED;
  }

  const out = new Map<string, MemberGrant>();
  for (const raw of (data ?? []) as Array<Record<string, any>>) {
    const row = toGrantRow(raw);
    // Newest-first order plus first-wins is what makes this the NEWEST grant
    // per member. Taking a maximum over expiries instead would let a revoked
    // long grant outlive the short one that replaced it.
    if (out.has(row.grantedByUserId)) continue;

    const grantedAtMs = instantMs(row.grantedAt);
    const expiresAtMs = instantMs(row.expiresAt);
    if (grantedAtMs === null || expiresAtMs === null) {
      // A row whose window cannot be read is not a grant. Dropping it means the
      // ladder answers `never_granted` for this member, which discloses less
      // than any guess would. Logged because it means 3514's NOT NULL columns
      // hold something no reader understands.
      logger.warn(
        { crewId, grantId: row.id },
        "crew location grant has an unreadable window — treated as no grant",
      );
      continue;
    }

    out.set(row.grantedByUserId, {
      grant: {
        grantedByUserId: row.grantedByUserId,
        crewId: row.crewId,
        grantedAtMs,
        expiresAtMs,
      },
      revokedAtMs: instantMs(row.revokedAt),
    });
  }
  return { ok: true, value: out };
}

export type GrantWrite<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | "read_failed"
        | "write_failed"
        /** The granter is not in this crew, or their membership has ended. */
        | "not_a_member"
        /**
         * The window the caller asked for does not fit inside what the crew's
         * own life and the granter's certified return allow. See
         * `boundedGrantWindow`.
         */
        | "window_unavailable";
    };

/**
 * The derived bound on a grant's life, and the ONLY place a duration is decided.
 *
 * §14 L4 says "auto-expiring" and names no duration, so nothing here invents
 * one. What bounds a grant is the two instants the product has already derived
 * for other reasons:
 *
 *   * the CREW's `expires_at` — `crew_dissolved` is one of §14.1's five
 *     terminators, so a grant outliving its crew is inert anyway;
 *   * the granter's own certified hard return — `session_expired` is another,
 *     and the hard return is `certifySessionFeasibility`'s single canonical
 *     derivation, which `crewExpiryFor` already uses for the crew itself.
 *
 * A grant may therefore last until `min(crewExpiresAt, granterHardReturn)` and
 * no longer. A caller asking for less gets what they asked for; a caller asking
 * for more is CLAMPED rather than refused, because the traveller said yes and
 * the shorter grant is the one that honours both their consent and the bound.
 *
 * REFUSED, not clamped, when the bound is already in the past or unreadable:
 * `min(...)` at or before now would produce a grant whose window is empty,
 * which 3514's `expires_at > granted_at` CHECK refuses at the database and
 * which `locationPrecisionFor` would report as `ttl_elapsed` — blaming the TTL
 * for a write that was never valid. "There is no time left to share for" is a
 * real answer and this returns it instead.
 */
export function boundedGrantWindow(input: {
  nowMs: number;
  requestedExpiresAtMs: number | null;
  crewExpiresAtIso: string;
  granterHardReturnMs: number | null;
}): { ok: true; grantedAtMs: number; expiresAtMs: number } | { ok: false } {
  const crewMs = instantMs(input.crewExpiresAtIso);
  // An unreadable crew expiry is not "unbounded", it is unknown. The crew's own
  // reads are all bounded by this column, so a crew whose expiry cannot be read
  // is one no surface should be disclosing anything about.
  if (crewMs === null) return { ok: false };
  // An uncertified granter has no hard return, and the whole §14.1 apparatus
  // treats an uncertified member as infeasible rather than as unconstrained.
  if (input.granterHardReturnMs === null) return { ok: false };

  const ceiling = Math.min(crewMs, input.granterHardReturnMs);
  if (ceiling <= input.nowMs) return { ok: false };

  const requested = input.requestedExpiresAtMs;
  const expiresAtMs =
    requested !== null && Number.isFinite(requested)
      ? Math.min(requested, ceiling)
      : ceiling;
  if (expiresAtMs <= input.nowMs) return { ok: false };

  return { ok: true, grantedAtMs: input.nowMs, expiresAtMs };
}

export interface GrantCrewLocationInput {
  crewId: string;
  /** The person sharing. Only they can grant, and only for themselves. */
  grantedByUserId: string;
  /** Their own layover, so §14.1's `session_expired` terminator is derivable. */
  sessionId: string;
  grantedAtMs: number;
  expiresAtMs: number;
}

/**
 * Record one act of consent.
 *
 * MEMBERSHIP IS CHECKED HERE AND IT IS A READ, SO A FAILED READ REFUSES THE
 * GRANT. 3514 cascades `crew_id` but has no way to assert that the granter is
 * in the crew — a row count is not something a CHECK can see — so an unreadable
 * membership list is an unenforced scope, and the write must not proceed on
 * one. This is the rule `joinCrew` already applies to `max_members` and the
 * stops route to `MAX_STOPS`.
 *
 * It matters more here than there. `locationPrecisionFor` refuses a grant
 * scoped to another crew, but it has no way to tell that a grant names a crew
 * its granter was never in: the grant and the viewer's `sameCrewId` would agree,
 * and the ladder would answer `precise`. So "is the granter actually a member"
 * is a question only this write can answer, and it answers it before writing.
 *
 * NOT AN UPSERT, and no row is ever modified. Each grant is a new row, which is
 * what keeps the history of consent readable — see 3514's REVOCATION IS A
 * COLUMN.
 */
export async function grantCrewLocation(
  db: SupabaseClient,
  input: GrantCrewLocationInput,
): Promise<GrantWrite<CrewLocationGrantRow>> {
  const { data: mem, error: memErr } = await db
    .from("layover_crew_members")
    .select("crew_id,user_id,session_id,role,joined_at")
    .eq("crew_id", input.crewId)
    .eq("user_id", input.grantedByUserId)
    .is("left_at", null)
    .maybeSingle();
  if (memErr) {
    logger.warn(
      { err: memErr.message, crewId: input.crewId },
      "crew membership read failed on grant — refusing rather than writing an unscoped grant",
    );
    return { ok: false, reason: "read_failed" };
  }
  if (!mem) return { ok: false, reason: "not_a_member" };

  const { data, error } = await db
    .from("layover_crew_location_grants")
    .insert({
      crew_id: input.crewId,
      granted_by_user_id: input.grantedByUserId,
      session_id: input.sessionId,
      granted_at: new Date(input.grantedAtMs).toISOString(),
      expires_at: new Date(input.expiresAtMs).toISOString(),
    })
    .select(GRANT_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    logger.warn(
      { err: error?.message, crewId: input.crewId },
      "crew location grant insert failed",
    );
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: toGrantRow(data as Record<string, any>) };
}

/**
 * Take it back.
 *
 * REVOKES EVERY UNREVOKED GRANT this member holds for this crew, not just the
 * newest, and the plural is load-bearing. Grants accumulate by design, so a
 * member can hold several unrevoked rows; revoking only the newest would leave
 * an older one unrevoked, and a later read that happened to order differently
 * — or a future reader taking a maximum over expiries — would find a live
 * grant after the traveller had revoked. "I revoked" must not depend on the
 * reader's sort order.
 *
 * ALREADY-EXPIRED ROWS ARE REVOKED TOO, deliberately, because `revoked_at` is
 * the signal `evaluateCrewLocationShare` reads and an expired row that is later
 * re-read must still be able to say which came first. The terminator ordering
 * is the spec's, not this function's: a share that ended at boarding and is now
 * also revoked ended at boarding, and the ladder works that out from the
 * instants.
 *
 * REPORTS WHAT IT CHANGED, and `0` is a count rather than a failure. Revoking
 * when nothing was granted is not an error — the traveller's intent is already
 * the state of the world — but the caller is told, because a UI that says
 * "sharing stopped" over a revoke that matched nothing has told the traveller
 * something about a grant that never existed.
 */
export async function revokeCrewLocation(
  db: SupabaseClient,
  input: { crewId: string; userId: string },
  nowIso: string,
): Promise<GrantWrite<{ revoked: number }>> {
  const { data, error } = await db
    .from("layover_crew_location_grants")
    .update({ revoked_at: nowIso })
    .eq("crew_id", input.crewId)
    .eq("granted_by_user_id", input.userId)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    // A revocation that could not be written has NOT happened, and saying
    // otherwise is the worst lie this module could tell: the traveller would be
    // shown "sharing stopped" over a grant that is still live. There is no
    // best-effort reading of this write.
    logger.error(
      { err: error.message, crewId: input.crewId },
      "crew location revocation failed — the grant is still live and the caller must say so",
    );
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: { revoked: ((data ?? []) as unknown[]).length } };
}

/**
 * §14.1's five terminators, assembled from facts the route already holds.
 *
 * PURE, and takes no clock: the instants are what they are, and
 * `evaluateCrewLocationShare` compares them against `nowMs` itself. `undefined`
 * means "has not happened", which is the solver's own convention.
 *
 * ── WHAT EACH ONE IS DERIVED FROM, AND THE ONE THAT ISN'T ────────────────────
 *
 * `crewDissolvedAtMs` — the crew's `updated_at`, and ONLY when its status is
 *   `closed` or `disbanded`. That is exact today rather than approximate, and
 *   the reason is worth writing down because it is fragile: the only writes to
 *   `layover_crews.updated_at` in the tree are the two disband updates in
 *   `LayoverCrewStore` (`createCrew`'s ownerless-crew undo and `leaveCrew`'s
 *   owner-leaves path), so for a non-open crew `updated_at` IS the dissolution
 *   instant. ANY NEW WRITER OF THAT COLUMN BREAKS THIS DERIVATION, and breaks
 *   it in the unsafe direction — a later `updated_at` is a later dissolution,
 *   which keeps a share alive past the moment the crew ended. A dedicated
 *   `disbanded_at` column is the durable fix and is deliberately not added
 *   here: it is an ALTER on an applied table for a signal that, today, is
 *   already enforced more strictly upstream (see the next paragraph), so it
 *   would be schema churn buying nothing.
 *
 *   IN PRACTICE THIS SIGNAL IS NEVER THE ONE THAT FIRES, because
 *   `activeCrewForUser` filters `status <> 'disbanded'` and every crew read is
 *   bounded by `expires_at > now()`. A viewer whose crew has dissolved has no
 *   `sameCrewId`, so `locationPrecisionFor` returns `none` — stricter than the
 *   `meeting_point` that `crew_dissolved` would have produced. The signal is
 *   assembled anyway so the ladder can NAME the cause on the paths that do
 *   reach it, and so the rule does not depend on a filter two modules away.
 *
 * `sessionExpiredAtMs` — the granter's session `updated_at`, and only when its
 *   status is no longer live. Same shape and the same fragility;
 *   `expireOldSessions` is what sets both, together, in one UPDATE.
 *
 * `boardingAtMs` — the session's `boarding_time`. A SCHEDULED instant, not an
 *   observed boarding event, and that is honest rather than a compromise: using
 *   the schedule ends the share EARLIER than an observation would, which is the
 *   direction a disclosure terminator must err. A traveller who boards late
 *   has their location stop being shared at the time they told us they were
 *   boarding, which is what they consented to.
 *
 * `airportReentryAtMs` — NOT SUPPLIED, AND THIS IS A NAMED GAP RATHER THAN AN
 *   OVERSIGHT. §14.1 lists "airport re-entry" as a terminator. The only place
 *   that instant could come from is a checkpoint observation, and
 *   `layover_checkpoints` (migration 2992) is absent from the production schema
 *   snapshot — it is written but unapplied. There is nothing else in the tree
 *   that records when a traveller went back through security, so any value here
 *   would be invented. `undefined` is the solver's word for "has not happened",
 *   which is the truthful thing to pass: a share therefore survives airport
 *   re-entry until boarding time or the grant's own TTL, whichever comes first,
 *   and both of those are real. This is the one §14.1 terminator this build
 *   does not close, and it closes when 2992 is applied.
 */
export function crewShareSignalsFor(input: {
  crewStatus: string;
  crewUpdatedAt: string | null;
  granterSessionStatus: string | null;
  granterSessionUpdatedAt: string | null;
  granterBoardingTime: string | null;
  liveSessionStatuses: ReadonlyArray<string>;
  revokedAtMs: number | null;
}): CrewShareSignals {
  const signals: CrewShareSignals = {};

  if (input.crewStatus === "closed" || input.crewStatus === "disbanded") {
    const at = instantMs(input.crewUpdatedAt);
    if (at !== null) signals.crewDissolvedAtMs = at;
  }

  if (
    input.granterSessionStatus !== null &&
    !input.liveSessionStatuses.includes(input.granterSessionStatus)
  ) {
    const at = instantMs(input.granterSessionUpdatedAt);
    if (at !== null) signals.sessionExpiredAtMs = at;
  }

  const boarding = instantMs(input.granterBoardingTime);
  if (boarding !== null) signals.boardingAtMs = boarding;

  if (input.revokedAtMs !== null) signals.revokedAtMs = input.revokedAtMs;

  // airportReentryAtMs is deliberately never set. See the doc comment.
  return signals;
}
