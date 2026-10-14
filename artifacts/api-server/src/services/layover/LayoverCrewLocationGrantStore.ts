/**
 * LayoverCrewLocationGrantStore — the §14 L4 grant store the precision ladder
 * has never had. census-layover L166 ("Precise crew sharing: separate explicit
 * control, off by default") and L203 ("Crew membership/location rows require
 * membership and explicit permission"). Storage: migration 3787.
 *
 * PORTED BY CONTENT from open PR #569's module of the same name (lead ruling
 * LR-B58-1), re-verified against current main. What changed in the port, and
 * why, is listed where it happens:
 *   - every row carries its `sessionId` to the reader, because three §14.1
 *     terminators (boarding, session expired, airport re-entry) are facts about
 *     the session the grant was made from;
 *   - `grantCrewLocation` refuses a grant made from a session other than the one
 *     the granter is in the crew with (`session_not_in_crew`) — #569 wrote the
 *     URL's session unchecked, so a traveller with two layovers could bound a
 *     grant by the wrong hard return;
 *   - revocation can be scoped to every crew (`revokeCrewLocation` with no
 *     crew), and a crew's grants can be revoked together when it disbands
 *     (`revokeCrewLocationGrantsForCrew`); both treat an absent store (3787 not
 *     applied) as "nothing to revoke", never as a failure;
 *   - `crewShareSignalsFor` is NOT ported. It derived dissolution and session
 *     expiry from `updated_at`, which its own comment called fragile in the
 *     unsafe direction. The decision now lives in `LayoverCrewLocationShare.ts`,
 *     which treats a non-open crew or a non-live session as ENDED NOW.
 *
 * ── IT SUPPLIES PERMISSION, AND NOTHING SUPPLIES A POSITION ──────────────────
 * 3787 holds no coordinate and 2984's postcondition asserting the crew tables
 * hold none is left standing. A grant is a permission that nothing reads for a
 * position until a position store exists (census-layover LAY-C2).
 *
 * ── EVERY READ REFUSES RATHER THAN RETURNING "NOBODY GRANTED ANYTHING" ───────
 * An unreadable grant table and a crew where nobody has shared produce the same
 * empty map. Failing to read discloses less, never more — which is exactly why
 * it must not be silent: the traveller who tapped "share" would be told
 * nothing. So the read returns a discriminated result and the route publishes
 * the degrade (`location_grants_unreadable`).
 *
 * ── A REVOKED GRANT IS READ, NOT SKIPPED ─────────────────────────────────────
 * `newestGrantsForCrew` reads the newest row per member WHATEVER its
 * revocation state, so the ladder can report `user_revoked` rather than
 * `never_granted` for a traveller who said yes and took it back.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import type { CrewLocationGrant } from "../airport/LayoverCrewService.js";

const logger = rootLogger.child({ service: "LayoverCrewLocationGrantStore" });

/**
 * NOTE FOR ANYONE TIDYING THIS UP: the `.from(...)` call sites below write the
 * table name as a STRING LITERAL. `check:write-path-columns` resolves a site
 * only when it can see `.from("<literal>")`; `.from(CONSTANT)` is a blind spot.
 * This constant stays exported because the tests import it.
 */
export const CREW_LOCATION_GRANT_TABLE = "layover_crew_location_grants";

/**
 * The largest history one crew read will fold. A crew is at most 12 people
 * (2984's `max_members` CHECK) and grants accumulate one row per act of
 * consent, so the bound is generous; the newest-per-member fold below is what
 * resolves them. Its job is only to stop one crew's history from becoming an
 * unbounded read.
 */
export const GRANT_READ_LIMIT = 240;

/**
 * The most grant rows one member may hold in one crew: GRANT_READ_LIMIT shared
 * by the largest crew 2984 allows (12). DERIVED, not chosen: it is the bound
 * under which the crew read above can never truncate a member's newest grant,
 * so one member cycling share/stop cannot push another member's consent out of
 * the read (which would fail closed, but would silently end their share).
 */
export const MAX_GRANTS_PER_MEMBER = GRANT_READ_LIMIT / 12;

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
 * The newest grant per member, as the ladder wants it. `grant` is
 * `CrewLocationGrant` exactly (the pure solver's own type, converted to epoch
 * milliseconds HERE, once). `revokedAtMs` is carried beside it because a
 * revocation is a later and different act. `sessionId` is the session the
 * grant was made from.
 */
export interface MemberGrant {
  grant: CrewLocationGrant;
  revokedAtMs: number | null;
  sessionId: string;
}

/**
 * A timestamp that must parse; `null` otherwise. NOT `Date.parse(x) || x`:
 * `NaN` fails every comparison in `evaluateCrewLocationShare`, so an
 * unparseable expiry would make a grant look LIVE FOREVER. A row whose window
 * cannot be read is dropped — the ladder then answers `never_granted`, which
 * discloses less than any guess would.
 */
export function instantMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 42P01 / PGRST205: the relation does not exist — 3787 is not applied here. */
export function grantStoreAbsent(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
}

/**
 * Every member's newest grant for one crew, keyed by `grantedByUserId`. A
 * member absent from the map has never granted anything — a MEASURED absence,
 * only ever returned from a successful read.
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
      { err: error.message, code: (error as { code?: string }).code, crewId },
      "crew location grant read failed — refusing rather than reporting that nobody is sharing",
    );
    return FAILED;
  }

  const out = new Map<string, MemberGrant>();
  for (const raw of (data ?? []) as Array<Record<string, any>>) {
    const row = toGrantRow(raw);
    // Newest-first order plus first-wins: the NEWEST grant per member. Taking a
    // maximum over expiries instead would let a revoked long grant outlive the
    // short one that replaced it.
    if (out.has(row.grantedByUserId)) continue;

    const grantedAtMs = instantMs(row.grantedAt);
    const expiresAtMs = instantMs(row.expiresAt);
    if (grantedAtMs === null || expiresAtMs === null || typeof row.sessionId !== "string") {
      logger.warn({ crewId, grantId: row.id }, "crew location grant has an unreadable window — treated as no grant");
      // First-wins still applies: an unreadable NEWEST row must not let an
      // older, readable one stand in for it — that older grant was superseded.
      out.set(row.grantedByUserId, {
        grant: { grantedByUserId: row.grantedByUserId, crewId: row.crewId, grantedAtMs: Number.NaN, expiresAtMs: Number.NaN },
        revokedAtMs: null,
        sessionId: "",
      });
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
      sessionId: row.sessionId,
    });
  }
  return { ok: true, value: out };
}

/** True when a held grant's window could not be read (see `newestGrantsForCrew`). */
export function grantUnreadable(held: MemberGrant | null | undefined): boolean {
  return !!held && (!Number.isFinite(held.grant.grantedAtMs) || !Number.isFinite(held.grant.expiresAtMs) || held.sessionId === "");
}

export type GrantWrite<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | "read_failed"
        | "write_failed"
        /** The granter is not a live member of this crew. */
        | "not_a_member"
        /** The granter is in this crew with a DIFFERENT session than the one granting. */
        | "session_not_in_crew"
        /** MAX_GRANTS_PER_MEMBER rows already exist for this member in this crew. */
        | "too_many_grants";
    };

/**
 * The derived bound on a grant's life, and the ONLY place a duration is decided
 * (owner question OQ-2: no invented ceiling).
 *
 * A grant may last until `min(crewExpiresAt, granterHardReturn)` and no longer.
 * A caller asking for less gets what they asked for; asking for more is CLAMPED,
 * because the traveller said yes and the shorter grant honours both their
 * consent and the bound. REFUSED when the bound is already past or unreadable:
 * "there is no time left to share for" is a real answer.
 */
export function boundedGrantWindow(input: {
  nowMs: number;
  requestedExpiresAtMs: number | null;
  crewExpiresAtIso: string;
  granterHardReturnMs: number | null;
}): { ok: true; grantedAtMs: number; expiresAtMs: number } | { ok: false } {
  const crewMs = instantMs(input.crewExpiresAtIso);
  // An unreadable crew expiry is unknown, not unbounded.
  if (crewMs === null) return { ok: false };
  // An uncertified granter has no hard return; §14.1 reads uncertified as infeasible.
  if (input.granterHardReturnMs === null || !Number.isFinite(input.granterHardReturnMs)) return { ok: false };

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
  /** The session they are in this crew WITH. Refused otherwise. */
  sessionId: string;
  grantedAtMs: number;
  expiresAtMs: number;
}

/**
 * Record one act of consent.
 *
 * MEMBERSHIP IS CHECKED HERE AND IT IS A READ, SO A FAILED READ REFUSES THE
 * GRANT (census L203: "require membership"). 3787 cannot assert that the
 * granter is in the crew, and `locationPrecisionFor` cannot tell that a grant
 * names a crew its granter was never in. So "is the granter a live member, from
 * THIS session" is a question only this write can answer, before writing.
 *
 * NOT AN UPSERT, and no row is ever modified: each grant is a new row — except
 * that a member whose newest grant here is unrevoked and unexpired is answered
 * with THAT row (`alreadyGranted: true`) and nothing is written: a double tap is
 * one act of consent, not two.
 */
export async function grantCrewLocation(
  db: SupabaseClient,
  input: GrantCrewLocationInput,
): Promise<GrantWrite<CrewLocationGrantRow & { alreadyGranted: boolean }>> {
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
  if ((mem as Record<string, any>).session_id !== input.sessionId) {
    return { ok: false, reason: "session_not_in_crew" };
  }

  const { data: mine, error: mineErr } = await db
    .from("layover_crew_location_grants")
    .select(GRANT_COLUMNS)
    .eq("crew_id", input.crewId)
    .eq("granted_by_user_id", input.grantedByUserId)
    .order("granted_at", { ascending: false })
    .limit(MAX_GRANTS_PER_MEMBER);
  if (mineErr) {
    logger.warn({ err: mineErr.message, crewId: input.crewId }, "crew location grant history unreadable on grant — refusing");
    return { ok: false, reason: "read_failed" };
  }
  const history = ((mine ?? []) as Array<Record<string, any>>).map(toGrantRow);
  const newest = history[0];
  const newestExpires = newest ? instantMs(newest.expiresAt) : null;
  if (newest && newest.revokedAt === null && newestExpires !== null && newestExpires > input.grantedAtMs) {
    return { ok: true, value: { ...newest, alreadyGranted: true } };
  }
  if (history.length >= MAX_GRANTS_PER_MEMBER) return { ok: false, reason: "too_many_grants" };

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
    logger.warn({ err: error?.message, crewId: input.crewId }, "crew location grant insert failed");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: { ...toGrantRow(data as Record<string, any>), alreadyGranted: false } };
}

/**
 * Take it back — EVERY unrevoked grant this person holds (for one crew, or for
 * every crew when `crewId` is omitted). The plural is load-bearing: grants
 * accumulate, so revoking only the newest would leave an older one live for a
 * reader that ordered differently. Expired rows are revoked too; the ladder
 * works out which terminator came first from the instants.
 *
 * `0` is a count, not a failure. An ABSENT store (3787 not applied) has nothing
 * in it to revoke and answers `{ revoked: 0, storeAbsent: true }`. Any other
 * failed write has NOT happened, and the caller must say the share may still be
 * live.
 */
export async function revokeCrewLocation(
  db: SupabaseClient,
  input: { userId: string; crewId?: string },
  nowIso: string,
): Promise<GrantWrite<{ revoked: number; storeAbsent: boolean }>> {
  let q: any = db
    .from("layover_crew_location_grants")
    .update({ revoked_at: nowIso })
    .eq("granted_by_user_id", input.userId)
    .is("revoked_at", null);
  if (input.crewId) q = q.eq("crew_id", input.crewId);
  const { data, error } = await q.select("id");
  if (error) {
    if (grantStoreAbsent(error)) return { ok: true, value: { revoked: 0, storeAbsent: true } };
    logger.error(
      { err: error.message, crewId: input.crewId ?? null },
      "crew location revocation failed — the grant may still be live and the caller must say so",
    );
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: { revoked: ((data ?? []) as unknown[]).length, storeAbsent: false } };
}

/**
 * A crew that disbands takes every member's grant with it. The share is
 * already inert — a disbanded crew is no crew, and `crew_dissolved` is a §14.1
 * terminator — but leaving the rows unrevoked would make a later reader's
 * answer depend on the crew filter two modules away. Same absent-store rule.
 */
export async function revokeCrewLocationGrantsForCrew(
  db: SupabaseClient,
  crewId: string,
  nowIso: string,
): Promise<GrantWrite<{ revoked: number; storeAbsent: boolean }>> {
  const { data, error } = await db
    .from("layover_crew_location_grants")
    .update({ revoked_at: nowIso })
    .eq("crew_id", crewId)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    if (grantStoreAbsent(error)) return { ok: true, value: { revoked: 0, storeAbsent: true } };
    logger.error({ err: error.message, crewId }, "crew location revocation on disband failed");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: { revoked: ((data ?? []) as unknown[]).length, storeAbsent: false } };
}
