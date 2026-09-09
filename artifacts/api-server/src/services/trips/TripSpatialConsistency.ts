/**
 * Trips §7.4 — spatial consistency checks.
 *
 * §7.4 names four checks and gives each a failure example:
 *
 *   Travel feasibility   "Dinner in Da Nang 19:00; Hoi An event 19:30."
 *   Place identity       "External booking and hidden gem share a name but
 *                         not canonical identity."
 *   Stage locality       "Plan belongs to a stage whose location/timezone does
 *                         not contain it."
 *   Route availability   "Plan is feasible by taxi but transport mode policy
 *                         says no taxi."
 *
 * Travel feasibility is TripFeasibilityEngine and is not repeated here. This
 * file is the other three, and one of them cannot be built:
 *
 * ROUTE AVAILABILITY IS NOT IMPLEMENTED, AND THE REASON IS NOT "NOT YET"
 * =====================================================================
 * It requires a transport-mode POLICY — a statement that this trip, or this
 * traveller, will not use a taxi. Searched across both trees: `transport_mode`
 * exists only in `services/memoryProjections/episodeDetection.ts`, where it is
 * an OBSERVED attribute of a past journey, not a permission. There is no table,
 * column, preference or flag anywhere that expresses "no taxi".
 *
 * So this check has no INPUT, and inventing one would mean inventing the
 * policy. `ROUTE_AVAILABILITY_UNCHECKABLE` is returned as an explicit finding
 * rather than omitted, because a consistency report that silently covers three
 * of four checks reads as a clean bill of health on all four.
 *
 * EVERY CHECK IS THREE-VALUED
 * ==========================
 * CONSISTENT / INCONSISTENT / UNCHECKABLE. The third is the one that matters:
 * a plan whose stage has no dates cannot be shown to fall outside them, and
 * "we could not check" must never come back as "it is fine". That is the same
 * asymmetry §7's engine is built on, one layer up.
 *
 * PURE. Every input is a parameter, including the coordinates and the clock,
 * so the whole thing is testable without a database.
 */

export const CONSISTENCY_VERDICTS = ["CONSISTENT", "UNCHECKABLE", "INCONSISTENT"] as const;
export type ConsistencyVerdict = (typeof CONSISTENCY_VERDICTS)[number];

/** Which §7.4 check produced a finding. */
export const CONSISTENCY_CHECKS = [
  "STAGE_LOCALITY_TIME",
  "STAGE_LOCALITY_PLACE",
  "PLACE_IDENTITY",
  "ROUTE_AVAILABILITY",
] as const;
export type ConsistencyCheck = (typeof CONSISTENCY_CHECKS)[number];

/** Why a check could not be run, or what it found. Each is actionable
 *  differently, which is why none of them is a shared "problem". */
export const CONSISTENCY_REASONS = [
  /** The plan's time falls outside its stage's interval. */
  "PLAN_OUTSIDE_STAGE_INTERVAL",
  /** The plan's coordinates are further from the stage anchor than any
   *  reasonable reading of "in this place". */
  "PLAN_FAR_FROM_STAGE_ANCHOR",
  /** Two plan items share a location NAME and disagree on canonical place id. */
  "SAME_NAME_DIFFERENT_PLACE",
  /** The stage has no dates, so containment is not decidable. */
  "STAGE_HAS_NO_INTERVAL",
  /** The plan has no time, so containment is not decidable. */
  "PLAN_HAS_NO_TIME",
  /** One or both coordinates are missing. */
  "NO_COORDINATES",
  /** The stage this plan names is not in the set given. */
  "STAGE_NOT_FOUND",
  /** No transport-mode policy exists in this system. See the header. */
  "NO_TRANSPORT_MODE_POLICY",
] as const;
export type ConsistencyReason = (typeof CONSISTENCY_REASONS)[number];

export interface ConsistencyFinding {
  check: ConsistencyCheck;
  verdict: ConsistencyVerdict;
  reason: ConsistencyReason;
  /** The plan item(s) this concerns. Two for PLACE_IDENTITY. */
  planIds: string[];
  stageId: string | null;
  /** Human-facing, and never phrased as reassurance for an UNCHECKABLE. */
  detail: string;
}

export interface GeoPoint { lat: number; lng: number }

export interface PlanForConsistency {
  id: string;
  stageId: string | null;
  /** `starts_at` when there is one, else the day. Null when neither. */
  startsAt: string | null;
  dayDate: string | null;
  locationName: string | null;
  /** Canonical place identity, when the plan has one. */
  placeId: string | null;
  lat: number | null;
  lng: number | null;
}

export interface StageForConsistency {
  id: string;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  /** The stage's anchor coordinates, resolved by the caller. Null when the
   *  stage is anchored to a city with no coordinates, or to nothing readable. */
  anchor: GeoPoint | null;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle metres. Same formula as TravelTimeProvider, deliberately: two
 *  modules answering about the same pair of points must not disagree. */
export function metresBetween(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far from its stage's anchor a plan may be before "this stage does not
 * contain it" is the honest reading.
 *
 * 60 km, and the number is arbitrary in the way every threshold is — what is
 * NOT arbitrary is that it is stated once, here, rather than appearing as a
 * magic number in a condition. A city stage's anchor is its centre, and a plan
 * an hour's drive outside the metropolitan area is the §7.4 example: Da Nang
 * and Hoi An are 30 km apart, so this deliberately does NOT flag them — the
 * spec files that pair under travel FEASIBILITY, not under locality, and
 * flagging it here would double-report one problem as two.
 */
export const STAGE_LOCALITY_RADIUS_M = 60_000;

/** The instant a plan happens at, or null. A day with no time is midnight UTC,
 *  which is a real instant and is marked as coarse by the caller's reason. */
function planInstant(p: PlanForConsistency): number | null {
  if (p.startsAt) { const t = Date.parse(p.startsAt); return Number.isFinite(t) ? t : null; }
  if (p.dayDate) { const t = Date.parse(`${p.dayDate}T12:00:00Z`); return Number.isFinite(t) ? t : null; }
  return null;
}

/**
 * §7.4 stage locality: does the plan's stage contain it, in time and in space?
 *
 * Time and space are checked SEPARATELY and reported separately, because they
 * fail for different reasons and are fixed differently — a plan on the wrong
 * day is a scheduling mistake, a plan in the wrong city is an attachment
 * mistake.
 */
export function checkStageLocality(
  plans: PlanForConsistency[],
  stages: StageForConsistency[],
): ConsistencyFinding[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const out: ConsistencyFinding[] = [];

  for (const p of plans) {
    if (p.stageId === null) continue;   // not attached: nothing to be outside of
    const stage = byId.get(p.stageId);
    if (!stage) {
      out.push({
        check: "STAGE_LOCALITY_TIME", verdict: "UNCHECKABLE", reason: "STAGE_NOT_FOUND",
        planIds: [p.id], stageId: p.stageId,
        detail: "This plan names a stage that is not on this trip, so it cannot be checked against one.",
      });
      continue;
    }

    // ── time ──────────────────────────────────────────────────────────────
    const t = planInstant(p);
    if (t === null) {
      out.push({
        check: "STAGE_LOCALITY_TIME", verdict: "UNCHECKABLE", reason: "PLAN_HAS_NO_TIME",
        planIds: [p.id], stageId: stage.id,
        detail: "This plan has no date or time, so whether its stage covers it is not decidable.",
      });
    } else if (stage.startsAt === null && stage.endsAt === null) {
      out.push({
        check: "STAGE_LOCALITY_TIME", verdict: "UNCHECKABLE", reason: "STAGE_HAS_NO_INTERVAL",
        planIds: [p.id], stageId: stage.id,
        detail: "This stage has no dates, so nothing can be shown to fall outside it.",
      });
    } else {
      const from = stage.startsAt ? Date.parse(stage.startsAt) : Number.NEGATIVE_INFINITY;
      const to = stage.endsAt ? Date.parse(stage.endsAt) : Number.POSITIVE_INFINITY;
      // A bound that will not parse is not an open bound. Treating it as one
      // would make an unreadable date into permission.
      if ((stage.startsAt && !Number.isFinite(from)) || (stage.endsAt && !Number.isFinite(to))) {
        out.push({
          check: "STAGE_LOCALITY_TIME", verdict: "UNCHECKABLE", reason: "STAGE_HAS_NO_INTERVAL",
          planIds: [p.id], stageId: stage.id,
          detail: "This stage's dates could not be read, so containment is not decidable.",
        });
      } else if (t < from || t > to) {
        out.push({
          check: "STAGE_LOCALITY_TIME", verdict: "INCONSISTENT", reason: "PLAN_OUTSIDE_STAGE_INTERVAL",
          planIds: [p.id], stageId: stage.id,
          detail: "This plan is scheduled outside the dates of the stage it belongs to.",
        });
      }
    }

    // ── space ─────────────────────────────────────────────────────────────
    if (p.lat === null || p.lng === null || stage.anchor === null) {
      out.push({
        check: "STAGE_LOCALITY_PLACE", verdict: "UNCHECKABLE", reason: "NO_COORDINATES",
        planIds: [p.id], stageId: stage.id,
        detail: "Either this plan or its stage has no coordinates, so their locations cannot be compared.",
      });
    } else {
      const d = metresBetween({ lat: p.lat, lng: p.lng }, stage.anchor);
      if (d > STAGE_LOCALITY_RADIUS_M) {
        out.push({
          check: "STAGE_LOCALITY_PLACE", verdict: "INCONSISTENT", reason: "PLAN_FAR_FROM_STAGE_ANCHOR",
          planIds: [p.id], stageId: stage.id,
          detail: `This plan is ${Math.round(d / 1000)} km from the place its stage is anchored to.`,
        });
      }
    }
  }

  return out;
}

/**
 * §7.4 place identity: "External booking and hidden gem share a name but not
 * canonical identity."
 *
 * Two plan items with the SAME location name and DIFFERENT canonical place ids
 * are either two genuinely different places that happen to share a name, or one
 * place recorded twice under two identities. This code cannot tell those apart
 * and does not try — it reports the collision, which is the actionable fact.
 *
 * A plan with NO place id is not evidence of anything: an unresolved plan and a
 * plan resolved to a different place are different situations, and reporting
 * the first as a collision would bury the second in noise. It is UNCHECKABLE.
 */
export function checkPlaceIdentity(plans: PlanForConsistency[]): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = [];
  const byName = new Map<string, PlanForConsistency[]>();

  for (const p of plans) {
    const name = (p.locationName ?? "").trim().toLowerCase();
    if (name === "") continue;   // no name, no possible name collision
    const list = byName.get(name) ?? [];
    list.push(p);
    byName.set(name, list);
  }

  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const resolved = group.filter((p) => p.placeId !== null);
    const unresolved = group.filter((p) => p.placeId === null);

    const ids = new Set(resolved.map((p) => p.placeId as string));
    if (ids.size > 1) {
      out.push({
        check: "PLACE_IDENTITY", verdict: "INCONSISTENT", reason: "SAME_NAME_DIFFERENT_PLACE",
        planIds: resolved.map((p) => p.id), stageId: null,
        detail: `${resolved.length} plans are called "${name}" and point at ${ids.size} different places.`,
      });
    }
    if (unresolved.length > 0 && resolved.length > 0) {
      out.push({
        check: "PLACE_IDENTITY", verdict: "UNCHECKABLE", reason: "NO_COORDINATES",
        planIds: unresolved.map((p) => p.id), stageId: null,
        detail: `${unresolved.length} plan(s) called "${name}" have no canonical place, so whether they are the same place as the others is not decidable.`,
      });
    }
  }

  return out;
}

/**
 * §7.4 route availability. Always UNCHECKABLE, and it says why.
 *
 * Returned rather than omitted: a report covering three of the four checks and
 * saying nothing about the fourth reads as a clean bill of health on all four.
 */
export function checkRouteAvailability(): ConsistencyFinding[] {
  return [{
    check: "ROUTE_AVAILABILITY", verdict: "UNCHECKABLE", reason: "NO_TRANSPORT_MODE_POLICY",
    planIds: [], stageId: null,
    detail: "Nothing in this system records which transport modes a trip will or will not use, so no plan can be checked against one.",
  }];
}

/** All of §7.4 except travel feasibility, which is TripFeasibilityEngine. */
export function checkSpatialConsistency(
  plans: PlanForConsistency[],
  stages: StageForConsistency[],
): ConsistencyFinding[] {
  return [
    ...checkStageLocality(plans, stages),
    ...checkPlaceIdentity(plans),
    ...checkRouteAvailability(),
  ];
}

/**
 * The one-line verdict over a set of findings.
 *
 * INCONSISTENT beats UNCHECKABLE beats CONSISTENT — the worst thing found
 * wins, and an empty finding list is the ONLY thing that yields CONSISTENT.
 * Note that `checkRouteAvailability` always emits one UNCHECKABLE, so this
 * function cannot currently return CONSISTENT for a real trip. That is
 * correct: one of §7.4's four checks cannot be run, and a green verdict would
 * be claiming otherwise.
 */
export function foldConsistency(findings: ConsistencyFinding[]): ConsistencyVerdict {
  if (findings.some((f) => f.verdict === "INCONSISTENT")) return "INCONSISTENT";
  if (findings.some((f) => f.verdict === "UNCHECKABLE")) return "UNCHECKABLE";
  return "CONSISTENT";
}
