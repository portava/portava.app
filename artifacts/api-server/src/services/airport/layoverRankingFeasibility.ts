/**
 * layoverRankingFeasibility — the feasibility state a CANDIDATE PIN carries,
 * spec §13 map elements (census L117, L122) and §9.1's ranking contract.
 *
 * ── WHY THIS EXISTS AS A CONTRACT AND NOT AS A CLIENT CALCULATION ───────────
 * §13 L115 is explicit that the map *"consumes the active snapshot and envelope
 * geometry; does not recalculate feasibility"*, and L122 names the source the
 * pin must read: *"carries feasibility state FROM THE RECOMMENDATION
 * CONTRACT."* Those two together forbid the obvious client shortcut — the
 * overview already publishes `safeEnvelope { centre, radiusMetres }`, and a
 * client could haversine every pin against it in four lines. That client would
 * then hold a SECOND feasibility rule, derived from a disc rather than from the
 * provider's own bound, free to disagree with the server about where the edge
 * is. This module is the alternative: the server bands the candidate once,
 * beside the certification that produced the window, and the band travels ON
 * the card.
 *
 * ── WHAT IT MAY AND MAY NOT SAY ────────────────────────────────────────────
 * The vocabulary is `LayoverEnvelope`'s `ENVELOPE_BANDS`, imported rather than
 * re-spelled, because §13's three bands are that module's three bands and a
 * second spelling of `BLOCKED` is how two surfaces start disagreeing quietly.
 * Nothing here can INVENT a band: every value comes from an `EnvelopeVerdict`
 * the envelope produced, or from the explicit "nobody banded this" state.
 *
 * `impliesFit` is the L125 prohibition made machine-checkable. §13 says a
 * blocked area must *"explain the reason, never imply safe fit"*, and the
 * honest reading of this tree is stronger than that: NO band it can produce
 * implies a fit, because `SAFE` and `TIGHT` are certifications and there is no
 * routed provider to certify with (`LayoverEnvelope`'s header). So the field is
 * derived from `ENVELOPE_BAND_CERTIFIES_FIT` rather than hard-coded `false` —
 * it is `false` today for every band this tree emits, and it will start being
 * `true` by itself on the day an inner edge exists, instead of needing someone
 * to remember. A test asserts it is false on every served card; that assertion
 * is a claim about the tree, not about this file.
 *
 * ── COORDINATE-FREE, ON PURPOSE ─────────────────────────────────────────────
 * `LayoverPrivacyGuard` strips lat/lng from every recommendation before it
 * reaches a client, and this state is attached AFTER that sanitiser, so it must
 * not put a position back. It does not: the only spatial figures here are a
 * distance-from-the-airport in the prose reason (rounded to 100 m by the
 * envelope itself) and a one-way lower bound in minutes. Neither locates a
 * place; both are what L125 requires a blocked pin to explain itself with.
 */
import {
  ENVELOPE_BAND_CERTIFIES_FIT,
  type EnvelopeBand,
  type EnvelopeVerdict,
} from "./LayoverEnvelope.js";

export interface CandidateFeasibility {
  /** §13's band, straight off the envelope verdict. Never widened here. */
  band: EnvelopeBand;
  /**
   * TRUE only when an envelope actually measured this candidate. FALSE is not
   * a failure — an airside card has no landside leg to band, and a card served
   * from storage was banded against a window that has since moved — but it is
   * the difference between "we looked and it is unproven" and "nobody looked",
   * and a pin that renders those the same way is the L293 defect again.
   */
  certified: boolean;
  /** The provider's one-way LOWER BOUND in minutes. `null` when unmeasured. */
  lowerBoundOneWayMin: number | null;
  /**
   * Inside the CONTRACTED planning edge — the radius left after the §6.2
   * confidence haircut. `null` when nothing measured it. FALSE is a FLAG and
   * never a refusal: a candidate between the planning edge and the proved edge
   * is still served, still ratable and still addable. The pin shows it; the
   * list does not withhold it.
   */
  withinPlannedEdge: boolean | null;
  /** Why this band, in the words a pin shows. `null` when there is nothing. */
  reason: string | null;
  /** Why the planning edge excluded it, naming the band. `null` when inside. */
  plannedEdgeReason: string | null;
  /**
   * Whether this band is a CERTIFICATION that the candidate fits. Derived, not
   * asserted — see the header. A surface may use it to decide whether it is
   * allowed to present the pin as safe; today the answer is always no.
   */
  impliesFit: boolean;
}

/**
 * The state for a candidate nothing banded.
 *
 * Two callers, and the reason is the whole value of the field: an AIRSIDE card
 * has no landside leg — there is nothing to measure and never will be — while a
 * card read back out of `layover_recommendations` was banded once, against a
 * window that has since moved, and this read did not re-cut an envelope. Both
 * are `certified: false`, and the `reason` is what tells them apart.
 */
export function unbandedCandidateFeasibility(reason: string | null): CandidateFeasibility {
  return {
    band: "UNCERTIFIED",
    certified: false,
    lowerBoundOneWayMin: null,
    withinPlannedEdge: null,
    reason,
    plannedEdgeReason: null,
    impliesFit: ENVELOPE_BAND_CERTIFIES_FIT.UNCERTIFIED,
  };
}

/**
 * Carry one `EnvelopeVerdict` onto the card.
 *
 * `undefined` — the candidate was never handed to the envelope, because it has
 * no position — falls through to the unbanded state rather than being invented
 * as `UNCERTIFIED` with a measured-looking shape.
 *
 * A verdict whose `lowerBoundOneWayMin` is null is a verdict the provider could
 * not answer (no coordinate, provider unavailable, malformed reply — see
 * `bandCandidate`'s NO_VERDICT). That is NOT a certification either, and it is
 * demoted here rather than published as one, so `certified: true` means exactly
 * "a bound was computed and this band came out of it".
 */
export function candidateFeasibilityFrom(
  verdict: EnvelopeVerdict | undefined,
  unbandedReason: string | null,
): CandidateFeasibility {
  if (!verdict || verdict.lowerBoundOneWayMin === null) {
    return unbandedCandidateFeasibility(unbandedReason);
  }
  return {
    band: verdict.band,
    certified: true,
    lowerBoundOneWayMin: verdict.lowerBoundOneWayMin,
    withinPlannedEdge: verdict.withinPlannedEdge,
    reason: verdict.reason,
    plannedEdgeReason: verdict.plannedEdgeReason,
    impliesFit: ENVELOPE_BAND_CERTIFIES_FIT[verdict.band],
  };
}

/** The reason an airside card carries. Stated once so two paths cannot drift. */
export const AIRSIDE_UNBANDED_REASON =
  "inside the terminal — there is no landside journey to measure";

/**
 * The reason a LANDSIDE card with no usable coordinate carries.
 *
 * `fetchDiscoveryPlaces` answers `point: null` for a `discovery_places` row
 * whose lat/lng are absent or `(0, 0)`, and `bandCandidates` cannot band a
 * candidate it cannot place. The card is still served — a missing coordinate is
 * not a reason to withhold a real place — and the pin says why it has no band
 * instead of showing one.
 */
export const NO_POSITION_UNBANDED_REASON =
  "we do not have a location for this place, so it could not be measured against your safe envelope";

/** The reason a card served out of storage carries. */
export const STORED_UNBANDED_REASON =
  "served from an earlier certification — this read did not re-measure the envelope";
