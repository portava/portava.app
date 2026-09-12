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

/** The snapshot filename. Bump this when an operator captures a fresher one. */
const PRODUCTION_SNAPSHOT = "20260907_production_tables.txt";

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
  schema_migration_ledger: {
    classification: "unapplied",
    note:
      "public.schema_migration_ledger DOES NOT EXIST IN PRODUCTION. The entire " +
      "migration-provenance apparatus — isProofOfApply(), the 2254 backfill rows, " +
      "check:migration-ledger — describes a table that lives only in portava-ci. " +
      "apply-migrations.ts exits 2 ('no ledger table') without it, so the sanctioned " +
      "applier has NEVER been able to run against production; every production " +
      "migration was applied by some other means and is unrecorded. Nothing in the " +
      "tree can currently answer 'which migrations are applied to production?'. " +
      "This is the highest-priority entry in this file.",
  },

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
    classification: "unmerged-pr",
    note:
      "Migration 2315, PR #475 (UNMERGED). Applied to portava-ci on 2026-09-07 to " +
      "unblock the schema-drift audit. Not drift until that PR lands, and applying it " +
      "to production needs an owner decision — the store is inert by construction.",
  },
  intel_claim_reviews: {
    classification: "unmerged-pr",
    note: "Migration 2311, PRs #456/#457 (UNMERGED). Applied to portava-ci 2026-09-07.",
  },
  memory_episodes: {
    classification: "unmerged-pr",
    note: "Migration 2320, PR #470 (UNMERGED). Applied to portava-ci 2026-09-07.",
  },
  memory_evidence: {
    classification: "unmerged-pr",
    note: "Migration 2320, PR #470 (UNMERGED). Applied to portava-ci 2026-09-07.",
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

  // Highlights / Memories, migrations 2720-2724.
  highlight_resurfacing_preferences: {
    classification: "unapplied",
    note:
      "Migration 2720. Per-user control over what may resurface. Queued behind the " +
      "STORY_HIGHLIGHT_VISIBILITY owner decision, which fixes who a resurfaced " +
      "highlight may be shown TO; applying the preference table before that is " +
      "decided would build the control surface for a rule nobody has picked.",
  },
  highlight_projection_policies: {
    classification: "unapplied",
    note:
      "Migration 2721. The projection policy rows the Highlights/Memories spec " +
      "s18 requires. Same gate as 2720: it encodes visibility policy, and " +
      "STORY_HIGHLIGHT_VISIBILITY is open.",
  },
  highlight_sources: {
    classification: "unapplied",
    note:
      "Migration 2722. Provenance for a highlight (which memory, which version). " +
      "Ordered after 2720/2721 because it references the policy identity they " +
      "establish; not independently applicable.",
  },
  highlight_revocation_log: {
    classification: "unapplied",
    note:
      "Migration 2724. Append-only record of revoked derivatives. Depends on " +
      "2722's source identity — a revocation of nothing is not storable — so it " +
      "cannot lead the family in.",
  },

  // Memory command kernel, migrations 2710/2711/2730.
  memory_domain_events: {
    classification: "unapplied",
    note:
      "Migration 2710, RENAMED from memory_events on this branch: production " +
      "already holds a DIFFERENT public.memory_events (12 columns, the s4/s15 " +
      "projection ledger) that ten migrations and the deletion cascade build on. " +
      "2710's original name would have collided, and CREATE TABLE IF NOT EXISTS " +
      "would have skipped SILENTLY, leaving the kernel writing into a table with " +
      "the wrong shape. Unapplied anywhere but portava-ci while the outbox lane " +
      "certifies it.",
  },
  memory_event_outbox: {
    classification: "unapplied",
    note:
      "Migration 2710. Transactional outbox for memory domain events. No worker " +
      "consumes it yet, so applying it to production would create a table that " +
      "accumulates nothing — the same shape as trip_outbox above, and held for " +
      "the same reason.",
  },
  memory_command_receipts: {
    classification: "unapplied",
    note:
      "Migration 2710. Idempotency receipts for the memory command bus. Meaningless " +
      "without the kernel that writes them; applied only with 2710 as a whole.",
  },
  memory_command_audit: {
    classification: "unapplied",
    note:
      "Migration 2710. Audit trail for accepted and refused memory commands. Same " +
      "family, same apply.",
  },
  memory_derivative_registry: {
    classification: "unapplied",
    note:
      "Migration 2730. One row per built derivative of the Memory domain " +
      "(spec s18). Ordered strictly after 2710: a derivative registry keyed on " +
      "domain-event identity cannot precede the events.",
  },

  // Layover, migration 2700.
  layover_certified_computations: {
    classification: "unapplied",
    note:
      "Migration 2700. Append-only record of each certified layover feasibility " +
      "computation so an answer can be REPLAYED rather than re-derived. Creates " +
      "one table and alters nothing. Queued behind 2741, which landed in " +
      "production 2026-09-08; not yet certified through its own gate.",
  },

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
  const undeclared = Object.entries(KNOWN_PRODUCTION_GAPS)
    .filter(([t, g]) => g.classification !== "unmerged-pr" && !declared.has(t) && !production.has(t))
    .map(([t]) => t)
    .sort();

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
