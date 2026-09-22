/**
 * routeHopSignal — the SECOND §10 Crowd Flow signal family: `accepted_plan`.
 *
 * lib/crowdFlowProducer's audit found exactly ONE fed family and recorded, per
 * family, why the rest could not be fed. `accepted_plan` was the only candidate
 * whose SOURCE SHAPE was ever right: `route_legs` is the one table in this
 * repository with a real from→to pair AND a real writer. It failed on four
 * separate blockers, and this module exists because all four are now closed —
 * three of them elsewhere, and it says where, because "we fixed it" is not a
 * claim a reader can check:
 *
 *   1. NOTHING WAS EVER ACCEPTED — routes/routePlan.ts wrote status 'draft' and
 *      nothing else, so a leg was OPTIMIZER OUTPUT, never a traveller's
 *      declaration. Closed by POST /api/route-plans/:id/accept, which is the
 *      ONLY writer of 'active', and by migration 2224's CHECK constraint
 *      `route_plans_accepted_requires_evidence`, which makes an accepted state
 *      with no recorded accepter UNREPRESENTABLE. This module reads
 *      status='active' AND accepted_at IS NOT NULL AND accepted_by_user_id IS
 *      NOT NULL — a database-enforced fact, not an application convention.
 *   2. NO LAWFUL BASIS — closed by the `route_plan_itinerary` purpose in
 *      lib/locationPurposes.ts.
 *   3. NO CONSENT COVERING PUBLICATION — closed by
 *      `route_flow_contribution_consent` (migration 2224), default OFF, modelled
 *      on `intel_contribution_consent` (2172, D4). Enforced below: no consent,
 *      no hop; a consent-read FAILURE yields an EMPTY consented set.
 *   4. COORDINATES, NOT ZONES — closed here, structurally. See the next section.
 *
 * ── THE COORDINATE QUARANTINE ────────────────────────────────────────────────
 * `route_stops.structured_location` holds {label, lat, lng}. §10 hops are
 * zone-to-zone, and a coordinate must never reach the flow. That is enforced by
 * TYPES, not by care:
 *
 *   * `resolveStopZones` is the ONLY function in this module whose input can
 *     contain a coordinate. It returns `StopZone` — {stopId, zoneId, updatedAt}
 *     — and there is no lat/lng field on it, so the point is gone one function
 *     call after it was read.
 *   * `deriveAcceptedPlanHops` takes `StopZone[]`. Its input type CANNOT carry a
 *     coordinate, so no later stage can "fall back to the point" even by
 *     accident: there is no point to fall back to.
 *   * A stop whose coordinate resolves to no zone is DROPPED (`unresolved_zone`)
 *     and every leg touching it is dropped with it. Zone resolution is INJECTED
 *     (`resolveZoneForPoint`); with no resolver, nothing resolves and the family
 *     produces nothing. Fail-closed in the direction that matters.
 *
 * ── WHY THIS COUNTS AS AN INDEPENDENT FAMILY (AND WHERE IT DOESN'T) ──────────
 * The bar the prior audit set, verbatim: a second claim type on
 * `intel_observations` "would not count: same table, same consent record, same
 * capture service, same actor population — MIN_SIGNAL_FAMILIES would then be
 * measuring prompt variety rather than source independence."
 *
 * `ACCEPTED_PLAN_INDEPENDENCE` below states the case in the six terms that
 * matter — source table, derivation path, actor population, correlation risk,
 * failure mode, and the separateness argument — AS DATA, pinned by a test, so it
 * is reviewable rather than asserted. Read it there; the summary is:
 *
 *   CLEARS THE BAR ON SOURCE INDEPENDENCE. Different table (route_plans /
 *   route_stops / route_legs vs intel_observations), different writer
 *   (routes/routePlan.ts vs IntelCaptureService), different consent record
 *   (route_flow_contribution_consent vs intel_contribution_consent), different
 *   feature gate, and — the one that actually matters — DIFFERENT FAILURE MODES.
 *   A bug, an outage, a flag flip or a spam campaign in the intel capture path
 *   cannot manufacture an accepted route plan, and vice versa. That is precisely
 *   what MIN_SIGNAL_FAMILIES defends: one sensor's artefact must not be able to
 *   masquerade as a crowd.
 *
 *   DOES NOT CLEAR IT ON SEMANTIC INDEPENDENCE, and this is stated rather than
 *   glossed. Both families are DECLARED INTENT under P0 self-report, not
 *   measured movement. A population-level bias that makes people name a
 *   destination they never reach biases BOTH. And the actor populations overlap:
 *   one person can both accept a plan and file a next-move contribution for the
 *   same edge. That overlap cannot INFLATE a cohort — `distinctActors` is a Set
 *   keyed on actor id across families, so the same person is one body however
 *   many families they appear in — but it does mean two families can, in the
 *   limit, trace to one population. The producer's confidence ladder already
 *   answers this: two families cap the band at `provisional`, and only three or
 *   more reach `likely_current`.
 *
 * ── WHAT ONE ACCEPTED PLAN CONTRIBUTES ───────────────────────────────────────
 * ONE actor (the accepter), one group token, and one hop per leg whose BOTH
 * endpoints resolve to zones. Members who merely joined the plan
 * (`route_plan_members`) contribute NOTHING: they joined, they did not declare
 * acceptance, and counting them would add bodies for an act nobody performed.
 *
 * The group token follows lib/intelGroupKey's ruling verbatim rather than
 * inventing a second convention: a trip-linked plan yields a CREW token keyed on
 * the trip, so five friends on one trip who each accept their own plan collapse
 * to ONE party (the leak the gate must catch); a plan with no trip yields a SOLO
 * token, per the ruling that "a solo visitor counts as its own independent
 * group". The token is an HMAC over a server secret scoped to the EDGE, so it
 * stores no membership and the same crew on two edges is unlinkable. WITHOUT
 * THAT SECRET THIS MODULE REFUSES TO READ (`no_group_key_secret`): a family that
 * adds bodies but no group credit would push the privacy gate's independent-group
 * floor further out of reach while looking like progress.
 *
 * ── THE STALENESS RULE THAT IS EASY TO MISS ──────────────────────────────────
 * `route_legs` is written ONCE, at plan creation, and PATCH .../stops/:stopId can
 * reorder or re-status a stop afterwards WITHOUT recomputing legs. So a stop
 * modified after acceptance is no longer the thing that was accepted. Any leg
 * touching such a stop is dropped (`stop_modified_after_acceptance`). Publishing
 * it would attribute to the traveller a declaration they did not make.
 *
 * ── PURITY ───────────────────────────────────────────────────────────────────
 * `resolveStopZones` and `deriveAcceptedPlanHops` are pure: rows in, signals out,
 * `now` injected, zone resolution and group-key derivation injected. The single
 * I/O function is `readAcceptedPlanHops`, with the service client passed in.
 */
import { deriveGroupKey, type GroupIdentity } from "./intelGroupKey.js";
import { logger } from "./logger.js";
import type { MovementSignal } from "./crowdFlowProducer.js";

/** The §10 family this module feeds. */
export const ACCEPTED_PLAN_FAMILY = "accepted_plan" as const;

/** The consent scope created by migration 2224. */
export const ROUTE_FLOW_CONSENT_TABLE = "route_flow_contribution_consent";

/**
 * The ONLY route_plans.status value that means a traveller accepted the plan and
 * the plan is still the current one. 'completed' also implies acceptance, but a
 * completed plan is a past journey, not a live intent, and §10 flow is about now.
 */
export const ACCEPTED_PLAN_STATUS = "active";

// ── The independence case, as reviewable data ────────────────────────────────

/**
 * Why `accepted_plan` counts as a SECOND signal family, in the six terms a
 * reviewer needs, plus the part of the claim that does NOT hold.
 *
 * This is data rather than prose because MIN_SIGNAL_FAMILIES is only worth
 * anything if adding a family costs someone an argument they have to write down.
 * `src/test/routeHopSignal.test.ts` pins every field, so a future family cannot
 * be appended with a shrug — and `residualCorrelation` cannot be quietly emptied.
 */
export interface FamilyIndependenceCase {
  family: string;
  /** The tables the signal is read from. */
  sourceTable: readonly string[];
  /** Row → hop, in steps, naming the code that performs each. */
  derivationPath: readonly string[];
  /** Who generates the source rows, and how that population is bounded. */
  actorPopulation: string;
  /** How this family could correlate with the other wired family, honestly. */
  correlationRisk: string;
  /** What makes this family go silent — and why that is not what silences the other. */
  failureMode: string;
  /** The argument that it is a separate SOURCE, against the audit's own bar. */
  separatenessArgument: string;
  /** The part of the independence claim that does NOT hold. Never empty. */
  residualCorrelation: string;
  /** Where each claim above can be checked. Files, not adjectives. */
  evidence: readonly string[];
}

export const ACCEPTED_PLAN_INDEPENDENCE: FamilyIndependenceCase = {
  family: ACCEPTED_PLAN_FAMILY,
  sourceTable: ["route_plans", "route_stops", "route_legs"],
  derivationPath: [
    "A traveller creates a route plan with >=2 stops (POST /api/route-plans, routes/routePlan.ts). The optimizer (services/routeOptimizer) chooses an ordering and route_legs is written once, from that ordering.",
    "The traveller ACCEPTS that plan (POST /api/route-plans/:id/accept). status draft -> active, accepted_at and accepted_by_user_id stamped server-side. This is the act; nothing before it is a declaration.",
    "readAcceptedPlanHops reads only status='active' plans accepted inside the freshness window, whose accepter has a live route_flow_contribution_consent row.",
    "resolveStopZones maps each stop's {label,lat,lng} to a ZONE id and returns a record with no coordinate field. The point does not survive this step.",
    "deriveAcceptedPlanHops turns each leg whose BOTH endpoints resolved into one MovementSignal(fromZoneId,toZoneId) observed at accepted_at — one actor, one group token, no sequence.",
  ],
  actorPopulation:
    "Travellers who plan a multi-stop route in the Trip surface AND explicitly accept it AND have opted in to route-flow contribution. One actor per accepted plan: the accepter. Members who merely joined the plan (route_plan_members) contribute nothing, because joining is not accepting.",
  correlationRisk:
    "The populations OVERLAP but are not the same: a person can both accept a plan and file an experience.next_move contribution for the same edge. Overlap cannot inflate a cohort — deriveZoneTransitions counts distinctActors in a Set keyed on actor id across families, so one person is one body however many families they appear in. What overlap CAN do is let two families trace to one population, so 'two families agreed' is weaker evidence than it sounds. Both families are also self-reported INTENT rather than measured movement, so a bias that makes people name a destination they do not reach biases both.",
  failureMode:
    "This family goes silent when nobody plans and accepts multi-stop routes, when the route optimizer is broken, or when accepted plans sit inside a single zone (a nightlife route within one neighbourhood yields zero hops — every leg is a self-transition). next_stop_contribution goes silent when nobody is prompted in the field, when intel_trail_followup is off, or when IntelCaptureService fails. Neither outage, bug, flag flip or spam campaign can produce the other family's rows.",
  separatenessArgument:
    "Measured against the prior audit's own bar — 'same table, same consent record, same capture service, same actor population' — this family shares NONE of the four. Different tables (route_plans/route_stops/route_legs vs intel_observations), a different writer (routes/routePlan.ts vs IntelCaptureService), a different consent record (route_flow_contribution_consent vs intel_contribution_consent) and a different, only partially overlapping actor population. The property MIN_SIGNAL_FAMILIES exists to protect — that one sensor's artefact cannot masquerade as a crowd — holds: nothing that corrupts one family can fabricate the other.",
  residualCorrelation:
    "Semantic, not structural. Both families are P0 unverified self-report of INTENT, and their actor populations overlap. Two families therefore do not certify two independent populations, only two independent SOURCES. The producer's confidence ladder is the mitigation already in place: two families cap the observed band at 'provisional'; 'likely_current' needs three. This limitation should be re-read before anyone treats a two-family flow as strong evidence.",
  evidence: [
    "src/routes/routePlan.ts — the accept endpoint is the only writer of status='active'",
    "src/migrations/2224_route_hop_signal.sql — route_plans_accepted_requires_evidence makes 'active' without an accepter unrepresentable; creates route_flow_contribution_consent (default off, service-role write only)",
    "src/lib/locationPurposes.ts — purpose 'route_plan_itinerary' declares the lawful basis, retention, visibility and deletion behaviour",
    "src/lib/intelGroupKey.ts — the crew/solo group-token ruling this module reuses verbatim",
    "src/lib/crowdFlowProducer.ts — deriveZoneTransitions counts distinctActors in a Set across families, so family overlap adds no bodies",
  ],
};

// ── Inputs ───────────────────────────────────────────────────────────────────

/** An accepted plan, with no geometry of any kind. */
export interface AcceptedPlanRow {
  planId: string;
  /** The accepter. Consumed for counting; never copied into an output. */
  actorId: string;
  /** Trip the plan belongs to, or null. Decides crew vs solo group identity. */
  tripId: string | null;
  /** The acceptance instant — the observation time of every hop this plan makes. */
  acceptedAt: string | number | Date;
}

/**
 * A stop AFTER zone resolution. Note what is absent: there is no lat, no lng, no
 * label and no address. This type is the coordinate quarantine boundary.
 */
export interface StopZone {
  stopId: string;
  zoneId: string;
  /** route_stops.updated_at — a stop touched after acceptance was not accepted. */
  updatedAt: string | number | Date | null;
}

/** One optimizer-written leg, by stop id. Carries no geometry. */
export interface RouteLegRow {
  planId: string;
  fromStopId: string;
  toStopId: string;
}

export type HopSkipReason =
  | "invalid_input"
  | "unknown_plan"
  | "missing_stop"
  | "unresolved_zone"
  | "stale_acceptance"
  | "future_acceptance"
  | "stop_modified_after_acceptance"
  | "no_group_key";

export interface HopSkip {
  planId: string;
  reason: HopSkipReason;
}

/** Derives the party token for one edge. Injected so the derivation stays pure. */
export type HopGroupKeyFn = (
  edge: { fromZoneId: string; toZoneId: string },
  identity: GroupIdentity,
) => string | null;

/**
 * The default token: lib/intelGroupKey's HMAC, scoped to the EDGE rather than to
 * a place. The subject is a JSON array, not a delimiter-joined string, because a
 * zone id may contain any character and there is no safe in-band delimiter — the
 * same reasoning deriveZoneTransitions records for its bucket keys.
 */
export const defaultHopGroupKey: HopGroupKeyFn = (edge, identity) =>
  deriveGroupKey(JSON.stringify([edge.fromZoneId, edge.toZoneId]), identity);

export interface DeriveAcceptedPlanHopsInput {
  plans: readonly AcceptedPlanRow[];
  stopZones: readonly StopZone[];
  legs: readonly RouteLegRow[];
  /**
   * Stops that WERE read but whose coordinate resolved to no zone
   * (`resolveStopZones().unresolvedStopIds`). Carried through so a leg dropped
   * for lack of a zone is distinguishable from a leg pointing at a stop row that
   * is not there at all — two different defects that would otherwise share a
   * reason and hide each other.
   */
  unresolvedStopIds?: readonly string[];
}

export interface DeriveAcceptedPlanHopsOptions {
  now?: string | number | Date;
  /** Oldest an acceptance may be and still contribute. Required; no default clock. */
  maxAgeMinutes: number;
  /** Test seam. Defaults to `defaultHopGroupKey`. */
  groupKeyFor?: HopGroupKeyFn;
}

export interface DeriveAcceptedPlanHopsResult {
  signals: MovementSignal[];
  /** Why each discarded leg contributed nothing. Never a silent drop. */
  skipped: HopSkip[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function toEpochMs(t: string | number | Date | null | undefined): number | null {
  if (t === null || t === undefined) return null;
  const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ── Stage 1: the coordinate quarantine (PURE) ────────────────────────────────

/** A raw stop, straight off the table. The only shape here that holds a point. */
export interface RawStopRow {
  stopId: string;
  /** route_stops.structured_location — {label, lat, lng}. Read, resolved, dropped. */
  structuredLocation: unknown;
  updatedAt: string | number | Date | null;
}

/** Resolves a point to a ZONE id, or null. Injected: zone identity is the caller's model. */
export type ResolveZoneForPoint = (point: { lat: number; lng: number }) => string | null;

export interface ResolveStopZonesResult {
  stopZones: StopZone[];
  /** Stop ids whose coordinate resolved to no zone. They are dropped, not approximated. */
  unresolvedStopIds: string[];
}

/**
 * Map each stop's structured_location onto a zone id and RETURN NOTHING ELSE.
 *
 * This is the only function in the module that can see a coordinate, and it
 * cannot leak one: `StopZone` has no field that could hold a lat or a lng. A stop
 * that does not resolve is reported as unresolved and dropped — there is
 * deliberately no "fall back to the point" branch, because the fallback IS the
 * privacy failure §10 forbids.
 */
export function resolveStopZones(
  stops: readonly RawStopRow[],
  resolveZoneForPoint: ResolveZoneForPoint | undefined,
): ResolveStopZonesResult {
  const stopZones: StopZone[] = [];
  const unresolvedStopIds: string[] = [];
  if (!Array.isArray(stops)) return { stopZones, unresolvedStopIds };

  for (const s of stops) {
    if (!s || typeof s.stopId !== "string" || s.stopId === "") continue;
    const loc = s.structuredLocation as { lat?: unknown; lng?: unknown } | null | undefined;
    const lat = loc && typeof loc === "object" ? loc.lat : undefined;
    const lng = loc && typeof loc === "object" ? loc.lng : undefined;
    if (
      !resolveZoneForPoint ||
      !finite(lat) || !finite(lng) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180
    ) {
      unresolvedStopIds.push(s.stopId);
      continue;
    }
    let zoneId: string | null = null;
    try {
      zoneId = resolveZoneForPoint({ lat, lng });
    } catch (err) {
      logger.warn({ err }, "routeHopSignal: zone resolver threw; stop dropped");
      zoneId = null;
    }
    if (typeof zoneId !== "string" || zoneId === "") {
      unresolvedStopIds.push(s.stopId);
      continue;
    }
    stopZones.push({ stopId: s.stopId, zoneId, updatedAt: s.updatedAt ?? null });
  }
  return { stopZones, unresolvedStopIds };
}

// ── Stage 2: legs → hops (PURE) ──────────────────────────────────────────────

/**
 * Turn accepted plans + resolved stops + legs into MovementSignals.
 *
 * PURE: `now`, the freshness window and the group-key function are all injected.
 * Every discard is reported; nothing is dropped silently. There is no path here
 * that assembles more than one edge for one actor into anything — a plan's legs
 * are emitted as INDEPENDENT hops and the producer buckets each edge separately,
 * so a five-stop itinerary cannot be read back out of the aggregate.
 */
export function deriveAcceptedPlanHops(
  input: DeriveAcceptedPlanHopsInput,
  opts: DeriveAcceptedPlanHopsOptions,
): DeriveAcceptedPlanHopsResult {
  const signals: MovementSignal[] = [];
  const skipped: HopSkip[] = [];

  const nowMs = toEpochMs(opts?.now ?? Date.now());
  const maxAgeMs =
    (finite(opts?.maxAgeMinutes) && opts.maxAgeMinutes > 0 ? opts.maxAgeMinutes : 0) * 60_000;
  if (nowMs === null || maxAgeMs <= 0) return { signals, skipped };

  const groupKeyFor = opts.groupKeyFor ?? defaultHopGroupKey;

  // Plans first, so a stale or malformed plan is refused ONCE rather than once
  // per leg — a five-leg plan must not report five identical skips.
  const planById = new Map<string, AcceptedPlanRow & { acceptedMs: number }>();
  for (const p of input?.plans ?? []) {
    if (!p || typeof p.planId !== "string" || p.planId === "" ||
        typeof p.actorId !== "string" || p.actorId === "") {
      skipped.push({ planId: p?.planId ?? "", reason: "invalid_input" });
      continue;
    }
    const acceptedMs = toEpochMs(p.acceptedAt);
    if (acceptedMs === null) {
      skipped.push({ planId: p.planId, reason: "invalid_input" });
      continue;
    }
    // An untrusted clock must not buy a fresh label (deriveZoneTransitions'
    // future_signal rule, applied one stage earlier).
    if (acceptedMs > nowMs) {
      skipped.push({ planId: p.planId, reason: "future_acceptance" });
      continue;
    }
    if (nowMs - acceptedMs > maxAgeMs) {
      skipped.push({ planId: p.planId, reason: "stale_acceptance" });
      continue;
    }
    planById.set(p.planId, { ...p, acceptedMs });
  }

  const unresolved = new Set<string>(input?.unresolvedStopIds ?? []);
  const zoneByStop = new Map<string, StopZone>();
  for (const z of input?.stopZones ?? []) {
    if (z && typeof z.stopId === "string" && z.stopId !== "" && typeof z.zoneId === "string" && z.zoneId !== "") {
      zoneByStop.set(z.stopId, z);
    }
  }

  for (const leg of input?.legs ?? []) {
    if (!leg || typeof leg.planId !== "string" ||
        typeof leg.fromStopId !== "string" || typeof leg.toStopId !== "string") {
      skipped.push({ planId: leg?.planId ?? "", reason: "invalid_input" });
      continue;
    }
    const plan = planById.get(leg.planId);
    if (!plan) {
      // Either the plan was refused above (already reported) or the leg belongs
      // to a plan we never read. Reported either way; the producer never guesses.
      skipped.push({ planId: leg.planId, reason: "unknown_plan" });
      continue;
    }
    const from = zoneByStop.get(leg.fromStopId);
    const to = zoneByStop.get(leg.toStopId);
    if (!from || !to) {
      // A stop we read but could not place, versus a stop row that is not there
      // at all. Both drop the leg; they are different defects and are named so.
      const unplaced = unresolved.has(leg.fromStopId) || unresolved.has(leg.toStopId);
      skipped.push({ planId: leg.planId, reason: unplaced ? "unresolved_zone" : "missing_stop" });
      continue;
    }

    // route_legs is written once, at creation; PATCH .../stops/:stopId can move a
    // stop afterwards WITHOUT recomputing legs. A stop touched after acceptance
    // is not the stop that was accepted, so the leg is no longer a declaration.
    const fromTouched = toEpochMs(from.updatedAt);
    const toTouched = toEpochMs(to.updatedAt);
    if (
      (fromTouched !== null && fromTouched > plan.acceptedMs) ||
      (toTouched !== null && toTouched > plan.acceptedMs)
    ) {
      skipped.push({ planId: leg.planId, reason: "stop_modified_after_acceptance" });
      continue;
    }

    const identity: GroupIdentity =
      typeof plan.tripId === "string" && plan.tripId !== ""
        ? { kind: "crew", crewId: plan.tripId }
        : { kind: "solo", actorId: plan.actorId };

    let groupKey: string | null = null;
    try {
      groupKey = groupKeyFor({ fromZoneId: from.zoneId, toZoneId: to.zoneId }, identity);
    } catch (err) {
      logger.warn({ err }, "routeHopSignal: group key derivation failed");
      groupKey = null;
    }
    if (typeof groupKey !== "string" || groupKey === "") {
      // A body with no party token pushes the privacy gate's independent-group
      // floor FURTHER away while looking like progress. Refuse the hop instead.
      skipped.push({ planId: leg.planId, reason: "no_group_key" });
      continue;
    }

    signals.push({
      actorId: plan.actorId,
      groupKey,
      family: ACCEPTED_PLAN_FAMILY,
      fromZoneId: from.zoneId,
      toZoneId: to.zoneId,
      observedAt: new Date(plan.acceptedMs).toISOString(),
    });
  }

  return { signals, skipped };
}

// ── Stage 3: the ONE I/O function ────────────────────────────────────────────

export type AcceptedPlanReadRefusal =
  | "no_service_client"
  | "no_zone_resolver"
  | "no_group_key_secret"
  | "read_failed"
  /**
   * The consent table could not be read, so NOBODY is treated as consented.
   *
   * The suppression is the same one this module always applied — a failure may
   * shrink a cohort, never inflate one — but it used to be returned as
   * `{ signals: [], refusal: null }`, which is a silent empty and exactly what
   * `refusal`'s own doc comment says can never happen. "Nobody has consented"
   * and "we could not read the consent table" are different facts about D4
   * consent (route_flow_contribution_consent, 2224), and only the first may be
   * reported to a caller as a successfully-read, empty cohort.
   */
  | "consent_read_failed";

export interface ReadAcceptedPlanHopsResult {
  signals: MovementSignal[];
  /** Populated when nothing was read. Never a silent empty. */
  refusal: AcceptedPlanReadRefusal | null;
  skipped: HopSkip[];
}

export interface ReadAcceptedPlanHopsOptions {
  now?: string | number | Date;
  maxAgeMinutes: number;
  /** Required. Without it no coordinate can be coarsened, so nothing is read. */
  resolveZoneForPoint?: ResolveZoneForPoint;
  /** Test seam. */
  groupKeyFor?: HopGroupKeyFn;
}

/** Batch size for the id-scoped follow-up reads. */
const MAX_PLANS_PER_READ = 500;

/**
 * Read accepted route plans as MovementSignals.
 *
 * REFUSES BEFORE IT READS when it could not produce a usable hop anyway: no zone
 * resolver means no coordinate could be coarsened, and no group-key secret means
 * every hop would arrive with zero group credit. In both cases reading the plans
 * would process personal data for an outcome that cannot exist.
 *
 * Consent is enforced per actor, mirroring lib/crowdFlowProducer's D4 handling
 * exactly: enabled AND not withdrawn, with a consent-read FAILURE leaving the
 * consented set EMPTY. A failure can shrink a cohort; it can never inflate one
 * — and it is NAMED (`consent_read_failed`) rather than returned as a cohort
 * of zero, so a caller cannot mistake an unreadable consent table for an
 * unconsenting population.
 */
export async function readAcceptedPlanHops(
  sc: any,
  opts: ReadAcceptedPlanHopsOptions,
): Promise<ReadAcceptedPlanHopsResult> {
  const empty = (refusal: AcceptedPlanReadRefusal | null): ReadAcceptedPlanHopsResult => ({
    signals: [],
    refusal,
    skipped: [],
  });

  if (!sc) return empty("no_service_client");
  if (!opts?.resolveZoneForPoint) return empty("no_zone_resolver");

  const groupKeyFor = opts.groupKeyFor ?? defaultHopGroupKey;
  // Probe with the real function rather than re-reading the env here: one place
  // decides what a valid group-key secret is, and it is lib/intelGroupKey.
  try {
    if (!groupKeyFor({ fromZoneId: "probe", toZoneId: "probe" }, { kind: "solo", actorId: "probe" })) {
      return empty("no_group_key_secret");
    }
  } catch {
    return empty("no_group_key_secret");
  }

  const nowMs = toEpochMs(opts.now ?? Date.now()) ?? Date.now();
  const maxAgeMinutes = finite(opts.maxAgeMinutes) && opts.maxAgeMinutes > 0 ? opts.maxAgeMinutes : 0;
  if (maxAgeMinutes <= 0) return empty("read_failed");
  const sinceIso = new Date(nowMs - maxAgeMinutes * 60_000).toISOString();

  try {
    // status='active' AND accepted_at IS NOT NULL is belt-and-braces against the
    // CHECK constraint (2224); the query states the invariant it depends on
    // rather than trusting that the constraint is present in every environment.
    const { data: planRows, error: planErr } = await sc
      .from("route_plans")
      .select("id, trip_id, accepted_by_user_id, accepted_at, status")
      .eq("status", ACCEPTED_PLAN_STATUS)
      .not("accepted_at", "is", null)
      .gte("accepted_at", sinceIso)
      .limit(MAX_PLANS_PER_READ);
    if (planErr || !planRows) {
      logger.warn({ err: planErr }, "routeHopSignal: accepted plan read failed");
      return empty("read_failed");
    }

    const plans: AcceptedPlanRow[] = (planRows as any[])
      .filter((p) => p && p.accepted_by_user_id && p.accepted_at && p.status === ACCEPTED_PLAN_STATUS)
      .map((p) => ({
        planId: String(p.id),
        actorId: String(p.accepted_by_user_id),
        tripId: typeof p.trip_id === "string" && p.trip_id !== "" ? p.trip_id : null,
        acceptedAt: p.accepted_at,
      }));
    if (plans.length === 0) return { signals: [], refusal: null, skipped: [] };

    // Consent, per accepter. Fail-soft to EMPTY.
    const actorIds = [...new Set(plans.map((p) => p.actorId))];
    let consented = new Set<string>();
    const { data: consentRows, error: consentErr } = await sc
      .from(ROUTE_FLOW_CONSENT_TABLE)
      .select("user_id")
      .in("user_id", actorIds)
      .eq("enabled", true)
      .is("withdrawn_at", null);
    if (consentErr || !Array.isArray(consentRows)) {
      logger.warn({ err: consentErr }, "routeHopSignal: consent read failed; cohort empty");
      // Fail-closed AND fail-loud: no signals (unchanged), but the caller is
      // told the cohort is empty because the consent read failed, not because
      // nobody has consented.
      return empty("consent_read_failed");
    }
    consented = new Set((consentRows as any[]).map((r) => r.user_id as string));

    const consentedPlans = plans.filter((p) => consented.has(p.actorId));
    if (consentedPlans.length === 0) return { signals: [], refusal: null, skipped: [] };
    const planIds = consentedPlans.map((p) => p.planId);

    const [stopsRes, legsRes] = await Promise.all([
      sc.from("route_stops").select("id, route_plan_id, structured_location, updated_at").in("route_plan_id", planIds),
      sc.from("route_legs").select("route_plan_id, from_stop_id, to_stop_id").in("route_plan_id", planIds),
    ]);
    if (stopsRes?.error || legsRes?.error || !stopsRes?.data || !legsRes?.data) {
      logger.warn({ err: stopsRes?.error ?? legsRes?.error }, "routeHopSignal: stop/leg read failed");
      return empty("read_failed");
    }

    // The quarantine boundary. Everything past this line is coordinate-free.
    const { stopZones, unresolvedStopIds } = resolveStopZones(
      (stopsRes.data as any[]).map((s) => ({
        stopId: String(s.id),
        structuredLocation: s.structured_location,
        updatedAt: s.updated_at ?? null,
      })),
      opts.resolveZoneForPoint,
    );

    const legs: RouteLegRow[] = (legsRes.data as any[])
      .filter((l) => l && l.route_plan_id && l.from_stop_id && l.to_stop_id)
      .map((l) => ({
        planId: String(l.route_plan_id),
        fromStopId: String(l.from_stop_id),
        toStopId: String(l.to_stop_id),
      }));

    const derived = deriveAcceptedPlanHops(
      { plans: consentedPlans, stopZones, legs, unresolvedStopIds },
      { now: nowMs, maxAgeMinutes, groupKeyFor },
    );
    return { signals: derived.signals, refusal: null, skipped: derived.skipped };
  } catch (err) {
    logger.warn({ err }, "routeHopSignal: accepted plan read threw");
    return empty("read_failed");
  }
}
