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
import { dirname, join } from "node:path";
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
  intel_state_snapshot_versions: {
    classification: "unapplied",
    note: "Migration 2273. intelReplay targets it. Replayable projection is impossible in production without it.",
  },
  intel_presence_verifications: {
    classification: "unapplied",
    note:
      "Migration 2276. Also WRITE-ONLY: written at IntelCaptureService.ts:303 and read " +
      "by nothing. checkWriterlessReads cannot see this shape — findWriterless only " +
      "walks the reads map, so a write-only table is invisible to it.",
  },

  // ── Everything else measured in the same comparison ────────────────────────
  canonical_events: { classification: "unapplied", note: "In portava-ci, absent from production." },
  event_passport_shares: { classification: "unapplied", note: "In portava-ci, absent from production." },
  hidden_gem_contributions: { classification: "unapplied", note: "In portava-ci, absent from production." },
  input_selection_history: { classification: "unapplied", note: "In portava-ci, absent from production." },
  media_intent_signals: { classification: "unapplied", note: "In portava-ci, absent from production." },
  media_view_requests: { classification: "unapplied", note: "In portava-ci, absent from production." },
  media_view_request_optins: { classification: "unapplied", note: "In portava-ci, absent from production." },
  locate_friends_sessions: { classification: "unapplied", note: "Locate-Friends storage; in portava-ci, absent from production." },
  locate_friends_members: { classification: "unapplied", note: "Locate-Friends storage; in portava-ci, absent from production." },
  locate_friends_positions: { classification: "unapplied", note: "Locate-Friends storage; in portava-ci, absent from production." },
  locate_friends_audit: { classification: "unapplied", note: "Locate-Friends storage; in portava-ci, absent from production." },
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
  trip_events: {
    classification: "ci-only-by-ruling",
    note: "Migration 2420 (Trip Kernel event store). Applied to portava-ci 2026-09-07; production apply is an owner decision and needs 2334+2337 first.",
  },
  trip_command_receipts: {
    classification: "ci-only-by-ruling",
    note: "Migration 2420 (Trip Kernel idempotency receipts). Applied to portava-ci 2026-09-07; production apply is an owner decision and needs 2334+2337 first.",
  },
  trip_outbox: {
    classification: "ci-only-by-ruling",
    note: "Migration 2420 (Trip Kernel outbox; no consumer yet). Applied to portava-ci 2026-09-07; production apply is an owner decision and needs 2334+2337 first.",
  },
};

/**
 * Table names that a naive `CREATE TABLE` regex extracts from PROSE inside SQL
 * comments, plus the legacy-root `buddy_*` names that were renamed to
 * `rent_buddy_*` long ago. Excluded so the check reports storage, not grammar.
 */
const NOT_TABLE_NAMES = new Set([
  "if", "above", "below", "ran", "returns", "silently", "storage", "time", "not", "exists",
  "buddy_addons", "buddy_applications", "buddy_availability", "buddy_bookings",
  "buddy_packages", "buddy_profiles", "buddy_reviews", "buddy_saved", "buddy_waitlist",
]);

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

function declaredTables(): Set<string> {
  const out = new Set<string>();
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi;
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const m of sql.matchAll(re)) {
      const name = m[1].toLowerCase();
      if (!NOT_TABLE_NAMES.has(name)) out.add(name);
    }
  }
  return out;
}

function main(): void {
  const production = readProductionSnapshot();
  const declared = declaredTables();

  const gaps = [...declared].filter((t) => !production.has(t)).sort();
  const unrecorded = gaps.filter((t) => !(t in KNOWN_PRODUCTION_GAPS));
  const struckOff = Object.keys(KNOWN_PRODUCTION_GAPS)
    .filter((t) => production.has(t))
    .sort();

  console.log(
    `Compared ${declared.size} table(s) declared in src/migrations against ` +
      `${production.size} table(s) in the production snapshot (${PRODUCTION_SNAPSHOT}).`,
  );
  console.log("  no credentials were used, and no database was contacted.");
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

main();
