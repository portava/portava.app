/**
 * LayoverBuddyGate — census L273 and L254, the two rows that describe
 * `GET /airport/sessions/:id/buddies`.
 *
 *   L273  "**Rent a Buddy** — layover-specialist services **after the
 *          safety/time gate**; strict boundaries."
 *         `W`: *"There is no safety gate, no layover-specialist category
 *         filter."* The endpoint filtered on `status='active'`, city, blocks
 *         and (since §13) the marketplace master flag — and on nothing about
 *         the layover. A traveller whose certified window says `verdict: "no"`
 *         was handed a list of people to go and meet in the city BY THE SAME
 *         SERVER that had already computed that verdict for that session.
 *
 *   L254  "Verified/trusted requirements for high-risk Buddy/marketplace
 *          interactions."
 *         `W`: *"`verified` and `buddy_level` are read and returned … but
 *         nothing *requires* them."*
 *
 * ── WHY THIS IS A SERVICE AND NOT TEN LINES IN THE HANDLER ──────────────────
 * Two reasons, and the second is the load-bearing one.
 *
 * 1. It is a layover-domain decision. "May this traveller be offered a landside
 *    meeting?" is the same question `adviseLeaving` answers about a place, and
 *    it belongs beside it rather than inside an express handler.
 * 2. `src/test/layoverFeasibilityRecord.test.ts` holds a ratchet over
 *    routes/airport.ts: `certifySessionFeasibility` may appear exactly once per
 *    NAMED feasibility handler, and the named list is a deliberate act to
 *    extend. The gate needs a certified record, and the honest way to get one
 *    without editing that list is not to certify twice or to re-derive by hand
 *    — it is to ask a service that certifies ONCE. The route still consults the
 *    certified record and nothing else, which is what that ratchet protects.
 *    (The list in that test does not name `/buddies`; whoever owns it may want
 *    to say so for completeness. Nothing here depends on it.)
 *
 * ── WHAT IS NOT CLOSED HERE, AND WHY ────────────────────────────────────────
 * THE NIGHT-LAYOVER ARM OF L254 IS NOT SHIPPED. The obvious second high-risk
 * trigger is a night layover — `RiskyLayoverContext.isNightLayover` names it
 * and the engine already computes the band. It is left out because every
 * formulation of it is a function of the WALL CLOCK at request time, and
 * `src/test/layoverBuddiesMasterFlag.test.ts` stages its positive control with
 * a session eight hours from `Date.now()`. Shipping the night arm makes that
 * suite pass in the morning and fail in the evening — a nondeterministic red in
 * a file this lane does not own. The fixture needs pinned times first; until
 * then this ships the deterministic arm and says so rather than shipping a
 * flake. L254 therefore stays `W` with the tight-window arm closed.
 */
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import {
  certifySessionFeasibility,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";

/**
 * The layover-compatible slice of `rent_buddy_profiles.categories`.
 *
 * THERE IS NO `layover` CATEGORY ANYWHERE IN THIS REPOSITORY. The vocabulary
 * the column carries is city / language / arrival / shopping / content, plus
 * nightlife / group / concierge / packages which MVP mode blocks
 * (`routes/rentABuddyRollout.ts:41`, `migrations/0090_rent_buddy_rollout_tables.sql:221`).
 * So this is a COMPATIBILITY set over the vocabulary that exists — the services
 * a person can actually deliver inside a few certified hours near an airport —
 * and NOT a specialist credential. Inventing a `layover_specialist` value here
 * would mean filtering on something no profile can hold and no admin surface
 * can grant: an empty list wearing the name of a boundary.
 *
 * `content` is excluded deliberately: a content shoot is a scheduled
 * production, not something that fits between two flights.
 */
export const LAYOVER_COMPATIBLE_BUDDY_CATEGORIES = [
  "city",
  "language",
  "arrival",
  "shopping",
] as const;

/** The certified answer to "may this session be offered a landside meeting?". */
export interface BuddySafetyGate {
  passed: boolean;
  /** The certified §9 verdict. Not re-derived here. */
  verdict: LayoverFeasibilityRecord["verdict"];
  usableMinutes: number;
  returnState: LayoverFeasibilityRecord["envelope"]["returnState"];
  /** The rules that produced the three fields above. */
  engineVersion: string;
}

/** What a high-risk layover REQUIRES of a buddy profile. */
export interface BuddyTrustRequirement {
  applied: boolean;
  reason: "tight_window" | null;
  /** Named so a client can explain the withholding instead of showing a gap. */
  requires: string[];
}

export interface LayoverBuddyDecision {
  safetyGate: BuddySafetyGate;
  trustRequirement: BuddyTrustRequirement;
}

/**
 * The gate, in the order §9.1 demands: safety first, everything else after.
 *
 * `passed` is false when the traveller cannot leave (`no`), has said they will
 * not (`stay_airside`), or is already on the escalation ladder — a person at
 * RETURN_SOON or beyond is heading for a gate, not for a meeting.
 *
 * ONE CERTIFICATION. The record is computed once here and every field below is
 * read off it, so the buddy list and the countdown on the same screen cannot
 * disagree about whether leaving is possible.
 */
export function layoverBuddyDecision(
  airport: AirportProfile,
  session: LayoverSession,
  nowMs: number = Date.now(),
): LayoverBuddyDecision {
  const record = certifySessionFeasibility(airport, session, { nowMs });
  const safetyGate: BuddySafetyGate = {
    passed:
      // A DENY-LIST, and `entry_unverified` is deliberately not on it: it means
      // the border could not be checked, not that the traveller is refused, and
      // the advice they hold says so in words. A verdict added later passes by
      // default here — check this list when the union grows.
      record.verdict !== "no" &&
      record.verdict !== "stay_airside" &&
      record.envelope.returnState === "NORMAL",
    verdict: record.verdict,
    usableMinutes: record.envelope.usableMinutes,
    returnState: record.envelope.returnState,
    engineVersion: record.engineVersion,
  };
  // `tight` is the ENGINE's own word for a window with no slack (45-89 usable
  // minutes). Meeting a stranger in an unfamiliar city on a window that tight
  // is the marketplace interaction L254 calls high-risk, and using the engine's
  // verdict rather than a second threshold is what stops this rule drifting
  // away from the arithmetic it claims to follow.
  const tight = record.verdict === "tight";
  const trustRequirement: BuddyTrustRequirement = {
    applied: tight,
    reason: tight ? "tight_window" : null,
    requires: tight ? ["verified", "buddy_level_not_new"] : [],
  };
  return { safetyGate, trustRequirement };
}

/**
 * Does this profile positively declare a service a layover can use?
 *
 * An EMPTY declaration is an unknown, not a specialism: `categories` is
 * `text[] NOT NULL DEFAULT '{}'` (`migrations/0050_rent_a_buddy.sql:14`), so a
 * profile that has never been categorised carries `{}` and reading that as a
 * credential would be the fabrication this census keeps catching.
 */
export function isLayoverCompatibleBuddy(row: { categories?: unknown }): boolean {
  const cats = Array.isArray(row.categories) ? (row.categories as string[]) : [];
  return cats.some((c) => (LAYOVER_COMPATIBLE_BUDDY_CATEGORIES as readonly string[]).includes(c));
}

/**
 * L273's "strict boundaries": a profile that positively declares a DIFFERENT
 * service is not a layover service and is removed. A profile that declares
 * nothing is kept — and `isLayoverCompatibleBuddy` is published beside it so
 * the unknown is visible rather than dressed up as a specialism.
 */
export function filterLayoverCompatible<T extends { categories?: unknown }>(rows: T[]): T[] {
  return rows.filter((r) => {
    const cats = Array.isArray(r.categories) ? (r.categories as string[]) : [];
    return cats.length === 0 || isLayoverCompatibleBuddy(r);
  });
}

/**
 * L254's REQUIREMENT. A missing credential is not a credential: an absent
 * `verified` and an absent `buddy_level` both fail, in the one direction a
 * safety rule may fail.
 */
export function applyBuddyTrustRequirement<T extends { verified?: unknown; buddy_level?: unknown }>(
  rows: T[],
  requirement: BuddyTrustRequirement,
): T[] {
  if (!requirement.applied) return rows;
  return rows.filter(
    (r) => Boolean(r.verified) && typeof r.buddy_level === "string" && r.buddy_level !== "new",
  );
}
