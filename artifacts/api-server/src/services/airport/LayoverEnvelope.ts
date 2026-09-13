/**
 * LayoverEnvelope — spec §8, the half of a safe envelope this tree can honestly
 * certify: the OUTER bound.
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
 *  - The bound is symmetric (`back >= out`), so §8.1's "return traffic forecast
 *    — use a future-time estimate, not outbound time" is NOT satisfied by it:
 *    a symmetric lower bound is still a lower bound, which is all that is
 *    claimed, but it is not the asymmetric return model L60/L72 ask for.
 *  - Transport reliability, route alternatives, queue friction, weather and
 *    re-entry cost (L62) are not inputs. The bound is geometry and two speeds.
 */
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
}

/**
 * The exact inverse of `min(walk, drive)` at `maxOneWaySeconds`.
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
export function safeEnvelope(usableMinutes: number, centre: GeoPoint | null): SafeEnvelope | null {
  if (!centre) return null;
  if (!Number.isFinite(usableMinutes) || usableMinutes <= 0) {
    return {
      centre,
      radiusMetres: 0,
      usableMinutes: Math.max(0, Number.isFinite(usableMinutes) ? usableMinutes : 0),
      maxOneWayMinutes: 0,
      basis: "straight_line_lower_bound",
      certifiedOutward: true,
      certifiedInward: false,
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
  return {
    centre,
    radiusMetres: Math.floor(reachMetres(maxOneWayMinutes * 60)),
    usableMinutes,
    maxOneWayMinutes,
    basis: "straight_line_lower_bound",
    certifiedOutward: true,
    certifiedInward: false,
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
}

const NO_VERDICT: EnvelopeVerdict = {
  band: "UNCERTIFIED",
  distanceMetres: null,
  lowerBoundOneWayMin: null,
  reason: null,
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
  let oneWay: number;
  let metres: number;
  try {
    metres = haversineMeters(envelope.centre, point);
    const r = await estimateTravel(provider, { from: envelope.centre, to: point, departAt }, departAt);
    if (r.kind !== "estimate") return NO_VERDICT;
    oneWay = Number(r.estimate.minutes);
    if (!Number.isFinite(oneWay) || oneWay < 0) return NO_VERDICT;
  } catch {
    return NO_VERDICT;
  }
  if (oneWay * 2 > envelope.usableMinutes) {
    return {
      band: "BLOCKED",
      distanceMetres: Math.round(metres),
      lowerBoundOneWayMin: oneWay,
      reason:
        `${Math.round(metres / 100) / 10} km from the airport — at least ${oneWay * 2} min there and back, ` +
        `against ${envelope.usableMinutes} min of usable time`,
    };
  }
  return {
    band: "UNCERTIFIED",
    distanceMetres: Math.round(metres),
    lowerBoundOneWayMin: oneWay,
    reason: null,
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
