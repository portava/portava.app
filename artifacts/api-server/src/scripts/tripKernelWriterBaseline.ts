/**
 * Trips spec §24 Phase 0 — the inventory of direct writers to the Trip
 * aggregate's canonical tables, and §24 Phase 1's ratchet baseline.
 *
 * Read by checkTripKernelWriters.ts. A file not listed here that writes one of
 * CANONICAL_TRIP_TABLES fails the check; a listed file whose count grows fails
 * the check. Counts may only go DOWN, as writers move to lib/tripKernel.ts.
 *
 * SURVEYED 2026-09-07 on claude/portava-continuation-uqta94 by
 * `check:trip-kernel-writers --print-baseline`. 47 direct writes in 18 files.
 * This is a FLOOR: 38 files in src/ contain a non-literal `.from(expr)` and an
 * `.rpc()` that writes is invisible to a literal scan (the check prints them).
 *
 * The registry (docs/architecture/cross-cutting-obligations.md, "seven sites")
 * and the census (census-trips.md TR1) under-counted this surface: the registry
 * excluded routes/trips* by construction and both missed the single-quoted
 * writer in services/contentTranslation.ts and the writers in routes/plan.ts,
 * routes/events.ts, routes/hiddenGems.ts, routes/telegraphChat.ts,
 * routes/compass.ts, routes/routePlan.ts, lib/tripReminderScheduler.ts,
 * services/appeals/resolveAppeal.ts and services/hiddenGems/HiddenGemService.ts.
 *
 * WHICH OF THESE GO THROUGH THE KERNEL
 * ====================================
 * Only two files consult the kernel at all, and only when trip_kernel_enabled
 * is TRUE; with the flag FALSE (its seeded value) every count below is live:
 *
 *   routes/trips.ts      6 of its 14 writes (the plan-item handlers: create,
 *                        patch, remove, delete, reorder, batch reorder) are
 *                        kernel-gated. The other 8 — trip create/patch and the
 *                        six trip_members writes (invite, accept, decline, add,
 *                        change role, remove) — are still direct.
 *   routes/routePlan.ts  its 1 write (route_stop_id link on accept) is
 *                        kernel-gated when the plan is attached to a trip.
 *
 * Everything else is a legacy direct write with no kernel path. The lane
 * report names the change each needs.
 */

/** The Trip aggregate's own rows (Trips spec §2.2). */
export const CANONICAL_TRIP_TABLES = ["trips", "trip_members", "trip_plan_items"] as const;

export const TRIP_KERNEL_DIRECT_WRITERS: Record<string, number> = {
  "compass/CompassAutopilotEngine.ts": 1,   // trip_plan_items insert on proposal accept (Compass lane)
  "lib/tripReminderScheduler.ts": 3,        // trips reminder bookkeeping columns (not aggregate state)
  "lib/visuals/service.ts": 1,              // trips cover columns (Visuals lane)
  "routes/admin.ts": 3,                     // admin moderation writes to trips
  "routes/airport.ts": 3,                   // trip_plan_items from Layover (Layover lane)
  "routes/compass.ts": 1,                   // trip_plan_items (Compass lane)
  "routes/events.ts": 1,
  "routes/hiddenGems.ts": 1,
  "routes/plan.ts": 2,
  "routes/requests.ts": 3,                  // trip_members accept/decline/withdraw (Requests lane)
  "routes/routePlan.ts": 1,                 // KERNEL-GATED (legacy path kept for flag-off / detached plans)
  "routes/telegraphChat.ts": 1,
  "routes/tripReservations.ts": 1,
  "routes/trips-expansion.ts": 7,           // trips status/complete/settings, trip_members
  "routes/trips.ts": 14,                    // 6 KERNEL-GATED plan-item writes + 8 direct trip/member writes
  "services/appeals/resolveAppeal.ts": 2,
  "services/contentTranslation.ts": 1,      // single-quoted .from('trips') — missed by every double-quote grep
  "services/hiddenGems/HiddenGemService.ts": 1,
};
