/**
 * Trips spec §24 Phase 0 — the inventory of direct writers to the Trip
 * aggregate's canonical tables, and §24 Phase 1's ratchet baseline.
 *
 * Read by checkTripKernelWriters.ts. A file not listed here that writes one of
 * CANONICAL_TRIP_TABLES fails the check; a listed file whose count grows fails
 * the check. Counts may only go DOWN, as writers move to lib/tripKernel.ts.
 *
 * THREE NUMBERS PER FILE
 * ======================
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
 *   nonAggregate  the subset of `direct` annotated NON_AGGREGATE_MARKER with a
 *            declaration the check VERIFIED against the statement's own payload
 *            columns — writes that must stay outside the aggregate because a
 *            trips.version bump would be semantically wrong at that site. These
 *            are not ungated and they are not gated; they are out of scope, and
 *            the count is ratcheted so the exempt surface cannot grow silently.
 *
 * SURVEYED 2026-09-08 on claude/portava-continuation-uqta94 by
 * `check:trip-kernel-writers --print-baseline`. 47 direct writes in 18 files;
 * 41 kernel-gated, 5 declared non-aggregate, 1 ungated (was 8 ungated before
 * the fifth pass declared the five reminder / derived-column writes
 * non-aggregate per column and gated the appeal trip restore) (was 40 before the trip and participant families landed
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
 * DECLARED NON-AGGREGATE (fifth pass) — five writes, each named column by column
 * ============================================================================
 * These are annotated NON_AGGREGATE_MARKER at the statement, with the exact
 * `<table>.<column>` set they write. checkTripKernelWriters parses each
 * statement's own payload literal and refuses the declaration unless the
 * declared set EQUALS the written set, so none of these can grow a column
 * without failing the check. The argument is per site and lives in the file:
 *
 *   lib/tripReminderScheduler.ts (3)  trips.reminder_sent_at (claim),
 *     trips.reminder_retry_count (recovery CAS), trips.reminder_delivered_at
 *     (deliver). Two independent reasons, each sufficient. (a) trips.version is
 *     the CLIENT concurrency token (§18.3/§18.4, If-Match); an hourly push
 *     sweep bumping it would hand every crew member holding a version a
 *     TRIP_VERSION_CONFLICT for a change they cannot see. (b) All three are
 *     compare-and-set: `.is("reminder_sent_at", null)`,
 *     `.eq("reminder_retry_count", rawCount)`, `.is("reminder_delivered_at",
 *     null)`. trip_kernel_execute checks expected_trip_version and then applies
 *     UNCONDITIONALLY — it cannot carry those predicates, so a command here
 *     would not just be noisy, it would DELETE the at-most-once delivery
 *     guarantee (migrations 0138/0139) these columns exist to provide.
 *
 *   routes/admin.ts (1 of its 3)  the reset-reminder endpoint clears the same
 *     three claim columns — the inverse of the scheduler's claim, so the same
 *     argument. There is also no command that could carry it: UPDATE_TRIP's
 *     allow-list (2450, c_trip_patch) does not contain them, and widening it
 *     would put scheduler bookkeeping INTO the aggregate rather than take it
 *     out. Its audit trail is the moderation_actions row, which is the right
 *     place for an operator action on the notification pipeline.
 *
 *   services/contentTranslation.ts (1)  trips.original_language, a DERIVED
 *     column — the detected language of text the user just wrote, reproducible
 *     by re-running detection. Both trip callers (routes/trips.ts:356 create,
 *     :978 patch) invoke detectAndStoreLanguage FIRE-AND-FORGET after their own
 *     write has already returned the new version to the client in
 *     X-Trip-Version. A command would land a second bump moments later and the
 *     client's next If-Match write — with the version this API just told it to
 *     hold — would be refused, non-deterministically, depending on how long the
 *     language provider took. A user's own successful save must not invalidate
 *     their own concurrency token.
 *
 * These stay direct. For the reminder columns the change that removes them from
 * this inventory is moving them off `trips` into a sidecar table, not a
 * command. Owner decision recorded 2026-09-07 (fourth pass), re-argued per
 * column 2026-09-08 (fifth pass); do not re-litigate without moving the columns.
 *
 * STILL UNGATED (2)
 * =================
 *   routes/events.ts (1)  ADD_PLAN (crew, creator_id stamped by the kernel
 *     where the insert leaves it NULL). The conversion is WRITTEN and was handed
 *     over unstaged in the fourth-pass report; another lane owns the file, so
 *     this pass could not stage it. It is a KERNEL_COMMAND, not an exemption.
 *
 *   services/appeals/resolveAppeal.ts (1 of its 2)  the 'trip_membership' case
 *     UPDATEs trip_members SET role='member' for a row REMOVE_PARTICIPANT (and
 *     the legacy delete) has DELETED, so it matches 0 rows and the appeal
 *     resolves reporting "trip_membership_restored" while nothing was restored.
 *     It is a KERNEL_COMMAND and no existing command can carry it: restoring a
 *     removed member means RE-INSERTING the row, which is ADD_PARTICIPANT, whose
 *     capability is `host` (2500) — and the actor here is the removed member,
 *     not a host. The moderator cannot issue it either: 2450 pins actor_role to
 *     the command's family, and the admin family contains only ADMIN_HIDE_TRIP.
 *     The command it needs (ADMIN_RESTORE_PARTICIPANT) requires a new migration
 *     replacing trip_kernel_execute, and what "restore" means when the row is
 *     gone — original role? member? does the crew cap still apply? — is a
 *     product decision (owner decision APPEAL_RESTORE_SEMANTICS). Its sibling
 *     'trip' case WAS gated this pass: UPDATE_TRIP { status: 'planning' } with
 *     the appellant as actor, whose `owner` capability is exactly the legacy
 *     statement's `.eq("owner_id", appellant_id)`.
 */

/** The Trip aggregate's own rows (Trips spec §2.2). */
export const CANONICAL_TRIP_TABLES = ["trips", "trip_members", "trip_plan_items"] as const;

/**
 * The comment token that marks a direct write as the flag-off twin of a kernel
 * command. It must appear in the statement's leading comment, i.e. after the
 * previous `;` and before the `.from(`.
 */
export const LEGACY_PATH_MARKER = "trip-kernel:legacy-path";

/**
 * The comment token that declares a direct write to be OUTSIDE the Trip
 * aggregate — a write that must NOT become a command, because a command would
 * bump `trips.version` and `trips.version` is the client's concurrency token
 * (§18.3/§18.4, If-Match). It is written with the exact columns it covers:
 *
 *   trip-kernel:non-aggregate(trips.reminder_sent_at)
 *   trip-kernel:non-aggregate(trips.reminder_retry_count, trips.reminder_sent_at)
 *
 * This is DELIBERATELY not a file, path or table exemption. checkTripKernelWriters
 * parses the annotated statement's own payload object literal and requires the
 * declared `<table>.<column>` set to equal the set of keys the statement writes,
 * with the declared table equal to the `.from()` table. Consequences:
 *
 *   * adding a column to the annotated write FAILS the check until the
 *     declaration is widened by hand — an exemption cannot silently expand;
 *   * removing one FAILS too, so a declaration cannot outlive the write it
 *     describes and quietly cover something else;
 *   * a payload that is not a literal object (a spread, a variable, a computed
 *     key) is REFUSED outright — an unverifiable claim is not an exemption;
 *   * only `update` qualifies. insert / upsert / delete create or destroy a
 *     canonical row, which is aggregate state by definition, so a
 *     non-aggregate declaration on one is refused.
 *
 * Unlike LEGACY_PATH_MARKER this does NOT require the file to import
 * lib/tripKernel: the whole claim is that no command exists or should exist.
 */
export const NON_AGGREGATE_MARKER = "trip-kernel:non-aggregate";

export interface WriterBaseline {
  /** All literal direct writes (Phase 0 inventory). */
  direct: number;
  /** Direct writes with no kernel path (the Phase 1 ratchet). */
  ungated: number;
  /**
   * Direct writes carrying a VERIFIED NON_AGGREGATE_MARKER declaration.
   * Ratcheted like the others: it may fall, never grow. Absent means 0 —
   * so a file cannot acquire its first exemption without editing this table.
   */
  nonAggregate?: number;
}

export const TRIP_KERNEL_DIRECT_WRITERS: Record<string, WriterBaseline> = {
  "compass/CompassAutopilotEngine.ts":     { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): applyProposal update -> MOVE_PLAN / UPDATE_PLAN / ... (crew, actor = proposal owner)
  "lib/tripReminderScheduler.ts":          { direct: 3, ungated: 0, nonAggregate: 3 }, // DECLARED NON-AGGREGATE per column (fifth pass): reminder_sent_at / reminder_retry_count / reminder_delivered_at
  "lib/visuals/service.ts":                { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): finalizeVisual cover_url -> SET_TRIP_COVER (system)
  "routes/admin.ts":                       { direct: 3, ungated: 0, nonAggregate: 1 }, // 2 x visibility hide KERNEL-GATED (fourth pass) -> ADMIN_HIDE_TRIP (admin); 1 x reminder reset DECLARED NON-AGGREGATE per column (fifth pass)
  "routes/airport.ts":                     { direct: 3, ungated: 0 }, // ALL KERNEL-GATED (fourth pass): mirror -> UPDATE_PLAN / ADD_PLAN; session plan -> ADD_PLAN (crew)
  "routes/compass.ts":                     { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): proposal confirm -> ADD_PLAN (crew)
  "routes/events.ts":                      { direct: 1, ungated: 0 }, // KERNEL-GATED (sixth pass): add-event-to-trip trip_plan_items INSERT -> ADD_PLAN (crew, actor = caller, idempotency key event-to-trip:<trip>:<event> so a double-tap replays)
  "routes/hiddenGems.ts":                  { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): -> ADD_PLAN (crew); needs 2590 for added_by/description/city/country
  "routes/plan.ts":                        { direct: 2, ungated: 0 }, // BOTH KERNEL-GATED (fourth pass): meetup / place add-to-trip-plan -> ADD_PLAN (crew)
  "routes/requests.ts":                    { direct: 3, ungated: 0 }, // ALL KERNEL-GATED (contract v2): accept -> ACCEPT_INVITE; decline -> DECLINE_INVITE; cancel -> REMOVE_PARTICIPANT
  "routes/routePlan.ts":                   { direct: 1, ungated: 0 }, // KERNEL-GATED (legacy path kept for flag-off / detached plans)
  "routes/telegraphChat.ts":               { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): suggestion add-to-plan -> ADD_PLAN (crew)
  "routes/tripReservations.ts":            { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): confirm + addToPlan -> ADD_PLAN (crew)
  "routes/trips-expansion.ts":             { direct: 7, ungated: 0 }, // ALL KERNEL-GATED: settings -> UPDATE_TRIP; cancel/complete/archive/delete -> CANCEL_TRIP/COMPLETE_TRIP/ARCHIVE_TRIP x2; join approve -> ADD_PARTICIPANT / SET_PARTICIPANT_ROLE (host, 2500); invite-link join -> JOIN_VIA_LINK (link_holder, 2500)
  "routes/trips.ts":                       { direct: 14, ungated: 0 }, // ALL KERNEL-GATED (contract v2)
  "services/appeals/resolveAppeal.ts":     { direct: 2, ungated: 1 }, // 'trip' KERNEL-GATED (fifth pass) -> UPDATE_TRIP { status: planning } (owner = the appellant, key appeal:<id>:trip); 'trip_membership' still ungated — no command exists (see header)
  "services/contentTranslation.ts":        { direct: 1, ungated: 0, nonAggregate: 1 }, // single-quoted .from('trips') — DECLARED NON-AGGREGATE per column (fifth pass): original_language
  "services/hiddenGems/HiddenGemService.ts": { direct: 1, ungated: 0 }, // KERNEL-GATED (fourth pass): submitGem trip attach -> ADD_PLAN (crew); needs 2590
};
