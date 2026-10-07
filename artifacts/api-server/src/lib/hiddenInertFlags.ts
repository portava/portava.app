/**
 * The ONE list of feature flags that are seeded (or were) but that nothing
 * reads, and the ONE guard every admin flag writer applies (verifier F9,
 * 2026-10-06).
 *
 * Hidden from every admin list, refused by every admin route that can write
 * `feature_flags`, and filtered out of the client flag bundle
 * (routes/featureFlags.ts):
 *   - routes/admin.ts           PATCH /admin/feature-flags/:flag and /metadata
 *   - routes/adminVisuals.ts    PUT /admin/feature-flags/:flag,
 *                               PATCH /admin/visuals/feature-flags/:flag
 *   - routes/adminCompass.ts    PATCH /admin/compass/frontload-rules (an upsert:
 *                               it could re-create a deleted row)
 * Moved here verbatim from routes/admin.ts, where it was the admin-only copy;
 * routes/featureFlags.ts kept a second, hand-copied list. Two lists drift, and a
 * writer that is not on either is a lever that does nothing.
 *
 * See scripts/check-flag-polarity.mjs INERT_SEEDED_FLAGS for each flag's recorded intent.
 */
// Flags that are seeded but have no code readers — hiding them prevents an
// operator from toggling a switch that does nothing during an incident and
// mistaking silence for the feature being stopped.
export const HIDDEN_INERT_FLAGS: ReadonlySet<string> = new Set([
  // Retired 2026-09-16 by 2962_retire_unread_sensing_flags.sql. Seeded FALSE by
  // 2956 and read by nothing: their readers on the source branch both depended on
  // a credential module the port rejected, and lib/sensingAuthPosture.ts forbids
  // any runtime flag from flipping the sensing posture at all. Hidden here as well
  // as deleted, so the surface behaves identically on a database where 2962 has
  // not been applied yet -- the pairing 0209/4d5cc1f4e used for the freeze flags.
  "intel_sensing_credentials_enabled",
  "intel_sensing_device_enrollment_enabled",

  "freeze_city",
  "freeze_event",
  "freeze_circle",
  "freeze_booking",

  // Retired 2026-08-12 by 2080_retire_inert_seeded_flags.sql. Every one of the
  // ten was seeded by an `INSERT INTO public.feature_flags`, which the seed
  // scanner in scripts/check-flag-polarity.mjs did not match until 2026-08-12 —
  // so none of them was ever subject to the "seeded flags must be read or
  // declared" rule, and all ten reached an operator-visible toggle surface
  // gating nothing.
  //
  // The wire-or-drop pass required a LIVE READ to keep a flag: a branch that
  // consults it and changes behaviour. None of the ten has one. For the six
  // COMPASS_* that is despite compass/flags.ts loading every `COMPASS_%` row
  // into a Record on each request — being loaded is not being read, and no
  // caller asks isEnabled() for these six names. The four notification flags
  // had one reference, an admin write-map in routes/notifications.ts that set
  // them and never read them; that map now writes only push_notifications_enabled.
  //
  // They stay in this set after the rows are deleted, for the same reason the
  // freeze_* entries do: a PATCH for a deleted flag would otherwise fall
  // through to generic not-found handling, reading as "wrong URL" rather than
  // "this control does not exist", and these guards keep behaviour identical on
  // a database where the migration has not been applied yet.
  "COMPASS_FRONTLOAD_ENABLED",
  "COMPASS_ACTIVE_REWARD_ENABLED",
  "COMPASS_EXPLAIN_WHY_ENABLED",
  "COMPASS_ADMIN_CONTROLS_ENABLED",
  "COMPASS_ABUSE_DEFENSE_ENABLED",
  "COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED",
  "notifications_enabled",
  "notification_digests_enabled",
  "realtime_activity_enabled",
  "safety_notifications_enabled", "rent_buddy_allow_bookings_without_kyc", // retired 2026-10-06 by 3932 (N-1, owner: "No tester bypass"); read by nothing, so never offered as a lever
]);

export function isHiddenInertFlag(flag: string): boolean {
  return HIDDEN_INERT_FLAGS.has(flag);
}

/** Writes the 400 every admin flag writer answers for a hidden flag and returns true; false when the flag may be written. */
export function refuseHiddenInertFlag(
  res: { status(code: number): { json(body: unknown): unknown } },
  flag: string,
  action = "It cannot be toggled.",
): boolean {
  if (!HIDDEN_INERT_FLAGS.has(flag)) return false;
  res.status(400).json({
    error: "not_operational",
    message: `Flag '${flag}' has no implementation and is not exposed on the admin toggle surface. ${action}`,
  });
  return true;
}
