/**
 * discoveryPeopleBuddy — Buddy ELIGIBILITY for Discovery's buddy resolver
 * (census-discovery B03; census-input-intelligence G71 / G283).
 *
 * THE REQUIREMENT
 * ===============
 * Global Input Intelligence §11 (the resolver table): *"Buddy — Service
 * category, availability, launch/safety/payment eligibility."* §20: *"Before
 * ranking, the system should remove or demote options that are infeasible or
 * inappropriate for the field … Unavailable Buddy category or required
 * safety/payment gate."*
 *
 * `searchTravelers(isBuddy)` in routes/discoverySearch.ts applied two
 * predicates: `profiles.buddy_verified_at IS NOT NULL` and — behind
 * `discovery_buddy_launch_gate_enabled` (2360, seeded FALSE) — the marketplace
 * launch switch. It never looked at the marketplace row at all, so a verified
 * buddy whom Rent-a-Buddy had SUSPENDED, put on a risk hold, or who offered no
 * service they were approved for, was still suggested as a Buddy.
 *
 * THIS MODULE CONSUMES THE OWNING DOMAIN'S RULES; IT DOES NOT INVENT ONE
 * ======================================================================
 * Every predicate below is the one Rent-a-Buddy already applies somewhere, and
 * the place is named so a drift can be checked. The drift guard in
 * src/test/discoveryPeopleBuddy.test.ts reads those source lines and goes red
 * if the domain's rule text moves out from under this mirror.
 *
 *   SAFETY (listing standing)
 *     status = 'active' AND admin_status = 'active'
 *         — the marketplace's own search (routes/rentABuddy.ts, the two
 *           `.eq("status", "active").eq("admin_status", "active")` reads) and
 *           the Wall's opportunity loader (services/wall/WallCandidateLoaders.ts).
 *     risk_hold ≠ true — the Wall loader and Compass's buddy candidates.
 *     risk_review_status ∉ {suspended, under_review} — the eligibility check in
 *         routes/rentABuddy.ts (`account_suspended` / `account_under_review`).
 *     rent_buddy_user_limits.rent_buddy_disabled / buddy_disabled — the admin
 *         restriction written by routes/rentABuddy.ts's limits endpoint.
 *
 *   CATEGORY ("approved categories only")
 *     A declared category is OFFERABLE unless the booking gate would refuse it:
 *       • nightlife / group need `category_approvals[c]` truthy
 *         (enforceBookingCreationGates: `if (!approvals[category])`);
 *       • nightlife also needs `nightlife_admin_approved`;
 *       • a HIGH-risk category (lib/rentaBuddyScanner.ts CATEGORY_RISK_LEVELS)
 *         needs the buddy verified — `verification_status = 'verified'` or
 *         `id_verified && phone_verified`, the gate's own disjunction;
 *       • `nightlife_disabled` in the buddy's limits removes nightlife.
 *     A buddy with NO offerable category offers nothing bookable and is not a
 *     Buddy suggestion. When the request ASKS for a category, the buddy must be
 *     approved for that one.
 *
 *   AVAILABILITY
 *     The owning domain treats an UNSET date as bookable: booking creation and
 *     rebook refuse only on an explicit `rent_buddy_availability` row with
 *     `is_available = false`, or on a `buddy_availability_exceptions` range
 *     covering the date (`findBlockingAvailabilityException`). Requiring a
 *     declared window here would make Discovery refuse buddies the booking path
 *     accepts, which is the opposite untruth. So availability is applied
 *     against an ASKED window — the time intent the search already parses
 *     ("tonight", "this weekend", …), which events and trips already apply as
 *     a hard filter — and a buddy is available in it when at least one of its
 *     dates is not blocked by a window the buddy set. With no asked window
 *     there is no availability question to answer, and none is invented.
 *
 *   PAYMENT — NOT BUILT, AND NOT FAKED
 *     There is no payment processor (docs/specs/discovery-v1/09_Payment_
 *     Architecture.md §1: "real payouts" are "Do later"). No column says a
 *     buddy can be paid, so no predicate here pretends to. What it needs is a
 *     per-buddy payout-readiness state written by a processor integration.
 *
 * FAIL-CLOSED, AND SAYS SO
 * ========================
 * Any read that fails returns `{ ok: false, relation, error }`. The caller
 * throws DiscoverySearchReadError, which withholds every buddy AND tells the
 * client a source failed (`type=buddies` → refusal; `type=all` and the suggest
 * fan-out → `partial` naming `buddies`). A buddy whose standing could not be
 * read is never served on the strength of a missing row.
 */
import { getCategoryRiskLevel } from "./rentaBuddyScanner.js";

// ── The ask ──────────────────────────────────────────────────────────────────

/**
 * The buddy service categories the marketplace knows: the risk table's keys
 * plus `group`, which the booking gate names although the risk table does not.
 */
export const BUDDY_SERVICE_CATEGORIES: ReadonlySet<string> = new Set([
  "arrival", "nightlife", "adventure", "wellness", "city", "language", "food",
  "shopping", "culture", "content", "nature", "other", "group",
]);

/** What the request asked of a buddy. Both halves are optional. */
export interface BuddyAsk {
  /** A buddy service category the request names, or null. */
  readonly category: string | null;
  /** The calendar dates (YYYY-MM-DD) of the asked window, or null for none. */
  readonly dates: readonly string[] | null;
}

export const NO_BUDDY_ASK: BuddyAsk = { category: null, dates: null };

/** The widest asked window enumerated. `next_week` is the longest intent (7 days). */
const MAX_ASK_DAYS = 31;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Derive the ask from the search context the route already builds.
 *
 *  - `intentCategory` counts only when it names a buddy SERVICE. `beach` is an
 *    intent the client can send and no buddy offers; it constrains nothing
 *    rather than excluding everyone.
 *  - The window is the time intent's half-open instant range mapped to UTC
 *    calendar days — the same `.slice(0, 10)` day mapping the trips arm of
 *    this search applies, and the same UTC `today` the marketplace's own
 *    availability reads use. A one-sided or oversized window is not
 *    enumerated.
 */
export function buddyAskFrom(ctx?: {
  intentCategory?: string | null;
  startsAfter?: string | null;
  startsBefore?: string | null;
} | null): BuddyAsk {
  const rawCat = typeof ctx?.intentCategory === "string" ? ctx.intentCategory.trim().toLowerCase() : "";
  const category = BUDDY_SERVICE_CATEGORIES.has(rawCat) ? rawCat : null;

  let dates: string[] | null = null;
  const a = ctx?.startsAfter ? Date.parse(ctx.startsAfter) : NaN;
  const b = ctx?.startsBefore ? Date.parse(ctx.startsBefore) : NaN;
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
    const first = isoDay(a);
    const last = isoDay(b - 1); // half-open: an instant AT midnight ends the previous day
    const out: string[] = [];
    for (let t = Date.parse(`${first}T00:00:00.000Z`); ; t += 86_400_000) {
      const d = isoDay(t);
      out.push(d);
      if (d >= last || out.length > MAX_ASK_DAYS) break;
    }
    dates = out.length > MAX_ASK_DAYS ? null : out;
  }
  return { category, dates };
}

// ── The rule, pure ───────────────────────────────────────────────────────────

/** The `rent_buddy_profiles` columns this rule reads. Never a coordinate. */
export interface BuddyMarketplaceRow {
  id: string;
  user_id: string;
  categories?: unknown;
  category_approvals?: unknown;
  nightlife_admin_approved?: boolean | null;
  status?: string | null;
  admin_status?: string | null;
  risk_hold?: boolean | null;
  risk_review_status?: string | null;
  verification_status?: string | null;
  id_verified?: boolean | null;
  phone_verified?: boolean | null;
}

/** The `rent_buddy_user_limits` columns this rule reads. */
export interface BuddyLimitsRow {
  user_id: string;
  rent_buddy_disabled?: boolean | null;
  buddy_disabled?: boolean | null;
  nightlife_disabled?: boolean | null;
}

/** The windows a buddy SET that close a date: explicit "not available" rows and exception ranges. */
export interface BuddyBlockedWindows {
  /** Dates with a `rent_buddy_availability` row whose `is_available` is false. */
  readonly unavailableDates: ReadonlySet<string>;
  /** `buddy_availability_exceptions` rows (vacation / blocked). */
  readonly exceptions: ReadonlyArray<{ exception_date: string; end_date: string | null }>;
}

export const BUDDY_INELIGIBLE_REASONS = [
  "no_marketplace_profile",
  "not_listed",
  "admin_restricted",
  "risk_hold",
  "risk_review",
  "buddy_disabled",
  "no_approved_category",
  "category_not_approved",
  "unavailable_in_window",
] as const;
export type BuddyIneligibleReason = (typeof BUDDY_INELIGIBLE_REASONS)[number];

export type BuddyEligibility =
  | { eligible: true; approvedCategories: string[] }
  | { eligible: false; reason: BuddyIneligibleReason };

/** Risk-review states the marketplace's own eligibility check refuses. */
const RISK_REVIEW_REFUSED: ReadonlySet<string> = new Set(["suspended", "under_review"]);
/** Categories the booking gate requires a per-category approval for. */
const APPROVAL_REQUIRED: ReadonlySet<string> = new Set(["nightlife", "group"]);

function buddyIsVerified(row: BuddyMarketplaceRow): boolean {
  return row.verification_status === "verified" || (row.id_verified === true && row.phone_verified === true);
}

/** The declared categories this buddy may actually be booked for. Order and case are normalised. */
export function approvedBuddyCategories(row: BuddyMarketplaceRow, limits: BuddyLimitsRow | null): string[] {
  const declared = Array.isArray(row.categories) ? row.categories : [];
  const approvals = (row.category_approvals && typeof row.category_approvals === "object")
    ? row.category_approvals as Record<string, unknown>
    : {};
  const out: string[] = [];
  for (const raw of declared) {
    if (typeof raw !== "string") continue;
    const c = raw.trim().toLowerCase();
    if (!c || out.includes(c)) continue;
    if (c === "nightlife" && limits?.nightlife_disabled === true) continue;
    if (APPROVAL_REQUIRED.has(c) && !approvals[c]) continue;
    if (c === "nightlife" && row.nightlife_admin_approved !== true) continue;
    if (getCategoryRiskLevel(c) === "high" && !buddyIsVerified(row)) continue;
    out.push(c);
  }
  return out;
}

function dateBlocked(d: string, w: BuddyBlockedWindows): boolean {
  if (w.unavailableDates.has(d)) return true;
  // findBlockingAvailabilityException's rule, verbatim: a single-day exception
  // when end_date is null, an inclusive range otherwise.
  return w.exceptions.some((ex) =>
    ex.exception_date <= d && (ex.end_date == null ? ex.exception_date === d : ex.end_date >= d));
}

/**
 * One buddy's eligibility. `row` null ⇒ the verified profile has no
 * marketplace row, so it offers no service.
 */
export function buddyEligibility(
  row: BuddyMarketplaceRow | null,
  limits: BuddyLimitsRow | null,
  windows: BuddyBlockedWindows | null,
  ask: BuddyAsk,
): BuddyEligibility {
  if (!row) return { eligible: false, reason: "no_marketplace_profile" };
  // Safety, first: a restricted buddy is withheld whatever they offer.
  if (row.status !== "active") return { eligible: false, reason: "not_listed" };
  if (row.admin_status !== "active") return { eligible: false, reason: "admin_restricted" };
  if (row.risk_hold === true) return { eligible: false, reason: "risk_hold" };
  if (typeof row.risk_review_status === "string" && RISK_REVIEW_REFUSED.has(row.risk_review_status)) {
    return { eligible: false, reason: "risk_review" };
  }
  if (limits?.rent_buddy_disabled === true || limits?.buddy_disabled === true) {
    return { eligible: false, reason: "buddy_disabled" };
  }
  // Category.
  const approvedCategories = approvedBuddyCategories(row, limits);
  if (approvedCategories.length === 0) return { eligible: false, reason: "no_approved_category" };
  if (ask.category !== null && !approvedCategories.includes(ask.category)) {
    return { eligible: false, reason: "category_not_approved" };
  }
  // Availability, against the asked window only.
  if (ask.dates !== null && ask.dates.length > 0) {
    const w = windows ?? { unavailableDates: new Set<string>(), exceptions: [] };
    if (ask.dates.every((d) => dateBlocked(d, w))) return { eligible: false, reason: "unavailable_in_window" };
  }
  return { eligible: true, approvedCategories };
}

// ── The reads ────────────────────────────────────────────────────────────────

export type BuddyEligibilityRead =
  | { ok: true; ineligible: ReadonlyMap<string, BuddyIneligibleReason> }
  | { ok: false; relation: string; error: unknown };

type Resolved = { data: unknown; error: unknown };

async function settle(p: PromiseLike<Resolved>): Promise<Resolved> {
  try {
    return await p;
  } catch (error) {
    // A REJECTED read is a failed read, never an empty one.
    return { data: null, error: error ?? new Error("read rejected") };
  }
}

/**
 * Read the marketplace facts for `userIds` (profile ids that passed
 * `buddy_verified_at`) and decide each one. Every `.from()` and select list is
 * a literal at its call site so the column checker can read it.
 */
export async function readBuddyEligibility(
  sc: any,
  userIds: readonly string[],
  ask: BuddyAsk,
): Promise<BuddyEligibilityRead> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return { ok: true, ineligible: new Map() };

  const [profilesQ, limitsQ] = await Promise.all([
    settle(sc.from("rent_buddy_profiles")
      .select("id, user_id, categories, category_approvals, nightlife_admin_approved, status, admin_status, risk_hold, risk_review_status, verification_status, id_verified, phone_verified")
      .in("user_id", ids)),
    settle(sc.from("rent_buddy_user_limits")
      .select("user_id, rent_buddy_disabled, buddy_disabled, nightlife_disabled")
      .in("user_id", ids)),
  ]);
  if (profilesQ.error) return { ok: false, relation: "rent_buddy_profiles", error: profilesQ.error };
  if (limitsQ.error) return { ok: false, relation: "rent_buddy_user_limits", error: limitsQ.error };

  const rowByUser = new Map<string, BuddyMarketplaceRow>();
  for (const r of (Array.isArray(profilesQ.data) ? profilesQ.data : []) as BuddyMarketplaceRow[]) {
    if (r && typeof r.user_id === "string") rowByUser.set(r.user_id, r);
  }
  const limitsByUser = new Map<string, BuddyLimitsRow>();
  for (const r of (Array.isArray(limitsQ.data) ? limitsQ.data : []) as BuddyLimitsRow[]) {
    if (r && typeof r.user_id === "string") limitsByUser.set(r.user_id, r);
  }

  // Windows are read only when the request asked about a window, and only for
  // buddies that could otherwise be served.
  const windowsByBuddy = new Map<string, { unavailableDates: Set<string>; exceptions: Array<{ exception_date: string; end_date: string | null }> }>();
  const askedDates = ask.dates !== null && ask.dates.length > 0 ? ask.dates : null;
  if (askedDates) {
    const buddyIds = [...rowByUser.values()].map((r) => r.id).filter(Boolean);
    if (buddyIds.length > 0) {
      const lastDay = [...askedDates].sort().at(-1)!;
      const [availQ, excQ] = await Promise.all([
        settle(sc.from("rent_buddy_availability")
          .select("buddy_id, date, is_available")
          .in("buddy_id", buddyIds)
          .in("date", [...askedDates])),
        settle(sc.from("buddy_availability_exceptions")
          .select("buddy_id, exception_date, end_date")
          .in("buddy_id", buddyIds)
          .lte("exception_date", lastDay)),
      ]);
      if (availQ.error) return { ok: false, relation: "rent_buddy_availability", error: availQ.error };
      if (excQ.error) return { ok: false, relation: "buddy_availability_exceptions", error: excQ.error };
      const slot = (id: string) => {
        let w = windowsByBuddy.get(id);
        if (!w) { w = { unavailableDates: new Set(), exceptions: [] }; windowsByBuddy.set(id, w); }
        return w;
      };
      for (const r of (Array.isArray(availQ.data) ? availQ.data : []) as any[]) {
        if (r && r.is_available === false && typeof r.date === "string") slot(String(r.buddy_id)).unavailableDates.add(r.date);
      }
      for (const r of (Array.isArray(excQ.data) ? excQ.data : []) as any[]) {
        if (r && typeof r.exception_date === "string") {
          slot(String(r.buddy_id)).exceptions.push({
            exception_date: r.exception_date,
            end_date: typeof r.end_date === "string" ? r.end_date : null,
          });
        }
      }
    }
  }

  const ineligible = new Map<string, BuddyIneligibleReason>();
  for (const uid of ids) {
    const row = rowByUser.get(uid) ?? null;
    const verdict = buddyEligibility(
      row,
      limitsByUser.get(uid) ?? null,
      row ? (windowsByBuddy.get(row.id) ?? null) : null,
      ask,
    );
    if (!verdict.eligible) ineligible.set(uid, verdict.reason);
  }
  return { ok: true, ineligible };
}
