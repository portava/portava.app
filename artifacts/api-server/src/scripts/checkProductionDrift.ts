/**
 * check:production-drift — the gate that can see PRODUCTION, without ever touching it.
 *
 * ─── THE PROBLEM THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * `audit:schema` (auditMigrationsVsLive.ts) and `audit:live-unexplained`
 * (auditLiveVsCanonical.ts) are both real, both good, and both **structurally
 * incapable of seeing production**. Every live-DB job runs
 * `.github/scripts/assert-nonprod-supabase.sh` first, which REFUSES to proceed
 * unless the project ref it resolves from the connection URL is the sanctioned
 * CI project. That guard is correct and must not be weakened: CI must never
 * hold production credentials.
 *
 * (This comment deliberately does not spell out the connection-URL environment
 * variable's name. `check:guard-coverage` classifies any file naming a database
 * credential as one that "can reach Supabase" and requires it to import a guard
 * front door or take an EXEMPT entry. Neither is right here: this script opens
 * no socket, so a guard would protect nothing, and an EXEMPT entry asserts "CI
 * never invokes this file" — the opposite of the intent, since the whole point
 * is that CI CAN run it. The honest resolution is not to name the variable.)
 *
 * The consequence is a blind spot rather than a bug. CI has been green
 * throughout while production was missing tables the code targets — measured
 * 2026-09-07: portava-ci held 435 public tables, production held 417, and 28
 * tables existed in CI and not in production.
 *
 * ─── THE RESOLUTION ───────────────────────────────────────────────────────────
 *
 * You cannot read production from CI. You CAN diff a committed file.
 *
 *   operator (has production read access)  ->  refreshes baseline/*_production_tables.txt
 *   CI (has no production credentials)     ->  runs this script against that file
 *
 * This script therefore takes **no credentials, opens no socket, and reads no
 * environment variable**. It is a pure file-vs-file comparison, which is exactly
 * what lets it run in the same pipeline as a guard that forbids production
 * access. Run it anywhere, including the credential-free `preflight` job.
 *
 * ─── IT IS A RATCHET, NOT AN ALLOWLIST ────────────────────────────────────────
 *
 * Every known gap below carries a classification and a reason. It fails in BOTH
 * directions, on the model of checkWriterlessReads.ts:
 *
 *   - a NEW table declared in the tree but absent from the production snapshot
 *     fails, because that is drift nobody recorded;
 *   - a listed table that has since reached production and was not struck off
 *     also fails, because a ratchet that silently stays full stops being read.
 *
 * Entries classified `unapplied` MUST reach zero. They are not a steady state:
 * each one is code in the tree pointed at storage production does not have.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 *
 * It compares TABLE PRESENCE only — not columns, indexes, policies or grants.
 * Presence is what a snapshot can carry honestly at this size; a column-level
 * claim from a name list would be exactly the kind of confident wrong answer
 * .agents/memory/db-column-drift.md warns about. Column drift already has an
 * instrument (`check:missing-live-columns`), and it too sees only CI.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SERVER_ROOT = join(HERE, "..", "..");
const MIGRATIONS_DIR = join(API_SERVER_ROOT, "src", "migrations");
const BASELINE_DIR = join(API_SERVER_ROOT, "baseline");

/**
 * The snapshot filename. Bump this when an operator captures a fresher one.
 *
 * EXPORTED so tests measure the rule against the snapshot actually in use
 * rather than restating its date. A test that hard-codes the capture date goes
 * stale silently on the next refresh, which is how two cases in
 * productionDriftExtraction.test.ts came to assert the opposite of the truth.
 */
export const PRODUCTION_SNAPSHOT = "20261024_production_tables.txt"; // 2026-10-24 capability refresh (the header of that file)

/**
 * `unmerged-pr` HAS NO MEMBERS AS OF 2026-09-15, AND IS KEPT — ruling, with the
 * reason, because the guard's own error message asked for the opposite.
 *
 * Restoring 2311/2320 — to close three `schema_migration_ledger` rows that named
 * no file on disk — made intel_claim_reviews, memory_episodes and memory_evidence
 * declared in this tree, so the STALE UNMERGED-PR assertion below correctly
 * refused their `unmerged-pr` notes and all three became `unapplied`. They were
 * the last three members, and productionDriftExtraction.test.ts's positive
 * control then failed with: "no unmerged-pr entry remains — if that is genuinely
 * true, delete the classification rather than leaving a rule that exempts
 * nothing."
 *
 * THE CLASSIFICATION IS NOT DELETED. Two reasons, in order of weight:
 *
 *   1. It describes a situation this repository keeps producing. 2311, 2315,
 *      2320 and the whole 289x-295x block each arrived as "a table an unmerged
 *      PR's migration declares, applied to portava-ci to unblock someone". The
 *      next one is a question of when. Deleting the type does not prevent that
 *      case; it only removes the name for it, the exemption that keeps it out of
 *      the must-reach-zero total, and — the part that actually matters — the
 *      STALE assertion that notices the day the PR lands. That is strictly less
 *      coverage than an idle rule that works.
 *
 *   2. The vacuity the control complains about was never really about the
 *      population. The control asserted over a COPY of the rule kept in the test
 *      file, so an empty population left the copy unexercised — and the copy
 *      could have drifted from this file without anything noticing either way.
 *      Both predicates are therefore exported below and the test calls THESE,
 *      against a constructed fixture as well as the real ratchet. The
 *      discrimination is now proven directly, on the real implementation,
 *      whether or not any live entry happens to carry the classification.
 */
type Classification =
  /** Declared in the tree, never applied to production. MUST reach zero. */
  | "unapplied"
  /** Applied to portava-ci on purpose, awaiting an owner decision for production. */
  | "ci-only-by-ruling"
  /** Belongs to an unmerged PR; it is not drift until that PR lands. */
  | "unmerged-pr";

interface Gap {
  classification: Classification;
  note: string;
}

/**
 * Tables that exist in the tree and NOT in production, each with a stated reason.
 *
 * Seeded 2026-09-07 from a direct database-to-database comparison of
 * portava-ci (hwokxgbmezheskbzskfr) against production (ajrurzioarfkagpuxfnb) —
 * not from a regex over migration text, which picks up prose inside comments and
 * legacy-root renames.
 */
export const KNOWN_PRODUCTION_GAPS: Record<string, Gap> = {
  // ── STRUCK OFF 2026-09-17: the twenty-six this ratchet was largest for ─────
  // Twenty-one Trips tables (2760-2794) and five that were not Trips at all —
  // map_telemetry_events, map_telemetry_drops (2202/2222), media_intent_signals
  // (2256), sensing_anon_contributions (2315/2340) and
  // sensing_contribution_sessions (2480) — now EXIST in production and are
  // struck off rather than left in place, because this ratchet fails in both
  // directions and "a ratchet nobody prunes stops being read" is its own rule.
  //
  // The five non-Trips ones are the finding worth keeping. They were applied to
  // production ON 2026-09-16 and recorded in production-applied-migrations.json
  // that day, but baseline/20260916_production_tables.txt was never refreshed
  // with them, so this check went on reporting five gaps that had already
  // closed while the file it reads described a production two applies old. That
  // is the same staleness class as the one checkFlagSchemaPrerequisites exists
  // to refuse, in the sibling file, and it is why 20260917_production_tables.txt
  // and snapshots/20260917-production-schema.json were refreshed together.
  //
  // WHAT BEING IN PRODUCTION DOES NOT ESTABLISH, stated so the next reader does
  // not overclaim it: trip_kernel_enabled and trip_operational_projections_enabled
  // are both still FALSE in production. Every one of these tables is reachable
  // by its writer and read by nothing, exactly as before. The schema is applied;
  // the feature is not on. docs/TRIPS-PRODUCTION-ACTIVATION.md keeps those two
  // states in separate columns for this reason.

  // ── STRUCK OFF 2026-09-21: seven tables, on two very different grounds ────
  //
  // map_telemetry_disabled_discards (2964) — STRUCK because its own removal
  // condition was met, in full and in one change. That entry read: "Strike this
  // off in the same change that applies 2964 and refreshes the two production
  // snapshots." 2964 was applied to production on 2026-09-21 07:43 UTC from
  // merged main fd0b3a6f4, after the same file was applied and certified on
  // portava-ci by the merge of PR #511; both snapshots
  // (baseline/20260921_production_tables.txt and
  // snapshots/20260921-production-schema.json) were refreshed in this change,
  // and PRODUCTION_SNAPSHOT above moved with them. The apply was verified
  // against production independently of 2964's own postconditions: exactly four
  // columns, no identity-shaped and no uuid column, the hour-bucket CHECK
  // present, RLS on, anon and authenticated holding nothing, and service_role
  // holding SELECT and DELETE but NOT INSERT or UPDATE — so the upsert function
  // remains the only writer, which is the whole point of the table.
  //
  // trails, content_trails, trail_edges, trail_follows, trail_health_snapshots,
  // trail_reports (2910) — STRUCK for the opposite reason: not because this
  // change applied them, but because their entries had QUIETLY BECOME FALSE.
  // All six said "absent from production only because this branch is unmerged".
  // 2910_discovery_trails.sql was applied to production on 2026-09-20 19:56 UTC
  // by someone other than this session, and all six tables have existed there
  // since. Nothing noticed for four days.
  //
  // WHY NOTHING NOTICED, which is the part worth keeping: the staleness
  // tripwire in checkFlagSchemaPrerequisites fires only when
  // production-applied-migrations.json is AHEAD of the snapshot watermark. A
  // record that LAGS reality — an apply that happened and was never written
  // down — is precisely the case it cannot see. These six were found by
  // capturing production's table list and diffing it against the 09-17
  // baseline, not by any check. That gap is real and is written down here and
  // in the new baseline's header rather than patched over; the seven missing
  // entries have been added to production-applied-migrations.json in this
  // change so the record is at least true today.
  //
  // This ratchet fails in BOTH directions, so leaving six entries claiming a
  // table is absent when it is present would fail the check — correctly. An
  // entry nobody prunes stops being read.

  // ── ADDED 2026-09-22: six tables from the wave integrated this session ────
  //
  // All six are "unapplied" in the strict sense the classification requires:
  // declared in the tree, present on NO database, and each MUST reach zero by
  // being applied rather than by being tolerated. They arrived together because
  // two lanes landed two migrations in one integration, and the drift check
  // caught them on the first run after the merge — which is the check working,
  // not the check being noisy.

  /* layover_constraints: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */














  /* layover_time_budgets: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  /* layover_return_plans: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  /* layover_checkpoints: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  /* layover_outcomes: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  /* layover_presence: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */  /* layover_event_pseudonymisation_dead_letters: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */// one line, in place of the blank one, so every line cited below holds
  /* memory_relations: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */














 /* memory_id_redirects: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_graph_shadow_daily: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ // one line, so every line cited below holds

  // ── Trips §23, the one Trips table that is genuinely NOT in production ─────
  /* trip_commitment_recurrences: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */













  // ── The one that undermines every other migration claim ────────────────────
  // schema_migration_ledger: STRUCK OFF 2026-09-15 — it now EXISTS in production.
  //
  // This entry read "the highest-priority entry in this file", and it was right:
  // without a ledger, apply-migrations.ts exited 2 against production ("no ledger
  // table"), so the sanctioned applier had never been able to run there, and
  // nothing in the tree could answer "which migrations are applied to
  // production?". 2254_schema_migration_ledger.sql was applied to
  // ajrurzioarfkagpuxfnb on 2026-09-15: one new table, RLS ENABLED with NO
  // policies, anon/authenticated REVOKEd, service_role only, plus the 382
  // backfill rows 2254 enumerates. Verified after the apply, by reading the
  // catalog rather than trusting the applier's own report: 382 rows, 0 malformed
  // checksums, relrowsecurity = true, 0 policies, anon and authenticated holding
  // no grants — every postcondition 2254 states for itself.
  //
  // It is STRUCK OFF rather than left in place because this ratchet fails in BOTH
  // directions: "a listed table that has since reached production and was not
  // struck off also fails, because a ratchet that silently stays full stops being
  // read." Leaving it would have been exactly that failure.
  //
  // WHAT THE LEDGER DOES NOT ESTABLISH, stated here so the next reader does not
  // overclaim it: all 382 rows are applied_by = 'backfill', and a backfill row
  // asserts ONLY that the filename existed in src/migrations/ when 2254 was
  // authored. None of them is evidence that the file ran against production.
  // Which pre-2254 migrations production actually has remains unreconstructable,
  // exactly as 2254's own header says; check:missing-live-columns is still the
  // instrument for pre-ledger drift. The ledger is authoritative FORWARD only.

  // ── Trips v4 §5.1: the schema spine, CI-only and deliberately writerless ──
  // Ten tables from migrations 2760-2763, applied to portava-ci 2026-09-09 and
  // NOT to production. They are on this ratchet as one block because they share
  // one reason, and the reason is not "we have not got round to it":
  //
  //   Each ships with RLS on, a crew-only SELECT policy, and NO client write
  //   grant of any kind — asserted as an equality in every postcondition. They
  //   have no writer at all yet, because Trips §4 requires every aggregate
  //   mutation to go through trip_kernel_execute, and each kernel change
  //   replaces that 700-line function in full. All of §5's command families
  //   should land in ONE replacement rather than ten.
  //
  //   So census-trips TR78/79/81/84/85/86/87/88/90/91 do NOT close on these
  //   tables existing — the census's own rule 2 is "a table nothing writes
  //   satisfies nothing", and it is right. Applying an unwritable, unreadable
  //   table to production buys nothing and adds surface, so it waits for the
  //   command family and goes with it.

  // ── Trips §41 (census-trips), migrations 2780-2785: seven kernel families ──
  // Absent from BOTH databases, like 2771/2774 above: this branch is not on
  // main and .github/workflows/live-db.yml applies only from main. Every reader
  // of these tables sits behind trip_operational_projections_enabled (FALSE in
  // both projects; check:flag-schema-prerequisites lists the whole batch as that
  // flag's prerequisite) and every writer behind trip_kernel_enabled (also
  // FALSE). Rehearsed on scripts/local-db (the api-server-local-db CI job).

  // ── A guarantee the docs rest on, that production does not have ───────────
  // protected_zones — STRUCK 2026-09-21. The entry's own complaint was that "the
  // pattern every new migration is told to follow has no production instance to
  // compare against". It has one now: 2217_protected_locations.sql was applied at
  // 11:09:40 UTC in the same change that strikes this line.
  //
  // WHAT WAS AND WAS NOT DEPLOYED. The table, its four indexes and its eight CHECK
  // constraints. NO ROWS — the migration's own header is emphatic that which places
  // are protected is a policy decision with a named owner, not a schema decision,
  // and that the row set is itself a map of exactly what it protects. With no rows
  // applyProtection() is an identity pass, so this changes nothing a user sees. The
  // first row remains an act of policy.
  //
  // Verified independently of the file's own postconditions: RLS enabled with ZERO
  // policies (the deny-by-default state 10_Database_Architecture.md §8 cites), anon
  // and authenticated holding neither SELECT nor INSERT, service_role holding the
  // four writes, 4 indexes, 8 CHECKs, 0 rows. Rehearsed first-apply and re-run on a
  // throwaway PostgreSQL 16, where four constraint probes were each REFUSED — a
  // circle with no centre, action='allow' (deliberately not storable, because a
  // protection row that permits is a hole), a polygon carrying circle fields, and
  // an unknown category — and a well-formed row was accepted and then removed.
  // Both snapshots were refreshed in the same change (baseline 482 -> 483 tables;
  // the schema snapshot's three digests recomputed and compared against the ones
  // the database computes for itself, and matched).

  // ── Telemetry: writers exist, storage does not ─────────────────────────────
  /* wall_telemetry_events: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */



  /* passport_telemetry_events: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */




  // ── The intel lane: five tables, four registered schedulers ────────────────
  /* intel_attributions: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */








  /* intel_historical_patterns: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */



  /* intel_scoped_trust: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */




  // ── Everything else measured in the same comparison ────────────────────────
  /* event_passport_shares: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  // input_selection_history — STRUCK 2026-09-21. It is no longer "absent from
  // production": 2258_input_selection_history.sql was applied to production at
  // 10:52:03 UTC in the same change that strikes this line, rehearsed first on a
  // throwaway PostgreSQL 16 with Supabase's ALTER DEFAULT PRIVILEGES armed so the
  // migration's ACL postcondition was exercised rather than trivially true, and
  // verified in production independently of that postcondition: RLS on, anon
  // holding no SELECT and authenticated no INSERT, service_role holding the four
  // writes, both indexes present, the auth.users FK ON DELETE CASCADE, and
  // input_record_selection SECURITY DEFINER with EXECUTE revoked from anon and
  // authenticated. Both production snapshots were refreshed in the same change
  // (baseline/20260921_production_tables.txt 481 -> 482 tables, and
  // snapshots/20260921-production-schema.json, whose three digests were compared
  // against the ones production computes for itself and matched).
  //
  // The entry's own header says this classification "MUST reach zero. They are
  // not a steady state." This is one reaching zero by being applied, which is the
  // only way the header allows.
  /* media_view_requests: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  /* media_view_request_optins: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  /* route_flow_contribution_consent: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */



  /* sources: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */

  // ── Applied to CI this session, deliberately not to production ─────────────
  // ── RECLASSIFIED 2026-09-15, unmerged-pr -> unapplied. The migration files
  //    are now IN THIS TREE, so the exemption is false by construction.
  //
  //    WHY THEY ARE HERE. public.schema_migration_ledger carried three rows with
  //    applied_by='manual' — 2311, 2320 and 2325 — whose FILES were on no merged
  //    branch, which is check:migration-ledger finding #2, "ledger rows with no
  //    file on disk". Each row records a REAL apply to portava-ci on 2026-09-07.
  //    Deleting such a row would make the ledger assert that a migration which
  //    DID run never ran, so the remedy was to restore the files, each verified
  //    by sha256 against the checksum its ledger row recorded. The entries below
  //    are what those files being present costs this ratchet, paid rather than
  //    dodged. (2325 adds a column and a function, no table, so it has no entry.)
  //
  //    The rule applied is the one the 289x-295x block below records in full:
  //    `unmerged-pr` is for a table whose migration you CANNOT SEE. The moment
  //    the file is here the table is declared here, whatever the source branch's
  //    merge status, and `unapplied` — "declared in the tree, never applied to
  //    production, MUST reach zero" — is exactly what these are. All three were
  //    confirmed absent from the production snapshot; portava-ci is not
  //    production, and an apply there has never been evidence about this one.
  //
  //    NO WRITER EXISTS FOR ANY OF THE THREE in this tree, and that is stated
  //    rather than left to be discovered: by the Trips §5.1 rule above, a table
  //    nothing writes satisfies nothing. Each migration's writer lives in the
  //    application code of its source branch, which was deliberately NOT brought
  //    across — the ledger row names a FILE, and only the file was owed.
  /* intel_claim_reviews: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */



  /* memory_episodes: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */



  /* memory_evidence: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */



  // Trip Kernel foundation (Trips spec §4/§5.1), migration 2420. Applied to
  // portava-ci 2026-09-07. Inert in production until an owner applies 2420 AND
  // flips trip_kernel_enabled (seeded false); the only caller is behind that
  // flag. Production also lacks 2334/2337 (authz.is_trip_crew /
  // authz.is_accepted_trip_member), which 2420 depends on — apply in order.

  // ── Added 2026-09-08. Eleven tables built on this branch and applied nowhere.
  //    Every one was CONFIRMED ABSENT by a read-only live listing of
  //    production's public schema on 2026-09-08, not inferred from the snapshot
  //    — the snapshot predates twelve OTHER tables and would have been wrong
  //    about those (see appliedAfterSnapshot below). "unapplied" means exactly
  //    what it says here: the file exists in src/migrations and no database
  //    outside portava-ci has ever run it.

  // ── STRUCK OFF 2026-09-15: nine tables from 2710/2720/2721/2722/2724/2730 ──
  //    now EXIST in production, applied by the operator under explicit
  //    authorization. This ratchet fails in BOTH directions — "a listed table
  //    that has since reached production and was not struck off also fails,
  //    because a ratchet that silently stays full stops being read" — so the
  //    entries are removed rather than left standing.
  //
  //    Each was run verbatim from its version-controlled file and recorded in
  //    public.schema_migration_ledger with applied_by = 'manual' and the file's
  //    real sha256, then verified by reading the catalog: tables, indexes,
  //    relrowsecurity, policy counts and the anon/authenticated grant boundary.
  //
  //    THE HAZARD memory_domain_events' entry NAMED WAS CHECKED, NOT ASSUMED.
  //    It warned that 2710 was renamed from memory_events because production
  //    already holds a DIFFERENT public.memory_events, and that the original
  //    name would have made CREATE TABLE IF NOT EXISTS skip SILENTLY, leaving
  //    the kernel writing into a table with the wrong shape. Measured after the
  //    apply: memory_domain_events has 11 columns, memory_events still has 12,
  //    and they are distinct relations. The rename did its job.
  //
  //    WHAT THE STRIKE-OFF MUST NOT ERASE — two reasons these entries gave for
  //    being held are still true, and are carried forward here rather than
  //    deleted with the rows that stated them:
  //
  //      * STORY_HIGHLIGHT_VISIBILITY IS RESOLVED (2026-09-15) — this entry
  //        previously read "STILL AN OPEN OWNER DECISION" and is superseded, not
  //        deleted, because the reasoning it carried is what the ruling rests on.
  //        THE RULING: promotion is restricted to the faithful rungs. The
  //        promotable set is exactly { public, circle_only } and the 409 refusal
  //        on the other four is the INTENDED behaviour, not a placeholder.
  //        Grounds, in order of weight: (a) no spec describes Story ->
  //        Highlight promotion at all — the Highlights/Memories spec lists an
  //        "Instagram Stories clone" under Non-goals and has no Story object —
  //        so no rule can be read out of the silence; (b) the specs ARE
  //        determinate on the shape, and the shape decides it: a Highlight's
  //        audience is supplied explicitly at publish time and backed by a
  //        policy row ("Publishing is always a separate projection decision"),
  //        which rules out inheriting one; (c) every available mapping widens,
  //        trip_crew -> trip_only most sharply, since one trip's accepted crew
  //        becomes every crew the owner has ever had; (d) refusing costs a
  //        capability that can be added later, mapping wrongly costs exposure
  //        that cannot be taken back. Reopening it is a BUILD, not a re-ruling:
  //        the spec's own VisibilityClass already names the two rungs
  //        `highlights` lacks (SELECTED_PEOPLE, TRIP_CREW), and adding them to
  //        the table and to RLS makes the other four faithfully promotable.
  //        Pinned by src/test/storyHighlightVisibility.test.ts's
  //        "RULING: `trip_crew` may never map to `trip_only`" case, which
  //        asserts the substance rather than the promotable set.
  //        SEPARATELY, and still true: 2720 and 2721 were queued behind this
  //        decision on the grounds that a preference table would "build the
  //        control surface for a rule nobody has picked". They are audience-
  //        neutral — resurfacing preference and location precision — and 2721's
  //        own header names a DIFFERENT open decision, LOCATION_PRECISION_DEFAULT,
  //        which this ruling does not touch. Every capability is still seeded
  //        FALSE (highlights_feed_bounded_enabled, memory_kernel_enabled,
  //        memory_location_precision_enabled,
  //        memory_public_feed_projection_enabled), the tables are empty, RLS is
  //        on and owner-scoped, and no user-visible behaviour changed by this
  //        ruling: the code already refused, and the ruling makes the refusal
  //        intended rather than provisional.
  //      * memory_event_outbox STILL HAS NO CONSUMER. Its entry said applying it
  //        "would create a table that accumulates nothing". That is exactly what
  //        it now is, deliberately: nothing writes to it while the kernel flag is
  //        FALSE, and no worker drains it. A §18 projection worker is still
  //        unbuilt.
  //
  //    APPLIED 2026-09-15, and the tenth of this family: 2711_memory_kernel_execute.
  //    This note previously read "NOT APPLIED"; it is superseded. The blocker was
  //    always the mechanism, never the authorization: the repo's own runner,
  //    scripts/src/apply-migrations.ts, REFUSES the production ref by design and
  //    that guard was not bypassed, so the 31,633 characters had to go through the
  //    Management API by hand. What made that acceptable is that the result is
  //    CHECKABLE rather than trusted — production stores the applied text, and
  //    sha256(stored_text || "\n") equals the file's own sha256sum
  //    (8fe87cb62ae4516bad70a6c970b15607d515b04584bc911d8d09c49b748081a7), so the
  //    transcription is proven byte-identical instead of assumed. All six of the
  //    migration's own postconditions passed inside its transaction, including the
  //    two that matter most here: a client role cannot EXECUTE it, and
  //    memory_kernel_enabled is still FALSE. So the four kernel tables now have a
  //    writer in production that nothing calls — routes/memories.ts keeps its
  //    direct-write path until an operator flips the flag.

  // Layover, migration 2700.
  /* layover_certified_computations: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */







  // Layover, migration 2860 — layover_external_events — STRUCK OFF, APPLIED.
  //
  // Applied by the same file in the same pass. It remains WRITERLESS and
  // EMPTY: there is still no flight or airport feed anywhere in this tree, and
  // LayoverEventReplanner is pure. Striking it off says the table exists, not
  // that anything fills it — and the entry is removed rather than reclassified
  // because a gap that has been closed is not a gap.


  // Sensing, migration 2480.

  // Telegraph, migration 2810.
  /* telegraph_outbox: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */























  // ── Telegraph §12's four side tables, migration 2811, as one block ─────────
  // They are one decision — stop putting structure in messages.body and in
  // nullable columns on messages — and they share 2810's flag, deliberately:
  // two switches for one capability is how a half-on state gets created by
  // accident. Every one ships with RLS on and a SELECT-only policy keyed on
  // ACTIVE thread membership, with a POSTCONDITION that fails if a non-SELECT
  // policy ever appears, so a client cannot write any of them directly.
  //
  // NONE HAS A WRITER TODAY, and census-trips' own rule — "a table nothing
  // writes satisfies nothing" — is why census-telegraph T142/T143/T144/T147
  // move only to BUILT-BUT-WRONG on the strength of this migration. The one
  // partial exception is message_reactions, which POST /api/telegraph/commands
  // writes when the kernel flag is on; the flag is seeded FALSE and no database
  // has the table, so "partial" here means "the code exists", not "rows exist".
  //
  // DDL and re-application were EXECUTED on a throwaway PostgreSQL 16 carrying
  // the baseline plus the chain from 2093.
  /* message_edits: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */







  /* message_reactions: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */










  /* message_attachments: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */









  /* conversation_action_refs: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */









  // ── Telegraph §22 restricted moderation storage (migration 2812) ───────────
  // The one table in this lane whose ABSENCE is a live harm rather than a
  // missing feature: census T284 measured that a reported message deleted by
  // its sender is destroyed, because deletion blanks messages.body in place and
  // nothing copied it first. The snapshot is taken at REPORT time by
  // services/telegraphReportEvidence.ts, behind its own flag.
  //
  // DDL and re-application were EXECUTED on a throwaway PostgreSQL 16 carrying
  // the baseline plus the chain from 2093.
  /* telegraph_report_evidence: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */














  // ── Added 2026-09-15 by the INTEGRATION OWNER. Twelve tables from this
  // branch's 289x-295x band, absent from production because the branch is not
  // merged and live-db.yml applies ONLY from main.
  //
  // CLASSIFIED `unmerged-pr` FIRST, AND THAT WAS WRONG. The reasoning was that
  // `unapplied` implies a decision taken and not carried out, and no such
  // decision exists for these. The checker refused it within one CI run:
  //
  //   ✖ 12 table(s) are classified 'unmerged-pr' but a migration in THIS TREE
  //     declares them ... the classification is false and the table is being
  //     excused from the must-reach-zero total by a sentence that stopped
  //     being true.
  //
  // The rule is mechanical and it is right: `unmerged-pr` is for a table whose
  // migration you CANNOT SEE, declared by a PR that is not this tree. The
  // moment the migration file is here, the table is declared here, and the
  // excuse is false by construction — whatever the branch's merge status. These
  // are `unapplied`: "declared in the tree, never applied to production, MUST
  // reach zero", which is exactly what they are.
  //
  // The STALE UNMERGED-PR assertion that caught this was added on 2026-09-14
  // for `sensing_anon_contributions`, whose own note records the identical
  // mistake — an excuse that "stayed plausible while being false" because
  // nothing checked it. It has now caught its author's successor, which is the
  // only real evidence an assertion of that kind works.
  //
  // NOT hand-applied to portava-ci either, which is the same ruling recorded on
  // stamp_definitions.evidences_presence in checkMissingLiveColumns.ts. Applying
  // migrations to the CI project from unmerged branches is the RECORDED root
  // cause of `CI (live DB)` being red on main's own sha across five consecutive
  // scheduled runs — portava-ci carries 2900/2901/2910/2930 under `rehearsal_*`
  // names and certification cannot reconcile that with the ledger. Turning a
  // check green by repeating the thing that broke another one trades a visible
  // red for an invisible one.
  //
  // Each note names its migration and says whether a WRITER exists, because the
  // Trips §5.1 block above establishes that a table nothing writes satisfies
  // nothing — a gap entry that omits that is hiding the more important half.

  // Discovery Trails, migration 2910 — all six STRUCK OFF 2026-09-21. 2910 was
  // applied to production on 2026-09-20 19:56 UTC and every one of these tables
  // now exists there, so the six entries that said "absent from production only
  // because this branch is unmerged" had become false statements. See the
  // struck-off block at the top of this record for how they were found and why
  // no check caught it.
  //
  // WHAT THEIR PRESENCE DOES NOT ESTABLISH, stated so it is not overclaimed:
  // the tables are applied, the surface is not on. Nothing here says the trails
  // flag is TRUE in production, and a table reachable by its writer and read by
  // nothing is exactly the state the 2760-2763 block was left in.

  // Creator economy, migrations 2920/2921 — gated by a flag 2922 seeds FALSE.
  /* creator_attributions: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  /* creator_rule_versions: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* PR #762's 3980-3995 (25 tables), on this line so no cited line moves. Each note states its migration, what the table is, its feature gate seeded FALSE, and that it awaits the production press. */ /* media_derivative_jobs: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_derivative_job_events: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_image_understanding_consents: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_image_understanding_artifacts: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_visual_index_consents: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_visual_index_tombstones: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_visual_embeddings: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_caption_manifests: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_caption_asr_config: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_caption_asr_epochs: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_caption_asr_consents: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_dubbing_epochs: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_dubbing_consents: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_dubbing_artifacts: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_caption_translation_config: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_caption_translation_consents: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_caption_translation_epochs: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* creator_attribution_scan_cursors: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_snapshots: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_video_segments: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_video_segment_operations: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_import_batches: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_import_batch_items: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_resurfacing_policy_heads: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* media_caption_translation_artifacts: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  /* creator_earning_entries: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */

  // Rent-a-Buddy earnings, migration 2901.
  /* rent_buddy_earnings_entries: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */

  // Place momentum, migration 2892.
  /* place_momentum: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */

  // Input-assistance telemetry, migration 2950.
  // input_assistance_telemetry_events — STRUCK 2026-09-21. It is no longer
  // "absent from production because the branch is unmerged": 2950 was applied
  // at 12:11:18 UTC in the same change that strikes this line.
  //
  // WHY IT WAS WORTH APPLYING AHEAD OF ITS MERGE. The §44 sink is attached at
  // boot now (installInputTelemetry.ts + app/_layout.tsx), so events are
  // produced; without this table the ingest answers 503 and the batcher drops
  // and counts them. A destination that refuses is not a destination.
  //
  // WHAT LANDED: the table, four indexes, eight CHECK constraints, ZERO rows,
  // and — by design, not omission — NO account id. Every §57 metric over it is
  // a rate or a quantile, so it needs no column linking a row to a person.
  //
  // Verified independently of the file's own postconditions: RLS on with zero
  // policies, anon and authenticated holding neither SELECT nor INSERT,
  // service_role holding the writes, 0 account-link columns. Then probed with
  // controlled data AFTER the apply and cleaned up: a well-formed event was
  // accepted and read back through its `request_id` (the §44 linkage G355
  // needs), all THIRTEEN forbidden raw-text prop keys were refused, an
  // undeclared event name was refused, an oversized props blob was refused, and
  // the probe left zero rows behind.
  //
  // RECORDED RATHER THAN CHANGED: 2950 REVOKEs from anon and authenticated but
  // issues no explicit GRANT to service_role, which holds its privileges
  // through Supabase's ALTER DEFAULT PRIVILEGES. That is implicit where the
  // rest of this band is explicit. It was verified true in production rather
  // than assumed, and the file was not edited because it is already applied on
  // portava-ci and an edit would drift its checksum there.
  //
  // WHAT THIS DOES NOT CLOSE: G306. The table is one link. The deployed app
  // host (portava.replit.app) is unreachable from this environment — the egress
  // gateway answers 403 to CONNECT — so the end-to-end round trip through a
  // running app has NOT been observed, and the row stays `W`.

  // ── Story retention (2998): declared here, applied nowhere yet ────────────
  /* story_purge_queue: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */


































  // ── The anti-differencing gate's durable memory (3110): declared, unapplied ─
  /* sensing_published_aggregates: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */




























  // ── The contributor token's pepper (3002): declared, unapplied ─────────────
  /* intel_contributor_pepper: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */































  // ── Added 2026-09-27 by census-discovery §48 (P3 telemetry) ─────────────────
  /* recommendations: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */

















  // ── Added 2026-09-27 by census-discovery §52 (P10 creator ledger) ──────────
  /* creator_ledger_audit_events: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */













  // ── Added 2026-09-27 by census-discovery §62 (P15 verified-defect repairs) ──
  /* rank_event_outcome_receipts: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */













  // ── Added 2026-09-27 for census-discovery §61 (P14 Trails integrity; recorded at §64.14) ──
  /* trail_relations: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */










 /* §81 (W10-S2): on this line so every cited line below keeps its number */ /* layover_place_dwell: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* census-discovery §86 (lane W10-T), on this line so no cited line below moves: */ /* discovery_admin_audit_events: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* trend_integrity_reviews: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* trail_member_exposures: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* trail_content_suggestions: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* area_momentum: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* census-discovery §95 (lane W11-X3), on this line so no cited line moves: */ /* place_cooccurrence: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } *//* Added 2026-10-03, background-jobs lane; on this line so no cited line below moves: */ /* scheduler_watermarks: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* FLAGS lane (3561), on this line so no cited line moves: */ /* compass_search_signal_log: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* Lane D, Input Intelligence (3780-3783), on this line so no cited line moves: */ /* input_outcome_consent: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* input_outcome_counters: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_narrative_ai_consent: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* input_memory_context_consent: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* input_outcome_task_daily: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } *//* census-trips TR256 (lane C, 2026-10-05), on this line so no cited line moves: */ /* trip_private_anchor_shares: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* trip_plan_item_audience: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* routes_api_daily_user_usage: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* routes_api_daily_trip_usage: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* routes_api_daily_usage: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* Layover 165 lane B1-R1 (3856), on this line so no cited line moves: */ /* routes_api_layover_session_usage: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* routes_api_layover_user_daily_usage: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* payments PAY-T05/T06/T07 (09 §4-§7, §10), on this line so no cited line below moves: */ /* payment_parties: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* payment_accounts: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* payment_transactions: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* payment_ledger_entries: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* payment_account_balances: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* payment_balance_rules: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* payment_retention_settings: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* Rent-a-Buddy test-mode payment slice (3931, lane B), on this line so no cited line below moves: */ /* rent_buddy_booking_payments: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* rent_buddy_payment_refunds: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* rent_buddy_monthly_payouts: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* rent_buddy_payment_recipients: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* payment_webhook_events: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* lane T, Telegraph (3651), on this line so no cited line below moves: */ /* nearby_proximity_observations: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* availability_audience_policies: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* nearby_consents: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* eta_coordination_grants: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* Lane H, mission 4 (3670), on this line so no cited line moves: */ /* memory_deletion_dead_letters: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_resurfacing_preferences: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* telegraph_thread_controls: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* telegraph_thread_member_mutes: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_corrections: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */  // ── Added 2026-09-28 for census-discovery §84 (lane W10-R1) ──
  /* lane T-PLAT (3665), on this line so no cited line moves: */ /* message_content_capabilities: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* message_forwards: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* sensing_consent_grants: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
  /* compass_live_search_usage: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* 3705 (lane L), on this line so no cited line moves: */ /* moderation_report_captures: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* B58 TM-1 (3825), on this line so no cited line moves: */ /* message_link_previews: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_crew_location_grants: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_crew_location_controls: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_visibility_policies: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_shared_experiences: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* memory_shared_experience_invitations: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* conversation_snapshots: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_recommendation_supersessions: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_crew_plans: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_crew_plan_branches: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* airport_curated_facts: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_discovery_consents: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* airport_time_band_calibrations: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_service_write_audit: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_safe_return_links: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_buddy_booking_links: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_route_subjects: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_compass_actions: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_experience_plans: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_objective_facts: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_objective_intents: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_route_dispatches: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */ /* layover_route_work: { struck off 2026-10-24, present in production (baseline/20261024_production_tables.txt) } */
};

/**
 * The legacy-root `buddy_*` names, renamed to `rent_buddy_*` long ago. They are
 * declared by migrations that still sit in the tree and will never exist in
 * production under these names.
 *
 * This set USED to carry a second job: absorbing words the `CREATE TABLE` regex
 * picked out of PROSE inside SQL comments — "if", "above", "ran", "returns",
 * "silently", "storage", "time", "not", "exists". That was a losing game. Every
 * new migration whose comment happened to contain the words "create table" cost
 * this check a false finding, and the fix each time was to add another English
 * word to a denylist — which is exactly how a ratchet quietly becomes an
 * allowlist. Two more had just arrived ("re" from 2490's "the next CREATE TABLE
 * re-issues", "receives" from 2370's "that every CREATE TABLE receives").
 *
 * They are gone because the scan no longer reads comments. stripSqlNoise below
 * removes them before the regex runs, so the check reports storage rather than
 * grammar, and this set is back to naming real tables only. Deleting the prose
 * words is also the proof: if any of them were reachable from real SQL the
 * check would now report it.
 */
const NOT_TABLE_NAMES = new Set([
  "buddy_addons", "buddy_applications", "buddy_availability", "buddy_bookings",
  "buddy_packages", "buddy_profiles", "buddy_reviews", "buddy_saved", "buddy_waitlist",
]);

/**
 * Blank out everything in a SQL file that is not executable SQL: `--` line
 * comments, block comments, single-quoted literals and dollar-quoted bodies.
 *
 * Replaced with spaces rather than deleted, so byte offsets and line structure
 * survive and nothing accidentally joins two statements together.
 *
 * A hand scanner and not a regex, because the four cases nest in ways a regex
 * gets wrong in both directions: a `--` inside a string literal is not a
 * comment, and a quote inside a comment does not open a string. Getting that
 * backwards would either resurrect the prose findings or, worse, silently drop
 * a real CREATE TABLE that happened to follow an apostrophe.
 */
export function stripSqlNoise(sql: string): string {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") { depth++; j += 2; continue; }
        if (sql.slice(j, j + 2) === "*/") { depth--; j += 2; continue; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; } // escaped quote
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    const dollar = /^\$[a-z_0-9]*\$/i.exec(sql.slice(i, i + 40));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      blank(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** The snapshot's table names: one per line, blank lines and `#` comments skipped. */
export function snapshotTableNames(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function readProductionSnapshot(): Set<string> {
  const path = join(BASELINE_DIR, PRODUCTION_SNAPSHOT);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(
      `check:production-drift: cannot read the production snapshot at ${path}.\n` +
        "This check compares the tree against a committed snapshot rather than against a\n" +
        "live database, precisely so it needs no production credentials. Without the file\n" +
        "it has verified NOTHING, so it fails rather than passing quietly.",
    );
    process.exit(2);
  }
  const names = snapshotTableNames(raw);
  if (names.length === 0) {
    console.error(`check:production-drift: ${PRODUCTION_SNAPSHOT} contains no table names.`);
    process.exit(2);
  }
  return new Set(names);
}

export function declaredTables(): Set<string> {
  const out = new Set<string>();
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi;
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = stripSqlNoise(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    for (const m of sql.matchAll(re)) {
      const name = m[1].toLowerCase();
      if (!NOT_TABLE_NAMES.has(name)) out.add(name);
    }
  }
  return out;
}

/**
 * The migration files that declare each table, so a gap can be traced to the
 * file that would close it rather than guessed at.
 */
function declaringMigrations(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi;
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = stripSqlNoise(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    for (const m of sql.matchAll(re)) {
      const name = m[1].toLowerCase();
      if (NOT_TABLE_NAMES.has(name)) continue;
      const list = out.get(name) ?? [];
      if (!list.includes(file)) list.push(file);
      out.set(name, list);
    }
  }
  return out;
}

/**
 * A snapshot cannot see the future, and this check kept blaming it for that.
 *
 * The snapshot is captured on a date; migrations are applied to production
 * after it. `trip_map_projections` and `trip_map_projection_applied` were
 * reported as production drift on 2026-09-08 for one reason only: 2520 was
 * applied on 2026-09-08 and the snapshot in the tree was taken on 2026-09-07.
 * They were in production the whole time. A check that reports a table as
 * MISSING when the honest answer is "my evidence predates it" is manufacturing
 * findings, and a ratchet entry saying "unapplied" would have been a false
 * statement committed to the repository.
 *
 * So: a gap is EXCUSED, and reported separately rather than silently, when a
 * migration that declares it appears in production-applied-migrations.json with
 * a version stamp later than the snapshot's capture date. Both files are
 * committed, so this stays offline and credential-free. It is narrow on purpose
 * — nothing is excused because it "looks recent"; the apply has to be recorded,
 * by name, with a version, in the file whose whole job is recording applies.
 *
 * It also self-heals: refresh the snapshot and the excuse evaporates, because
 * the table is then simply present.
 */
export function appliedAfterSnapshot(): Map<string, string> {
  const captureDate = PRODUCTION_SNAPSHOT.slice(0, 8); // YYYYMMDD from the filename
  const out = new Map<string, string>();
  let applied: Array<{ version: string; name: string }>;
  try {
    const raw = readFileSync(
      join(API_SERVER_ROOT, "src", "lib", "capability", "production-applied-migrations.json"),
      "utf8",
    );
    applied = (JSON.parse(raw).migrations ?? []) as Array<{ version: string; name: string }>;
  } catch {
    return out; // no ledger, no excuses
  }
  const byName = new Map(applied.map((m) => [m.name, m.version]));
  for (const [table, files] of declaringMigrations()) {
    for (const file of files) {
      const version = byName.get(file.replace(/\.sql$/, ""));
      if (version && version.slice(0, 8) > captureDate) {
        out.set(table, `${file} applied ${version}, snapshot captured ${captureDate}`);
        break;
      }
    }
  }
  return out;
}

/**
 * THE TWO RATCHET-ROT PREDICATES, exported so that exactly ONE implementation of
 * each exists and the test exercises the same code main() does.
 *
 * They used to live inline in main() and be RE-STATED in
 * productionDriftExtraction.test.ts. That was a copy, and a copy has two
 * failure modes the originals do not: it can drift from this file silently, and
 * — the one that actually bit — when the real ratchet has no `unmerged-pr`
 * member, asserting over the copy proves nothing about the rule at all. Taking
 * `gaps` and `declared` as parameters instead of reading the module constants
 * lets the test hand them a CONSTRUCTED ratchet and check that each predicate
 * discriminates, independently of what the live ratchet happens to contain.
 *
 * Both ask the TREE, never the note.
 */

/**
 * Entries classified `unmerged-pr` whose table IS declared by a migration here.
 *
 * `unmerged-pr` means "a PR declares this table; it is not drift until that PR
 * lands" — correct the day the entry is written, false the day the PR lands. If
 * a migration file in this tree declares the table, the PR has landed by
 * definition and the entry is excusing the table from the must-reach-zero total
 * with a sentence that stopped being true.
 */
export function staleUnmergedEntries(
  gaps: Record<string, Gap>,
  declared: Set<string>,
): string[] {
  return Object.entries(gaps)
    .filter(([t, g]) => g.classification === "unmerged-pr" && declared.has(t))
    .map(([t]) => t)
    .sort();
}

/**
 * Entries for a table NOTHING IN THE TREE DECLARES and production does not have.
 *
 * Not drift, not a gap: a sentence about storage no migration asks for, which
 * inflates the must-reach-zero count with work that does not exist.
 * `unmerged-pr` is exempt by definition — those tables are declared in a PR's
 * migration, which is precisely why they are not declared here. That exemption
 * is the one `staleUnmergedEntries` asks in the other direction, and neither is
 * sound without the other.
 */
export function undeclaredEntries(
  gaps: Record<string, Gap>,
  declared: Set<string>,
  production: Set<string>,
): string[] {
  return Object.entries(gaps)
    .filter(([t, g]) => g.classification !== "unmerged-pr" && !declared.has(t) && !production.has(t))
    .map(([t]) => t)
    .sort();
}

/**
 * The lines printed under a passing run's "Unapplied" list.
 *
 * The ledger line used to be printed whenever anything was unapplied, and it
 * said production has no `schema_migration_ledger`. The snapshot this check
 * reads has listed that table since 2026-09-15 (KNOWN_PRODUCTION_GAPS strikes
 * it off above), so the footer contradicted the file two screens up.
 * census-discovery §69 (DV-70) found it and §70 made it conditional: the
 * line is printed only when the snapshot does NOT list the ledger, which is
 * the only case in which it is true.
 */
export const LEDGER_TABLE = "schema_migration_ledger";

export function unappliedFooter(unapplied: readonly string[], production: ReadonlySet<string>): string[] {
  if (unapplied.length === 0) return [];
  const lines = ["\n  Unapplied — code in the tree pointed at storage production does not have:"];
  for (const t of unapplied) lines.push(`    ${t}`);
  if (!production.has(LEDGER_TABLE)) {
    lines.push(
      "\n  schema_migration_ledger is the one to fix first: without it, nothing can\n" +
        "  establish which migrations production has, and apply-migrations.ts cannot run there.",
    );
  }
  return lines;
}

function main(): void {
  const production = readProductionSnapshot();
  const declared = declaredTables();
  const excused = appliedAfterSnapshot();

  const gaps = [...declared].filter((t) => !production.has(t)).sort();
  const unrecorded = gaps.filter((t) => !(t in KNOWN_PRODUCTION_GAPS) && !excused.has(t));
  // Stale means "production has it", and the snapshot is not the only way to
  // know that. A ratcheted table that appliedAfterSnapshot excuses IS in
  // production -- we recorded the apply ourselves -- so leaving it on the
  // ratchet keeps a false "unapplied" claim in the repository, which is the
  // exact thing this ratchet is supposed to prevent.
  const struckOff = Object.keys(KNOWN_PRODUCTION_GAPS)
    .filter((t) => production.has(t) || excused.has(t))
    .sort();

  console.log(
    `Compared ${declared.size} table(s) declared in src/migrations against ` +
      `${production.size} table(s) in the production snapshot (${PRODUCTION_SNAPSHOT}).`,
  );
  console.log("  no credentials were used, and no database was contacted.");
  const excusedHere = [...excused.keys()].filter((t) => !production.has(t)).sort();
  if (excusedHere.length > 0) {
    console.log(
      `  ${excusedHere.length} table(s) are absent from the snapshot only because it predates their apply:`,
    );
    for (const t of excusedHere) console.log(`    ${t} — ${excused.get(t)}`);
    console.log("  Refresh the snapshot and these stop needing an explanation.");
  }
  console.log("");

  let failed = false;

  if (unrecorded.length > 0) {
    failed = true;
    console.error(
      `✖ ${unrecorded.length} table(s) are declared in the tree, absent from production, and NOT on the ratchet:`,
    );
    for (const t of unrecorded) console.error(`    ${t}`);
    console.error(
      "\n  Each needs an entry in KNOWN_PRODUCTION_GAPS with a classification and a\n" +
        "  reason, OR the migration needs applying to production. Do not add an entry\n" +
        "  without a reason — an entry with no reason is how this becomes an allowlist.",
    );
  }

  if (struckOff.length > 0) {
    failed = true;
    console.error(
      `\n✖ ${struckOff.length} ratcheted table(s) now EXIST in production and were not struck off:`,
    );
    for (const t of struckOff) console.error(`    ${t}`);
    console.error("\n  Remove them from KNOWN_PRODUCTION_GAPS. A ratchet nobody prunes stops being read.");
  }

  // A third way this ratchet rots, and the one nothing was watching: an entry
  // for a table that NOTHING IN THE TREE DECLARES. It is not drift, it is not a
  // gap, it is a sentence about storage no migration asks for -- and it inflates
  // the "must reach zero" count with work that does not exist. `unmerged-pr` is
  // exempt by definition: those tables are declared in a PR's migration, which
  // is precisely why they are not declared here.
  const undeclared = undeclaredEntries(KNOWN_PRODUCTION_GAPS, declared, production);

  if (undeclared.length > 0) {
    failed = true;
    console.error(
      `\n✖ ${undeclared.length} ratcheted table(s) are declared by NO migration in the tree:`,
    );
    for (const t of undeclared) console.error(`    ${t}`);
    console.error(
      "\n  Either the migration was deleted and the entry should go with it, or the\n" +
        "  entry names a table that never existed. Reclassify as unmerged-pr only if a\n" +
        "  real unmerged PR declares it.",
    );
  }
  // ── STALE UNMERGED-PR: the exemption above, asked in the other direction ────
  //
  // `unmerged-pr` means "a PR declares this table; it is not drift until that PR
  // lands". That is correct the day the entry is written and wrong the day the
  // PR lands, and until 2026-09-14 nothing watched for the second day.
  //
  // It had already happened once. `sensing_anon_contributions` carried
  // "PR #475 (UNMERGED) ... Not drift until that PR lands" while
  // 2315_sensing_anon_contributions.sql sat on main — it reached main inside
  // #476, so no commit subject ever named #475 and the sentence stayed
  // plausible. The effect was not cosmetic: an `unmerged-pr` entry is excused
  // from the MUST-REACH-ZERO total, so a landed migration was being counted as
  // somebody else's problem.
  //
  // The question is mechanical and asks the TREE, never the note: if a migration
  // file in this tree declares the table, the PR has landed by definition.
  const staleUnmerged = staleUnmergedEntries(KNOWN_PRODUCTION_GAPS, declared);

  if (staleUnmerged.length > 0) {
    failed = true;
    const declaring = declaringMigrations();
    console.error(
      `\n✖ ${staleUnmerged.length} table(s) are classified 'unmerged-pr' but a migration in THIS TREE declares them:`,
    );
    for (const t of staleUnmerged) {
      console.error(`    ${t} — declared by ${(declaring.get(t) ?? ["(unknown)"]).join(", ")}`);
    }
    console.error(
      "\n  The PR has landed, so the classification is false and the table is being\n" +
        "  excused from the must-reach-zero total by a sentence that stopped being\n" +
        "  true. Reclassify each as 'unapplied', or strike it off if production has it.",
    );
  }


  const unapplied = Object.entries(KNOWN_PRODUCTION_GAPS).filter(
    ([t, g]) => g.classification === "unapplied" && !production.has(t),
  );

  if (!failed) {
    console.log(
      `✓ No unrecorded production drift. ${Object.keys(KNOWN_PRODUCTION_GAPS).length} table(s) on the ratchet, ` +
        `of which ${unapplied.length} are UNAPPLIED and must reach zero.`,
    );
    for (const line of unappliedFooter(unapplied.map(([t]) => t), production)) console.log(line);
  }

  process.exit(failed ? 1 : 0);
}

// Only when RUN, never when imported. This module used to call main()
// unconditionally at import time, and main() ends in process.exit — so the
// first test file that imported it to unit-test its extraction functions
// reported "1 test, 1 pass" and exited 0 while ten assertions had never been
// reached. A false green produced by the check's own entry point.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
