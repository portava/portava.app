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
 * ── THE NIGHT ARM (census-layover L254, wave W) ─────────────────────────────
 * The second high-risk trigger is a night layover. It is a function of the
 * certified record ALONE — the landside window the record certifies,
 * `[max(inputs.nowMs, earliestOutTime), hardReturnTime)`, read in the
 * AIRPORT's timezone against the engine's one night band (`isNightBandHour`,
 * 22:00–06:00). The record carries its own `nowMs`, so the arm reads no wall
 * clock; the shared fixture (`test/helpers/fakeLayoverDb.ts` `sessionRow`)
 * takes a pinned `nowMs` and the route suites pin `Date`, which is what kept
 * this arm out until now (a suite staged from `Date.now()` passed in the
 * morning and failed in the evening).
 *
 * The spec names neither the hours nor the action, so both are the
 * conservative reading and both are OWNER DECISIONS:
 *   LAYOVER_NIGHT_BAND_HOURS   — the engine's existing 22:00–06:00 band, and a
 *                                window that TOUCHES it counts (overlap, not
 *                                "arrives at night").
 *   LAYOVER_NIGHT_BUDDY_ACTION — the tight-window action: a verified, non-new
 *                                buddy is required. Not a block.
 * An unusable timezone or an unreadable window instant counts as night: the
 * one direction a safety rule may fail.
 */
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js"; import type { EntryEligibility } from "./layoverEntryGate.js"; import { landsideStatusOf, type LandsideStatus } from "./LayoverConstraints.js";
import { isNightBandHour } from "./LayoverSafetyEngine.js";
import { localHourMinute, isValidTimezone } from "./AirportTime.js";
import {
  certifySessionFeasibility,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";

/**
 * The layover-compatible slice of `rent_buddy_profiles.categories`.
 *
 * `layover` is an explicit specialist declaration in the marketplace.
 * Generic city, shopping and arrival services do not imply that specialism.
 * The declaration editors require a current live identity verification.
 * The traveller list independently rechecks identity, including revocation.
 * A profile flag alone cannot substitute for that verification.
 * Booking still uses the existing KYC, rollout, trust and payment gates.
 * Its server-owned context ties the requested slot to the certified deadline.
 * A missing category remains an unknown and is withheld from this offer.
 * Neither a declaration nor a safety gate asserts availability for a slot.
 *
 * `content` is excluded deliberately: a content shoot is a scheduled
 * production, not something that fits between two flights.
 */
export const LAYOVER_COMPATIBLE_BUDDY_CATEGORIES = [
  "layover",
  // Only the specialist category qualifies.
  // Other marketplace services retain their own categories.
  // Identity is checked by the caller, independently of this predicate.
] as const;

/** The certified answer to "may this session be offered a landside meeting?". */
export interface BuddySafetyGate {
  passed: boolean; bookingStartsAt: string; bookingEndsBy: string; timezone: string;
  /** The certified §9 verdict. Not re-derived here. */
  verdict: LayoverFeasibilityRecord["verdict"];
  usableMinutes: number;
  returnState: LayoverFeasibilityRecord["envelope"]["returnState"];
  /** The rules that produced the three fields above. */
  engineVersion: string; /** The record's three-valued landside gate (`landsideStatusOf`). `passed` can be true under `caution`: not forbidden is not confirmed. */ landside: LandsideStatus;
}

/** Why a layover is high-risk for a buddy meeting. Order is the order reported. */
export type BuddyTrustReason = "tight_window" | "night_window";

/** What a high-risk layover REQUIRES of a buddy profile. */
export interface BuddyTrustRequirement {
  applied: boolean;
  /** The FIRST of `reasons` (wire-compatible with clients that read one). */
  reason: BuddyTrustReason | null;
  /** Every arm that fired, `tight_window` before `night_window`. */
  reasons: BuddyTrustReason[];
  /** Named so a client can explain the withholding instead of showing a gap. */
  requires: string[];
}

export interface LayoverBuddyDecision {
  safetyGate: BuddySafetyGate;
  trustRequirement: BuddyTrustRequirement;
}

/**
 * THE GATE ITSELF, as a function of the certified record ALONE.
 *
 * `passed` is false when the traveller cannot leave (`no`), has said they will
 * not (`stay_airside`), or is already on the escalation ladder — a person at
 * RETURN_SOON or beyond is heading for a gate, not for a meeting.
 *
 * ── WHY IT IS SEPARATE FROM `layoverBuddyDecision` ──────────────────────────
 * `layoverBuddyDecision` takes an airport and a session because it may have to
 * CERTIFY. §14's crew surface already holds a certified record for every member
 * of a crew (`crewSolverMembers` → `certifyCrewMemberRecord`), and the crew
 * meet-gate needs the same predicate over the record it already has.
 *
 * Re-deriving the predicate there would make a SECOND answer to "may this
 * traveller be offered a landside meeting?", which is the exact defect L273
 * recorded on this surface. Re-certifying there would add a second derivation
 * of the same session's record in one request, which `layoverFeasibilityRecord`
 * pins against. So the predicate is named once and read from two places.
 */
export function buddySafetyGateFor(record: LayoverFeasibilityRecord): BuddySafetyGate {
  return {
    passed:
      // A DENY-LIST, and `entry_unverified` is deliberately not on it: it means
      // the border could not be checked, not that the traveller is refused, and
      // the advice they hold says so in words. A verdict added later passes by
      // default here — check this list when the union grows.
      record.verdict !== "no" && landsideStatusOf(record) !== "closed" && // the one gate read every surface shares — an unreadable or undeclared constraint closes it
      record.verdict !== "stay_airside" &&
      record.envelope.returnState === "NORMAL",
    verdict: record.verdict,
    usableMinutes: record.envelope.usableMinutes,
    returnState: record.envelope.returnState,
    engineVersion: record.engineVersion, landside: landsideStatusOf(record), bookingStartsAt:new Date(Math.max(record.inputs.nowMs,record.envelope.earliestOutTime.getTime())).toISOString(),bookingEndsBy:record.deadline.hardReturnTime.toISOString(),timezone:record.inputs.airport.timezone,
  };
}

/**
 * The gate, in the order §9.1 demands: safety first, everything else after.
 *
 * ONE CERTIFICATION. The record is computed once here and every field below is
 * read off it, so the buddy list and the countdown on the same screen cannot
 * disagree about whether leaving is possible.
 */
export function layoverBuddyDecision(
  airport: AirportProfile,
  session: LayoverSession,
  nowMs: number = Date.now(), /** The session owner's corridor (`resolveLayoverEntry`), as every certification takes it — census-discovery §65. Omitted = unresolved. */ entry?: EntryEligibility | null, /** census-discovery §81: the certified snapshot's record, when the caller read one; the gate then certifies nothing itself. */ certified?: LayoverFeasibilityRecord | null,
): LayoverBuddyDecision {
  const record = certified ?? certifySessionFeasibility(airport, session, { nowMs, entry });
  const safetyGate: BuddySafetyGate = buddySafetyGateFor(record);
  // `tight` is the ENGINE's own word for a window with no slack (45-89 usable
  // minutes). Meeting a stranger in an unfamiliar city on a window that tight
  // is the marketplace interaction L254 calls high-risk, and using the engine's
  // verdict rather than a second threshold is what stops this rule drifting
  // away from the arithmetic it claims to follow.
  const tight = record.verdict === "tight";
  // The night arm: the certified landside window touches the engine's night
  // band in the airport's own timezone. See the header for the definition and
  // the two owner decisions it stands in for.
  const night = isNightLayoverRecord(record);
  const reasons: BuddyTrustReason[] = [];
  if (tight) reasons.push("tight_window");
  if (night) reasons.push("night_window");
  const applied = reasons.length > 0;
  const trustRequirement: BuddyTrustRequirement = {
    applied,
    reason: reasons[0] ?? null,
    reasons,
    requires: applied ? ["verified", "buddy_level_not_new"] : [],
  };
  return { safetyGate, trustRequirement };
}

const HOUR_MS = 3_600_000;

/**
 * Does `[startMs, endMs)` touch the night band in `tz`'s local time?
 *
 * Half-open: a window ENDING at 22:00 local does not touch night; one ending at
 * 22:01 does. A window STARTING at 06:00 does not; one starting at 05:59 does.
 *
 * Walked at local hour boundaries (the only instants the band can change),
 * re-reading the hour from the clock at each so a DST jump cannot
 * desynchronise it. Any span longer than 18 hours contains a night hour in
 * every zone (the day part is 16 local hours, 17 across a DST fall-back), so
 * it answers without walking.
 *
 * FAIL CLOSED: an unusable zone, or a non-finite instant, is night.
 */
export function landsideWindowTouchesNight(tz: string | null | undefined, startMs: number, endMs: number): boolean {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return true;
  if (endMs <= startMs) return false; // no landside window: nothing to meet in (the gate refuses it anyway)
  if (typeof tz !== "string" || tz.length === 0 || !isValidTimezone(tz)) return true;
  if (endMs - startMs > 18 * HOUR_MS) return true;
  let t = startMs;
  while (t < endMs) {
    const { hour, minute } = localHourMinute(tz, new Date(t));
    if (isNightBandHour(hour)) return true;
    // next local hour boundary (zone offsets are whole minutes)
    t = t - (t % 60_000) + (60 - minute) * 60_000;
  }
  return false;
}

function instantMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") return new Date(v).getTime();
  return Number.NaN;
}

/**
 * L254's night arm, as a function of the certified record alone: the window
 * the record certifies for being landside, read at the record's own `nowMs`.
 * A record without those fields (hand-built, or from an older build) is night.
 */
export function isNightLayoverRecord(record: LayoverFeasibilityRecord): boolean {
  const nowMs = instantMs(record.inputs?.nowMs);
  const earliestOut = instantMs(record.envelope?.earliestOutTime);
  const hardReturn = instantMs(record.envelope?.hardReturnTime);
  return landsideWindowTouchesNight(record.inputs?.airport?.timezone, Math.max(nowMs, earliestOut), hardReturn);
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
 * nothing is withheld — `isLayoverCompatibleBuddy` requires the declaration,
 * and identity is independently checked before an offer is published.
 */
export function filterLayoverCompatible<T extends { categories?: unknown }>(rows: T[]): T[] {
  return rows.filter((r) => {
    const cats = Array.isArray(r.categories) ? (r.categories as string[]) : [];
    return cats.length > 0 && isLayoverCompatibleBuddy(r);
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
