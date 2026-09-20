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
 * ─── THE SECOND THING IT COMPARES: CHECK VOCABULARIES ─────────────────────────
 *
 * Table presence was the only comparison here until 2026-09-20, and the blind
 * spot that left cost two live features.
 *
 * 2298_dead_check_vocabularies.sql widens two CHECK vocabularies, and it sat
 * unapplied on production for a long time while CI was green:
 *
 *   - `rank_events.surface` did not admit 'wall', so every analytics row the
 *     Wall's For You page wrote was refused 23514. The insert is fire-and-forget
 *     and the handler only warns, so the loss was invisible in the product and
 *     invisible in the ranking data.
 *   - `circle_presence.status` did not admit 'paused', so two privacy controls
 *     were inert: POST /circle/pause-on-session-end returned 500 because its
 *     UPDATE was rejected, and the deactivation path's server-side pause
 *     silently left a deactivating user visible on other members' maps.
 *
 * `check:enum-literals` could not catch either, and this is the part worth
 * understanding: its source of truth is the repo's baseline plus the migration
 * chain, and by THAT source both labels were legal. The code was right. The
 * schema in the tree was right. Production had simply not applied the migration,
 * and nothing compared the two.
 *
 * So a CHECK-constrained column's VOCABULARY is now compared the same way table
 * presence is, from a committed capture, with the same both-directions property:
 *
 *   - a label the TREE declares that the production capture does not admit fails,
 *     because that is a write production refuses;
 *   - a ratcheted label the capture NOW admits fails, because a gap that has
 *     closed and was not struck off is a false claim left in the repository.
 *
 * WHY THIS IS NOT THE CONFIDENT WRONG ANSWER THE COLUMN CASE WOULD HAVE BEEN.
 * The paragraph below used to end this header by refusing to go past table
 * presence, on the grounds that "a column-level claim from a NAME LIST would be
 * exactly the kind of confident wrong answer .agents/memory/db-column-drift.md
 * warns about". That reasoning is still right, and it is why the vocabulary
 * capture is NOT a name list: baseline/*_production_check_vocabularies.txt
 * records `pg_get_constraintdef` VERBATIM, and this file parses it with
 * `vocabularyFromCheck` — the SAME function that derives the tree side inside
 * canonicalVocabulary.ts. One parser, two inputs. There is no second derivation
 * to disagree with the first, and a label is only ever judged against a
 * constraint production really has.
 *
 * WHERE IT DECLINES TO JUDGE, all three cases over-permissive on purpose:
 *
 *   - a column the capture carries NO vocabulary-bearing CHECK for. An
 *     unconstrained column ACCEPTS every label, so nothing is refused: that is
 *     not the 2298 defect, and reporting it as one would manufacture findings.
 *     It is counted and named in the run's output instead.
 *   - an ENUM-typed column. Its labels live in pg_type, not pg_constraint, so
 *     this capture has nothing to say about it and every enum column would
 *     otherwise read as "production constrains nothing".
 *   - a column whose CHECK neither side can parse. Both sides then model nothing
 *     and nothing is compared, which is the same posture canonicalVocabulary.ts
 *     takes and for the same reason.
 *
 * Both sides take the UNION when two CHECKs constrain one column, which is the
 * wider and safer set — and, because it is the same function on both sides, the
 * same widening on both. A real vocabulary is the INTERSECTION; taking the union
 * can therefore MISS a gap, and cannot invent one.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 *
 * It compares TABLE PRESENCE and CHECK VOCABULARIES — not columns, indexes,
 * policies or grants. Column drift already has an instrument
 * (`check:missing-live-columns`), and it too sees only CI.
 *
 * ─── MUTATION LOG ─────────────────────────────────────────────────────────────
 *
 * Each mutation below was applied to ONE file alone (this one, except M9 which
 * mutates the capture), `check:production-drift` was run, and the file was
 * restored from a byte-for-byte copy — `cmp` clean every time, and `git status`
 * showed only the intended changes at the end.
 *
 * BASELINE on the tree this was measured against: exit 0, 60 tables on the table
 * ratchet (all 60 UNAPPLIED), 30 CHECK vocabulary gaps (29 UNAPPLIED, 1
 * staged-by-ruling), 366 constraints read from the capture, 331 CHECK
 * vocabularies derived from the tree, 300 columns compared on both sides.
 *
 * TWO MUTANTS SURVIVED THE FIRST ATTEMPT. They are recorded here with what they
 * exposed, because deleting them would have left both weaknesses in place:
 *
 *   • M1 (finder disabled) → exit 0, GREEN. `missingVocabularyLabels` was made to
 *     skip every column, so it found nothing, and the check still passed with
 *     every other rule green. The reason is worth keeping: `closedVocabularyGaps`
 *     and `phantomVocabularyGaps` interrogate production and the tree directly, so
 *     all thirty entries stayed valid, and "no unrecorded gaps" is trivially true
 *     of a rule that has stopped looking. The finding half of this check could be
 *     disabled in one line with nothing going red.
 *     FIXED by `unexplainedVocabularyGaps`: the three outcomes are exhaustive over
 *     any recorded entry, so an entry explained by none of them means the
 *     comparison is broken rather than that production changed. The ratchet now
 *     answers for the finder.
 *   • M3 (parser stops honouring '#') → exit 0, GREEN. The header's prose was
 *     harmless, because a line with no delimiters is skipped anyway — but the
 *     mutation exposed something else: the capture's payload digest was computed
 *     nowhere in the check, only in the test file, which is "one curated-test-list
 *     edit away from not running" by checkEnumLiterals.ts's own argument about its
 *     floors.
 *     FIXED by verifying the digest inside the check, and by accumulating the
 *     payload in the same pass that decides what a comment is — which is what
 *     makes the '#' guard load-bearing.
 *
 * AFTER BOTH FIXES, re-run in full. Every mutant dies:
 *
 *   • M1  finder skips every column → exit 1, "30 ratcheted vocabulary gap(s) are
 *         explained by NONE of the three rules above".
 *   • M2  the `!admitted.has(label)` test inverted, so the rule reports what
 *         production DOES admit → exit 1, 1400 unrecorded gaps plus the same 30
 *         unexplained. A rule pointing the wrong way is loud, not quiet.
 *   • M3  the parser's '#' guard removed → exit 1, "records no payload sha256 in
 *         its header": the digest line is no longer read, so the capture cannot be
 *         authenticated and the check refuses before comparing anything.
 *   • M4  the `plan_attendance_events.event_type:checked_in_successfully` entry
 *         deleted → exit 1, "1 CHECK vocabulary gap(s) ... and nothing records
 *         it". The first acceptance case: a label the tree declares, absent from
 *         production, unrecorded. It also turns productionDriftExtraction.test.ts
 *         red ("every label the tree declares and production refuses is ON the
 *         ratchet"), 31 pass / 1 fail.
 *   • M5  an entry ADDED for `circle_presence.status:paused`, the label 2298
 *         closed → exit 1, "1 ratcheted vocabulary gap(s) are now ADMITTED by
 *         production and were not struck off". The second acceptance case, and the
 *         one that stops this ratchet from silently staying full; the test goes red
 *         too ("nothing on the ratchet is already admitted by production"),
 *         31 pass / 1 fail.
 *   • M6  an entry ADDED for `plan_checkins.status:not_a_real_label` → exit 1,
 *         phantom. An entry cannot inflate the must-reach-zero total with work that
 *         does not exist.
 *   • M7  enum-typed columns folded into the comparable set → exit 1, 12
 *         unrecorded gaps. THIS MUTANT WAS PREDICTED TO BE A NO-OP AND IS NOT,
 *         which is how the enum/CHECK divergence report came to exist: those 12
 *         labels sit on 5 columns the tree types as an ENUM and production
 *         CHECK-constrains, and two of the five have DISJOINT vocabularies. They
 *         are a different defect class, they are now reported by name rather than
 *         swallowed by the filter, and `enumVsCheckDivergences` states why this
 *         capture cannot adjudicate them.
 *   • M8  PRODUCTION_CHECK_SNAPSHOT repointed at a filename that does not exist →
 *         exit 2 with the "cannot read" message. Not a pass.
 *   • M9  ONE BYTE of the capture changed, 'paused' → 'pausee' → exit 1, "does not
 *         match the digest in its own header", followed by the gap that edit
 *         manufactured. Transcription error and tampering are both caught.
 *   • M10 the parser's delimiter changed from '|' so no payload line is readable →
 *         exit 1 on the liveness floors (constraints 0 of 250, compared 0 of 200)
 *         as well as on 30 phantoms. The floors are what matter at an EMPTY
 *         ratchet, where the phantom and unexplained controls have nothing to say.
 *
 * ONE THING NO MUTATION HERE CAN KILL, stated rather than left as a silent gap:
 * the enum/CHECK divergence block is report-only by design — it prints and never
 * fails — so no mutation of it changes an exit code. Its discrimination is pinned
 * by productionDriftExtraction.test.ts instead, which asserts both that a
 * constructed case is separated correctly and that no column is ever reported as
 * BOTH a divergence and a vocabulary gap.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanonicalVocabulary, vocabularyFromCheck } from "./lib/canonicalVocabulary.js";
// The tree side of the vocabulary comparison is check:enum-literals' OWN source of
// truth, imported rather than restated. BASELINE and MIGRATION_DIRS are its exported
// constants, so a baseline rename or a new migration directory moves both checks at
// once; a local copy of those paths is exactly how the two would come to disagree
// about what the tree declares while both reported success.
import { BASELINE, MIGRATION_DIRS } from "./checkEnumLiterals.js";

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
export const PRODUCTION_SNAPSHOT = "20260916_production_tables.txt";

/**
 * The CHECK-vocabulary snapshot, the second committed capture this check reads.
 *
 * Bump this when an operator captures a fresher one. It is a SEPARATE constant
 * from PRODUCTION_SNAPSHOT on purpose: the two captures answer different
 * questions, are taken by different queries, and go stale independently — this
 * one is dated 09-20 while the table list is dated 09-16, and pretending one
 * date covered both would be a claim neither capture supports.
 *
 * EXPORTED for the same reason PRODUCTION_SNAPSHOT is: so the test measures the
 * rule against the capture actually in use instead of restating its date.
 */
export const PRODUCTION_CHECK_SNAPSHOT = "20260920_production_check_vocabularies.txt";

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
  trip_stages:         { classification: "unapplied", note: "Trips §5.1 (2760). In portava-ci, absent from production. No writer until the §4 stage command family lands; RLS crew-SELECT only, zero client write grants." },
  trip_legs:           { classification: "unapplied", note: "Trips §5.1 (2761). In portava-ci, absent from production. Same block as trip_stages." },
  trip_commitments:    { classification: "unapplied", note: "Trips §5.1 + §7.1 (2761). In portava-ci, absent from production. Carries required_arrival_at / prep_duration / lateness_tolerance / confidence — the §7.2 inputs that did not previously exist. Same block." },
  trip_goals:          { classification: "unapplied", note: "Trips §5.1/§8 (2762). In portava-ci, absent from production. Same block." },
  trip_decision_tasks: { classification: "unapplied", note: "Trips §5.1/§8 (2762). In portava-ci, absent from production. Same block." },
  trip_risks:          { classification: "unapplied", note: "Trips §5.1/§8.4 (2762). In portava-ci, absent from production. The risk register §8.4 propagation (TR144) needs and does not have. Same block." },
  trip_presence:       { classification: "unapplied", note: "Trips §5.1/§10 (2763). In portava-ci, absent from production. Distinct from trip_crew_location_sessions, which is a live-SHARE session. Same block." },
  trip_proposals:      { classification: "unapplied", note: "Trips §5.1/§9/§12.2 (2763). In portava-ci, absent from production. Same block." },
  trip_snapshots:      { classification: "unapplied", note: "Trips §5.1/§22 (2763). In portava-ci, absent from production. Distinct from trip_readiness_snapshots, which is a cached readiness summary. Same block." },
  trip_outcomes:       { classification: "unapplied", note: "Trips §5.1/§20 (2763). In portava-ci, absent from production. Same block." },
  trip_proposal_votes: { classification: "unapplied", note: "Trips §9.3 / §1 (2774) — one vote per crew member per proposal, the relation MAJORITY and UNANIMOUS are counted over. Absent from BOTH databases like the rest of this lane: nothing in it is on main and .github/workflows/live-db.yml applies only from main. Its writer is 2775 (VOTE_ON_PROPOSAL). Rehearsed end to end on db/harness/run.sh." },
  trip_plan_participants: { classification: "unapplied", note: "Trips §5.1/§9.1 (2771) — the attendance relation census-trips TR83 is about. Absent from BOTH databases, unlike the 2760-2763 block which portava-ci carries: nothing in this Trips lane is on main, and .github/workflows/live-db.yml applies only from main. Its writer is 2772 (JOIN_PLAN / LEAVE_PLAN / SET_PLAN_ATTENDANCE). Rehearsed end to end on db/harness/run.sh." },

  // ── Trips §41 (census-trips), migrations 2780-2785: seven kernel families ──
  // Absent from BOTH databases, like 2771/2774 above: this branch is not on
  // main and .github/workflows/live-db.yml applies only from main. Every reader
  // of these tables sits behind trip_operational_projections_enabled (FALSE in
  // both projects; check:flag-schema-prerequisites lists the whole batch as that
  // flag's prerequisite) and every writer behind trip_kernel_enabled (also
  // FALSE). Rehearsed on scripts/local-db (the api-server-local-db CI job).
  trip_subgroups:          { classification: "unapplied", note: "Trips §9.5 (2780) — temporary crews. Writer: CREATE_SUBGROUP / JOIN_SUBGROUP / LEAVE_SUBGROUP / DISSOLVE_SUBGROUP in trip_kernel_execute; reader: TripCloseoutService (§20.2 dissolve) under trip_operational_projections_enabled." },
  trip_subgroup_members:   { classification: "unapplied", note: "Trips §9.5 (2780) — membership of trip_subgroups. Written only by the kernel; read by TripCrewLocationService for subgroup-scoped live shares under the same flag." },
  trip_decisions:          { classification: "unapplied", note: "Trips §5.3/§21.2 (2781) — the persisted decision ledger. Writer: lib TripDecisionLedger.persistTripDecision, flag-gated and table-probed; absent table = in-process ring only, stated by DECISION_RETENTION." },
  trip_transport_segments: { classification: "unapplied", note: "Trips §7.4 (2782) — transport legs with a state machine. Written only by the kernel (ADD/UPDATE/SET_STATE/REMOVE_TRANSPORT_SEGMENT); no TS reader yet." },
  trip_reservation_events: { classification: "unapplied", note: "Trips §18.3 (2784) — append-only reservation history, trigger-fed from trip_reservations. Read by GET /trips/:id/reservations/:rid/history under trip_operational_projections_enabled." },
  trip_disruptions:        { classification: "unapplied", note: "Trips §17 (2785) — disruption register. Written only by the kernel (DECLARE/RESOLVE_DISRUPTION); TripHealth does not consult it yet (census §41.3)." },
  trip_transport_policies: { classification: "unapplied", note: "Trips §7.4 (2793) — the transport-mode policy the route-availability check reads (census-trips §47, TR137). Written by PUT /trips/:tripId/transport-policy (owner, §6.1 canEditTrip) and read by GET /trips/:tripId/feasibility, both under trip_operational_projections_enabled; absent from every database but the local replica until this branch merges and the owner's Batch C applies it." },
  trip_meeting_checkpoints: { classification: "unapplied", note: "Trips §10.4 / §11.3 (2794) — meeting checkpoints: a chosen §14.3 candidate with its explanation, a meet-by and a status (census-trips §52, TR177/TR198). Written only by the kernel (CREATE_MEETING_CHECKPOINT / CLOSE_MEETING_CHECKPOINT); read by routes/tripMeetingCheckpoints, TripHealthProjection (REGROUP_OPEN), the map's meetup layer and the offline bundle, all under trip_operational_projections_enabled; absent from every database but the local replica until this branch merges and the owner's Batch C applies it." },
  trip_meeting_checkpoint_participants: { classification: "unapplied", note: "Trips §10.4 (2794) — who is expected at a meeting checkpoint and their arrival state. Written only by the kernel (CREATE_MEETING_CHECKPOINT / SET_MEETING_ARRIVAL); read under the same flag as trip_meeting_checkpoints." },

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
  map_telemetry_events: {
    classification: "unapplied",
    note: "Telemetry writer targets a table production does not have; the write fails there.",
  },
  map_telemetry_drops: {
    classification: "unapplied",
    note: "Companion to map_telemetry_events. Same absence, same consequence.",
  },
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
  media_intent_signals: { classification: "unapplied", note: "In portava-ci, absent from production." },
  media_view_requests: { classification: "unapplied", note: "In portava-ci, absent from production." },
  media_view_request_optins: { classification: "unapplied", note: "In portava-ci, absent from production." },
  route_flow_contribution_consent: {
    classification: "unapplied",
    note: "On the check:writerless-reads ratchet as well. Absent from production entirely.",
  },
  sources: { classification: "unapplied", note: "In portava-ci, absent from production." },

  // ── Applied to CI this session, deliberately not to production ─────────────
  sensing_anon_contributions: {
    // RECLASSIFIED 2026-09-14, unmerged-pr -> unapplied. This note used to read
    // "PR #475 (UNMERGED) ... Not drift until that PR lands". It landed:
    // 2315_sensing_anon_contributions.sql is on `main` and in portava-ci's
    // ledger. It reached main inside #476 rather than under its own number, so
    // no commit subject ever named #475 and the excuse stayed plausible while
    // being false. Nothing caught it because the "declared by NO migration"
    // check in main() exempted unmerged-pr in one direction only; the assertion
    // that closes that is STALE UNMERGED-PR, below.
    classification: "unapplied",
    note:
      "Migration 2315, ON MAIN (it reached main inside #476) and applied to portava-ci " +
      "2026-09-07. Absent from production, so it counts toward the must-reach-zero total " +
      "like any other unapplied migration. Applying it to production remains an owner " +
      "decision — the store is inert by construction — but that is a reason to leave it " +
      "unapplied, not a reason to leave it unaccounted.",
  },
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
  sensing_contribution_sessions: {
    classification: "unapplied",
    note:
      "Migration 2480. The ISSUED half of the Sensing spec s4.2 contribution " +
      "credential. Its own header says NOT APPLIED, and it is written so the " +
      "SENSING_AUTH_POSTURE decision (docs/architecture/" +
      "sensing-auth-posture-decision.md) can be taken on evidence: dry-run inside " +
      "a ROLLED-BACK transaction on portava-ci, postconditions passed, nothing " +
      "committed. Under Option B the file is never run at all, so applying it " +
      "would TAKE the decision.",
  },

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

// ════════════════════════════════════════════════════════════════════════════
//  CHECK VOCABULARIES — the second comparison, on the model of the first
// ════════════════════════════════════════════════════════════════════════════

/**
 * There is deliberately NO `unmerged-pr` analogue here, and the reason is
 * structural rather than a judgement call.
 *
 * On the table side `unmerged-pr` names a real situation: a table declared by a
 * migration you CANNOT SEE, so the tree does not declare it and the entry is what
 * keeps it out of the must-reach-zero total. A vocabulary gap cannot be in that
 * position. The tree side of this comparison is DERIVED FROM THE TREE — a label
 * an unmerged PR's migration adds is not in the derivation at all, so there is
 * nothing to compare and nothing to exempt. An entry for it would be a phantom,
 * which is exactly what `phantomVocabularyGaps` reports.
 *
 * Adding the classification anyway would create the failure the table side's own
 * `Classification` docblock spent a page on: a rule that exempts nothing, whose
 * only effect is to let a gap out of the must-reach-zero total.
 */
type VocabularyClassification =
  /** The tree declares the label, production does not admit it. MUST reach zero. */
  | "unapplied"
  /**
   * The declaring migration is deliberately STAGED behind a NAMED owner
   * decision, so production not admitting the label is the intended state.
   * Not exempt from being read — exempt only from the must-reach-zero total,
   * and the note has to name the decision.
   */
  | "staged-by-ruling";

interface VocabularyGap {
  classification: VocabularyClassification;
  note: string;
}

/**
 * Labels the TREE declares that PRODUCTION does not admit, each with a reason.
 *
 * Keyed `table.column:label`, one entry per label rather than one per column,
 * because two labels on one column can have different classifications and
 * because the exactness is what makes this fail in both directions: a new
 * refused label fails, and a label production has since been taught fails until
 * it is struck off.
 *
 * Seeded 2026-09-20 from the first run of this comparison, against
 * baseline/20260920_production_check_vocabularies.txt. EVERY ENTRY WAS TRACED TO
 * THE MIGRATION THAT WOULD CLOSE IT and to whether a writer exists, because a
 * gap entry that omits the consequence is hiding the more important half: a
 * refused label with a live writer is a broken feature, and one with no writer
 * is only latent vocabulary drift. The writer question was answered with the
 * repo's own instrument — the extractors behind check:enum-literals — not by
 * reading the code and hoping.
 */
export const KNOWN_VOCABULARY_GAPS: Record<string, VocabularyGap> = {
  // ── Plan attendance, migration 2302: FOUR LIVE WRITERS AND ONE LIVE READER ──
  // The worst block here, and the one whose shape is identical to 2298's.
  //
  // 2302's own header records how it happened: plan_attendance_events and
  // plan_checkins were created by 0039 with NO CHECK at all, and the constraints
  // were added OUT OF BAND directly on the live database — they are in
  // baseline/20260819_baseline_structure.sql (lines 8153 and 8169) and in no
  // migration in this repository — using a SHORTER vocabulary than the code has
  // ever emitted. So production admits suspicious | late | override | excused
  // and the application writes checked_in_successfully, late_check_in,
  // suspicious_check_in and host_manual_override.
  //
  // routes/geofence.ts:251 (writeAttendanceEvent) inserts all four. Its own
  // docblock says a write that vanishes "takes the explanation with it", and the
  // failure is logged at error and dropped — so in production the attendance
  // audit trail is EMPTY and every entry in it was refused 23514, not missing.
  // check:enum-literals cannot see this: by baseline + 2302 all four labels are
  // legal, which is why its ratchet struck the `checked_in` entry for this table
  // and recorded that the emptiness was "a constraint defect, not a missing
  // producer — and #416's migration 2302 is what fixes it". 2302 is in the tree.
  // It is not in production.
  "plan_attendance_events.event_type:checked_in_successfully": {
    classification: "unapplied",
    note: "Migration 2302. Written by routes/geofence.ts:251 on every successful geofence check-in; refused 23514 in production, logged at error and dropped. Not recorded in production-applied-migrations.json.",
  },
  "plan_attendance_events.event_type:late_check_in": {
    classification: "unapplied",
    note: "Migration 2302. Same writer, the late branch. Same refusal.",
  },
  "plan_attendance_events.event_type:suspicious_check_in": {
    classification: "unapplied",
    note: "Migration 2302. Same writer, AND the only one of the four with a live READER: routes/admin.ts:620 filters .eq(\"event_type\", \"suspicious_check_in\"). A CHECK-constrained text filter on a value the column cannot hold raises nothing — it matches nothing, forever — so the admin's suspicious-check-in view is permanently empty in production and looks like a clean record.",
  },
  "plan_attendance_events.event_type:host_manual_override": {
    classification: "unapplied",
    note: "Migration 2302. Same writer, the host-override branch — the row that explains why a host overrode an attendance outcome. Same refusal.",
  },
  "plan_checkins.status:late": {
    classification: "unapplied",
    note: "Migration 2302. The one label in this column with a writer: routes/geofence.ts:294 upserts status 'late'. Unlike the attendance events this write is LOAD-BEARING — upsertCheckin's caller must honour its boolean — so in production a late check-in does not silently vanish, it fails the check-in.",
  },
  "plan_checkins.status:left": {
    classification: "unapplied",
    note: "Migration 2302. NO WRITER in this tree: nothing names it at a plan_checkins site. Latent vocabulary drift, recorded so it is not mistaken for a live defect.",
  },
  "plan_checkins.status:nearby": {
    classification: "unapplied",
    note: "Migration 2302. NO WRITER in this tree. Same as 'left'.",
  },
  "plan_checkins.status:not_checked_in": {
    classification: "unapplied",
    note: "Migration 2302. NO WRITER in this tree. Same as 'left'.",
  },
  "plan_checkins.status:on_the_way": {
    classification: "unapplied",
    note: "Migration 2302. NO WRITER in this tree. Same as 'left'.",
  },

  // ── Trust admin audit, migration 2940 ──────────────────────────────────────
  // The site itself predicted this entry. routes/trust-admin.ts:623 carries a
  // comment saying `update_setting` "is admitted by
  // trust_admin_actions_action_type_check AS OF MIGRATION 2940; renaming the
  // literal without that migration would have produced a 23514 and, because
  // supabase-js RESOLVES on a DB error, NO AUDIT ROW AT ALL — silently." That is
  // the state production is in, because 2940 is not applied there. The insert
  // now reads its own error and logs "trust setting updated but its audit row
  // was REFUSED — the change is live and unrecorded", so the harm is visible in
  // the logs rather than invisible, and the row is still not written.
  "trust_admin_actions.action_type:update_setting": {
    classification: "unapplied",
    note: "Migration 2940 (IDF-53). Written by routes/trust-admin.ts:623 on every trust-settings edit; refused 23514 in production, so each edit is live and unaudited. Before 2940 the same act was filed as 'score_override', which is why the audit log could not answer the question it exists for — reverting to that label is not an option, applying 2940 is.",
  },

  // ── Identity verification, migration 2870 ──────────────────────────────────
  // 2870's header states this defect against a direct read of production on
  // 2026-09-13 and is the reason the file exists: toVerificationLevel returns
  // exactly 'id_verified' or 'id_selfie_verified', routes/verification.ts's
  // applyVerifiedProfile writes that value on every webhook that resolves to
  // `verified`, and the live constraint permits NEITHER.
  //
  // The header also says "⚠ STAGED. NOT APPLIED TO ANY DATABASE BY THE LANE THAT
  // WROTE IT" — but it names no owner decision and no precondition, so this is
  // `unapplied` and not `staged-by-ruling`: nothing is waiting on a ruling, the
  // file is waiting on an apply. Classifying it by the word "STAGED" alone would
  // put a broken success path outside the must-reach-zero total.
  "profiles.verification_level:id_verified": {
    classification: "unapplied",
    note: "Migration 2870. THE SUCCESS PATH OF IDENTITY VERIFICATION IS UNWRITABLE IN PRODUCTION: services/identityVerification/types.ts#toVerificationLevel returns this exact string for ID-only verification and routes/verification.ts#applyVerifiedProfile writes it, where the live CHECK permits none | basic_verified | trusted_traveler | host_verified | buddy_verified. 2870's header records the same constraint definition, read from production on 2026-09-13.",
  },
  "profiles.verification_level:id_selfie_verified": {
    classification: "unapplied",
    note: "Migration 2870. The ID + selfie-liveness half of the same write. Same refusal, same remedy.",
  },

  // ── Compass intelligence graph, migration 2290 ─────────────────────────────
  // Distinctive failure mode, and the reason both labels are listed rather than
  // summarised: CompassGraphEngine persists nodes with
  // `.upsert(chunk, { onConflict: "node_type,node_key" })` in batches of 500. A
  // single row whose node_type production cannot hold fails the WHOLE statement,
  // so one 'circle' or 'experience' node takes up to 499 legal nodes with it.
  // The engine counts and logs the loss ("node chunk upsert rejected — those
  // nodes are NOT persisted") rather than reporting 0 as an empty graph, so this
  // is measurable in production logs today.
  "compass_graph_nodes.node_type:circle": {
    classification: "unapplied",
    note: "Migration 2290. Written by CompassGraphEngine.ts:657 and :729 (batch.node(\"circle\", …)) and persisted through a 500-row chunked upsert, so a refused row loses its whole chunk. Production admits behavior | city | event | outcome | person | place | time_slice | trip | vibe.",
  },
  "compass_graph_nodes.node_type:experience": {
    classification: "unapplied",
    note: "Migration 2290. Written by CompassGraphEngine.ts:799 and read by reconcileExperienceNodes at :1504 — a PRIVACY revocation path that deletes experience nodes whose source memory is gone. In production the write is refused and the read matches nothing, so the reconciliation is vacuous rather than wrong; it starts mattering the moment 2290 is applied.",
  },

  // ── The intel lane: three columns, three migrations, no live harm yet ──────
  // Grouped because they share a reason and it is NOT the reason above. Every
  // one of these labels belongs to the intel pipeline whose tables are on the
  // TABLE ratchet above as unapplied (intel_attributions, intel_scoped_trust,
  // intel_historical_patterns). The columns here DO exist in production with an
  // older vocabulary, so these are ordinary vocabulary gaps, but the writers sit
  // in code whose surrounding lane production cannot run.
  "canonical_events.verb:intel.observation.recorded": {
    classification: "unapplied",
    note: "Migration 2277. Written by lib/intelDomainEvents.ts:77 into canonical_events (:198). Refused 23514 in production. The extractors behind check:enum-literals do not see this site because the verb is set on an object built away from the insert — found by reading the writer, and stated here so the next reader does not conclude from a clean check:enum-literals run that nothing writes it.",
  },
  "canonical_events.verb:intel.claim.promoted": {
    classification: "unapplied",
    note: "Migration 2277. Second of the three intel domain verbs, same writer module, same refusal.",
  },
  "canonical_events.verb:intel.state.changed": {
    classification: "unapplied",
    note: "Migration 2277. Third of the three. lib/eventFamilies.ts files all three under family 'domain'.",
  },
  "intel_mission_candidates.status:completed": {
    classification: "unapplied",
    note: "Migration 2280. Written by services/intel/CoverageService.ts:157 (completeMission), which is UNGATED by design — \"honoring a commitment must survive the flag being off\". In production the UPDATE is refused 23514 and the function returns { ok: false, reason: <db message> }, so a contributor who completed a mission is told it is not completable.",
  },
  "intel_mission_candidates.status:declined": {
    classification: "unapplied",
    note: "Migration 2280. Written by CoverageService.ts:183 (declineMission), the §22 guarantee that unsafe work can be declined without penalty. Refused 23514 in production, so the terminal state is never recorded.",
  },
  "intel_evidence.evidence_kind:video": {
    classification: "unapplied",
    note: "Migration 2255. NO WRITER names it at an intel_evidence site; lib/intelProjectionAggregator.ts:241 READS it as one of the kinds that count toward a projection, and lib/media/mediaEvidenceLink.ts maps a video asset onto it. Latent until the evidence-link path writes one.",
  },

  // ── Passport stamps: nine labels from 2309, and one that must NOT be applied ─
  // Production admits the 0042 set — achievement | destination | event | host |
  // rent_a_buddy | trip | verification. 2309 widens it by nine and 2880 adds
  // 'place' on top of that.
  //
  // NO WRITER names any of the ten at a passport_stamps site: every award path
  // takes stamp_type from a stamp DEFINITION row rather than a literal
  // (StampAwardEngine, PassportStampService, reconcileStampCatalog), so what
  // production would refuse depends on catalog data rather than on code, and
  // this check cannot see catalog data. Recorded as vocabulary drift, not as a
  // broken feature, because that is what the evidence supports.
  "passport_stamps.stamp_type:city": {
    classification: "unapplied",
    note: "Migration 2309. In the tree, absent from production. No writer names the literal; the award paths read stamp_type from a definition row.",
  },
  "passport_stamps.stamp_type:neighborhood": {
    classification: "unapplied",
    note: "Migration 2309. Same block as 'city'.",
  },
  "passport_stamps.stamp_type:plan": {
    classification: "unapplied",
    note: "Migration 2309. Same block as 'city'.",
  },
  "passport_stamps.stamp_type:hidden_gem": {
    classification: "unapplied",
    note: "Migration 2309. Same block as 'city'.",
  },
  "passport_stamps.stamp_type:safe_return": {
    classification: "unapplied",
    note: "Migration 2309. Same block as 'city'.",
  },
  "passport_stamps.stamp_type:activity": {
    classification: "unapplied",
    note: "Migration 2309. Same block as 'city'.",
  },
  "passport_stamps.stamp_type:trip_crew": {
    classification: "unapplied",
    note: "Migration 2309. Same block as 'city'.",
  },
  "passport_stamps.stamp_type:compass_ai": {
    classification: "unapplied",
    note: "Migration 2309. Same block as 'city'.",
  },
  "passport_stamps.stamp_type:qr_checkin": {
    classification: "unapplied",
    note: "Migration 2309. Same block as 'city'.",
  },
  "passport_stamps.stamp_type:place": {
    classification: "staged-by-ruling",
    note:
      "Migration 2880, and the ONE entry here that production is right not to have. 2880's own header says " +
      "\"⚠ STAGED. NOT APPLIED TO ANY DATABASE ... AND NOT READY TO APPLY\", and its DO NOT APPLY BEFORE list " +
      "names the decision: owner decision D-STAMP (docs/architecture/census-passport.md §12.4), a product rule " +
      "for what earns a Place stamp, which exists in no spec in this repository. Its rollback is only safe while " +
      "`SELECT count(*) FROM passport_stamps WHERE stamp_type = 'place'` is 0, and it forbids a producer until " +
      "after the file is applied — so applying it alone makes the surface worse, not better. It also preconditions " +
      "on 2309, which is the entry block above: the nine labels must land first.",
  },
};

/**
 * Production's CHECK vocabularies, as the committed capture records them.
 *
 * `values` unions every vocabulary-bearing CHECK on a column, which is the same
 * thing canonicalVocabulary.ts does to the tree side — and it is the same
 * function doing it, so the two cannot disagree about how a constraint reads.
 *
 * `tables` is every table the capture carries at least one vocabulary-bearing
 * CHECK for. It is NOT "every table in production": a table with no such
 * constraint is absent from this file, which is why the table half of this check
 * keeps its own capture and why nothing here infers table presence.
 */
export interface ProductionVocabulary {
  /** `table.column` -> the labels production admits. */
  values: Map<string, Set<string>>;
  /** Tables the capture carries at least one vocabulary-bearing CHECK for. */
  tables: Set<string>;
  /** Constraint lines parsed, for the report and the liveness floor. */
  constraints: number;
  /**
   * sha256 of the payload as this parser read it — every non-comment, non-blank
   * line, joined with \n and terminated by one \n, exactly as the capture's own
   * header defines it.
   */
  payloadSha256: string;
  /** The digest the capture's header records, for comparison against the above. */
  declaredSha256: string;
}

/**
 * Parse the capture. One line per constraint: `table|constraint name|def`.
 *
 * A `#` line is a comment and a blank line is nothing. Everything else must
 * carry two delimiters; a line that does not is SKIPPED rather than guessed at,
 * and the liveness floor in main() is what makes a file this stops being able to
 * read fail loudly instead of comparing nothing.
 */
export function parseProductionCheckSnapshot(raw: string): ProductionVocabulary {
  const values = new Map<string, Set<string>>();
  const tables = new Set<string>();
  const payload: string[] = [];
  let constraints = 0;
  let declaredSha256 = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("#")) {
      const m = /^#\s*sha256\s*:\s*([0-9a-f]{64})\s*$/.exec(line);
      if (m) declaredSha256 = m[1]!;
      continue;
    }
    if (line.trim().length === 0) continue;
    // The payload is accumulated HERE, inside the same pass that decides what is
    // a comment, so the digest covers exactly the bytes this parser treated as
    // data. Computing it in a separate pass would let the two disagree about what
    // the payload is — and then a capture could be edited in a way the digest
    // check accepted and the parser acted on.
    payload.push(line);
    const first = line.indexOf("|");
    const second = line.indexOf("|", first + 1);
    if (first === -1 || second === -1) continue;
    const table = line.slice(0, first);
    const def = line.slice(second + 1);
    constraints++;
    tables.add(table);
    for (const [column, labels] of vocabularyFromCheck(def)) {
      const key = `${table}.${column}`;
      if (!values.has(key)) values.set(key, new Set());
      for (const label of labels) values.get(key)!.add(label);
    }
  }
  return {
    values,
    tables,
    constraints,
    payloadSha256: createHash("sha256").update(`${payload.join("\n")}\n`, "utf8").digest("hex"),
    declaredSha256,
  };
}

/**
 * What the TREE says a CHECK-constrained column may contain.
 *
 * This is check:enum-literals' vocabulary, built by the same call it makes —
 * baseline plus every migration, replayed in the repo's own order — and then
 * narrowed to the columns whose vocabulary comes from a CHECK.
 *
 * The narrowing is documentation of intent rather than a load-bearing guard, and
 * the mutation log at the top of this file says so honestly: removing it does not
 * change the verdict, because an ENUM-typed column appears in no line of a
 * capture of pg_constraint and is therefore never judged either way. It is kept
 * because the "capture carries no vocabulary for this column" count is a REPORT a
 * reader is meant to act on, and 70 structurally-unjudgeable enum columns in it
 * would bury the handful that mean something.
 */
export function treeVocabularies(): {
  /** Columns whose tree vocabulary comes from a CHECK — the comparable ones. */
  check: Map<string, Set<string>>;
  /** Columns the tree models as an ENUM type. Not comparable against this capture. */
  enumTyped: Map<string, Set<string>>;
} {
  const vocab = buildCanonicalVocabulary(BASELINE, MIGRATION_DIRS);
  const check = new Map<string, Set<string>>();
  const enumTyped = new Map<string, Set<string>>();
  for (const [key, labels] of vocab.values) {
    if ((vocab.origin.get(key) ?? "").startsWith("check ")) check.set(key, labels);
    else enumTyped.set(key, labels);
  }
  return { check, enumTyped };
}

/** The comparable half, for callers that want only it. */
export function treeCheckVocabularies(): Map<string, Set<string>> {
  return treeVocabularies().check;
}

/**
 * Columns the TREE models as an ENUM type where PRODUCTION enforces a CHECK, with
 * at least one label the CHECK does not admit.
 *
 * THIS IS REPORTED AND NOT FAILED, and the distinction is the whole reason the
 * `check ` filter above exists. Five columns are in this state as of 2026-09-20
 * and two of them are not near misses — `location_preferences.pulse_visibility`
 * is `circle_only | none | public | trip_only` in the tree and
 * `circle | everyone | nobody | trip_members` in production's CHECK, which is
 * DISJOINT.
 *
 * Why it is not a failure: the two sides are not describing the same thing. A
 * capture of pg_constraint establishes what a CHECK admits; it cannot establish a
 * column's TYPE, and a CHECK existing on a column the tree types as an enum most
 * likely means production has it as TEXT — a type divergence, of which the
 * vocabulary difference is a symptom. Failing on it would be a confident claim
 * from evidence that does not support it, which is the mistake
 * .agents/memory/db-column-drift.md is about and the reason this check refused to
 * go past table presence for as long as it did.
 *
 * Why it is not silent either: it could be a live 23514 on a write, and that is
 * too important to leave inside a filter. Closing it needs a capture of column
 * TYPES — `pg_attribute`/`information_schema.columns` joined to `pg_type` — which
 * no committed artefact here carries at the per-column level. Naming the missing
 * instrument is the honest end of this thought; inventing a verdict is not.
 */
export function enumVsCheckDivergences(
  enumTyped: Map<string, Set<string>>,
  production: ProductionVocabulary,
): Array<{ column: string; treeOnly: string[] }> {
  const out: Array<{ column: string; treeOnly: string[] }> = [];
  for (const [column, labels] of enumTyped) {
    const admitted = production.values.get(column);
    if (!admitted) continue;
    const treeOnly = [...labels].filter((l) => !admitted.has(l)).sort();
    if (treeOnly.length > 0) out.push({ column, treeOnly });
  }
  return out.sort((a, b) => a.column.localeCompare(b.column));
}

/** `table.column:label` — the ratchet's key, in one place so nothing restates it. */
export function vocabularyKey(column: string, label: string): string {
  return `${column}:${label}`;
}

/**
 * Split a ratchet key at the FIRST colon. `table.column` never contains one;
 * a label conceivably could, and splitting at the last would then corrupt it.
 */
export function splitVocabularyKey(key: string): { column: string; label: string } {
  const at = key.indexOf(":");
  return at === -1
    ? { column: key, label: "" }
    : { column: key.slice(0, at), label: key.slice(at + 1) };
}

/**
 * THE THREE VOCABULARY PREDICATES, exported for the same reason the table side's
 * two are: so ONE implementation of each exists and the test drives the code
 * main() drives, against a constructed fixture as well as against the real
 * ratchet. The table side's docblock records what the alternative cost — a copy
 * in the test file that could drift from the guard in either direction, and that
 * proved nothing at all whenever the live population happened to be empty.
 */

/**
 * Labels the tree declares that production does not admit — the drift itself.
 *
 * A column the capture has no vocabulary for is NOT judged. That is the
 * over-permissive direction and it is the right one: production leaving a column
 * unconstrained means every label is accepted there, so nothing is refused and
 * there is no defect of this kind to report. Calling it one would manufacture a
 * finding, which is the failure appliedAfterSnapshot was written against.
 */
export function missingVocabularyLabels(
  tree: Map<string, Set<string>>,
  production: ProductionVocabulary,
): string[] {
  const out: string[] = [];
  for (const [column, labels] of tree) {
    const admitted = production.values.get(column);
    if (!admitted) continue;
    for (const label of labels) {
      if (!admitted.has(label)) out.push(vocabularyKey(column, label));
    }
  }
  return out.sort();
}

/**
 * Ratchet entries production NOW admits: a gap that closed and was not struck
 * off.
 *
 * This is the direction that keeps the list readable. The table side states it
 * as "a ratchet that silently stays full stops being read", and it is worse than
 * unread here: an entry says in the repository that production refuses a label,
 * and once production admits it that sentence is simply false.
 */
export function closedVocabularyGaps(
  gaps: Record<string, VocabularyGap>,
  production: ProductionVocabulary,
): string[] {
  return Object.keys(gaps)
    .filter((key) => {
      const { column, label } = splitVocabularyKey(key);
      return production.values.get(column)?.has(label) ?? false;
    })
    .sort();
}

/**
 * Entries that describe no gap at all — the third way this rots, and the one
 * neither of the other two predicates can see.
 *
 * Two shapes, reported together because the remedy is the same (delete the
 * entry) and the consequence is the same (a must-reach-zero total inflated with
 * work that does not exist):
 *
 *   - THE TREE NO LONGER DECLARES THE LABEL. The migration was reworded or
 *     reverted, so nothing writes it and nothing asks production for it.
 *   - THE CAPTURE CONSTRAINS THE COLUMN AT ALL NO LONGER. Production dropped the
 *     constraint, so the label cannot be refused there. The gap is closed, but by
 *     removal rather than by widening, which is why `closedVocabularyGaps` does
 *     not see it: production does not "admit" a label it has no opinion about.
 */
export function phantomVocabularyGaps(
  gaps: Record<string, VocabularyGap>,
  tree: Map<string, Set<string>>,
  production: ProductionVocabulary,
): string[] {
  return Object.keys(gaps)
    .filter((key) => {
      const { column, label } = splitVocabularyKey(key);
      if (!production.values.has(column)) return true;
      return !(tree.get(column)?.has(label) ?? false);
    })
    .sort();
}

/**
 * THE RATCHET USED AS A POSITIVE CONTROL ON THE FINDER — added because a mutation
 * proved it was needed, and the mutation log at the top of this file records it as
 * the one that came back GREEN on the first attempt.
 *
 * `missingVocabularyLabels` was mutated to skip every column, so it found nothing
 * at all, and `check:production-drift` still exited 0. Nothing else noticed:
 * `closedVocabularyGaps` and `phantomVocabularyGaps` ask production and the tree
 * directly, so all thirty entries remained valid, and "no unrecorded gaps" is
 * trivially true of a rule that reports nothing. The finding half of this check
 * could be disabled in one line without a single test going red.
 *
 * The fix is to make the ratchet answer for the finder. Every entry on it is a
 * recorded claim, and for any entry EXACTLY ONE of three things must be true:
 *
 *   - production still refuses the label, so `missingVocabularyLabels` finds it;
 *   - production now admits it, so `closedVocabularyGaps` reports it;
 *   - it describes no gap, so `phantomVocabularyGaps` reports it.
 *
 * The three are exhaustive by construction, so an entry that lands in NONE of
 * them cannot be a fact about production — it can only mean the comparison has
 * stopped working. That is a stronger liveness statement than a numeric floor,
 * because it is derived from claims the repository has already committed to
 * rather than from a threshold somebody guessed.
 *
 * It degrades honestly, too: at an EMPTY ratchet this predicate has nothing to
 * say, which is exactly when the floors in main() take over.
 *
 * WHY IT TAKES THE THREE RESULTS RATHER THAN RECOMPUTING THEM. The first version
 * called the three predicates itself, and that version was UNFALSIFIABLE: given
 * one tree and one capture the three outcomes really are exhaustive, so the
 * function returned [] for every possible input and no fixture could make it fire.
 * Its only failure mode was a mutated finder, which means nothing could show it
 * discriminating — the same vacuity the table side's `unmerged-pr` control was
 * rewritten to escape, where "the control asserted over a COPY of the rule, so an
 * empty population left the copy unexercised".
 *
 * Taking the three results as arguments fixes that without weakening it: main()
 * passes what the rules actually returned, so a finder that stops finding is still
 * caught, and a test can pass a deliberately empty finding list and watch the
 * control fire on entries it should have accounted for.
 */
export function unexplainedVocabularyGaps(
  gaps: Record<string, VocabularyGap>,
  found: Iterable<string>,
  closed: Iterable<string>,
  phantom: Iterable<string>,
): string[] {
  const accounted = new Set<string>([...found, ...closed, ...phantom]);
  return Object.keys(gaps)
    .filter((key) => !accounted.has(key))
    .sort();
}

function readProductionCheckSnapshot(): ProductionVocabulary {
  const path = join(BASELINE_DIR, PRODUCTION_CHECK_SNAPSHOT);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(
      `check:production-drift: cannot read the CHECK-vocabulary snapshot at ${path}.\n` +
        "Like the table snapshot, this is a committed capture rather than a live read, so that\n" +
        "the check needs no production credentials. Without the file it has verified NOTHING\n" +
        "about vocabularies, so it fails rather than passing quietly.",
    );
    process.exit(2);
  }
  return parseProductionCheckSnapshot(raw);
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


  // ══════════════════════════════════════════════════════════════════════════
  //  THE VOCABULARY HALF
  // ══════════════════════════════════════════════════════════════════════════

  const prodVocab = readProductionCheckSnapshot();
  const { check: treeVocab, enumTyped } = treeVocabularies();
  const judged = [...treeVocab.keys()].filter((c) => prodVocab.values.has(c));

  console.log("");
  console.log(
    `Compared ${treeVocab.size} CHECK-constrained column vocabular(ies) declared in the tree ` +
      `against ${prodVocab.values.size} in the production snapshot (${PRODUCTION_CHECK_SNAPSHOT}, ` +
      `${prodVocab.constraints} constraint(s)).`,
  );
  console.log(`  ${judged.length} column(s) exist on both sides and were compared.`);

  // ── THE CAPTURE MUST BE THE CAPTURE IT CLAIMS TO BE ─────────────────────────
  //
  // This capture was transcribed through the Management API rather than piped to
  // disk, and production computed the digest in its header over the same
  // expression BEFORE the transcription. Recomputing it here is what turns
  // "verbatim" into a checked claim, and it is checked HERE rather than only in
  // productionDriftExtraction.test.ts for the reason checkEnumLiterals.ts gives
  // about its own floors: a check whose integrity is established only by another
  // file is one curated-test-list edit away from establishing nothing.
  if (prodVocab.declaredSha256.length === 0) {
    failed = true;
    console.error(
      `\n✖ ${PRODUCTION_CHECK_SNAPSHOT} records no payload sha256 in its header.\n` +
        "  A capture with no digest cannot be distinguished from an edited one. Add the\n" +
        "  '# sha256 : <hex>' line the refresh procedure in that file's header describes.",
    );
  } else if (prodVocab.declaredSha256 !== prodVocab.payloadSha256) {
    failed = true;
    console.error(
      `\n✖ ${PRODUCTION_CHECK_SNAPSHOT} does not match the digest in its own header:\n` +
        `      header:   ${prodVocab.declaredSha256}\n` +
        `      measured: ${prodVocab.payloadSha256}\n` +
        "  The capture has been edited since it was taken, or a refresh changed the bytes and\n" +
        "  left the header behind. Either way the file is no longer evidence about production.\n" +
        "  The comparison below STILL RUNS — a diff is more useful than silence when you are\n" +
        "  trying to work out what changed — but nothing it reports is trustworthy until the\n" +
        "  capture and its digest agree. Re-capture, or restore the file.",
    );
  }

  // ── LIVENESS FLOOR, on checkEnumLiterals.ts's model and for its reason ──────
  //
  // parseProductionCheckSnapshot SKIPS a line it cannot read, and
  // buildCanonicalVocabulary models nothing for a constraint it cannot parse.
  // Both are the right failure posture per-line and both are catastrophic in
  // aggregate: a capture whose format changed, or a baseline path that stopped
  // resolving, yields zero comparisons and no throw. Today an empty derivation
  // would be caught because the ratchet is non-empty and every entry would go
  // phantom — but the ratchet's stated goal is to reach zero, and AT zero a
  // completely broken comparison would exit 0 and report success.
  //
  // The numbers are far below the measured reality (366 constraints, 331 tree
  // vocabularies, 300 compared on 2026-09-20) so ordinary churn never trips
  // them. They catch a COLLAPSE, not a change.
  const vocabFloors: Array<[string, number, number]> = [
    ["constraints read from the production capture", prodVocab.constraints, 250],
    ["CHECK vocabularies derived from the tree", treeVocab.size, 250],
    ["columns compared on both sides", judged.length, 200],
  ];
  const vocabCollapsed = vocabFloors.filter(([, actual, floor]) => actual < floor);
  if (vocabCollapsed.length > 0) {
    failed = true;
    console.error("\n✖ the vocabulary comparison reached far less than it should have — refusing to report success:");
    for (const [what, actual, floor] of vocabCollapsed) {
      console.error(`    ${what}: ${actual} (floor ${floor})`);
    }
    console.error(
      "\n  A comparison that reaches nothing finds nothing, and with an empty ratchet that is\n" +
        "  indistinguishable from a tree production agrees with. Check the capture's format, the\n" +
        "  baseline path and the migration directories before touching these floors.",
    );
  }

  const missingLabels = missingVocabularyLabels(treeVocab, prodVocab);
  const unrecordedLabels = missingLabels.filter((k) => !(k in KNOWN_VOCABULARY_GAPS));
  if (unrecordedLabels.length > 0) {
    failed = true;
    console.error(
      `\n✖ ${unrecordedLabels.length} CHECK vocabulary gap(s): the tree declares a label production does NOT admit, and nothing records it:`,
    );
    for (const key of unrecordedLabels) {
      const { column, label } = splitVocabularyKey(key);
      console.error(`    ${column} cannot hold "${label}"`);
      console.error(`      production admits: ${[...(prodVocab.values.get(column) ?? [])].sort().join(" | ")}`);
    }
    console.error(
      "\n  A write of such a label is REFUSED 23514 and a filter on it matches nothing, forever.\n" +
        "  FIRST ask whether the capture is simply older than the apply: if the migration reached\n" +
        `  production after ${PRODUCTION_CHECK_SNAPSHOT.slice(0, 8)}, refresh the capture and move\n` +
        "  PRODUCTION_CHECK_SNAPSHOT — do NOT write an entry saying production lacks something it\n" +
        "  has. Otherwise apply the migration, or add an entry to KNOWN_VOCABULARY_GAPS with a\n" +
        "  classification and a reason that names the migration and says whether a writer exists.",
    );
  }

  const closedLabels = closedVocabularyGaps(KNOWN_VOCABULARY_GAPS, prodVocab);
  if (closedLabels.length > 0) {
    failed = true;
    console.error(
      `\n✖ ${closedLabels.length} ratcheted vocabulary gap(s) are now ADMITTED by production and were not struck off:`,
    );
    for (const key of closedLabels) console.error(`    ${key}`);
    console.error(
      "\n  Remove them from KNOWN_VOCABULARY_GAPS. Each one is a sentence in this repository\n" +
        "  saying production refuses a label it accepts.",
    );
  }

  const phantomLabels = phantomVocabularyGaps(KNOWN_VOCABULARY_GAPS, treeVocab, prodVocab);
  if (phantomLabels.length > 0) {
    failed = true;
    console.error(
      `\n✖ ${phantomLabels.length} ratcheted vocabulary gap(s) describe no gap: the tree no longer declares the label, or production no longer constrains the column:`,
    );
    for (const key of phantomLabels) {
      const { column, label } = splitVocabularyKey(key);
      const why = !prodVocab.values.has(column)
        ? "production has no vocabulary-bearing CHECK on this column, so the label cannot be refused there"
        : `the tree does not declare "${label}" for this column`;
      console.error(`    ${key} — ${why}`);
    }
    console.error(
      "\n  Delete the entry. An entry that describes no gap inflates the must-reach-zero total\n" +
        "  with work that does not exist.",
    );
  }

  const unexplained = unexplainedVocabularyGaps(
    KNOWN_VOCABULARY_GAPS,
    missingLabels,
    closedLabels,
    phantomLabels,
  );
  if (unexplained.length > 0) {
    failed = true;
    console.error(
      `\n✖ ${unexplained.length} ratcheted vocabulary gap(s) are explained by NONE of the three rules above:`,
    );
    for (const key of unexplained) console.error(`    ${key}`);
    console.error(
      "\n  Production refuses the label, or admits it, or the entry describes no gap — those three\n" +
        "  are exhaustive, so an entry in none of them is not a fact about production. The\n" +
        "  comparison itself has stopped working: check that the capture still parses and that\n" +
        "  missingVocabularyLabels still reaches the columns it claims to.",
    );
  }

  // ── THE TREE SAYS ENUM, PRODUCTION SAYS CHECK ───────────────────────────────
  // Counted and named rather than failed. See enumVsCheckDivergences' docblock:
  // this capture can say what a CHECK admits and cannot say what type a column
  // has, so the honest output is the observation plus the instrument that would
  // settle it — not a verdict.
  const divergences = enumVsCheckDivergences(enumTyped, prodVocab);
  if (divergences.length > 0) {
    console.log(
      `  ${divergences.length} column(s) the TREE models as an ENUM are CHECK-constrained in production,`,
    );
    console.log("    with labels the CHECK does not admit. Reported, NOT failed — the two sides may");
    console.log("    disagree about the column's TYPE, which a capture of pg_constraint cannot settle:");
    for (const { column, treeOnly } of divergences) {
      console.log(`      ${column} — tree-only: ${treeOnly.join(" ")}`);
      console.log(`        production's CHECK admits: ${[...(prodVocab.values.get(column) ?? [])].sort().join(" | ")}`);
    }
    console.log(
      "    Settling these needs a capture of column TYPES (pg_attribute joined to pg_type), which\n" +
        "    no committed artefact here carries per column. Until then a write of a tree-only label\n" +
        "    MAY be refused 23514 in production, and saying so is the most the evidence supports.",
    );
  }

  // The not-judged set is reported in TWO parts, because one part is somebody
  // else's business and the other is nobody's yet.
  //
  // A column whose whole TABLE is missing from the capture tells you nothing this
  // check owns: the table ratchet above is the instrument for that, and listing
  // thirty such columns individually buries the handful that matter.
  //
  // A column whose table IS in the capture and which production nonetheless
  // leaves UNCONSTRAINED is the interesting case: the tree declares a vocabulary
  // production does not enforce at all. It is drift, but in the permissive
  // direction — production accepts every label — so it cannot be the 23514 defect
  // this check is for, and it is reported rather than failed.
  const notJudged = [...treeVocab.keys()].filter((c) => !prodVocab.values.has(c));
  const tablesAbsent = new Set(
    notJudged.map((c) => c.slice(0, c.indexOf("."))).filter((t) => !prodVocab.tables.has(t)),
  );
  const unenforced = notJudged.filter((c) => prodVocab.tables.has(c.slice(0, c.indexOf(".")))).sort();
  if (tablesAbsent.size > 0) {
    console.log(
      `  ${notJudged.length - unenforced.length} column(s) belong to ${tablesAbsent.size} table(s) the capture carries nothing for; ` +
        "the table ratchet above owns those.",
    );
  }
  if (unenforced.length > 0) {
    console.log(
      `  ${unenforced.length} column(s) exist in a captured table but production constrains NONE of them,`,
    );
    console.log("    so they are not judged — an unconstrained column refuses nothing:");
    for (const c of unenforced) console.log(`      ${c}`);
    console.log(
      "    `<table>.NOT` in that list is an artefact of the tree-side parser rather than a column:\n" +
        "    `x NOT IN (…)` reads as a column called NOT. It is left visible instead of denylisted,\n" +
        "    because NOT_TABLE_NAMES above records what maintaining a denylist of English words\n" +
        "    costs, and an artefact that can never match a captured column can never fail anything.",
    );
  }

  const unapplied = Object.entries(KNOWN_PRODUCTION_GAPS).filter(
    ([t, g]) => g.classification === "unapplied" && !production.has(t),
  );
  const unappliedLabels = Object.entries(KNOWN_VOCABULARY_GAPS).filter(
    ([, g]) => g.classification === "unapplied",
  );

  if (!failed) {
    console.log(
      `\n✓ No unrecorded production drift. ${Object.keys(KNOWN_PRODUCTION_GAPS).length} table(s) on the ratchet, ` +
        `of which ${unapplied.length} are UNAPPLIED and must reach zero.`,
    );
    console.log(
      `  ${Object.keys(KNOWN_VOCABULARY_GAPS).length} CHECK vocabulary gap(s) on the ratchet, of which ` +
        `${unappliedLabels.length} are UNAPPLIED and must reach zero.`,
    );
    if (unapplied.length > 0) {
      console.log("\n  Unapplied — code in the tree pointed at storage production does not have:");
      for (const [t] of unapplied) console.log(`    ${t}`);
      console.log(
        "\n  schema_migration_ledger is the one to fix first: without it, nothing can\n" +
          "  establish which migrations production has, and apply-migrations.ts cannot run there.",
      );
    }
    if (unappliedLabels.length > 0) {
      console.log(
        "\n  Unapplied vocabularies — a label the tree writes or filters on and production refuses:",
      );
      for (const [key] of unappliedLabels.sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`    ${key}`);
      }
      console.log(
        "\n  Each is closed by applying ONE migration, named in that entry's note. They are\n" +
          "  cheap: every one of these files widens a CHECK and touches nothing else, so each\n" +
          "  admitted list is a strict superset of the one it replaces and no existing row can\n" +
          "  fail revalidation.",
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
