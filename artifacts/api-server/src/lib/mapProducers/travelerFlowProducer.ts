/**
 * travelerFlowProducer — the `traveler_flow` kind (Map spec §36 Phase 7).
 *
 * "City→city aggregate movement derived ONLY from consented, already-published
 * aggregates (accepted plans / itinerary stops at city granularity), never
 * per-person trajectories; k-floor enforced; expose as aggregate edges with
 * counts bucketed, never exact."
 *
 * ── IT REUSES §10's PIPELINE. THAT IS THE WHOLE PRIVACY ARGUMENT. ────────────
 * Nothing here re-implements consent, coordinate quarantine, group identity or
 * cohort counting. It changes exactly ONE injected parameter of the existing,
 * audited accepted-plan path:
 *
 *   §10 Crowd Flow  readAcceptedPlanHops(sc, { resolveZoneForPoint: <ZONE>  })
 *   §36 Phase 7     readAcceptedPlanHops(sc, { resolveZoneForPoint: <CITY> })
 *
 * `ResolveZoneForPoint` is `(point) => string | null` and lib/routeHopSignal
 * treats whatever it returns as an opaque area id. Handing it a CITY resolver
 * is therefore a coarsening, not a new capability — every one of that module's
 * guarantees survives unchanged and un-weakened:
 *
 *   consent      per accepter, `route_flow_contribution_consent` (2224),
 *                enabled AND not withdrawn, with a consent-read FAILURE leaving
 *                the consented set EMPTY. A failure shrinks a cohort; it can
 *                never inflate one.
 *   acceptance   status='active' AND accepted_at IS NOT NULL, which migration
 *                2224's CHECK makes unrepresentable for a plan nobody accepted.
 *   quarantine   `resolveStopZones` is the only function that sees a
 *                coordinate, and `StopZone` has no field that could hold one. A
 *                stop that resolves to no city is DROPPED, never approximated.
 *   group key    the plan's trip collapses a crew to one party, per
 *                lib/intelGroupKey's ruling.
 *   no path type there is no per-actor sequence anywhere: a plan's legs are
 *                emitted as INDEPENDENT hops, and each edge is independently
 *                gated at k, so a traveller's A→B→C itinerary cannot be read
 *                back out — B→C dies alone unless ≥ k other people made it.
 *
 * The counting is likewise `crowdFlowProducer.deriveZoneTransitions`, verbatim:
 * actor ids enter a Set and never leave it, group credit comes only from a real
 * key, and `maxGroupShare`'s denominator is the union of grouped actors.
 *
 * ── WHAT IS DIFFERENT FROM §10, AND WHY EACH DIFFERENCE IS NOT A WEAKENING ───
 *
 *   TIME SCALE.  §10 asks "who is moving right now" and requires
 *   `mayRenderAsLive`. A city→city travel graph is a slow aggregate: nobody
 *   flies Da Nang→Bangkok inside a 5-minute freshness window. So this producer
 *   uses a WINDOW (TRAVELER_FLOW_WINDOW_DAYS) instead of a live-freshness gate,
 *   and stamps the honest freshness the timestamp actually earns — usually
 *   `historical`. It never labels a 30-day aggregate live, which is the §37
 *   requirement the live gate exists to serve.
 *
 *   ONE SIGNAL FAMILY.  §10 requires MIN_SIGNAL_FAMILIES (2) because a live
 *   flow arrow driving a "go there now" decision should not rest on one source.
 *   Only `accepted_plan` resolves to city granularity at all (the other six
 *   families are audited in lib/crowdFlowProducer's header: absent tables,
 *   destination-only rows with no declared origin, or party-scoped sources), so
 *   requiring two here would make the layer permanently empty and dishonestly
 *   so. Instead the evidence is DECLARED: a single-family edge is capped at the
 *   WEAKEST confidence band (`SINGLE_FAMILY_CONFIDENCE_CAP`) and its payload
 *   carries `singleFamily: true`, so nothing downstream can mistake it for
 *   corroborated movement. Note what did NOT move: the k floor, the independent
 *   -group minimum, the dominant-group ceiling and the publication delay are
 *   `PRIVACY_THRESHOLD_V1`, untouched. Signal-family count is a CONFIDENCE gate,
 *   not a k-anonymity threshold, and only the confidence gate was traded.
 *
 *   BUCKETED COHORT.  §10 publishes `cohortSize` and a "N travelers moving"
 *   subtitle. This does NOT. `count` is absent from the object and the payload
 *   carries `cohortBucket` — §7's activity ladder, banded on multiples of k —
 *   so a reader learns "a lot of people" and never a number that changes by one
 *   when one person's plan changes.
 *
 *   THE REPORT IS GATED TOO.  §10's crowd-flow report reasons that a bare
 *   `withheld` COUNT is "enough to prove something was withheld, not enough to
 *   describe it". THAT REASONING DOES NOT SURVIVE A CALLER-CHOSEN, TWO-CITY
 *   DENOMINATOR. `bbox` picks the cities; the cities are the whole universe the
 *   counts are taken over; at two cities there is exactly one possible pair, so
 *   the count IS the shape — "1 pair withheld" says a sub-k number of people
 *   moved between the two cities the caller just named, and a second, wider
 *   request differences the rest out. So this producer gates its REPORT with
 *   the same floor it gates its OBJECTS with: nothing the privacy gates refused
 *   is counted anywhere a caller can read. See `TravelerFlowReport`.
 *
 * ── PURITY ───────────────────────────────────────────────────────────────────
 * `deriveTravelerFlowEdges` is pure; `readTravelerFlowEdges` is the single I/O
 * function, and it REFUSES before reading when it could not produce a usable
 * edge anyway (flag off, no city resolver) rather than processing personal data
 * for an outcome that cannot exist.
 */
import {
  MIN_SIGNAL_FAMILIES,
  normalizeLng,
  type ZoneTransition,
} from "../mapAggregation.js";
import { deriveZoneTransitions } from "../crowdFlowProducer.js";
import { readAcceptedPlanHops, type ResolveZoneForPoint } from "../routeHopSignal.js";
import { evaluatePrivacy, type PrivacyThreshold } from "../privacyGate.js";
import { PRIVACY_THRESHOLD_V1 } from "../intelContracts.js";
import { isFlagEnabled } from "../featureFlags.js";
import { logger } from "../logger.js";
import {
  CONFIDENCE_STATES,
  KIND_DEFAULT_PRIORITY,
  deriveFreshness,
  type ActivityLevel,
  type ConfidenceState,
  type MapObject,
  type PrivacyClass,
} from "../mapObjects.js";
import {
  WORLD_INTELLIGENCE_FLAG,
  bucketCohort,
  resolveWorldIntelligenceK,
  type WorldIntelligenceRefusal,
} from "./worldIntelligence.js";

/** An edge describes a crowd, never a person. Aggregate-only, always. */
export const TRAVELER_FLOW_PRIVACY_CLASS: PrivacyClass = "aggregate_only";

/**
 * How far back an acceptance may sit and still contribute. Thirty days is the
 * shortest window in which intercity travel produces a cohort at all — an
 * itinerary is accepted weeks before the trip — and it is bounded rather than
 * open-ended so a city pair cannot accumulate an edge forever off one busy
 * fortnight three years ago.
 */
export const TRAVELER_FLOW_WINDOW_DAYS = 30;

export const TRAVELER_FLOW_WINDOW_MINUTES = TRAVELER_FLOW_WINDOW_DAYS * 24 * 60;

/**
 * The confidence ceiling for an edge evidenced by fewer than
 * MIN_SIGNAL_FAMILIES families — which today means every edge, because only
 * `accepted_plan` reaches city granularity. The WEAKEST band there is.
 * `deriveZoneTransitions` already scores a one-family transition `unverified`;
 * this cap is applied again here so the ceiling survives a future change to
 * that scoring, and so the rule is stated where the trade was made.
 */
export const SINGLE_FAMILY_CONFIDENCE_CAP: ConfidenceState = CONFIDENCE_STATES[0];

export type TravelerFlowRejectionReason =
  | "invalid_input"
  | "not_a_transition"
  | "invalid_geometry"
  | "undateable"
  | "below_cohort_floor"
  | "privacy_gate"
  | "privacy_class_none";

export interface TravelerFlowRejection {
  fromCityId: string;
  toCityId: string;
  reason: TravelerFlowRejectionReason;
  /**
   * MAY THE FACT THAT THIS PAIR EXISTED BE COUNTED ON THE WIRE AT ALL?
   *
   * True only when the pair cleared EVERY privacy gate on its own — see
   * `mayDiscloseExistence`. False for anything the gates refused, which is why
   * a sub-k pair contributes to no number a caller can read. SERVER-SIDE ONLY
   * either way: this array never leaves the process.
   */
  disclosable: boolean;
}

export interface TravelerFlowPayload {
  /** §37: measured, never projected. Always the literal below. */
  basis: "observed_accepted_plans";
  fromCityId: string;
  toCityId: string;
  /** Public place names, when the city model supplied them. Never a person. */
  fromCityLabel: string | null;
  toCityLabel: string | null;
  /** §7's activity ladder, banded on multiples of k. NEVER a headcount. */
  cohortBucket: ActivityLevel;
  /** The §10 families that evidenced this movement. */
  signalFamilies: string[];
  /** True when fewer than MIN_SIGNAL_FAMILIES corroborated it. Always today. */
  singleFamily: boolean;
  windowDays: number;
  observedAt: string;
}

export interface DeriveTravelerFlowOptions {
  now?: string | number | Date;
  /** City id → its public display name. Optional; a missing label is null. */
  cityLabels?: ReadonlyMap<string, string>;
  threshold?: PrivacyThreshold;
  /** Cohort floor override. May only TIGHTEN. */
  k?: number;
}

export interface DeriveTravelerFlowResult {
  edges: MapObject<TravelerFlowPayload>[];
  /** Why each rejected transition produced nothing. Never a silent drop. */
  rejected: TravelerFlowRejection[];
  /**
   * How many of `rejected` may be COUNTED on the wire — the ones that cleared
   * every privacy gate and were then lost to a defect in the data (unusable
   * geometry, undateable observation). Every other rejection is counted
   * nowhere, deliberately: see the header's note on two-city viewports.
   */
  publishableButUnusable: number;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function toEpochMs(t: string | number | Date | null | undefined): number | null {
  if (t === null || t === undefined) return null;
  const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Turn city→city transitions into `traveler_flow` objects.
 *
 * PURE. Every gate blocks on its own and every rejection is reported:
 *
 *   1. PRIVACY GATE   lib/privacyGate.evaluatePrivacy against
 *                     PRIVACY_THRESHOLD_V1 — k distinct actors, independent
 *                     groups, no dominant group, publication delay,
 *                     sensitive-subject refusal.
 *   2. BUCKET         `bucketCohort` refuses below k a second time, so an edge
 *                     can never be published with a bucket it did not earn.
 *   3. DATEABLE       an edge whose observation cannot be dated is not an
 *                     observation. It is NOT required to be live: see header.
 *   4. GEOMETRY       both endpoints must be finite city centroids.
 *
 * Each rejection also records whether it may be COUNTED on the wire — gates 1
 * and 2 are what decide that, and nothing below them can rescue a pair. See
 * the header's "THE COUNT IS THE SHAPE" note.
 */
export function deriveTravelerFlowEdges(
  transitions: readonly ZoneTransition[],
  opts: DeriveTravelerFlowOptions = {},
): DeriveTravelerFlowResult {
  const edges: MapObject<TravelerFlowPayload>[] = [];
  const rejected: TravelerFlowRejection[] = [];
  const result = (): DeriveTravelerFlowResult => ({
    edges,
    rejected,
    publishableButUnusable: rejected.reduce((n, r) => n + (r.disclosable ? 1 : 0), 0),
  });
  if (!Array.isArray(transitions) || transitions.length === 0) return result();

  const threshold = opts.threshold ?? PRIVACY_THRESHOLD_V1;
  const now = opts.now ?? Date.now();
  const k = resolveWorldIntelligenceK(opts.k);
  const labels = opts.cityLabels;

  // Deterministic order regardless of input order, so paging is stable.
  //
  // Compared FIELD BY FIELD rather than on a joined key: a city id may contain
  // any character, so there is no safe in-band delimiter (the same reasoning
  // deriveZoneTransitions records for its bucket keys), and a joined key would
  // make two different pairs sort as one.
  const ordered = [...transitions].sort((a, b) => {
    const af = a?.fromZoneId ?? "";
    const bf = b?.fromZoneId ?? "";
    if (af !== bf) return af < bf ? -1 : 1;
    const at = a?.toZoneId ?? "";
    const bt = b?.toZoneId ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return 0;
  });

  for (const t of ordered) {
    const id = { fromCityId: t?.fromZoneId ?? "", toCityId: t?.toZoneId ?? "" };
    if (!t || !id.fromCityId || !id.toCityId) {
      // A pair we cannot even name has cleared no gate. Never countable.
      rejected.push({ ...id, reason: "invalid_input", disclosable: false });
      continue;
    }
    if (id.fromCityId === id.toCityId) {
      rejected.push({ ...id, reason: "not_a_transition", disclosable: false });
      continue;
    }

    const decision = evaluatePrivacy(
      {
        distinctActors: t.distinctActors,
        distinctGroups: t.distinctGroups,
        maxGroupShare: t.maxGroupShare,
        observedAt: t.observedAt,
        now,
        sensitiveSubject: t.sensitiveSubject,
      },
      threshold,
    );
    if (!decision.publishable) {
      // THE PAIR ITSELF IS THE SECRET. A privacy refusal is never countable —
      // at a two-city viewport a caller who learns that one pair was refused
      // has learned that a sub-k cohort moved between the two cities it named.
      rejected.push({ ...id, reason: "privacy_gate", disclosable: false });
      continue;
    }

    const cohortBucket = bucketCohort(t.distinctActors, k);
    if (cohortBucket === null) {
      // Same rule, and the reason it is a SEPARATE arm: an override may tighten
      // `k` above the threshold's own floor, and the tightened floor governs
      // disclosure too.
      rejected.push({ ...id, reason: "below_cohort_floor", disclosable: false });
      continue;
    }

    // From here the pair has cleared EVERY gate that governs whether its
    // existence may be spoken about, so a rejection below is a statement about
    // the DATA, not about the people: it is countable on the wire.
    const observedMs = toEpochMs(t.observedAt);
    if (observedMs === null) {
      rejected.push({ ...id, reason: "undateable", disclosable: true });
      continue;
    }
    const freshness = deriveFreshness(t.observedAt, t.expiresAt ?? null, now);
    if (freshness === "unknown") {
      rejected.push({ ...id, reason: "undateable", disclosable: true });
      continue;
    }

    if (
      !t.from || !t.to ||
      !finite(t.from.lat) || !finite(t.from.lng) ||
      !finite(t.to.lat) || !finite(t.to.lng) ||
      Math.abs(t.from.lat) > 90 || Math.abs(t.to.lat) > 90 ||
      Math.abs(t.from.lng) > 180 || Math.abs(t.to.lng) > 180
    ) {
      rejected.push({ ...id, reason: "invalid_geometry", disclosable: true });
      continue;
    }

    const families = Array.isArray(t.signalFamilies) ? [...t.signalFamilies].sort() : [];
    const singleFamily = families.length < MIN_SIGNAL_FAMILIES;
    // Never RAISE the transition's own band; cap it when uncorroborated.
    const declared = t.confidence ?? SINGLE_FAMILY_CONFIDENCE_CAP;
    const confidence: ConfidenceState = singleFamily
      ? weaker(declared, SINGLE_FAMILY_CONFIDENCE_CAP)
      : declared;

    const fromLabel = labels?.get(id.fromCityId) ?? null;
    const toLabel = labels?.get(id.toCityId) ?? null;
    const observedIso = new Date(observedMs).toISOString();

    const obj: MapObject<TravelerFlowPayload> = {
      id: `travelerflow:${id.fromCityId}:${id.toCityId}`,
      kind: "traveler_flow",
      geometry: {
        type: "LineString",
        coordinates: [
          [normalizeLng(t.from.lng), t.from.lat],
          [normalizeLng(t.to.lng), t.to.lat],
        ],
      },
      title:
        fromLabel && toLabel
          ? `${fromLabel} → ${toLabel}`
          : "Travellers moving between cities",
      // The BUCKET, never the number. §10's crowd_flow says "N travelers
      // moving" here; a city-pair edge must not, because the pair itself is
      // already a narrow slice of the world.
      subtitle: `${humanize(cohortBucket)} movement over the last ${TRAVELER_FLOW_WINDOW_DAYS} days`,
      observedAt: observedIso,
      freshness,
      confidence,
      activity: cohortBucket,
      privacyClass: TRAVELER_FLOW_PRIVACY_CLASS,
      renderingPriority: KIND_DEFAULT_PRIORITY.traveler_flow,
      // NO `count`: publishing an exact cohort is precisely what the bucket
      // replaces. NEVER_AGGREGATED_KINDS stops anything downstream wanting one.
      interaction: { actions: ["ask_compass", "view"], opensSheet: true },
      // No sourceRefs, for summarizeCell's reason: a reference list on an
      // aggregate is a re-identification handle back onto its contributors.
      provenance: {
        lines: [
          {
            text: singleFamily
              ? "From accepted trip plans whose travellers opted in — one signal source, uncorroborated"
              : "From accepted trip plans whose travellers opted in",
          },
        ],
        confidence,
      },
      payload: {
        basis: "observed_accepted_plans",
        fromCityId: id.fromCityId,
        toCityId: id.toCityId,
        fromCityLabel: fromLabel,
        toCityLabel: toLabel,
        cohortBucket,
        signalFamilies: families,
        singleFamily,
        windowDays: TRAVELER_FLOW_WINDOW_DAYS,
        observedAt: observedIso,
      },
    };
    const expiresMs = t.expiresAt == null ? null : toEpochMs(t.expiresAt);
    if (expiresMs !== null) obj.expiresAt = new Date(expiresMs).toISOString();
    edges.push(obj);
  }

  return result();
}

function weaker(a: ConfidenceState, b: ConfidenceState): ConfidenceState {
  return CONFIDENCE_STATES.indexOf(a) <= CONFIDENCE_STATES.indexOf(b) ? a : b;
}

function humanize(a: ActivityLevel): string {
  return a
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ── The ONE I/O function ─────────────────────────────────────────────────────

export interface ReadTravelerFlowOptions {
  now: number;
  /**
   * Point → CITY id. REQUIRED: without it no coordinate can be coarsened, so
   * nothing is read. The caller owns the city model, exactly as
   * routes/mapProjection owns the §10 zone model.
   */
  resolveCityForPoint?: ResolveZoneForPoint;
  /** City id → centroid. An endpoint with no centroid yields no edge. */
  cityCentroids?: ReadonlyMap<string, { lat: number; lng: number }>;
  /** City id → public display name. Optional. */
  cityLabels?: ReadonlyMap<string, string>;
  k?: number;
}

/**
 * What the traveler-flow layer did, ON THE WIRE.
 *
 * ── THE COUNT IS THE SHAPE ───────────────────────────────────────────────────
 * `CrowdFlowReport`'s rule — "a bare count is enough to prove something was
 * withheld, not enough to describe it" — DOES NOT SURVIVE HERE, and this report
 * is the shape it takes instead.
 *
 * The reason is the denominator. A caller supplies `bbox`, `bbox` selects the
 * cities, and the cities are the entire universe the counts are taken over. At
 * a viewport holding exactly two cities there is only one possible pair, so a
 * count of one is not an anonymous total at all: it says "between Da Nang and
 * Bangkok, specifically, some number of people below the floor moved in the
 * last 30 days" — a sharper statement than any object the layer would ever
 * publish, and one a second request over a wider viewport can then difference
 * against. `hops`, `hopsSkipped` and `transitions` were exactly that, and are
 * gone: no band rescues them either, because they count LEGS, and fifteen legs
 * can be one person's fifteen trips.
 *
 * So the only quantities here are ones a caller could already see:
 *   `published` — the edges actually served, each independently k-gated;
 *   `publishableButUnusable` — pairs that cleared EVERY privacy gate and were
 *                              then lost to a defect in the data.
 *
 * WHAT KEEPS A REFUSAL VISIBLE. `refusal`. It is set from the wiring — flag
 * off, no city model, the hop read threw — and never from a cohort, so "we
 * could not look" stays distinguishable from "we looked and nothing cleared
 * the floor" without either one describing a person. That is the whole of the
 * doctrine this report exists to serve; the per-pair counts were never part of
 * it.
 */
export interface TravelerFlowReport {
  refusal: WorldIntelligenceRefusal | "hop_read_failed" | null;
  /** Edges that cleared every gate. Exactly the objects the caller receives. */
  published: number;
  /**
   * City pairs that cleared every privacy gate — k distinct actors,
   * independent groups, no dominant group, publication delay elapsed — and
   * were then dropped for an unusable centroid or an undateable observation.
   *
   * A WIRING ALARM, NOT A COHORT STATEMENT: every pair counted here was
   * already publishable, so the count discloses nothing its edge would not
   * have. Pairs the privacy gates refused are counted NOWHERE.
   */
  publishableButUnusable: number;
}

export interface ReadTravelerFlowResult {
  edges: MapObject<TravelerFlowPayload>[];
  report: TravelerFlowReport;
}

/**
 * Read consented accepted-plan hops at CITY granularity and publish the edges
 * that clear every gate.
 *
 * The flag is checked HERE as well as at the call site so a disabled capability
 * costs nothing and cannot be bypassed by a future second caller. Fail-closed
 * throughout: a refusal returns no edges and says why.
 */
export async function readTravelerFlowEdges(
  sc: any,
  opts: ReadTravelerFlowOptions,
): Promise<ReadTravelerFlowResult> {
  const empty = (refusal: TravelerFlowReport["refusal"]): ReadTravelerFlowResult => ({
    edges: [],
    report: { refusal, published: 0, publishableButUnusable: 0 },
  });

  if (!sc) return empty("no_service_client");
  // A LITERAL, not the constant: check:flag-polarity resolves flag arguments
  // statically and a constant defeats it. WORLD_INTELLIGENCE_FLAG_PIN below
  // makes the two impossible to drift apart silently.
  if (!(await isFlagEnabled(sc, "map_world_intelligence_enabled"))) return empty("flag_off");
  if (!opts?.resolveCityForPoint || !opts.cityCentroids || opts.cityCentroids.size === 0) {
    return empty("no_city_model");
  }

  let hops;
  try {
    hops = await readAcceptedPlanHops(sc, {
      now: opts.now,
      maxAgeMinutes: TRAVELER_FLOW_WINDOW_MINUTES,
      resolveZoneForPoint: opts.resolveCityForPoint,
    });
  } catch (err) {
    logger.warn({ err }, "travelerFlowProducer: accepted-plan hop read threw");
    return empty("hop_read_failed");
  }
  if (hops.refusal) return empty("hop_read_failed");

  const { transitions } = deriveZoneTransitions(hops.signals, {
    now: opts.now,
    zoneCentroids: opts.cityCentroids,
    // ONE bucket the width of the whole window: a city→city graph is not
    // time-sliced at §10's 30-minute density granularity, and a narrower bucket
    // would split one real cohort into many sub-k ones. Note the direction of
    // the residual error — a hop that straddles the window boundary lands in a
    // second bucket and is therefore MORE likely to be suppressed, never less.
    bucketMinutes: TRAVELER_FLOW_WINDOW_MINUTES,
    maxSignalAgeMinutes: TRAVELER_FLOW_WINDOW_MINUTES,
  });

  const derived = deriveTravelerFlowEdges(transitions, {
    now: opts.now,
    cityLabels: opts.cityLabels,
    k: opts.k,
  });

  // The raw hop and transition counts stay HERE, in the process, where an
  // operator reading logs already has the database. They are not returned:
  // see TravelerFlowReport's header for why no viewport-scoped count of
  // ungated rows can be put on the wire safely.
  logger.debug(
    {
      hops: hops.signals.length,
      hopsSkipped: hops.skipped.length,
      transitions: transitions.length,
      published: derived.edges.length,
      rejected: derived.rejected.length,
    },
    "travelerFlowProducer: hop read",
  );

  return {
    edges: derived.edges,
    report: {
      refusal: null,
      published: derived.edges.length,
      publishableButUnusable: derived.publishableButUnusable,
    },
  };
}

/**
 * Compile-time pin for the flag literal above. The literal exists so
 * check:flag-polarity can resolve it; this makes renaming the constant a TYPE
 * ERROR rather than a silently-diverging second spelling.
 */
const WORLD_INTELLIGENCE_FLAG_PIN: "map_world_intelligence_enabled" = WORLD_INTELLIGENCE_FLAG;
void WORLD_INTELLIGENCE_FLAG_PIN;
