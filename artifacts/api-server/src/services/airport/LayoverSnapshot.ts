/**
 * LayoverSnapshot — the Layover domain's PUBLISHED contract, for lanes that are
 * not Layover.
 *
 * Spec §2.1 / census-layover L6: *"All surfaces consume the same certified
 * `LayoverSnapshot` / `RecommendationContract`; no duplicate time-budget
 * logic."*
 * Spec §25 / census-layover L269: *"Discovery — only show experiences from the
 * certified action universe in Layover mode."*
 *
 * ── WHAT THIS FILE IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT ──────────────
 * IT CONTAINS NO ARITHMETIC. Not one buffer, not one threshold, not one
 * subtraction of a deadline from a clock. Every number below is read off a
 * `LayoverFeasibilityRecord` that `certifyFeasibility` produced, or off a
 * helper that already derives from one:
 *
 *   the deadline, window, verdict, confidence   `certifySessionFeasibility`
 *   the certification header                    `certificationHeader`
 *   the snapshot identity                       `snapshotIdFor`
 *   minutes to the hard return                  `safeReturnPosture`
 *   the exploration-collapse rule               `safeReturnPosture`
 *   the outer envelope                          `safeEnvelope`
 *   a candidate's band                          `bandCandidates`
 *   a candidate's pin state                     `candidateFeasibilityFrom`
 *   "does this fit the certified window?"       `candidateFits`
 *   "did anybody measure this?"                 `candidateIsUnmeasured`
 *   the §11.1 step-5 action universe            `actionUniverseOf`
 *
 * That list IS the point of the row. L6's defect was never that the tree had no
 * canonical derivation — it has had one since `LayoverFeasibility.ts`, and six
 * services already consume it. The defect is that the canonical derivation was
 * only reachable by a caller who ALREADY HELD an `AirportProfile` and a
 * `LayoverSession`, and the only code that assembled those was a PRIVATE helper
 * inside `routes/airport.ts` (`resolveAirportForSession`) — which now delegates
 * to this file's exported `resolveSessionAirport`, so the rule has ONE
 * implementation and the route is one of its callers. A lane like Discovery
 * holds neither. Its choices were to duplicate the loader and the time budget —
 * the second copy L6 forbids — or to gate on nothing, which is what
 * `GET /hidden-gems/layover-safe` does today when it takes `availableMinutes`
 * from a query string.
 *
 * So what is NEW here is a DOOR, not a rule. Two functions:
 *
 *   `certifiedLayoverSnapshot(db, userId, opts)`  →  the one snapshot
 *   `certifiedActionUniverse(snapshot, candidates)` → what may be shown
 *
 * ── FAIL CLOSED, IN THIS SURFACE'S OWN VOCABULARY ──────────────────────────
 * supabase-js RESOLVES on a database error, so an unguarded read turns a failed
 * query into a confident statement about the world. The two reads this file
 * performs refuse instead, using the `*_unreadable` reason vocabulary the rest
 * of `services/airport/` already uses (`AirportProfileService`'s
 * `airport_profiles_unreadable`, `LayoverSessionService`'s "refusing rather than
 * reporting 'not found'", `LayoverNotificationService`'s `push_token_unreadable`):
 *
 *   `layover_sessions_unreadable`   never "you are not in a layover"
 *   `airport_profiles_unreadable`   never a deadline computed from the GENERIC
 *                                   buffer defaults with nothing on screen
 *                                   saying so
 *
 * and a consumer that cannot get a snapshot MUST NOT fall back to an ungated
 * list. There is no such thing as a partial certification here: a refusal is
 * the answer, and `GET /airport/sessions/:id/*` already answers 503
 * `degraded_unavailable` for exactly these two.
 *
 * ── WHAT THE ACTION UNIVERSE MAY SAY ───────────────────────────────────────
 * `ADMITTED` is the only state that means "the certified window has room for
 * this", and it is reachable only from candidate terms the CALLER stated. The
 * envelope's lower bound is deliberately NOT fed into `candidateFits`: a
 * straight-line bound can REFUSE a journey and can never certify one
 * (`domain/trips/contracts/TravelTimeProvider.ts`, and census L47's three-valued
 * rule), so using it to admit a card would be the fabrication this census keeps
 * catching. On this tree, where no routed provider exists, a Discovery place
 * with no stated durations comes back `UNMEASURED` — not admitted, not refused,
 * and legibly so.
 *
 * ── THE FLAG ───────────────────────────────────────────────────────────────
 * Nothing in this file changes what a traveller sees: it has no route and no
 * caller. The lane that wires it does change what a traveller sees, so the flag
 * name it must gate on is published here rather than invented there —
 * `LAYOVER_DISCOVERY_MODE_FLAG`. It is FALSE-seeded by ABSENCE: `isFlagEnabled`
 * returns false for a missing row and false for an unreadable `feature_flags`
 * (`lib/featureFlags.ts:14-26`), so a flag nobody has inserted is off, which is
 * the same seeding `layover_safety_engine_enabled` and `layover_plans_enabled`
 * rely on.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger as rootLogger } from "../../lib/logger.js";
import {
  airportRowToProfile,
  buildFallbackProfile,
  type AirportProfile,
} from "./AirportProfileService.js";
import {
  getActiveSession,
  getSession,
  type LayoverSession,
} from "./LayoverSessionService.js";
import {
  certificationHeader,
  certifySessionFeasibility,
  type EstimateConfidence,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";
import {
  bandCandidates,
  safeEnvelope,
  type EnvelopeBand,
  type SafeEnvelope,
} from "./LayoverEnvelope.js";
import {
  AIRSIDE_UNBANDED_REASON,
  NO_POSITION_UNBANDED_REASON,
  candidateFeasibilityFrom,
  unbandedCandidateFeasibility,
  type CandidateFeasibility,
} from "./layoverRankingFeasibility.js";
import {
  actionUniverseOf,
  candidateFits,
  candidateIsUnmeasured,
  type ActionUniverse,
  type ReplanCandidate,
} from "./LayoverEventReplanner.js";
import { snapshotIdFor } from "./layoverLedger.js";
import { safeReturnPosture, type SafeReturnPosture } from "./LayoverSafeReturnService.js";
import { airportPoint, placePoint } from "./LayoverTravelTime.js";
import type { LayoverReasonCode } from "./LayoverSafetyEngine.js";
import {
  straightLineTravelTimeProvider,
  type GeoPoint,
  type TravelTimeProvider,
} from "../../domain/trips/contracts/TravelTimeProvider.js";

const logger = rootLogger.child({ service: "LayoverSnapshot" });

/**
 * Version of the CONTRACT's shape — what a consumer decoded, not what the
 * engine computed. The engine's own versions travel in `certification`.
 */
export const LAYOVER_SNAPSHOT_CONTRACT_VERSION = "2026.09.15-1";

/**
 * The flag a consuming lane must gate its Layover mode on. FALSE by absence;
 * see the header. Published here so two lanes cannot spell it differently.
 */
export const LAYOVER_DISCOVERY_MODE_FLAG = "layover_discovery_mode_enabled";

// ─────────────────────────────────────────────────────────────────────────────
// The snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why there is no snapshot. The first two are REFUSALS — the server was not in
 * a position to answer — and a consumer must degrade rather than serve an
 * ungated list. The last two are ANSWERS: the statement ran and matched nothing.
 */
export type LayoverSnapshotRefusal =
  | "layover_sessions_unreadable"
  | "airport_profiles_unreadable"
  | "session_not_found"
  | "no_live_layover_session";

/** TRUE for the two reasons that mean "we could not look". */
export function isDegradedRefusal(reason: LayoverSnapshotRefusal): boolean {
  return reason === "layover_sessions_unreadable" || reason === "airport_profiles_unreadable";
}

export interface LayoverSnapshot {
  contractVersion: string;
  /** `snapshotIdFor(sessionId, inputHash)` — the ledger's identity, not a second one. */
  snapshotId: string;
  sessionId: string;
  /** engine/feasibility versions, input hash, computed-at, verdict, confidence. */
  certification: ReturnType<typeof certificationHeader>;

  // ── the certified answer, read off the record ──────────────────────────────
  verdict: LayoverFeasibilityRecord["verdict"];
  confidence: EstimateConfidence;
  returnState: LayoverFeasibilityRecord["envelope"]["returnState"];
  tier: LayoverFeasibilityRecord["envelope"]["tier"];
  usableMinutes: number;
  /** ISO. The one deadline every surface shows. */
  hardReturnBy: string;
  /** `safeReturnPosture`'s figure, not a fourth `(deadline - now) / 60000`. */
  minutesToHardReturn: number;
  reasonCodes: LayoverReasonCode[];
  unknowns: string[];
  /** §15 consequences, so a consumer need not re-derive the escalation rules. */
  posture: SafeReturnPosture;

  // ── §8 geometry ───────────────────────────────────────────────────────────
  /** `null` when the airport has no usable coordinate. NOT a default disc. */
  envelope: SafeEnvelope | null;
  envelopeUnavailableReason: "no_airport_coordinate" | null;

  // ── may this traveller be offered anything landside at all? ───────────────
  /**
   * The engine's own verdict plus Safe Return's own exploration rule, and
   * nothing else. `LayoverBuddyGate` requires `returnState === "NORMAL"` on top
   * of this for its higher-risk interaction; browsing a city's places is not
   * that interaction, so this is the weaker of the two and says so rather than
   * inventing a third threshold.
   */
  landsideOpen: boolean;
  landsideClosedReason: string | null;

  /**
   * The certified record this snapshot projects.
   *
   * A consumer does NOT need it — every figure it would want is above, and
   * `certifiedActionUniverse` reads this field so the caller never touches the
   * engine. It is carried rather than hidden because withholding it would push
   * a lane that wants one more field into calling `certifySessionFeasibility`
   * itself, which is the second certification this whole contract exists to
   * prevent.
   */
  certifiedRecord: LayoverFeasibilityRecord;
}

export type LayoverSnapshotResult =
  | { ok: true; snapshot: LayoverSnapshot }
  | { ok: false; reason: LayoverSnapshotRefusal; message: string };

/**
 * The fields the airport lookup reads, and nothing else.
 *
 * A full `LayoverSession` satisfies it. So does the PARTIAL `{ airportId }`
 * that `routes/airport.ts`'s admin buffer preview hands it — that call site
 * predates this type and used to be laundered through an `any` parameter, so
 * the shape is stated here rather than left to be discovered.
 */
export interface AirportLookupSession {
  id?: string | null;
  airportId?: string | null;
  manualIata?: string | null;
  manualCity?: string | null;
  manualCountry?: string | null;
  manualAirportName?: string | null;
}

/** Three answers. The third is not an airport. */
export type AirportLookupResult =
  | { ok: true; airport: AirportProfile }
  | { ok: false; message: string };

/**
 * Resolve the session's airport, refusing on an unreadable table.
 *
 * THE ONE IMPLEMENTATION OF THIS RULE. `routes/airport.ts`'s
 * `resolveAirportForSession` was a second copy of it, byte-comparable branch
 * for branch and differing only in one log string; it now delegates here. Two
 * copies of a lookup that decides a hard-return deadline drift, and the drift
 * is invisible until a traveller is served the wrong "head back at" time.
 *
 * Three answers rather than two: the profile row, the manual-field fallback
 * when there is genuinely no row, and "the table could not be read". Only the
 * first two are an airport. The row-to-profile mapping is
 * `AirportProfileService`'s own — this file does not hand-build a profile, which
 * is how `terminal_info` went missing from a route for two migrations.
 */
export async function resolveSessionAirport(
  db: SupabaseClient,
  session: AirportLookupSession,
): Promise<AirportLookupResult> {
  if (session.airportId) {
    // `error` is BOUND. supabase-js RESOLVES on a database error, so the old
    // `const { data } = await` read an unreadable `airport_profiles` as "this
    // airport has no profile row" and fell through to `buildFallbackProfile` —
    // a silent downgrade to the GENERIC buffers (60/90, 120/180, +30, +15,
    // +20). Every hard-return time downstream would then be computed from those
    // instead of the airport's admin-configured ones: the wrong "head back at"
    // time, with nothing on screen saying so. Callers get `ok: false` and
    // refuse.
    //
    // The `data == null` case is a DIFFERENT answer: the row genuinely is not
    // there, and the fallback profile built from the session's manual_* fields
    // is the honest best available. It stays a 200.
    const { data, error } = await db
      .from("airport_profiles")
      .select("*")
      .eq("id", session.airportId)
      .maybeSingle();
    if (error) {
      // One message for both doors. The two copies said "refusing rather than
      // certifying a snapshot" and "refusing rather than computing a return
      // deadline"; the refusal is the same refusal, and a log line that names
      // only one of the two callers was never true of the other.
      logger.warn(
        { err: error, airportId: session.airportId, sessionId: session.id },
        "airport profile unreadable — refusing rather than answering from the generic buffer defaults",
      );
      return { ok: false, message: String(error.message ?? "airport_profiles unreadable") };
    }
    if (data) return { ok: true, airport: airportRowToProfile(data) };
  }
  return {
    ok: true,
    airport: buildFallbackProfile({
      iataCode: session.manualIata ?? "UNK",
      city: session.manualCity ?? "Unknown",
      country: session.manualCountry ?? "Unknown",
      name: session.manualAirportName ?? "Unknown Airport",
    }),
  };
}

/**
 * THE DOOR. One certified snapshot of one session at one instant.
 *
 * `opts.sessionId` names a session; omitting it asks for the caller's live one
 * (`active` or `returning` — a traveller on their way back is still in a
 * layover, and is the traveller who needs the deadline most).
 *
 * A consumer wires it like this, and needs nothing else from this domain:
 *
 *   const snap = await certifiedLayoverSnapshot(sc, user.id);
 *   if (!snap.ok && isDegradedRefusal(snap.reason)) return sendError(res, "degraded_unavailable");
 *   if (!snap.ok) return <serve the ordinary, non-layover surface>;
 *   const universe = await certifiedActionUniverse(snap.snapshot, myCandidates);
 */
export async function certifiedLayoverSnapshot(
  db: SupabaseClient,
  userId: string,
  opts: { sessionId?: string | null; nowMs?: number } = {},
): Promise<LayoverSnapshotResult> {
  const nowMs = opts.nowMs ?? Date.now();

  const read = opts.sessionId
    ? await getSession(db, opts.sessionId, userId)
    : await getActiveSession(db, userId);
  if (!read.ok) {
    return {
      ok: false,
      reason: "layover_sessions_unreadable",
      message: read.message,
    };
  }
  if (!read.session) {
    return opts.sessionId
      ? { ok: false, reason: "session_not_found", message: "no such layover session for this traveller" }
      : { ok: false, reason: "no_live_layover_session", message: "this traveller has no live layover" };
  }
  const session = read.session;

  const resolved = await resolveSessionAirport(db, session);
  if (!resolved.ok) {
    return { ok: false, reason: "airport_profiles_unreadable", message: resolved.message };
  }
  const airport = resolved.airport;

  // THE ONE CERTIFICATION. Everything below reads it.
  const record = certifySessionFeasibility(airport, session, { nowMs });
  const posture = safeReturnPosture(record);
  const centre = airportPoint(airport);
  const envelope = safeEnvelope(record.envelope.usableMinutes, centre, record.confidence);

  // Read off the engine's verdict and Safe Return's own exploration rule.
  const forbidden = record.verdict === "no" || record.verdict === "stay_airside";
  const landsideOpen = !forbidden && !posture.explorationCollapsed;
  const landsideClosedReason = forbidden
    ? `the certified verdict for this layover is "${record.verdict}"`
    : posture.explorationCollapsed
      ? `this traveller is at ${posture.returnState} — exploration is collapsed in favour of the return`
      : null;

  return {
    ok: true,
    snapshot: {
      contractVersion: LAYOVER_SNAPSHOT_CONTRACT_VERSION,
      snapshotId: snapshotIdFor(session.id, record.inputHash),
      sessionId: session.id,
      certification: certificationHeader(record),
      verdict: record.verdict,
      confidence: record.confidence,
      returnState: record.envelope.returnState,
      tier: record.envelope.tier,
      usableMinutes: record.envelope.usableMinutes,
      hardReturnBy: record.deadline.hardReturnTime.toISOString(),
      minutesToHardReturn: posture.minutesToHardReturn,
      reasonCodes: record.reasonCodes,
      unknowns: record.unknowns,
      posture,
      envelope,
      envelopeUnavailableReason: envelope ? null : "no_airport_coordinate",
      landsideOpen,
      landsideClosedReason,
      certifiedRecord: record,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The certified action universe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A candidate as a consuming lane holds it: an identity, a position, and
 * whatever it knows about the time the action costs.
 *
 * THE TIME TERMS ARE NULLABLE AND DEFAULT TO NULL, and that is what makes the
 * contract fail closed for a caller who does not fill them in. `null` is "nobody
 * measured", not "zero" — census L47, and the exact defect
 * `layover_plan_stops.travel_min INTEGER NOT NULL DEFAULT 0` produced.
 */
export interface ActionUniverseCandidate {
  id: string;
  lat?: number | null;
  lng?: number | null;
  /** Inside the terminal: no landside leg exists to measure. Default false. */
  insideAirport?: boolean;
  /** One-way landside minutes, if the caller measured them. */
  travelTimeMin?: number | null;
  /** Minutes the action itself takes, if the caller measured them. */
  activityTimeMin?: number | null;
}

/**
 * What the certified universe says about one candidate.
 *
 *   ADMITTED    the certified window has room for the terms the caller stated
 *   BLOCKED     the envelope PROVED this cannot fit at any speed — a refusal
 *   UNMEASURED  nobody stated the terms; not admitted and not refused
 *   CLOSED      this session may not go landside at all
 */
export type ActionAdmission = "ADMITTED" | "BLOCKED" | "UNMEASURED" | "CLOSED";

export interface CertifiedAction {
  id: string;
  /** TRUE only for `ADMITTED`. The one field a caller needs to filter on. */
  admitted: boolean;
  state: ActionAdmission;
  /** §13's band, straight off the envelope verdict. Never widened here. */
  band: EnvelopeBand;
  /** The §13 pin state, so a map need not be handed a second vocabulary. */
  feasibility: CandidateFeasibility;
  /** Why this state, in the words a surface may show. `null` when admitted. */
  reason: string | null;
}

export interface CertifiedActionUniverse {
  contractVersion: string;
  snapshotId: string;
  sessionId: string;
  certification: ReturnType<typeof certificationHeader>;
  landsideOpen: boolean;
  /** §11.1 step 5's own object, computed by `actionUniverseOf`. */
  universe: ActionUniverse;
  actions: CertifiedAction[];
  /** Sorted. The ONLY ids §25 L269 permits a Layover-mode surface to show. */
  admittedIds: string[];
  /** Sorted. Ids a surface must NOT show: a proof, or a closed universe. */
  refusedIds: string[];
  /** Sorted. Neither admitted nor refused — nobody measured them. */
  unmeasuredIds: string[];
}

/** The consumer's candidate, in the replanner's own vocabulary. */
function replanCandidate(c: ActionUniverseCandidate): ReplanCandidate {
  const insideAirport = c.insideAirport === true;
  return {
    id: c.id,
    // Inside the terminal a 0 is a FACT; outside it, an absent leg is `null`.
    travelTimeMin: insideAirport ? (c.travelTimeMin ?? 0) : (c.travelTimeMin ?? null),
    activityTimeMin: c.activityTimeMin ?? null,
    insideAirport,
  };
}

function pointOf(c: ActionUniverseCandidate): GeoPoint | null {
  if (c.insideAirport === true) return null;
  return placePoint({ lat: c.lat ?? null, lng: c.lng ?? null });
}

/**
 * Reduce a consuming lane's candidates to the certified action universe.
 *
 * NO ARITHMETIC OF ITS OWN. The band comes from `bandCandidates`, the fit from
 * `candidateFits`, the "did anybody measure this" from `candidateIsUnmeasured`,
 * and the whole §11.1 object from `actionUniverseOf` — this function only
 * decides which of those four answers a surface is allowed to act on.
 *
 * THE BOUND IS NEVER PROMOTED TO A MEASUREMENT. `bandCandidate` can tell us a
 * candidate is at least N minutes away; that refuses a journey and can never
 * certify one, so it is not fed into `candidateFits`. A caller that states no
 * durations gets `UNMEASURED` for every landside candidate, which on this tree
 * — where `LAYOVER_TRAVEL_TIME_PROVIDER` is `noRoutedProvider` — is the honest
 * answer and the same one every other layover surface gives.
 */
export async function certifiedActionUniverse(
  snapshot: LayoverSnapshot,
  candidates: ActionUniverseCandidate[],
  provider: TravelTimeProvider = straightLineTravelTimeProvider,
): Promise<CertifiedActionUniverse> {
  const record = snapshot.certifiedRecord;
  const departAt = new Date(record.inputs.nowMs);

  const landside = candidates.filter((c) => c.insideAirport !== true);
  const bands = await bandCandidates(
    snapshot.envelope,
    landside.map((c) => ({ key: c.id, point: pointOf(c) })),
    departAt,
    provider,
  );

  const actions: CertifiedAction[] = candidates.map((c) => {
    const insideAirport = c.insideAirport === true;
    const rc = replanCandidate(c);
    const verdict = insideAirport ? undefined : bands.get(c.id);
    const feasibility = insideAirport
      ? unbandedCandidateFeasibility(AIRSIDE_UNBANDED_REASON)
      : candidateFeasibilityFrom(verdict, NO_POSITION_UNBANDED_REASON);

    // 1. A PROOF outranks everything: the envelope measured this and it cannot
    //    fit at any speed. Published even when landside is closed, because a
    //    block explains itself and "closed" does not.
    if (feasibility.band === "BLOCKED") {
      return { id: c.id, admitted: false, state: "BLOCKED", band: feasibility.band, feasibility, reason: feasibility.reason };
    }
    // 2. The session may not go landside at all. NOT a block — nothing measured
    //    this place — so the band stays whatever the envelope said.
    if (!snapshot.landsideOpen && !insideAirport) {
      return {
        id: c.id,
        admitted: false,
        state: "CLOSED",
        band: feasibility.band,
        feasibility,
        reason: snapshot.landsideClosedReason,
      };
    }
    // 3. A term nobody stated. Named, never folded into "does not fit".
    if (candidateIsUnmeasured(rc)) {
      return {
        id: c.id,
        admitted: false,
        state: "UNMEASURED",
        band: feasibility.band,
        feasibility,
        reason: "nobody has measured how long this takes, so it cannot be certified against your window",
      };
    }
    // 4. The certified window's own arithmetic, unchanged.
    if (!candidateFits(record, rc)) {
      return {
        id: c.id,
        admitted: false,
        state: "BLOCKED",
        band: feasibility.band,
        feasibility,
        reason: feasibility.reason
          ?? `needs more time than the ${record.envelope.usableMinutes} usable minutes this layover has`,
      };
    }
    return { id: c.id, admitted: true, state: "ADMITTED", band: feasibility.band, feasibility, reason: null };
  });

  const idsIn = (state: ActionAdmission | ActionAdmission[]): string[] => {
    const wanted = Array.isArray(state) ? state : [state];
    return actions.filter((a) => wanted.includes(a.state)).map((a) => a.id).sort();
  };

  return {
    contractVersion: LAYOVER_SNAPSHOT_CONTRACT_VERSION,
    snapshotId: snapshot.snapshotId,
    sessionId: snapshot.sessionId,
    certification: snapshot.certification,
    landsideOpen: snapshot.landsideOpen,
    universe: actionUniverseOf(record, candidates.map(replanCandidate)),
    actions,
    admittedIds: idsIn("ADMITTED"),
    refusedIds: idsIn(["BLOCKED", "CLOSED"]),
    unmeasuredIds: idsIn("UNMEASURED"),
  };
}
