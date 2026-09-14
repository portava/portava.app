/**
 * LayoverEnvelope — spec §8, the half of a safe envelope this tree can honestly
 * certify: the OUTER bound, cut from a BIDIRECTIONAL journey.
 *
 * ── WHAT §8 ASKS FOR, AND WHAT COULD ACTUALLY BE BUILT ──────────────────────
 * §8 asks for bidirectional reachability under future return conditions, a
 * time-based isochrone rather than a fixed radius, `SafeEnvelope = union(points
 * satisfying the feasibility constraint)`, and map bands SAFE / TIGHT /
 * BLOCKED. census-layover scored all of it NOT-BUILT, and four of those rows
 * (L61, L62, L66, L68–L73) need something this repository does not have: a
 * routed travel-time provider. `LAYOVER_TRAVEL_TIME_PROVIDER` is
 * `noRoutedProvider` and every landside leg comes back `null`.
 *
 * One thing does NOT need a routed provider, and it is the thing that protects
 * a traveller rather than tempting them. A great-circle distance is a genuine
 * LOWER BOUND on travel time — no road is shorter than the straight line — and
 * `domain/trips/contracts/TravelTimeProvider.ts` states the asymmetry that
 * follows in its own header: *"a straight-line INFEASIBLE is a real verdict; a
 * straight-line FEASIBLE is not."* `TripFeasibilityEngine` is built around it.
 *
 * So this module computes the envelope's OUTER edge — the set of points that
 * CANNOT fit the traveller's window at any speed a person could actually
 * travel — and nothing else. It never says SAFE and never says TIGHT, because
 * those are certifications and nothing here has measured a route.
 *
 * ── WHY THIS IS A TIME-BASED ENVELOPE AND NOT A FIXED RADIUS (L61) ──────────
 * The radius is derived from `usableMinutes`, which is the certified freedom
 * window from §7 — so it is different for every session, it CONTRACTS as the
 * window shrinks (a delayed inbound, a live security queue, a bag), and it goes
 * to zero when the window does. It is a circle rather than a polygon because a
 * lower bound over an unknown road network IS a circle: with no route data the
 * only shape the geometry supports is the disc the straight-line bound cuts
 * out. Drawing anything more detailed would be drawing a road network nobody
 * has.
 *
 * ── THE ARITHMETIC, AND WHY IT IS AN INVERSE RATHER THAN A SECOND FORMULA ───
 * A landside outing costs `out + dwell + back`. `dwell >= 0` and, for a return
 * to the airport it started from, `back >= out` under the same bound. So a
 * candidate is CERTAINLY infeasible when `2 × lowerBound(distance) >
 * usableMinutes`, whatever the dwell and whatever the route.
 *
 * `radiusMetres` is the exact inverse of `straightLineTravelTimeProvider`'s own
 * `min(walk, drive)` at half the window — the SAME constants, imported, never
 * re-spelled — so the disc and the per-candidate verdict cannot disagree about
 * where the edge is. `layoverEnvelope.test.ts` sweeps the two against each
 * other at the boundary rather than trusting the algebra.
 *
 * ── WHAT THIS DOES NOT CLOSE ────────────────────────────────────────────────
 *  - There is no INNER edge. Nothing here can say a candidate fits, so `SAFE`
 *    and `TIGHT` have no producer and the band vocabulary says so.
 *  - The two legs are asked separately and the return one is asked at the
 *    return instant (census L60), but THE CONFIGURED PROVIDER IS SYMMETRIC AND
 *    TIME-INDEPENDENT, so all three queries come back with the same number and
 *    nothing a traveller sees moves. What changed is that the asymmetry is now
 *    a provider's answer to give rather than an assumption this file makes. A
 *    forecast that is WORSE at the return hour may flag a candidate and may
 *    never block one: a statement about one later instant is not a bound over
 *    every instant in the window, and `returnLowerBoundMin` takes the smaller
 *    of the two answers for exactly that reason.
 *  - Transport reliability, route alternatives, queue friction, weather and
 *    re-entry cost (L62) are not inputs. The bound is geometry and two speeds.
 */
import type { EstimateConfidence } from "./LayoverFeasibility.js";
import {
  estimateTravel,
  haversineMeters,
  straightLineTravelTimeProvider,
  DRIVE_METRES_PER_SECOND,
  DRIVE_WAIT_SECONDS,
  WALK_METRES_PER_SECOND,
  type GeoPoint,
  type TravelTimeProvider,
} from "../../domain/trips/contracts/TravelTimeProvider.js";

/**
 * §8's three map bands, plus the one this tree can actually produce.
 *
 * The spec names three: `SAFE = LOW risk`, `TIGHT = MODERATE/HIGH but within
 * configured policy`, `BLOCKED = outside certified envelope`. Two of them are
 * CERTIFICATIONS and there is no routed provider to certify with, so they are
 * declared here and never emitted — the same arrangement `LAYOVER_REASON_CODES`
 * uses for the codes whose triggering fact does not exist, and for the same
 * reason: a future producer must not be free to invent a spelling.
 *
 * `UNCERTIFIED` is the fourth and it is not a weakening of the spec. It is the
 * difference between "this point is outside the envelope" (a fact a lower bound
 * can prove) and "nobody has measured whether this point is inside it" (every
 * other point on this tree). Collapsing the second into `SAFE` is the defect
 * census L293 deleted; collapsing it into `BLOCKED` would withhold every
 * landside option at every airport.
 */
export const ENVELOPE_BANDS = ["SAFE", "TIGHT", "BLOCKED", "UNCERTIFIED"] as const;
export type EnvelopeBand = (typeof ENVELOPE_BANDS)[number];

/** Which bands are a CERTIFICATION that a candidate fits. Asked, never compared. */
export const ENVELOPE_BAND_CERTIFIES_FIT: Record<EnvelopeBand, boolean> = {
  SAFE: true,
  TIGHT: true,
  BLOCKED: false,
  UNCERTIFIED: false,
};

/**
 * §8 `SafeEnvelope`, as far as a lower bound defines one: the disc outside
 * which no point can satisfy the feasibility constraint.
 *
 * `union(points satisfying the constraint)` is a SUBSET of this disc and this
 * tree cannot compute it — that is stated in `certifiedInward: false` rather
 * than left for a reader to infer from the absence of a polygon.
 */
/**
 * census L63 — "Envelope edges contract as confidence drops."
 *
 * The share of the certified window that is NOT planned against, per §6.2
 * confidence band. It is spent on the PLANNING edge only: the proved edge above
 * is an arithmetic fact and does not move (see `plannedRadiusMetres`).
 *
 *   HIGH          0 %   nothing to hedge; the two edges coincide.
 *   MEDIUM       10 %
 *   LOW          25 %   every production session on this tree is LOW — the
 *                       record's confidence is the weakest of its estimates and
 *                       `timeOfDayExtra` is a STATIC_DEFAULT everywhere.
 *   INSUFFICIENT 100 %  a window this uncertain plans nothing landside at all.
 *                       Not a block: the proved edge is unchanged and every
 *                       candidate inside it is still served and still rated.
 *
 * The figures are a POLICY, not a measurement, and are declared here as one
 * table so that the day a real error distribution exists (`measureCalibration`
 * in LayoverAirportTruth already computes p90 coverage) this is the one place
 * that changes.
 */
export const ENVELOPE_UNCERTAINTY_BUDGET: Record<EstimateConfidence, number> = {
  HIGH: 0,
  MEDIUM: 0.10,
  LOW: 0.25,
  INSUFFICIENT: 1,
};

export interface SafeEnvelope {
  centre: GeoPoint;
  /**
   * Metres. Beyond this, `2 × lowerBound(distance) > usableMinutes` and the
   * candidate cannot fit however it is travelled to.
   */
  radiusMetres: number;
  /** The certified §7 window this radius was cut from. */
  usableMinutes: number;
  /** Half of it, floored to whole minutes — the most either leg may take. */
  maxOneWayMinutes: number;
  /** What produced the edge. There is exactly one value today. */
  basis: "straight_line_lower_bound";
  /** TRUE: a point outside the disc is certainly infeasible. Always true. */
  certifiedOutward: true;
  /** FALSE: a point inside the disc is NOT certified to fit. Always false. */
  certifiedInward: false;
  /**
   * TRUE: the RADIUS above splits the window in half between the two legs.
   * That is exact under the straight-line provider and an approximation under
   * any provider that answers by direction. `bandCandidate` compares the two
   * legs it actually measured and is the authority where they differ.
   */
  discAssumesSymmetricReturn: true;

  // ── census L63: the edge that reads confidence ──────────────────────────────

  /**
   * The §6.2 confidence band this envelope was cut under, or `null` when the
   * caller supplied none (in which case nothing below contracts and the
   * envelope is byte-identical to the pre-L63 one).
   */
  confidence: EstimateConfidence | null;
  /** Minutes of the certified window deliberately not planned against. >= 0. */
  uncertaintyBudgetMinutes: number;
  /** `maxOneWayMinutes` after the budget. <= `maxOneWayMinutes`. */
  plannedMaxOneWayMinutes: number;
  /**
   * The CONTRACTED edge: the reach of a leg that leaves the uncertainty budget
   * unspent. Always <= `radiusMetres`, equal to it only at HIGH.
   *
   * This is a PLANNING bound, not a proof, and the distinction is the reason
   * there are two numbers rather than one smaller one. Outside `radiusMetres`
   * nothing fits at any speed — that is arithmetic. Outside this, a candidate
   * fits only if every estimate behind the window was right, which at LOW
   * confidence is not something this tree can say. A candidate between the two
   * is FLAGGED (`withinPlannedEdge: false`) and never blocked.
   */
  plannedRadiusMetres: number;
}

/**
 * The exact inverse of `min(walk, drive)` at `maxOneWaySeconds`.
 *
 * THE DISC ASSUMES A SYMMETRIC RETURN AND THE PER-CANDIDATE RULE DOES NOT.
 * `maxOneWayMinutes` is half the window, which is the right split only when the
 * ride back costs what the ride out did: true of the straight-line bound and of
 * nothing else. `bandCandidate` asks the port for BOTH legs and compares their
 * SUM, so under an asymmetric provider it is the authority and this disc is a
 * drawing. `discAssumesSymmetricReturn` on the envelope says so out loud rather
 * than leaving a map to infer it.
 *
 * Walking is the faster mode below roughly 265 m (driving pays
 * `DRIVE_WAIT_SECONDS` before it moves at all), so the bound is the LARGER of
 * the two modes' reaches, which is what makes this the inverse of a MINIMUM
 * over modes. Both constants are the provider's own, imported rather than
 * copied — if they change, this changes with them.
 */
function reachMetres(maxOneWaySeconds: number): number {
  if (maxOneWaySeconds <= 0) return 0;
  const byWalk = maxOneWaySeconds * WALK_METRES_PER_SECOND;
  const byDrive = maxOneWaySeconds > DRIVE_WAIT_SECONDS
    ? (maxOneWaySeconds - DRIVE_WAIT_SECONDS) * DRIVE_METRES_PER_SECOND
    : 0;
  return Math.max(byWalk, byDrive);
}

/**
 * Build the envelope for one certified window.
 *
 * `null` when there is no centre — the airport has no usable coordinate, which
 * is what `airportPoint` answers for the `(0, 0)` every fallback profile
 * carries. An envelope centred on the Gulf of Guinea would block every real
 * place on earth, so the absence of a coordinate must produce the absence of an
 * envelope and NOT a default one. This is the direction every refusal in this
 * surface fails: no proof, no block.
 */
export function safeEnvelope(
  usableMinutes: number,
  centre: GeoPoint | null,
  /**
   * census L63. The certified record's own `confidence` — `record.confidence`,
   * the weakest of its §6.2 estimates. OPTIONAL, and its absence spends no
   * budget: an existing caller that does not hold a band gets exactly the
   * envelope it got before, which is what keeps this additive.
   */
  confidence?: EstimateConfidence | null,
): SafeEnvelope | null {
  if (!centre) return null;
  const band = confidence ?? null;
  if (!Number.isFinite(usableMinutes) || usableMinutes <= 0) {
    return {
      centre,
      radiusMetres: 0,
      usableMinutes: Math.max(0, Number.isFinite(usableMinutes) ? usableMinutes : 0),
      maxOneWayMinutes: 0,
      basis: "straight_line_lower_bound",
      certifiedOutward: true,
      certifiedInward: false,
      discAssumesSymmetricReturn: true,
      confidence: band,
      uncertaintyBudgetMinutes: 0,
      plannedMaxOneWayMinutes: 0,
      plannedRadiusMetres: 0,
    };
  }
  // FLOORED, and the floor is not a rounding convenience — it is what makes the
  // disc and the per-candidate verdict the same rule. The provider reports
  // whole minutes (`Math.ceil(seconds / 60)`), so "the round trip fits" is
  // `2 × ceil(s/60) <= usableMinutes`, and for an integer k that is exactly
  // `k <= floor(usableMinutes / 2)`, i.e. `s <= floor(usableMinutes/2) × 60`.
  // Using the un-floored half admitted points the provider itself rounded up
  // past the window — measured: a 45-minute window admitted a 46-minute round
  // trip — which would have been a disc that disagreed with the block.
  const maxOneWayMinutes = Math.floor(usableMinutes / 2);
  // census L63. CEIL on the budget and FLOOR on what is left, so the haircut is
  // never rounded in the traveller's favour — the same direction every other
  // rounding in this surface fails.
  const budgetShare = band ? ENVELOPE_UNCERTAINTY_BUDGET[band] : 0;
  const uncertaintyBudgetMinutes = Math.ceil(usableMinutes * budgetShare);
  const plannedUsableMinutes = Math.max(0, usableMinutes - uncertaintyBudgetMinutes);
  const plannedMaxOneWayMinutes = Math.floor(plannedUsableMinutes / 2);
  return {
    centre,
    radiusMetres: Math.floor(reachMetres(maxOneWayMinutes * 60)),
    usableMinutes,
    maxOneWayMinutes,
    basis: "straight_line_lower_bound",
    certifiedOutward: true,
    certifiedInward: false,
    discAssumesSymmetricReturn: true,
    confidence: band,
    uncertaintyBudgetMinutes,
    plannedMaxOneWayMinutes,
    plannedRadiusMetres: Math.floor(reachMetres(plannedMaxOneWayMinutes * 60)),
  };
}

/** One candidate's verdict against the envelope. */
export interface EnvelopeVerdict {
  band: EnvelopeBand;
  /** Great-circle metres from the envelope's centre. `null` with no point. */
  distanceMetres: number | null;
  /**
   * The provider's one-way LOWER BOUND in minutes. `null` when there is no
   * point to measure, or no envelope to measure against.
   */
  lowerBoundOneWayMin: number | null;
  /**
   * Why this band. Empty for `UNCERTIFIED` — an absence needs no reason beyond
   * itself, and inventing one would read as a measurement.
   */
  reason: string | null;
  /**
   * census L63. Whether the point is inside the CONTRACTED planning edge.
   * `null` when there is no envelope or no point to measure. FALSE is a FLAG
   * and never a refusal: the band above is what decides whether a candidate is
   * served, and a confidence haircut may not change it.
   */
  withinPlannedEdge: boolean | null;
  /** Why the planning edge excluded it, naming the band. `null` when inside. */
  plannedEdgeReason: string | null;

  // ── census L60: the two legs, asked separately ──────────────────────────────

  /**
   * The AIRPORT → CANDIDATE lower bound, asked at `departAt`. `null` when the
   * port could not answer. `lowerBoundOneWayMin` above is this same number,
   * kept because consumers read it; it is no longer the whole journey.
   */
  outboundLowerBoundMin: number | null;
  /**
   * The CANDIDATE → AIRPORT lower bound the REFUSAL rests on: the SMALLER of
   * the port's two answers, at `departAt` and at `returnDepartsAt`.
   *
   * The smaller, deliberately. A forecast that says the way back is worse at
   * 18:40 is a statement about one instant, not a bound over every instant the
   * traveller might leave, so it may inform PLANNING and may not produce a
   * proof. Taking the larger would let an assumption block a card, which is the
   * one thing this module does not do.
   */
  returnLowerBoundMin: number | null;
  /**
   * The same leg asked at `returnDepartsAt` — the FORECAST answer. Equal to
   * `returnLowerBoundMin` under a time-independent provider, which is the only
   * kind configured on this tree. The planning edge reads this one.
   */
  returnForecastLowerBoundMin: number | null;
  /**
   * `outboundLowerBoundMin + returnLowerBoundMin`, the quantity the block
   * compares against the window. `null` when either leg is unanswered.
   */
  roundTripLowerBoundMin: number | null;
  /**
   * The instant the return leg was forecast FOR, ISO: the LATEST departure the
   * window allows, `departAt + (usableMinutes − outbound)`.
   *
   * It is exact for the candidate ON the edge — there, `usable = out + back`,
   * so `usable − out` is precisely when they must start back — and conservative
   * for anything nearer, which is a traveller who spends their whole window.
   * `null` when there is no outbound bound to subtract.
   */
  returnDepartsAt: string | null;
}

const NO_VERDICT: EnvelopeVerdict = {
  band: "UNCERTIFIED",
  distanceMetres: null,
  lowerBoundOneWayMin: null,
  reason: null,
  withinPlannedEdge: null,
  plannedEdgeReason: null,
  outboundLowerBoundMin: null,
  returnLowerBoundMin: null,
  returnForecastLowerBoundMin: null,
  roundTripLowerBoundMin: null,
  returnDepartsAt: null,
};

/**
 * Band one candidate.
 *
 * Asks the PROVIDER for the bound rather than computing it here, so the number
 * behind a block is the same number `TripFeasibilityEngine` would have used for
 * the same pair of points. `reachMetres` above inverts the same function for
 * the disc; the test sweeps them against each other at the edge.
 *
 * Fails open in every direction a caller can get wrong: no envelope, no point,
 * a provider that throws or answers `unknown` — each is `UNCERTIFIED`, never
 * `BLOCKED`. A block is a REFUSAL and refusals need proof; the safe direction
 * for an absence here is to leave the card standing and let `assess` rate it,
 * which already fails closed on an unmeasured leg.
 */
export async function bandCandidate(
  envelope: SafeEnvelope | null,
  point: GeoPoint | null,
  departAt: Date,
  provider: TravelTimeProvider = straightLineTravelTimeProvider,
): Promise<EnvelopeVerdict> {
  if (!envelope || !point) return NO_VERDICT;
  // NO try/catch HERE, and its absence is deliberate. `estimateTravel` already
  // wraps the provider — a throw comes back as `unknown / PROVIDER_UNAVAILABLE`
  // and a malformed answer as `unknown / PROVIDER_MALFORMED` — so a second
  // catch around this call is unreachable. The first draft had one; a mutation
  // that turned it into a fail-CLOSED block stayed GREEN, which is how the dead
  // branch was found. `haversineMeters` cannot throw either: both points come
  // from `airportPoint` / `placePoint`, which admit only finite coordinates.
  const metres = haversineMeters(envelope.centre, point);
  const legMinutes = async (from: GeoPoint, to: GeoPoint, at: Date): Promise<number | null> => {
    const r = await estimateTravel(provider, { from, to, departAt: at }, departAt);
    if (r.kind !== "estimate") return null;
    const m = Number(r.estimate.minutes);
    return Number.isFinite(m) && m >= 0 ? m : null;
  };

  // ── census L60, leg 1: AIRPORT → CANDIDATE, at the moment they leave ───────
  const oneWay = await legMinutes(envelope.centre, point, departAt);
  if (oneWay === null) return NO_VERDICT;

  // The latest instant the window allows the traveller to start back. Derived
  // rather than assumed: see `returnDepartsAt` for why it is exact on the edge.
  const returnDepartAt = new Date(
    departAt.getTime() + Math.max(0, envelope.usableMinutes - oneWay) * 60_000,
  );

  // ── leg 2: CANDIDATE → AIRPORT, asked twice ───────────────────────────────
  // Once at the same instant and once at the return instant. A symmetric,
  // time-independent provider — the only kind configured here — answers the
  // same number to all three queries, so nothing a traveller sees moves today.
  // The shape is the point: the day a routed, time-aware provider is wired,
  // the ride back stops being the ride out without another line changing.
  const backNow = await legMinutes(point, envelope.centre, departAt);
  const backLater = await legMinutes(point, envelope.centre, returnDepartAt);
  if (backNow === null || backLater === null) return NO_VERDICT;

  // The PROOF takes the smaller answer and the PLAN takes the larger. See
  // `returnLowerBoundMin` for why a forecast may flag and may not block.
  const backProved = Math.min(backNow, backLater);
  const backPlanned = Math.max(backNow, backLater);
  const roundTrip = oneWay + backProved;

  // census L63 — the contracted edge. Now evaluated on the ROUND TRIP against
  // the planned window rather than on one leg against half of it: with a
  // symmetric provider `out + back <= planned` and `out <= floor(planned / 2)`
  // are the same statement for integer minutes, so this is the same edge it
  // was, widened to say something under an asymmetric one.
  const plannedUsable = Math.max(0, envelope.usableMinutes - envelope.uncertaintyBudgetMinutes);
  const withinPlannedEdge = oneWay + backPlanned <= plannedUsable;
  const plannedEdgeReason = withinPlannedEdge
    ? null
    : `beyond what we would plan on ${envelope.confidence ?? "unknown"} confidence — ` +
      `${envelope.uncertaintyBudgetMinutes} of the ${envelope.usableMinutes} usable minutes are held back, ` +
      `and the return leg is forecast at ${oneWay + backPlanned} min there and back`;

  const twoLegs = {
    outboundLowerBoundMin: oneWay,
    returnLowerBoundMin: backProved,
    returnForecastLowerBoundMin: backLater,
    roundTripLowerBoundMin: roundTrip,
    returnDepartsAt: returnDepartAt.toISOString(),
  };

  if (roundTrip > envelope.usableMinutes) {
    return {
      band: "BLOCKED",
      distanceMetres: Math.round(metres),
      lowerBoundOneWayMin: oneWay,
      reason:
        `${Math.round(metres / 100) / 10} km from the airport — at least ${roundTrip} min there and back, ` +
        `against ${envelope.usableMinutes} min of usable time`,
      withinPlannedEdge,
      plannedEdgeReason,
      ...twoLegs,
    };
  }
  return {
    band: "UNCERTIFIED",
    distanceMetres: Math.round(metres),
    lowerBoundOneWayMin: oneWay,
    reason: null,
    withinPlannedEdge,
    plannedEdgeReason,
    ...twoLegs,
  };
}

/**
 * Band a whole candidate list in one pass.
 *
 * Returns a map keyed by whatever identity the caller supplies, so the caller's
 * own `recommendationKey` stays the single identity for a card and this module
 * never invents a second one.
 */
export async function bandCandidates<K>(
  envelope: SafeEnvelope | null,
  candidates: ReadonlyArray<{ key: K; point: GeoPoint | null }>,
  departAt: Date,
  provider: TravelTimeProvider = straightLineTravelTimeProvider,
): Promise<Map<K, EnvelopeVerdict>> {
  const out = new Map<K, EnvelopeVerdict>();
  if (!envelope) return out;
  const verdicts = await Promise.all(
    candidates.map((c) => bandCandidate(envelope, c.point, departAt, provider)),
  );
  candidates.forEach((c, i) => out.set(c.key, verdicts[i]!));
  return out;
}
