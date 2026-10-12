/**
 * Trips spec §6.3 — the SIX privacy scopes a plan carries, and the two-value
 * `visibility` that is derived from one (census-trips TR116).
 *
 * WHAT WAS TRUE BEFORE THIS FILE
 * ==============================
 * `2770_trip_plans_spec_columns.sql` put §6.3's six values on
 * `trip_plan_items.privacy_scope`, tied `visibility` to it by CHECK
 * (`(visibility = 'public') = (privacy_scope = 'public')`), and 2772 made the
 * kernel DERIVE `visibility` from the scope on ADD_PLAN and UPDATE_PLAN and
 * refuse a patch that sets `visibility` directly. The storage has had six
 * values since. Every server writer still sent the two-value `visibility` and
 * no writer ever named a scope, so a member could express exactly two of the
 * six and the other four were unreachable from any client — the reason TR116
 * stayed W after 2770 landed.
 *
 * WHAT THIS FILE IS
 * =================
 * The vocabulary and the derivation, in ONE place, so the flag-off legacy
 * write and the kernel command cannot disagree about what a scope means. The
 * derivation here is character-for-character the CASE 2772 installs in
 * `trip_kernel_execute`; if the two ever diverge, a plan written with the flag
 * off and the same plan written with it on would be readable by different
 * people, which is the class of defect §3.3's flag-off twins exist to prevent.
 *
 * WHY THE DERIVATION AND NOT A SECOND CHOICE. `visibility` is not an
 * independent field a caller may set beside a scope: 2770's CHECK makes the
 * two disagree impossible, so a writer that took both could only ever be
 * refused by the database or be redundant. It is computed, never asked for.
 *
 * PURE. No client, no flag read, no I/O — the two callers (routes/trips.ts's
 * create and patch) hold the I/O and the refusals.
 */

/**
 * §6.3's six, in the migration's order. Lowercase, matching 2770's CHECK
 * (`trip_plan_items_privacy_scope_known`) exactly: an uppercase spelling is a
 * different string to the constraint and would be refused by the database
 * rather than quietly stored.
 */
export const TRIP_PLAN_PRIVACY_SCOPES = [
  "private",
  "selected_participants",
  "crew",
  "friends_nearby",
  "trip",
  "public",
] as const;

export type TripPlanPrivacyScope = (typeof TRIP_PLAN_PRIVACY_SCOPES)[number];

/**
 * 2770's column default, restated here because the legacy (flag-off) INSERT
 * names its columns explicitly and a caller that sends no scope must land on
 * the same value the kernel's `coalesce(v_payload->>'privacy_scope', 'crew')`
 * lands on.
 */
export const DEFAULT_TRIP_PLAN_PRIVACY_SCOPE: TripPlanPrivacyScope = "crew";

/** True only for one of §6.3's six. Never throws on a non-string. */
export function isTripPlanPrivacyScope(value: unknown): value is TripPlanPrivacyScope {
  return typeof value === "string" && (TRIP_PLAN_PRIVACY_SCOPES as readonly string[]).includes(value);
}

/**
 * The derivation 2772 installs in the kernel:
 *
 *   CASE WHEN privacy_scope = 'public' THEN 'public' ELSE 'members' END
 *
 * Every scope that is not `public` is `members`, INCLUDING the ones narrower
 * than the crew (`private`, `selected_participants`) and the one wider than it
 * but not public (`friends_nearby`). That is deliberate and it is what 2770's
 * CHECK permits: `visibility` is the deployed two-value column older readers
 * still use, and the only thing it can say about a narrower scope is "not
 * public". A narrower scope is ENFORCED by the reader that understands
 * `privacy_scope`, never by this two-value shadow — a reader that honours only
 * `visibility` must treat `members` as the widest audience it may serve, which
 * is what it did before §6.3 existed.
 */
export function visibilityForPrivacyScope(scope: TripPlanPrivacyScope): "public" | "members" {
  return scope === "public" ? "public" : "members";
}

/**
 * The inverse mapping 2770's backfill used, for a row written BEFORE 2770 was
 * applied and never updated since.
 *
 * `null` in, `null` out: a row whose `visibility` was not read is not a row
 * whose scope is `crew`. A caller that turned an unread column into a scope
 * would be inventing an audience.
 */
export function privacyScopeFromVisibility(visibility: string | null | undefined): TripPlanPrivacyScope | null {
  if (visibility === null || visibility === undefined) return null;
  return visibility === "public" ? "public" : "crew";
}

/**
 * census-trips §90 (TR116): the scopes a write door REFUSES, because no reader
 * could honour them.
 *
 * `selected_participants` means "the creator and the people they chose". No
 * table stores that choice: `trip_plan_participants` (2771) is self-service
 * ATTENDANCE — JOIN_PLAN takes no user id and any crew member may join any
 * plan — so reading it as the selection would let anyone admit themselves.
 * Accepting the scope would tell a person their plan is visible to the people
 * they picked while the API has no list of them. Refused with 422 until a
 * selection store exists (an owner decision, §90.5); a row that already
 * carries it is served to its creator only (privateAnchorAccess.ts).
 *
 * `private` is NOT here: the reader rule enforces it (creator only).
 */
export const UNENFORCEABLE_PRIVACY_SCOPES: ReadonlySet<TripPlanPrivacyScope> = new Set<TripPlanPrivacyScope>(["selected_participants"]);

export const PRIVACY_SCOPE_NOT_ENFORCED_REASON = "TRIP_PRIVACY_SCOPE_NOT_ENFORCED";

/**
 * The 422 body for a scope no reader can honour, or null when the scope may be written.
 * census-trips §95 (OD-1012-PRIV-5): `selected_participants` IS honoured once the selection store exists
 * (3727's trip_plan_item_audience). `selectionStore` is what the write door read of it: only `available`
 * lifts the refusal — absent (3727 unapplied) or unread keeps it.
 */
export function privacyScopeRefusal(scope: TripPlanPrivacyScope | null | undefined, selectionStore: "available" | "absent" | "unread" = "absent"): null | { error: "privacy_scope_not_supported"; reason: string; message: string } {
  if (scope === null || scope === undefined || !UNENFORCEABLE_PRIVACY_SCOPES.has(scope)) return null;
  if (scope === "selected_participants" && selectionStore === "available") return null;
  return {
    error: "privacy_scope_not_supported",
    reason: PRIVACY_SCOPE_NOT_ENFORCED_REASON,
    message: "Sharing a plan with selected people is not available yet. Choose \"private\" to keep it to yourself, or \"crew\" to share it with the trip.",
  };
}

// ── OD-1012-PRIV-5: who may move a scope, and in which direction (census-trips §95) ─────────────────────
//
// The owner, 2026-10-12: "Organizers may narrow a plan's visibility, but organizer status alone grants no
// access to someone else's private plan. ... Never widen visibility automatically."
//
// BREADTH: how many people a scope admits, as an ORDER. Each step admits everyone the step below admits:
//   private (the author) < selected_participants (author + chosen crew) < crew < trip / friends_nearby < public.
// `trip` and `friends_nearby` share a rank and are NOT comparable — §6.3 does not say either contains the other
// (friends nearby may be outside the trip; the trip's audience is not "friends") — so moving between them is
// neither narrowing nor allowed to a non-author. An UNKNOWN current scope is the most private there is: nothing
// is narrower than it, so a non-author cannot move it at all. The SQL twin is 3727's
// trip_plan_items_client_never_widens (the same CASE); the two must not diverge.

export const PRIVACY_SCOPE_BREADTH: Readonly<Record<TripPlanPrivacyScope, number>> = {
  private: 0,
  selected_participants: 1,
  crew: 2,
  friends_nearby: 3,
  trip: 3,
  public: 4,
};

/** True when `to` admits nobody `from` does not: the same scope, or strictly lower in the order. Unknown `from` → only itself. */
export function isNarrowingOrSameScope(from: unknown, to: TripPlanPrivacyScope): boolean {
  if (from === to) return true;
  if (!isTripPlanPrivacyScope(from)) return false;
  return PRIVACY_SCOPE_BREADTH[to] < PRIVACY_SCOPE_BREADTH[from];
}

export const PLAN_SCOPE_WIDENING_REFUSED_REASON = "TRIP_PLAN_SCOPE_WIDENING_REFUSED";
export const PLAN_AUDIENCE_AUTHOR_ONLY_REASON = "TRIP_PLAN_AUDIENCE_AUTHOR_ONLY";

/**
 * May `actorId` move this plan's scope from `current` to `next`? The AUTHOR may move it anywhere — widening is
 * their explicit act. Anyone else the edit gate admitted (the organizer) may only narrow, or leave it as it is.
 * Returns the refusal, or null.
 */
export function planScopeChangeRefusal(actorId: string, creatorId: string | null, current: unknown, next: TripPlanPrivacyScope): null | { reason: string; message: string } {
  if (creatorId !== null && creatorId === actorId) return null;
  if (isNarrowingOrSameScope(current, next)) return null;
  return {
    reason: PLAN_SCOPE_WIDENING_REFUSED_REASON,
    message: "Only the person who added this plan can make it visible to more people. You can make it more private.",
  };
}
