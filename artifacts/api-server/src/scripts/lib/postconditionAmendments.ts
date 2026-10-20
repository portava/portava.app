/**
 * postconditionAmendments.ts — the declared statements certify:migrations
 * stage 4 does NOT re-run, each with the later migration that superseded it.
 *
 * WHY THIS EXISTS
 * ===============
 * Stage 4 re-runs every scoped migration's postconditions against the
 * committed database. On portava-ci and production a run's scope is the few
 * files it just applied. A beta bootstrap applies the WHOLE chain under one run
 * id (~490 files), so a postcondition written in September is re-run against a
 * database that later migrations deliberately changed: "anon holds SELECT on
 * passport_postcards" after 3363 withheld it, "3 stage-family assignments"
 * after 2779 added two. Measured on an offline rehearsal of the reset bootstrap
 * (PGlite behind the Management API endpoint, the job's own steps, #711 head
 * d981724bb, 2026-10-14): stages 1-3 and 5 pass, stage 4 fails 33 blocks in 33
 * files — every one of them the class below.
 *
 * WHY NOT THE HEADER MARKER 3801 USES. `-- certify:supersedes-postconditions`
 * lives in the superseding file's header, and every superseder here is already
 * applied to portava-ci (and most to production): the ledger holds each file's
 * sha256, so adding a header line is an edit to an applied migration and fails
 * check:migration-ledger. The declarations therefore live here, and they are
 * finer than the header's: one STATEMENT of a block is dropped, never a file,
 * so every other assertion of the block is still re-run.
 *
 * THE TWO KINDS
 * =============
 *   superseded     a later applied migration changed the object the statement
 *                  pins. `supersededBy` is MEASURED, not inferred: on a
 *                  whole-chain replay that re-ran each statement in a fresh
 *                  session after every file, it is the file after which the
 *                  statement fails and never passes again. The drop applies
 *                  only while that file is recorded applied. The re-asserting
 *                  migrations' postconditions (and `reassert`, where no
 *                  migration asserts the current form) run in the block's
 *                  place, even out of scope.
 *   session-bound  the statement reads a temp table or session setting only
 *                  its own apply transaction had — the three KNOWN findings of
 *                  check:migration-session-state. No separate request can
 *                  evaluate it; the applier did, inside the transaction that
 *                  also wrote the ledger row.
 *
 * WHAT HOLDS EACH ENTRY HONEST
 * ============================
 *   src/test/certifyPostconditionAmendments.test.ts   (static, every PR)
 *     the block is where blockLine says and hashes to blockSha256; every drop
 *     is a whole-line span inside it whose removal leaves an assertion-only
 *     block; supersededBy sorts after the file in the applier's order and
 *     touches the object the statement pins; every object the dropped statement
 *     reads is named by a re-assertion; a session-bound drop reads exactly the
 *     state check:migration-session-state finds for that block; failsWith names
 *     what the span asserts.
 *   src/test/db/postconditionAmendments.db.test.ts    (CI local-db, real PG)
 *     at the chain end: the block as written FAILS; with every drop applied it
 *     PASSES; with any ONE drop withheld it FAILS with that drop's failsWith (so
 *     every drop is necessary, and fails for the declared reason); every
 *     re-assertion PASSES.
 *   A declaration whose statement passes again (the superseder rolled back, the
 *   object restored) fails the db test: delete it. One that drifts from the
 *   file's text is refused by certify itself (blockSha256) and the stage fails.
 */
import type { PostconditionAmendment } from "./migrationSqlBlocks.js";

const P = "POSTCONDITION FAILED";

/**
 * 2192-2214 and 2320 pin "no memory_% / project_% function is executable by
 * anon or authenticated" — written before 2994 created the first TRIGGER
 * function in that namespace. A trigger function cannot be called outside its
 * trigger, so its EXECUTE grant is not an exposure; 3314 restated the rule for
 * CALLABLE functions only and says why ("2994's memory_relations_owner_matches_source
 * is exactly that"). 3314 covers memory_% and project_%memory%; 2195 also
 * pinned the broader project_%, so the restated rule is asserted here in full.
 */
const MEMORY_CALLABLE_REASSERT = `DO $reassert$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND (p.proname LIKE 'memory\\_%' OR p.proname LIKE 'project\\_%')
                AND p.prorettype <> 'trigger'::regtype
                AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                     OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'RE-ASSERTION FAILED (2192-2214, 2320 as narrowed by 3314): a callable memory_/project_ function is executable by anon/authenticated';
  END IF;
END
$reassert$;`;

const MEMORY = (file: string, blockLine: number, blockSha256: string, lines: [number, number], failsWith: string) =>
  ({
    file,
    blockLine,
    blockSha256,
    kind: "superseded",
    drops: [{ lines, failsWith, supersededBy: "2994_memory_relations_and_outbox_consumer.sql" }],
    reassertedBy: ["3314_memory_projection_claim_refs.sql"],
    reassert: MEMORY_CALLABLE_REASSERT,
    why:
      "2994 created public.memory_relations_owner_matches_source() RETURNS trigger and left Supabase's default " +
      "EXECUTE grant on it (a trigger function cannot be invoked outside its trigger, so this is not an exposure). " +
      "3314 restated the rule for callable functions only (p.prorettype <> 'trigger') and names 2994's function as " +
      "the reason. Replay: the statement fails after 2710, passes again after 2711 (which revoked), and fails for " +
      "good after 2994.",
  }) as const satisfies PostconditionAmendment;

/**
 * 2151:113/117 and 2158:38/40 asserted that each client role's TABLE-level
 * privileges on passport_postcards / post_media are exactly SELECT — so also no
 * table-level INSERT, UPDATE or DELETE. 3363 withheld the SELECT too (column
 * grants instead) and its postcondition re-asserts only the SELECT side, so
 * without this a table-level DELETE on passport_postcards would be asserted by
 * nothing (verifier V-714 F3). The current form, measured at the chain end: no
 * table-level privilege of any kind for anon, authenticated or PUBLIC. Read
 * from relacl with aclexplode(), so every privilege type counts (MAINTAIN too).
 */
const CLIENT_TABLE_PRIVILEGE_REASSERT = `DO $reassert$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                    || '/' || a.privilege_type, ', '
                    ORDER BY c.relname, a.grantee, a.privilege_type)
    INTO bad
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid IN ('public.passport_postcards'::regclass, 'public.post_media'::regclass)
     AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RE-ASSERTION FAILED (2151/2158 as superseded by 2152/3363): a client role holds a TABLE-level privilege on passport_postcards/post_media: %', bad;
  END IF;
END
$reassert$;`;

/**
 * The kernel transforms 2764-2785 each pinned counts of trip_kernel_execute()'s
 * text true at THEIR point in the chain; the declarations below drop the
 * statements a later transform moved — whole loops over several families, of
 * which only stage (2779) and proposal (2775) actually moved. No later
 * postcondition re-pins the families that did not move, nor the range-check,
 * engine-command and branch counts (verifier V-714 F4: "touches the object" is
 * not "re-asserts the count"). This pins every count those statements pinned,
 * at its CHAIN-END value, including 3826's RECORD_FLIGHT_STATUS engine command
 * and branch (the continuation of 2786's four commands and 72 branches). A transform that legitimately moves one of these
 * counts must update this block in the same change: the amendments db test
 * runs it at the chain end on every PR.
 */
const KERNEL_COUNTS_REASSERT = `DO $reassert$
DECLARE d text; n int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN
    RAISE EXCEPTION 'RE-ASSERTION FAILED (trip kernel counts): public.trip_kernel_execute is missing';
  END IF;
  FOREACH t IN ARRAY ARRAY['stage:5','leg:3','commitment:3','goal:3','decision_task:3','risk:3',
                           'proposal:4','presence:2','outcome:1','attendance:3'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || split_part(t, ':', 1) || ''';', '')))
         / length('v_family     := ''' || split_part(t, ':', 1) || ''';');
    IF n <> split_part(t, ':', 2)::int THEN
      RAISE EXCEPTION 'RE-ASSERTION FAILED (trip kernel counts at the chain end): expected % %-family assignments, found %',
        split_part(t, ':', 2), split_part(t, ':', 1), n;
    END IF;
  END LOOP;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 3 THEN
    RAISE EXCEPTION 'RE-ASSERTION FAILED (trip kernel counts at the chain end): expected 3 trip-level range checks, found %', n;
  END IF;
  n := (length(d) - length(replace(d, 'THEN ''engine''', ''))) / length('THEN ''engine''');
  IF n <> 5 THEN
    RAISE EXCEPTION 'RE-ASSERTION FAILED (trip kernel counts at the chain end): expected 5 engine-capability commands, found %', n;
  END IF;
  n := (length(d) - length(replace(d, E'\\n      WHEN ''', ''))) / length(E'\\n      WHEN ''');
  IF n <> 73 THEN
    RAISE EXCEPTION 'RE-ASSERTION FAILED (trip kernel counts at the chain end): expected 73 command branches, found %', n;
  END IF;
END
$reassert$;`;

/** The trip kernel transforms each pin counts of trip_kernel_execute()'s text at their own point in the chain. */
const KERNEL_COUNTS_WHY =
  "trip_kernel_execute() is rewritten by every later kernel transform, and each pins the counts true at ITS " +
  "point in the chain (\"expected 3 stage-family assignments\", \"the 2 pre-existing trip-level range checks\", " +
  "\"N command branches after this no-branch migration\"). The named transform added to that count on purpose; " +
  "its own postcondition (amended here in turn where a still later transform moved its counts) asserts the kernel " +
  "it installed, with 3826 adding the flight-status engine command; KERNEL_COUNTS_REASSERT re-pins every dropped count at its chain-end value.";

export const POSTCONDITION_AMENDMENTS: readonly PostconditionAmendment[] = [
  {
    file: "2151_passport_postcards_write_boundary.sql",
    blockLine: 107,
    blockSha256: "856880b27cd4385a",
    kind: "superseded",
    drops: [
      { lines: [113, 113], failsWith: `${P}: anon holds "(none)", expected SELECT only`, supersededBy: "3363_place_copies_client_column_grants.sql" },
      { lines: [117, 117], failsWith: `${P}: authenticated table-level "(none)", expected SELECT only`, supersededBy: "3363_place_copies_client_column_grants.sql" },
      { lines: [134, 134], failsWith: `${P}: expected 11 INSERT columns, got 10`, supersededBy: "2152_passport_postcards_status_boundary.sql" },
      { lines: [135, 135], failsWith: `${P}: expected 9 UPDATE columns, got 8`, supersededBy: "2152_passport_postcards_status_boundary.sql" },
    ],
    reassert: CLIENT_TABLE_PRIVILEGE_REASSERT,
    why:
      "2152 removed authenticated's column INSERT/UPDATE on passport_postcards.status (a moderation state the owner " +
      "could self-restore), so 2151's 11/9 column counts became 10/8. 3363 then withheld the table-level SELECT from " +
      "anon and authenticated and granted the place-free columns instead (census-media §44.11), so 'SELECT only at " +
      "table level' no longer holds by design. Both re-assert the table's current grant shape.",
  },
  {
    file: "2158_post_media_write_boundary.sql",
    blockLine: 34,
    blockSha256: "1b59dcfab875a9c4",
    kind: "superseded",
    drops: [
      { lines: [38, 38], failsWith: `${P}: anon=(none)`, supersededBy: "3363_place_copies_client_column_grants.sql" },
      { lines: [40, 40], failsWith: `${P}: authenticated=(none)`, supersededBy: "3363_place_copies_client_column_grants.sql" },
    ],
    reassert: CLIENT_TABLE_PRIVILEGE_REASSERT,
    why:
      "3363 revoked the table-level SELECT on post_media from anon and authenticated and granted the columns that " +
      "carry no place (canonical_place_id and stamp_overlay withheld, census-media §44.11); its postcondition asserts " +
      "that column set. The protected-column write check of this block is still re-run.",
  },
  {
    file: "2160_portava_featured_write_boundary.sql",
    blockLine: 43,
    blockSha256: "cc417c9bd50d808b",
    kind: "superseded",
    drops: [
      { lines: [47, 47], failsWith: `${P}: anon=(none)`, supersededBy: "2332_money_grant_boundary.sql" },
      { lines: [49, 49], failsWith: `${P}: authenticated=(none)`, supersededBy: "2332_money_grant_boundary.sql" },
    ],
    why:
      "2332 (M14) replaced Supabase's default privileges on the money tables and portava_featured with an explicit " +
      "grant set that gives the client roles no table-level privilege; its postcondition asserts that set. The " +
      "no-client-write check of this block is still re-run.",
  },
  MEMORY("2192_memory_provenance_policy.sql", 238, "588b47eecb3176ad", [252, 259], `${P}: a memory function is executable by anon/authenticated`),
  MEMORY("2193_memory_projector_provenance.sql", 179, "d9881dac43dd6cc9", [185, 189], `${P}: a memory/projector function is anon/authenticated executable`),
  MEMORY("2194_memory_reset_export.sql", 127, "c40374a780f3696f", [133, 137], `${P}: a memory function is anon/authenticated executable`),
  MEMORY("2195_memory_inferred_preferences.sql", 157, "f1db4cbc712df393", [162, 166], `${P}: a memory/projector function is anon/authenticated executable`),
  MEMORY("2196_memory_feedback_completeness.sql", 187, "3d84ab5bd4e88325", [196, 200], `${P}: a memory function is anon/authenticated executable`),
  MEMORY("2213_memory_passport_controls.sql", 187, "790dc5262c824e7b", [206, 214], `${P}: a memory function is executable by anon/authenticated (Supabase default grants after CREATE`),
  MEMORY("2214_memory_recaps.sql", 116, "077141d780376ced", [134, 142], `${P}: a memory function is executable by anon/authenticated (Supabase default grants after CREATE`),
  {
    file: "2274_intel_claim_observation_model.sql",
    blockLine: 223,
    blockSha256: "221a68da822123ee",
    kind: "superseded",
    drops: [
      {
        lines: [262, 266],
        failsWith: `${P}: intel_observations_select_own is "(actor_id = ANY (`,
        supersededBy: "3002_intel_contribution_identity.sql",
      },
    ],
    reassertedBy: [],
    reassert: `DO $reassert$
DECLARE q text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO q FROM pg_policy
   WHERE polrelid = 'public.intel_observations'::regclass AND polname = 'intel_observations_select_own';
  IF q IS NULL OR q !~ '^\\(?actor_id = ANY \\((public\\.)?intel_self_contributor_tokens\\(\\)\\)\\)?$' THEN
    RAISE EXCEPTION 'RE-ASSERTION FAILED (2274 as superseded by 3002): intel_observations_select_own is "%" — it must be (actor_id = ANY (intel_self_contributor_tokens())), so a NULL actor still matches no row', q;
  END IF;
  IF has_function_privilege('anon', 'public.intel_self_contributor_tokens()', 'EXECUTE') THEN
    RAISE EXCEPTION 'RE-ASSERTION FAILED (2274/3002): anon may execute intel_self_contributor_tokens()';
  END IF;
END
$reassert$;`,
    why:
      "3002 (Sensing §3/§24) replaced the stored account id with a rotating contributor token and rewrote " +
      "intel_observations_select_own as actor_id = ANY (intel_self_contributor_tokens()) — still owner-only, and a " +
      "NULL actor still matches nothing. 3002's own postconditions do not assert the policy, so the re-assertion " +
      "of its current form is carried here.",
  },
  {
    file: "2276_intel_presence_verification.sql",
    blockLine: 59,
    blockSha256: "db9947303eec086c",
    kind: "superseded",
    drops: [{ lines: [73, 75], failsWith: "PRECONDITION FAILED: 2130 append-only trigger functions are missing.", supersededBy: "2292_intel_stmt_trigger_removal_ig_campaign.sql" }],
    why:
      "An untagged PRECONDITION (it names itself one): it required intel_append_only_stmt() to exist before 2276 " +
      "attached statement triggers to it. 2292 removed those triggers and dropped the function on purpose (its header: " +
      "the statement-level guard refused every cascading delete), and its postconditions assert that state. " +
      "ORDER_OVERRIDES.json's 2137 entry records the same dependency.",
  },
  {
    file: "2277_intel_outcomes_attribution.sql",
    blockLine: 72,
    blockSha256: "6f14943592c49741",
    kind: "superseded",
    drops: [{ lines: [83, 86], failsWith: "PRECONDITION FAILED: intel_append_only trigger functions missing (2130).", supersededBy: "2292_intel_stmt_trigger_removal_ig_campaign.sql" }],
    why:
      "The same untagged PRECONDITION as 2276's, for 2277's statement triggers: 2292 removed them and dropped " +
      "intel_append_only_stmt(); its postconditions assert that.",
  },
  MEMORY("2320_memory_episode_provenance_spine.sql", 428, "803a30a04fdfac1a", [484, 492], `${P}: a memory function is executable by anon/authenticated (Supabase default grants after DROP/CREATE`),
  {
    file: "2401_telegraph_messages_rls_latent_disclosure.sql",
    blockLine: 127,
    blockSha256: "9ff726269d144abe",
    kind: "superseded",
    drops: [
      {
        lines: [139, 141],
        failsWith: `${P}: msg_select is not correlated on messages.thread_id: authz.is_active_thread_member(thread_id)`,
        supersededBy: "2402_telegraph_membership_rls_recursion.sql",
      },
    ],
    why:
      "2401 corrected msg_select's correlation in place; 2402 (Telegraph §26, the 42P17 repair) then rewrote msg_select " +
      "to authz.is_active_thread_member(thread_id), a SECURITY DEFINER membership test that is correlated by its " +
      "argument rather than by an EXISTS on mtm.thread_id. 2402's postconditions assert the new policies; the " +
      "self-compare and blocked-sender checks of this block are still re-run.",
  },
  {
    file: "2420_trip_kernel_foundation.sql",
    blockLine: 451,
    blockSha256: "2087b609818d7e6d",
    kind: "superseded",
    drops: [{ lines: [474, 476], failsWith: `${P}: authenticated cannot SELECT trip_events`, supersededBy: "3976_trip_events_private_place_minimised.sql" }],
    why:
      "3976 (census-trips §85, lead ruling D-65) revoked authenticated's table-level SELECT on trip_events so a private " +
      "place's name and identifiers cannot be read from event payloads; its postcondition asserts the new grant. " +
      "Every other kernel-table and kernel-function check of this block is still re-run.",
  },
  {
    file: "2570_intel_live_scope_admin_surface_flag.sql",
    blockLine: 112,
    blockSha256: "90dc54770e9b845d",
    kind: "session-bound",
    sessionState: "_m2570_before",
    drops: [{ lines: [166, 170], failsWith: 'relation "_m2570_before" does not exist' }],
    why:
      "check:migration-session-state KNOWN: the in-body block reads the ON COMMIT DROP snapshot _m2570_before, which " +
      "exists only inside 2570's apply transaction (where the applier ran it). The flag and grant checks of the block " +
      "are still re-run.",
  },
  {
    file: "2590_trip_kernel_add_plan_attachment_columns.sql",
    blockLine: 840,
    blockSha256: "9c788817f668a49f",
    kind: "superseded",
    drops: [{ lines: [846, 850], failsWith: `${P}: the 2590 body is not installed`, supersededBy: "2772_trip_kernel_plan_attendance_and_plan_version.sql" }],
    why:
      "The statement checks for 2590's exact ADD_PLAN text; 2772 rewrote ADD_PLAN/UPDATE_PLAN to learn stage_id, " +
      "place_id, privacy_scope and plan_scope, so that text is gone by design. " +
      KERNEL_COUNTS_WHY,
  },
  {
    file: "2710_memory_command_kernel_tables.sql",
    blockLine: 287,
    blockSha256: "557fb4e680f7f0a1",
    kind: "superseded",
    drops: [{ lines: [314, 317], failsWith: `${P}: memory_domain_events should carry exactly 1 policy, found 2`, supersededBy: "2993_highlight_command_boundary.sql" }],
    why:
      "2993 (the Highlight command boundary) added memory_domain_events_highlight_owner_select, a second owner-read " +
      "policy for the new highlight subject, and its postcondition asserts it. The RLS, grant and append-only checks " +
      "of this block are still re-run.",
  },
  {
    file: "2745_layover_recommendation_travel_provenance.sql",
    blockLine: 207,
    blockSha256: "038f569fb18a6579",
    kind: "session-bound",
    sessionState: "portava.m2745_labelled_before",
    drops: [{ lines: [268, 273], failsWith: "(2745): travel_time_source went from <NULL> to" }],
    why:
      "check:migration-session-state KNOWN: the block reads portava.m2745_labelled_before, set with set_config(..., " +
      "true) earlier in 2745's own apply transaction; a separate request reads NULL. The column, CHECK and " +
      "travel_time_min checks of the block are still re-run.",
  },
  {
    file: "2764_trip_kernel_stage_family.sql",
    blockLine: 239,
    blockSha256: "4e89c4487ed52136",
    kind: "superseded",
    drops: [
      { lines: [257, 258], failsWith: "2764: expected 3 stage-family assignments, found", supersededBy: "2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql" },
      { lines: [267, 268], failsWith: "2764: expected the 2 pre-existing trip-level range checks, found", supersededBy: "2785_trip_disruptions_and_derived_events.sql" },
    ],
    reassert: KERNEL_COUNTS_REASSERT,
    why: "2779 added START_STAGE's two stage-family assignments (2779: \"expected 5 … (3 from 2764 + 2)\"); 2785 added a third range check. " + KERNEL_COUNTS_WHY,
  },
  {
    file: "2765_trip_kernel_leg_and_commitment_families.sql",
    blockLine: 298,
    blockSha256: "986303ee9a2d8878",
    kind: "superseded",
    drops: [
      { lines: [330, 331], failsWith: "2765: 2764's 3 stage-family assignments became", supersededBy: "2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql" },
      { lines: [332, 333], failsWith: "2765: expected the 2 pre-existing trip-level range checks, found", supersededBy: "2785_trip_disruptions_and_derived_events.sql" },
    ],
    reassert: KERNEL_COUNTS_REASSERT,
    why: "2779 added two stage-family assignments; 2785 added a third range check. " + KERNEL_COUNTS_WHY,
  },
  {
    file: "2766_trip_kernel_goal_decision_risk_families.sql",
    blockLine: 319,
    blockSha256: "413e3f01d8865b21",
    kind: "superseded",
    drops: [
      { lines: [352, 355], failsWith: "2766: the earlier stage-family assignments became", supersededBy: "2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql" },
      { lines: [356, 357], failsWith: "2766: expected the 2 pre-existing trip-level range checks, found", supersededBy: "2785_trip_disruptions_and_derived_events.sql" },
    ],
    reassert: KERNEL_COUNTS_REASSERT,
    why: "2779 added two stage-family assignments; 2785 added a third range check. " + KERNEL_COUNTS_WHY,
  },
  {
    file: "2768_trip_kernel_presence_proposal_outcome_families.sql",
    blockLine: 318,
    blockSha256: "6f1cb73ff4613d1f",
    kind: "superseded",
    drops: [
      { lines: [339, 345], failsWith: "2768: expected 3 proposal-family assignments, found", supersededBy: "2775_trip_kernel_proposal_governance_and_apply.sql" },
      { lines: [349, 351], failsWith: "2768: ACCEPT_PROPOSAL is not host-gated", supersededBy: "2775_trip_kernel_proposal_governance_and_apply.sql" },
      { lines: [352, 354], failsWith: "2768: REJECT_PROPOSAL is not host-gated", supersededBy: "2775_trip_kernel_proposal_governance_and_apply.sql" },
      { lines: [363, 366], failsWith: "2768: the earlier stage-family assignments became", supersededBy: "2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql" },
      { lines: [367, 368], failsWith: "2768: expected the 2 pre-existing trip-level range checks, found", supersededBy: "2785_trip_disruptions_and_derived_events.sql" },
    ],
    reassert: KERNEL_COUNTS_REASSERT,
    why:
      "2768's host gate on ACCEPT/REJECT_PROPOSAL was interim by its own account; 2775 replaced it with the " +
      "proposal's own decision rule (its postcondition refuses \"2768's interim rule survived\") and added the fourth " +
      "proposal-family assignment. 2779 and 2785 moved the stage and range counts. " + KERNEL_COUNTS_WHY,
  },
  {
    file: "2769_trip_kernel_participant_roles_and_terminal_lifecycle.sql",
    blockLine: 187,
    blockSha256: "e81612d6ed121eb3",
    kind: "superseded",
    drops: [
      { lines: [224, 227], failsWith: "2769: the stage-family assignments became", supersededBy: "2775_trip_kernel_proposal_governance_and_apply.sql" },
      { lines: [228, 229], failsWith: "2769: expected 45 command branches after this no-branch migration, found", supersededBy: "2772_trip_kernel_plan_attendance_and_plan_version.sql" },
    ],
    reassert: KERNEL_COUNTS_REASSERT,
    why:
      "The family loop first fails when 2775 adds the fourth proposal-family assignment (stage follows with 2779); " +
      "the branch count first fails when 2772 adds the attendance commands. " + KERNEL_COUNTS_WHY,
  },
  {
    file: "2775_trip_kernel_proposal_governance_and_apply.sql",
    blockLine: 362,
    blockSha256: "a688a082ff8fea9a",
    kind: "superseded",
    drops: [{ lines: [401, 404], failsWith: "2775: the stage-family assignments became", supersededBy: "2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql" }],
    reassert: KERNEL_COUNTS_REASSERT,
    why: "2779 added two stage-family assignments. " + KERNEL_COUNTS_WHY,
  },
  {
    file: "2777_trip_kernel_presence_ordering.sql",
    blockLine: 151,
    blockSha256: "2d9d977d897621ee",
    kind: "superseded",
    drops: [{ lines: [179, 180], failsWith: "2777: expected 50 command branches after a no-branch migration, found", supersededBy: "2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql" }],
    reassert: KERNEL_COUNTS_REASSERT,
    why: "2779 added START_PLAN, SKIP_PLAN and START_STAGE branches. " + KERNEL_COUNTS_WHY,
  },
  {
    file: "2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql",
    blockLine: 261,
    blockSha256: "99d70642dd92405b",
    kind: "superseded",
    drops: [{ lines: [286, 287], failsWith: "2779: expected the 2 pre-existing trip-level range checks, found", supersededBy: "2785_trip_disruptions_and_derived_events.sql" }],
    reassert: KERNEL_COUNTS_REASSERT,
    why: "2785 added a third trip-level range check (the disruption window). " + KERNEL_COUNTS_WHY,
  },
  {
    file: "2785_trip_disruptions_and_derived_events.sql",
    blockLine: 240,
    blockSha256: "a376aa264627d3be",
    kind: "superseded",
    drops: [{ lines: [251, 252], failsWith: "2785: expected 3 engine-capability commands, found", supersededBy: "2786_trip_kernel_opportunity_events.sql" }],
    reassert: KERNEL_COUNTS_REASSERT,
    why: "2786 added RECORD_OPPORTUNITY_CHANGE, a fourth engine-capability command (Trips §13.3). " + KERNEL_COUNTS_WHY,
  },
  {
    file: "2798_trip_kernel_recurrence_family.sql",
    blockLine: 410,
    blockSha256: "f21f03410fecf96c",
    kind: "session-bound",
    sessionState: "_k2798_before",
    drops: [
      { lines: [441, 442], failsWith: 'relation "_k2798_before" does not exist' },
      { lines: [456, 457], failsWith: 'relation "_k2798_before" does not exist' },
      { lines: [459, 460], failsWith: 'relation "_k2798_before" does not exist' },
      { lines: [462, 463], failsWith: 'relation "_k2798_before" does not exist' },
      { lines: [465, 466], failsWith: 'relation "_k2798_before" does not exist' },
      { lines: [468, 470], failsWith: 'relation "_k2798_before" does not exist' },
    ],
    why:
      "check:migration-session-state KNOWN: six statements compare the kernel with the ON COMMIT DROP before-counts in " +
      "_k2798_before, which exists only inside 2798's apply transaction (the method 3974 copied, ORDER_OVERRIDES.json). " +
      "The recurrence-family and lost-command checks of the block are still re-run.",
  },
  {
    file: "3720_trip_plan_privacy_scope_rls.sql",
    blockLine: 86,
    blockSha256: "9111f2d4449320e3",
    kind: "superseded",
    drops: [
      {
        lines: [100, 102],
        failsWith: `${P} (3720): plan_items_privacy_scope_select names a narrow scope as admitting the crew`,
        supersededBy: "3727_trip_plan_item_audience.sql",
      },
    ],
    why:
      "Owner ruling OD-1012-PRIV-5: private plan access is limited to its author and explicitly selected people. 3727 " +
      "replaced 3720's restrictive scope policy with one that admits 'selected_participants' through the explicit " +
      "audience table, so the policy now names that scope on purpose; 3727's postcondition asserts it. The " +
      "RESTRICTIVE and creator-clause checks of this block are still re-run.",
  },
  {
    file: "3725_discovery_trend_post_owner_controls.sql",
    blockLine: 142,
    blockSha256: "0733c87fab68f6da",
    kind: "superseded",
    drops: [
      {
        lines: [146, 150],
        failsWith: `${P} (3725): discovery_trend_post_groups_v2 does not carry the owner-controls exclusion.`,
        supersededBy: "3726_discovery_trend_post_latest_correction.sql",
      },
    ],
    why:
      "Owner ruling OD-1012-PRIV-3 (second half): 3726 replaced 3725's \"the owner EVER rejected the place\" clause with " +
      "the latest-correction clause and nothing else; its postcondition asserts the new body. The SECURITY INVOKER and " +
      "EXECUTE checks of this block are still re-run.",
  },
  {
    file: "3971_trip_routes_api_spend_gate.sql",
    blockLine: 131,
    blockSha256: "7f51ced27bb21687",
    kind: "superseded",
    drops: [
      { lines: [144, 147], failsWith: 'routes_api_try_spend(integer, bigint, bigint)" does not exist', supersededBy: "3973_trip_routes_api_user_trip_shares.sql" },
      { lines: [151, 153], failsWith: "routes_api_try_spend(integer, integer, integer) does not exist", supersededBy: "3973_trip_routes_api_user_trip_shares.sql" },
    ],
    why:
      "census-trips §82: 3973 DROPPED routes_api_try_spend and replaced it with routes_api_try_spend_scoped (per-user and " +
      "per-trip shares taken with the day's unit); its postcondition asserts the new function's grants and its off " +
      "answer. The usage-table and flag checks of this block are still re-run.",
  },
];
