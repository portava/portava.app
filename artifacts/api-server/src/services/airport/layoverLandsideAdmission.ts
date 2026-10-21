/**
 * layoverLandsideAdmission — the ONE test every recommendation surface applies
 * before it serves a landside card: does the session's CERTIFIED record admit
 * landside at all? (census-layover L48, L77, L243, L249; LAYOVER 165 lane
 * B2-CURATE.)
 *
 * The certified record decides it (`gateLandside`): the §6.1 entry invariant
 * (fail closed on an unconfirmed corridor, in every flag state since the
 * owner's 2026-10-18 decision), the §22 maturity threshold (L1 from curated,
 * validated, unexpired facts), the clock and the declared constraints. A
 * surface that serves cards from somewhere other than a fresh generation — the
 * STORED list (`getRecommendations`), the Compass assistant's tool read, a plan
 * add of a card a client held — must ask the same record, or it is an
 * alternative route around the restriction. The owner's rule: "A
 * recommendation must never bypass a safety restriction through an
 * alternative API route."
 *
 * Airport-side cards always pass: the restriction is on LEAVING the airport,
 * and "airport-side guidance only" is the L0 product (§22 L243).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import { certifySessionFeasibility, type LayoverFeasibilityRecord } from "./LayoverFeasibility.js";
import { landsideStatusOf, type LandsideClosure } from "./LayoverConstraints.js";
import { consumerLayoverRecord } from "./LayoverSnapshot.js";
import { layoverAirportCountry, resolveLayoverEntry } from "./layoverEntryGate.js";

/** What a surface needs to know about the record: its verdict and its gate. */
export type LandsideRecordView = Pick<LayoverFeasibilityRecord, "verdict" | "landsideGate">;

/**
 * May landside CONTENT be served under this record? The admission test
 * `generateRecommendations` applies to both of its landside gates, and the one
 * `certifiedActionUniverse` applies to a snapshot (`landsideNotForbidden`):
 * open or caution, never closed, never a `no`. A missing record admits nothing.
 */
export function landsideAdmitted(record: LandsideRecordView | null | undefined): boolean {
  if (!record) return false;
  return record.verdict !== "no" && landsideStatusOf(record as LayoverFeasibilityRecord) !== "closed";
}

/** The closures behind a refusal, for the response. Empty when admitted or when there is no record. */
export function landsideClosuresOf(record: LandsideRecordView | null | undefined): LandsideClosure[] {
  return record?.landsideGate?.closedBy ? [...record.landsideGate.closedBy] : [];
}

/**
 * The cards a surface may serve: all of them when the record admits landside,
 * otherwise airport-side cards and already public, explicitly BLOCKED cards.
 * A blocked explanation is not an admitted action; moderation/reentry filters still apply.
 */
export function restrictToCertifiedLandside<T extends { insideAirport?: unknown; status?: unknown; available?: unknown; riskBand?: unknown }>(
  recs: readonly T[],
  record: LandsideRecordView | null | undefined,
): T[] {
  return landsideAdmitted(record) ? [...recs] : recs.filter((r) => r.insideAirport === true || (r.status === "BLOCKED" && r.available === false && r.riskBand === "UNSAFE"));
}

/**
 * The session's certified record at `nowMs`, exactly as every layover read
 * takes it: the stored snapshot's record when one is consumable, otherwise this
 * request's one certification with the resolved entry corridor.
 */
export async function certifiedLandsideRecord(
  db: SupabaseClient,
  airport: AirportProfile,
  session: LayoverSession,
  nowMs: number,
): Promise<LayoverFeasibilityRecord> {
  return (await consumerLayoverRecord(db, airport, session, nowMs))
    ?? certifySessionFeasibility(airport, session, {
      nowMs,
      entry: await resolveLayoverEntry(db, session.userId, layoverAirportCountry(airport)), liveConditions: await resolveLayoverLiveConditions(db, airport, session, nowMs),
    });
}

/** The words a refused plan-add carries. Discloses no corridor or curation detail. */
export const LANDSIDE_NOT_ADMITTED_MESSAGE =
  "Leaving the airport isn't something we can suggest for this layover right now, so this idea can't be added to your plan.";

import { resolveLayoverLiveConditions } from './layoverLiveSignals.js';
