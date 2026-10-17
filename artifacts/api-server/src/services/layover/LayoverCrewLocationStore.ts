/**
 * LayoverCrewLocationStore — persistence for §14's L4 rung (migration 3996):
 * `layover_crew_location_grants` and `layover_crew_location_controls`.
 *
 * It decides nothing. What may be shared is `LayoverCrewLocation.planCrewLocationShare`;
 * who may see it is `LayoverCrewLocation.projectCrewLocations`. This module
 * reads and writes rows, and every read is a discriminated result: a failed
 * read is never `[]`, because "nobody in your crew is sharing" and "we could not
 * read your crew's shares" must not produce the same screen (the rule
 * `LayoverCrewStore` states and census-layover has found four times).
 *
 * Table names are string LITERALS at every call site, for the reason
 * `LayoverCrewStore`'s header gives: `check:write-path-columns` can only diff a
 * `.from("<literal>")` against the live schema.
 *
 * STORAGE: 3996, applied to no database by the lane that wrote it. Until it is
 * applied every read and write here fails, and the route is behind
 * `layover_crew_location_enabled` (seeded FALSE), so nothing reaches it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { CREW_READ_LIMIT } from "./LayoverCrewStore.js";
import type { CrewGrantRow, PlannedCrewGrant, SharerSessionFacts } from "./LayoverCrewLocation.js";

const logger = rootLogger.child({ service: "LayoverCrewLocationStore" });

const GRANT_COLUMNS = "crew_id,user_id,session_id,purpose,precision,label,lat,lng,granted_at,expires_at";

type Failed = { ok: false; reason: "read_failed" | "write_failed" };
export type LocationRead<T> = { ok: true; value: T } | Failed;

function toGrant(r: Record<string, any>): CrewGrantRow {
  return {
    crewId: r.crew_id,
    userId: r.user_id,
    sessionId: r.session_id,
    purpose: r.purpose,
    precision: r.precision,
    label: r.label,
    lat: typeof r.lat === "number" ? r.lat : null,
    lng: typeof r.lng === "number" ? r.lng : null,
    grantedAt: r.granted_at,
    expiresAt: r.expires_at,
  };
}

/**
 * Every share in one crew. A crew has at most `CREW_READ_LIMIT` members and
 * one share each, so a page that comes back FULLER than that is a table edited
 * out of band — refused rather than answered from the rows that fitted.
 */
export async function readCrewGrants(db: SupabaseClient, crewId: string): Promise<LocationRead<CrewGrantRow[]>> {
  const { data, error } = await db
    .from("layover_crew_location_grants")
    .select(GRANT_COLUMNS)
    .eq("crew_id", crewId)
    .limit(CREW_READ_LIMIT + 1);
  if (error) {
    logger.warn({ err: error.message, crewId }, "crew location shares unreadable — refusing rather than reporting nobody sharing");
    return { ok: false, reason: "read_failed" };
  }
  const rows = (data ?? []) as Record<string, any>[];
  if (rows.length > CREW_READ_LIMIT) {
    logger.warn({ crewId, rows: rows.length }, "crew location share read exceeded the crew ceiling — refusing");
    return { ok: false, reason: "read_failed" };
  }
  return { ok: true, value: rows.map(toGrant) };
}

/** The sessions behind a crew's shares: the facts their ends are read from. */
export async function readSharerSessions(
  db: SupabaseClient,
  sessionIds: readonly string[],
): Promise<LocationRead<Map<string, SharerSessionFacts>>> {
  const out = new Map<string, SharerSessionFacts>();
  if (sessionIds.length === 0) return { ok: true, value: out };
  const { data, error } = await db
    .from("layover_sessions")
    .select("id,status,departure_time,boarding_time,updated_at")
    .in("id", [...sessionIds]);
  if (error) {
    logger.warn({ err: error.message, sessions: sessionIds.length }, "sharer sessions unreadable — refusing rather than treating every share as live");
    return { ok: false, reason: "read_failed" };
  }
  for (const r of (data ?? []) as Record<string, any>[]) {
    out.set(r.id, {
      id: r.id,
      status: r.status,
      departureTime: r.departure_time,
      boardingTime: r.boarding_time ?? null,
      updatedAt: r.updated_at ?? null,
    });
  }
  return { ok: true, value: out };
}

/**
 * Put the member's ONE current share in place of whatever was there (3996's
 * primary key is (crew_id, user_id): no history row is possible).
 */
export async function upsertCrewGrant(
  db: SupabaseClient,
  key: { crewId: string; userId: string; sessionId: string },
  grant: PlannedCrewGrant,
): Promise<LocationRead<CrewGrantRow>> {
  const { data, error } = await db
    .from("layover_crew_location_grants")
    .upsert(
      {
        crew_id: key.crewId,
        user_id: key.userId,
        session_id: key.sessionId,
        purpose: grant.purpose,
        precision: grant.precision,
        label: grant.label,
        lat: grant.lat,
        lng: grant.lng,
        granted_at: grant.grantedAt,
        expires_at: grant.expiresAt,
      },
      { onConflict: "crew_id,user_id" },
    )
    .select(GRANT_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    logger.warn({ err: error?.message, crewId: key.crewId }, "crew location share not written");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: toGrant(data as Record<string, any>) };
}

/**
 * Delete shares by (crew, member). Used for the owner's stop, for the precise
 * control going off (exact only), and to purge shares whose scope has ended.
 * Returns how many rows went, as the database reported them.
 */
export async function deleteCrewGrants(
  db: SupabaseClient,
  crewId: string,
  userIds: readonly string[],
  opts: { precision?: "exact" } = {},
): Promise<LocationRead<number>> {
  if (userIds.length === 0) return { ok: true, value: 0 };
  let q = db.from("layover_crew_location_grants").delete().eq("crew_id", crewId).in("user_id", [...userIds]);
  if (opts.precision) q = q.eq("precision", opts.precision);
  const { data, error } = await q.select("user_id");
  if (error) {
    logger.warn({ err: error.message, crewId }, "crew location shares not deleted");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: ((data ?? []) as unknown[]).length };
}

/**
 * The owner's stop, across every crew this session shared to. Not scoped to the
 * current crew on purpose: a share left behind in a crew the traveller has
 * since left is still theirs to end.
 */
export async function deleteOwnGrants(db: SupabaseClient, userId: string, sessionId: string): Promise<LocationRead<number>> {
  const { data, error } = await db
    .from("layover_crew_location_grants")
    .delete()
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .select("crew_id");
  if (error) {
    logger.warn({ err: error.message }, "own crew location shares not deleted");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: ((data ?? []) as unknown[]).length };
}

/** L166: the separate control. No row = never turned on = OFF. */
export async function readPreciseControl(db: SupabaseClient, crewId: string, userId: string): Promise<LocationRead<boolean>> {
  const { data, error } = await db
    .from("layover_crew_location_controls")
    .select("precise_sharing_enabled")
    .eq("crew_id", crewId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    logger.warn({ err: error.message, crewId }, "precise-sharing control unreadable — exact sharing is not offered");
    return { ok: false, reason: "read_failed" };
  }
  return { ok: true, value: (data as { precise_sharing_enabled?: unknown } | null)?.precise_sharing_enabled === true };
}

export async function writePreciseControl(
  db: SupabaseClient,
  crewId: string,
  userId: string,
  enabled: boolean,
  nowIso: string,
): Promise<LocationRead<boolean>> {
  const { data, error } = await db
    .from("layover_crew_location_controls")
    .upsert({ crew_id: crewId, user_id: userId, precise_sharing_enabled: enabled, updated_at: nowIso }, { onConflict: "crew_id,user_id" })
    .select("precise_sharing_enabled")
    .maybeSingle();
  if (error || !data) {
    logger.warn({ err: error?.message, crewId }, "precise-sharing control not written");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: (data as { precise_sharing_enabled?: unknown }).precise_sharing_enabled === true };
}
