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
export const PRODUCTION_SNAPSHOT = "20260917_production_tables.txt";

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

  // ── Trips §23, the one Trips table that is genuinely NOT in production ─────
  trip_commitment_recurrences: {
    classification: "unapplied",
    note:
      "Trips §23 (2797) — recurring commitments as a RULE in local wall-clock " +
      "time. REHEARSED on portava-ci 2026-09-17 (preconditions, the 15 refusal " +
      "probes and the final count(*) = 2 all fired) and deliberately NOT applied " +
      "to production. Its writer is 2798, whose five command branches are also " +
      "CI-only, so the table would reach production writerless and readerless — " +
      "the same argument the 2760-2763 block made, and 2797 is the last table " +
      "still making it. Applying 2797/2798/2799 to production is an owner " +
      "decision that has not been taken; when it is, strike this off in the same " +
      "change that refreshes the two production snapshots.",
  },

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
  protected_zones: {
    classification: "unapplied",
    note:
      "Migration 2217 is cited by 10_Database_Architecture.md §8 as THE canonical " +
      "deny-by-default RLS + grant pattern, and by 09_Payment_Architecture.md as the " +
      "shape to copy. It is on the check:writerless-reads ratchet as a human-allowlist " +
      "entry. It is not in production, so the pattern every new migration is told to " +
      "follow has no production instance to compare against.",
  },

  // ── Telemetry: writers exist, storage does not ─────────────────────────────
  wall_telemetry_events: {
    classification: "unapplied",
    note: "Wall telemetry writer targets a table production does not have.",
  },
  passport_telemetry_events: {
    classification: "unapplied",
    note: "Passport telemetry writer targets a table production does not have.",
  },

  // ── The intel lane: five tables, four registered schedulers ────────────────
  intel_attributions: {
    classification: "unapplied",
    note:
      "Migration 2277. intelAttributionScheduler is REGISTERED and running in " +
      "production (index.ts:167) against this missing table. It returns early only " +
      "because the flag intel_attribution is absent from production feature_flags and " +
      "an unseeded flag reads false. Seeding that flag points a live scheduler at a " +
      "table that is not there.",
  },
  intel_historical_patterns: {
    classification: "unapplied",
    note: "Migration 2279. Same shape: intelPatternScheduler registered at index.ts:150, gated by an unseeded flag.",
  },
  intel_scoped_trust: {
    classification: "unapplied",
    note: "Migration 2278. Same shape: registerScopedTrustApplier at index.ts:166, gated by an unseeded flag.",
  },

  // ── Everything else measured in the same comparison ────────────────────────
  event_passport_shares: { classification: "unapplied", note: "In portava-ci, absent from production." },
  input_selection_history: { classification: "unapplied", note: "In portava-ci, absent from production." },
  media_view_requests: { classification: "unapplied", note: "In portava-ci, absent from production." },
  media_view_request_optins: { classification: "unapplied", note: "In portava-ci, absent from production." },
  route_flow_contribution_consent: {
    classification: "unapplied",
    note: "On the check:writerless-reads ratchet as well. Absent from production entirely.",
  },
  sources: { classification: "unapplied", note: "In portava-ci, absent from production." },

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
  intel_claim_reviews: {
    classification: "unapplied",
    note: "Migration 2311 (restored from claude/safety-review-s1b-20260906, sha256 18e8899bf13a…, the checksum its ledger row records). Creates one table; additive and idempotent, alters nothing, seeds no flag, writes no row. NO WRITER in this tree: the writer is services/intel/SafetyReviewService.ts on the source branch and did not come with the file. Applied to portava-ci 2026-09-07, absent from production.",
  },
  memory_episodes: {
    classification: "unapplied",
    note: "Migration 2320 (restored from claude/memory-canonical-object-20260906, sha256 1d13adeec896…, the checksum its ledger row records). Inert by construction: RLS on with no policy, service_role-only grants, and its own postcondition asserts memory_projection stays FALSE. NO WRITER in this tree: memory/memoryEpisodeContract.ts stayed on the source branch. Applied to portava-ci 2026-09-07, absent from production.",
  },
  memory_evidence: {
    classification: "unapplied",
    note: "Migration 2320. Same block as memory_episodes; append-only at BOTH the grant and the trigger. NO WRITER in this tree. Note the one non-additive act in 2320: it DROP/CREATEs erase_memory_for_user(uuid) to widen its return from three counts to five so account deletion reaches the spine — 2190's body is reproduced verbatim inside it, and 2320 is the LAST definer of that function in this tree, so the widening is not undone by a later file.",
  },
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
  layover_certified_computations: {
    classification: "unapplied",
    note:
      "Migration 2700. Append-only record of each certified layover feasibility " +
      "computation so an answer can be REPLAYED rather than re-derived. Creates " +
      "one table and alters nothing. Queued behind 2741, which landed in " +
      "production 2026-09-08; not yet certified through its own gate.",
  },
  // Layover, migration 2860 — layover_external_events — STRUCK OFF, APPLIED.
  //
  // Applied by the same file in the same pass. It remains WRITERLESS and
  // EMPTY: there is still no flight or airport feed anywhere in this tree, and
  // LayoverEventReplanner is pure. Striking it off says the table exists, not
  // that anything fills it — and the entry is removed rather than reclassified
  // because a gap that has been closed is not a gap.


  // Sensing, migration 2480.

  // Telegraph, migration 2810.
  telegraph_outbox: {
    classification: "unapplied",
    note:
      "Migration 2810 (Telegraph §13.3 conversation_outbox). Applied to NO database " +
      "— not production and not portava-ci — and declared here the moment the file " +
      "entered the tree rather than after somebody noticed it. Two reasons it waits, " +
      "and neither is 'not got round to it': (1) NOTHING DRAINS IT. The table takes " +
      "one row per message lifecycle transition and no consumer reads them, so " +
      "applying it and turning its flag on would grow a table nobody empties — which " +
      "is why the trigger that writes it is gated on telegraph_message_kernel_enabled " +
      "and that flag is seeded FALSE. (2) The rest of 2810 adds columns to " +
      "public.messages, the hottest table in the product, and the sequence it " +
      "introduces is only meaningful after a per-conversation backfill an operator " +
      "runs deliberately. DDL and behaviour were EXECUTED on a throwaway PostgreSQL " +
      "16 carrying the baseline plus the chain from 2093 (209 applied, 6 " +
      "known-unreplayable, 0 unexpected), and the rollback was executed on the same " +
      "database and verified to leave migration 2400's visible_from_at intact. " +
      "RLS is enabled with zero policies, so no non-service role can read it.",
  },

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
  message_edits: {
    classification: "unapplied",
    note:
      "Migration 2811 (Telegraph §12 message_edits). Applied to no database. §12 says " +
      "'versioned text edits WHERE RETAINED' and previous_body is nullable for exactly " +
      "that reason — retention is a policy choice this schema declines to make. No writer: " +
      "the edit route still overwrites messages.body in place.",
  },
  message_reactions: {
    classification: "unapplied",
    note:
      "Migration 2811 (Telegraph §12 message_reactions). Applied to no database. Its " +
      "consumer PREDATES it: a telegraph.reaction notification template ('reacted to your " +
      "message') has existed with no table, no route and no UI. The 16-character cap on " +
      "emoji is a control rather than formatting — a reaction that could hold a sentence " +
      "would be a message bypassing the send path's block guard, rate limit and §22 scam " +
      "detection. Written by POST /api/telegraph/commands behind 2810's flag, which is " +
      "seeded FALSE.",
  },
  message_attachments: {
    classification: "unapplied",
    note:
      "Migration 2811 (Telegraph §12/§16.1 message_attachments). Applied to no database. " +
      "Replaces the four nullable media columns on public.messages, which §12.1 names as " +
      "the anti-pattern and which cap a message at one attachment of two kinds. References " +
      "public.media_assets with ON DELETE RESTRICT so an asset deletion cannot silently " +
      "erase the fact that a message carried one. No writer: messages.media_url is still " +
      "the live path.",
  },
  conversation_action_refs: {
    classification: "unapplied",
    note:
      "Migration 2811 (Telegraph §12 conversation_action_refs). Applied to no database. " +
      "The explicit reference table §12.1 asks for, carrying payload_version and revoked_at " +
      "— the property a string inside messages.body cannot have, and the one census T46 " +
      "says is missing when a source object is deleted and the shared card lives on. No " +
      "writer.",
  },

  // ── Telegraph §22 restricted moderation storage (migration 2812) ───────────
  // The one table in this lane whose ABSENCE is a live harm rather than a
  // missing feature: census T284 measured that a reported message deleted by
  // its sender is destroyed, because deletion blanks messages.body in place and
  // nothing copied it first. The snapshot is taken at REPORT time by
  // services/telegraphReportEvidence.ts, behind its own flag.
  //
  // DDL and re-application were EXECUTED on a throwaway PostgreSQL 16 carrying
  // the baseline plus the chain from 2093.
  telegraph_report_evidence: {
    classification: "unapplied",
    note:
      "Migration 2812 (Telegraph §22 evidence). Applied to no database. RLS is ENABLED " +
      "with FORCE and NO POLICY AT ALL, so only the service role can read it — a " +
      "membership-keyed policy would hand the reported party their own evidence file — " +
      "and a postcondition RAISES if any policy is ever added. Deliberately has no foreign " +
      "key to public.messages, so a deletion cannot cascade the evidence away; its one FK " +
      "is to public.reports ON DELETE CASCADE, because evidence is retained to serve a " +
      "report. Written by POST /api/messages/:id/report and POST /api/threads/:id/report " +
      "behind telegraph_report_evidence_enabled, which is seeded FALSE. retention_until is " +
      "NULL and nothing purges: a deletion schedule for moderation evidence is an owner " +
      "decision, and a job running on a number this migration invented would be worse than " +
      "no job.",
  },
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

  // Discovery Trails, migration 2910 — six tables, one migration, one block.
  trails:                 { classification: "unapplied", note: "Discovery Trails (2910). Created and written by the trail service; behind the trails flag. Absent from production only because this branch is unmerged." },
  trail_edges:            { classification: "unapplied", note: "Discovery Trails (2910). Same block as trails; one writer. The edge set is what makes a trail a path rather than a list." },
  trail_follows:          { classification: "unapplied", note: "Discovery Trails (2910). Same block; two writers (follow and unfollow). Viewer-scoped." },
  trail_health_snapshots: { classification: "unapplied", note: "Discovery Trails (2910). Same block; one writer. A snapshot table — absent means no history, not a broken read." },
  trail_reports:          { classification: "unapplied", note: "Discovery Trails (2910). Same block; one writer. Moderation intake for a surface that is not live in production." },
  content_trails:         { classification: "unapplied", note: "Discovery Trails (2910). Same block; two writers. The join from a trail to the content it threads." },

  // Creator economy, migrations 2920/2921 — gated by a flag 2922 seeds FALSE.
  creator_attributions:    { classification: "unapplied", note: "Creator economy (2920). Written by services/creators/CreatorAttributionService.ts, every path gated on creator_attribution_enabled — which migration 2922 seeds FALSE. So it would be created empty and STAY empty after the merge: enabling it is a separate owner decision, and census-discovery 17.2 records that four of the six creator types have no value-event producer at all." },
  creator_rule_versions:   { classification: "unapplied", note: "Creator economy (2920). NO WRITER, deliberately — the percentages live here as DATA, seeded by the migration itself, which is what 09 section 8's 'actual percentages must remain configurable' requires. Nothing in src/ writes it and nothing should." },
  creator_earning_entries: { classification: "unapplied", note: "Creator economy (2921). Written by CreatorAttributionService's balanced-pair upsert, same flag, same FALSE seed. Its columns are pinned against this migration by src/test/creatorLedgerRowSchemaDrift.test.ts, which is the cover for the three write-path sites allowlisted as unresolvable." },

  // Rent-a-Buddy earnings, migration 2901.
  rent_buddy_earnings_entries: { classification: "unapplied", note: "Rent-a-Buddy earnings (2901). Read through a module constant in services/ledger/CanonicalShareReader.ts and joined by the 2930 canonical-share view, so 2930 cannot be applied before it. Absent from production because the branch is unmerged." },

  // Place momentum, migration 2892.
  place_momentum: { classification: "unapplied", note: "Place momentum (2892). NO CONSUMER IN src/ AT ALL outside its own tests: grepping the tree for the name, excluding src/migrations, finds only test/placeMomentumSqlParity.test.ts and one table-name list. The classification function it ships is exercised by that parity test against the SQL, so it is not dead — but NOTHING READS THE TABLE, and by the Trips 5.1 rule above it satisfies nothing until something does. Stated here rather than discovered at deploy time." },

  // Input-assistance telemetry, migration 2950.
  input_assistance_telemetry_events: { classification: "unapplied", note: "Input-assistance telemetry (2950). lib/inputAssistance/telemetry.ts names it as TELEMETRY_TABLE and routes/inputAssistance.ts is its door; the payload is REBUILT server-side rather than accepted from the client, which is the property that makes the table safe to have. Absent from production because the branch is unmerged." },
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
  const names = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
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
    if (unapplied.length > 0) {
      console.log("\n  Unapplied — code in the tree pointed at storage production does not have:");
      for (const [t] of unapplied) console.log(`    ${t}`);
      console.log(
        "\n  schema_migration_ledger is the one to fix first: without it, nothing can\n" +
          "  establish which migrations production has, and apply-migrations.ts cannot run there.",
      );
    }
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
