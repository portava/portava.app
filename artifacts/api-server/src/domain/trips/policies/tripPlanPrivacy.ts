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
