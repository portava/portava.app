/**
 * Trips spec §24 Phase 0 — the inventory of direct writers to the Trip
 * aggregate's canonical tables, and §24 Phase 1's ratchet baseline.
 *
 * Read by checkTripKernelWriters.ts. A file not listed here that writes one of
 * CANONICAL_TRIP_TABLES fails the check; a listed file whose count grows fails
 * the check. Counts may only go DOWN, as writers move to lib/tripKernel.ts.
 *
 * TWO NUMBERS PER FILE
 * ====================
 *   direct   every literal `.from("<canonical>").insert|update|upsert|delete`
 *            in the file — the Phase 0 inventory. This is the number that was
 *            47 on 2026-09-07 and it does NOT shrink when a writer is
 *            flag-gated, because the flag-off path keeps the direct write.
 *   ungated  the subset of `direct` that has NO kernel path: a write is
 *            "gated" only when it is annotated `trip-kernel:legacy-path` in
 *            the statement's leading comment AND the file imports
 *            lib/tripKernel. The annotation is the writer's own claim that a
 *            command exists for it; the check refuses the annotation in a file
 *            that never calls the kernel. This is the number the ratchet
 *            exists for. When it reaches zero, the flag can be flipped and the
 *            legacy writes deleted, at which point `direct` falls too.
 *
 * SURVEYED 2026-09-07 on claude/portava-continuation-uqta94 by
 * `check:trip-kernel-writers --print-baseline`. 47 direct writes in 18 files;
 * 8 of them ungated (was 40 before the trip and participant families landed
 * in migration 2450, 32 before routes/trips-expansion.ts and routes/requests.ts
 * were gated in the third pass, 22 before the satellite plan-item writers in
 * routes/plan.ts, routes/tripReservations.ts, routes/telegraphChat.ts,
 * routes/hiddenGems.ts, routes/compass.ts, routes/airport.ts, routes/admin.ts,
 * compass/CompassAutopilotEngine.ts, lib/visuals/service.ts and
 * services/hiddenGems/HiddenGemService.ts were gated in the fourth pass).
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
 * Fourteen files consult the kernel at all, and only when trip_kernel_enabled
 * is TRUE; with the flag FALSE (its seeded value) every `direct` count below
 * is live:
 *
 *   routes/trips-expansion.ts  ALL 7 kernel-gated: settings (UPDATE_TRIP),
 *                        cancel / complete / archive / delete (CANCEL_TRIP /
 *                        COMPLETE_TRIP / ARCHIVE_TRIP x2), join-request approve
 *                        (ADD_PARTICIPANT or SET_PARTICIPANT_ROLE after reading
 *                        the row; `host` capability, migration 2500), invite-link
 *                        join (JOIN_VIA_LINK; `link_holder` capability, 2500 —
 *                        the actor is the joiner).
 *   routes/requests.ts   ALL 3 kernel-gated: accept (ACCEPT_INVITE), decline
 *                        (DECLINE_INVITE), cancel (REMOVE_PARTICIPANT).
 *
 *   routes/trips.ts      ALL 14 of its writes are kernel-gated (contract v2,
 *                        migration 2450): 6 plan-item writes (ADD_PLAN,
 *                        UPDATE_PLAN/MOVE_PLAN/CONFIRM_PLAN/CANCEL_PLAN/
 *                        COMPLETE_ACTIVITY, REMOVE_PLAN x2, REORDER_PLAN x2),
 *                        trip create (CREATE_TRIP), trip patch (UPDATE_TRIP),
 *                        invite (INVITE_PARTICIPANT), accept (ACCEPT_INVITE),
 *                        decline (DECLINE_INVITE), add member
 *                        (ADD_PARTICIPANT / SET_PARTICIPANT_ROLE), remove
 *                        member (REMOVE_PARTICIPANT).
 *   routes/routePlan.ts  its 1 write (route_stop_id link on accept) is
 *                        kernel-gated when the plan is attached to a trip.
 *   routes/plan.ts       BOTH gated (fourth pass): meetup / place add-to-trip-plan
 *                        -> ADD_PLAN (crew).
 *   routes/tripReservations.ts  gated: confirm + addToPlan -> ADD_PLAN (crew).
 *   routes/telegraphChat.ts     gated: suggestion add-to-plan -> ADD_PLAN (crew).
 *   routes/hiddenGems.ts        gated: gem add-to-plan -> ADD_PLAN (crew). The
 *                        ONLY writer whose kernel row needs migration 2590
 *                        (added_by / description / city / country).
 *   routes/compass.ts    gated: proposal confirm -> ADD_PLAN (crew).
 *   compass/CompassAutopilotEngine.ts  gated: applyProposal's per-item update
 *                        -> MOVE_PLAN / UPDATE_PLAN / CONFIRM_PLAN / CANCEL_PLAN /
 *                        COMPLETE_ACTIVITY (planCommandTypeForPatch), crew, the
 *                        actor is the proposal's OWNER (applied on their behalf),
 *                        key autopilot:<proposal>:<item>.
 *   lib/visuals/service.ts  gated: finalizeVisual's trips.cover_url
 *                        -> SET_TRIP_COVER (system actor — a pipeline completing,
 *                        nobody asked at that moment), key visual:<job>.
 *   routes/airport.ts    ALL 3 gated: the layover mirror -> UPDATE_PLAN when the
 *                        mirror row exists, ADD_PLAN when not (crew, fresh key —
 *                        the mirror is not idempotent today either); POST
 *                        /sessions/:id/plan -> ADD_PLAN (crew).
 *   routes/admin.ts      2 of 3 gated: hide-content (trip) and /trips/:id/hide
 *                        -> ADMIN_HIDE_TRIP (admin: actor_role 'admin' AND
 *                        profiles.role = 'admin', which is exactly requireAdmin's
 *                        DEFAULT_ROLES). The reminder reset stays direct (below).
 *   services/hiddenGems/HiddenGemService.ts  gated: submitGem's trip attach
 *                        -> ADD_PLAN (crew, actor = the submitter; the route
 *                        checked trip + membership first), key gem:<id>:attach.
 *
 * Every satellite sends location_is_private explicitly (the table default the
 * direct insert relies on), so the kernel row equals the legacy row under a
 * 2500 function as well as a 2590 one (src/test/tripKernelSatellites.test.ts,
 * which also pins the flag-off legacy write of every satellite byte for byte).
 *
 * Everything else is a legacy direct write with no kernel path. The command
 * each one needs now EXISTS (2450 / 2500 / 2590); the lane report names the
 * change per site. One of the remaining sites has a WRITTEN conversion that
 * was handed over unstaged because another lane owns the file (fourth-pass
 * report): routes/events.ts (ADD_PLAN, crew, creator_id stamped by the kernel
 * where the insert leaves it NULL).
 *
 * CLASSIFIED OUT OF THE AGGREGATE, NOT MIGRATED
 * =============================================
 *   lib/tripReminderScheduler.ts (3) and routes/admin.ts's reminder reset (1
 *   of its 3) write trips.reminder_sent_at / reminder_retry_count /
 *   reminder_delivered_at — scheduler claim columns (compare-and-set,
 *   at-most-once delivery), not aggregate state. The reason is not "they are
 *   infrastructure": trips.version is a CLIENT CONCURRENCY TOKEN (§18.3/§18.4,
 *   If-Match), so a kernel command per reminder would bump it on every send
 *   and hand every client holding a version a spurious TRIP_VERSION_CONFLICT
 *   for a change it can neither see nor care about. Compare-and-set claim
 *   columns do not belong in an aggregate whose version means "the trip
 *   changed". They stay direct until those three columns move off `trips`
 *   into a sidecar table, which is the change that removes them from this
 *   inventory. Owner decision recorded 2026-09-07 (fourth pass); do not
 *   re-litigate without moving the columns.
 *
 *   services/contentTranslation.ts (1) writes trips.original_language from
 *   language detection — a DERIVED column (a function of title/notes), not a
 *   state change a client should see as a version bump. Same classification.
 *
 *   services/appeals/resolveAppeal.ts (2) — NOT BUILT, owner decision
 *   APPEAL_RESTORE_SEMANTICS: 'trip_membership' UPDATEs trip_members SET
 *   role='member' for a row REMOVE_PARTICIPANT (and the legacy delete) has
 *   DELETED, so an approved appeal for a removed member restores nothing
 *   today; 'trip' UPDATEs trips SET status='planning', which does not undo
 *   ADMIN_HIDE_TRIP (visibility) and would exit a terminal cancelled /
 *   archived state the kernel refuses. The commands these need
 *   (ADMIN_RESTORE_PARTICIPANT re-inserting a row; ADMIN_RESTORE_TRIP restoring
 *   visibility) do not exist and what "restore" means is a product decision.
 */

/** The Trip aggregate's own rows (Trips spec §2.2). */
export const CANONICAL_TRIP_TABLES = ["trips", "trip_members", "trip_plan_items"] as const;

/**
 * The comment token that marks a direct write as the flag-off twin of a kernel
 * command. It must appear in the statement's leading comment, i.e. after the
 * previous `;` and before the `.from(`.
 */
export const LEGACY_PATH_MARKER = "trip-kernel:legacy-path";

export interface WriterBaseline {
  /** All literal direct writes (Phase 0 inventory). */
  direct: number;
  /** Direct writes with no kernel path (the Phase 1 ratchet). */
  ungated: number;
}

export const TRIP_KERNEL_DIRECT_WRITERS: Record<string, WriterBaseline> = {
  "compass/CompassAutopilotEngine.ts":     { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): applyProposal update -> MOVE_PLAN / UPDATE_PLAN / ... (crew, actor = proposal owner)
  "lib/tripReminderScheduler.ts":          { direct: 3, ungated: 3 }, // reminder bookkeeping columns (not aggregate state; see header)
  "lib/visuals/service.ts":                { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): finalizeVisual cover_url -> SET_TRIP_COVER (system)
  "routes/admin.ts":                       { direct: 3, ungated: 1 }, // 2 x visibility hide KERNEL-GATED (fourth pass) -> ADMIN_HIDE_TRIP (admin); 1 x reminder reset (not aggregate state; see header)
  "routes/airport.ts":                     { direct: 3, ungated: 0 }, // ALL KERNEL-GATED (fourth pass): mirror -> UPDATE_PLAN / ADD_PLAN; session plan -> ADD_PLAN (crew)
  "routes/compass.ts":                     { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): proposal confirm -> ADD_PLAN (crew)
  "routes/events.ts":                      { direct: 1, ungated: 1 }, // -> ADD_PLAN
  "routes/hiddenGems.ts":                  { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): -> ADD_PLAN (crew); needs 2590 for added_by/description/city/country
  "routes/plan.ts":                        { direct: 2, ungated: 0 }, // BOTH KERNEL-GATED (fourth pass): meetup / place add-to-trip-plan -> ADD_PLAN (crew)
  "routes/requests.ts":                    { direct: 3, ungated: 0 }, // ALL KERNEL-GATED (contract v2): accept -> ACCEPT_INVITE; decline -> DECLINE_INVITE; cancel -> REMOVE_PARTICIPANT
  "routes/routePlan.ts":                   { direct: 1, ungated: 0 }, // KERNEL-GATED (legacy path kept for flag-off / detached plans)
  "routes/telegraphChat.ts":               { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): suggestion add-to-plan -> ADD_PLAN (crew)
  "routes/tripReservations.ts":            { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): confirm + addToPlan -> ADD_PLAN (crew)
  "routes/trips-expansion.ts":             { direct: 7, ungated: 0 }, // ALL KERNEL-GATED: settings -> UPDATE_TRIP; cancel/complete/archive/delete -> CANCEL_TRIP/COMPLETE_TRIP/ARCHIVE_TRIP x2; join approve -> ADD_PARTICIPANT / SET_PARTICIPANT_ROLE (host, 2500); invite-link join -> JOIN_VIA_LINK (link_holder, 2500)
  "routes/trips.ts":                       { direct: 14, ungated: 0 }, // ALL KERNEL-GATED (contract v2)
  "services/appeals/resolveAppeal.ts":     { direct: 2, ungated: 2 }, // NOT BUILT — owner decision APPEAL_RESTORE_SEMANTICS (see header)
  "services/contentTranslation.ts":        { direct: 1, ungated: 1 }, // single-quoted .from('trips') — original_language (derived column, classified out; see header)
  "services/hiddenGems/HiddenGemService.ts": { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): submitGem trip attach -> ADD_PLAN (crew); needs 2590
};
