/**
 * Static schema-reference check — `check:schema-references`.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `buildPlaceProjection` read `places` with `.select("id, name, city, country,
 * neighborhood")`. The table has `country_code`; it has never had `country`.
 * PostgREST fails the WHOLE read on an unknown select-list column (PGRST100),
 * and that read sat inside a best-effort catch — so place identity was silently
 * empty on every projection for as long as the line existed.
 *
 * That was found, documented as the founding example in
 * `silentSchemaErrorCatches.test.ts`, fixed — AND THEN RECURRED, in
 * `MediaProjectionService.ts`, reaching `main`.
 *
 * WHY IT RECURRED, AND WHY THIS CHECK IS STATIC
 * ---------------------------------------------
 * The repo already had a check that catches it: `check:write-path-columns`.
 * But that check diffs against the LIVE database, so it only runs where live
 * credentials exist — on a lane that is starved. Of 100 sampled live-DB runs,
 * 64 were cancelled and 45% of commits received NO verdict at all. A guard that
 * usually cannot run is not a guard; `places.country` walked through the gap.
 *
 * A wrong column name is not a fact about the database. It is a fact about the
 * repository: the code names a column the repo's own migrations never create.
 * That needs no network, no credentials, and cannot be starved — so this check
 * runs on every PR alongside the other static checks.
 *
 * OWNERSHIP — this does NOT duplicate the live check
 * --------------------------------------------------
 *   this check                code   vs  CANONICAL schema (baseline+migrations)
 *   check:write-path-columns  code   vs  LIVE schema
 *   audit:schema              canon  vs  LIVE schema
 *
 * Different questions. This one asks "is the code consistent with the schema we
 * declare?". The live pair asks "is the database consistent with what we
 * declare?". Neither implies the other, and only this one can run everywhere.
 *
 * FAILURE POSTURE
 * ---------------
 * A false failure here blocks unrelated work, so the canonical model is built
 * as a deliberate SUPERSET (see lib/canonicalSchema.ts) and this script
 * declines to judge any table the model could not confidently build. The
 * residual risk is columns that exist LIVE but were applied out of band and
 * never recorded in a migration — real drift, listed explicitly in
 * UNDECLARED_LIVE_COLUMNS below rather than silently tolerated.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:schema-references
 *   pnpm run check:schema-references -- --verbose
 *
 * Exit 0 → every referenced column is declared by the repo (or allowlisted).
 * Exit 1 → at least one reference names a column the repo does not declare.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSchemaReferences } from "./lib/schemaReferenceExtract.js";
import {
  buildCanonicalSchema,
  isModelled,
  type CanonicalSchema,
} from "./lib/canonicalSchema.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
// COVERAGE. check:write-path-columns scans only routes+services, and that gap
// is not academic: sweeping the rest of the tree found `places.country` a THIRD
// time (src/lib/inputAssistance/duplicateDetection.ts) plus ten more dead
// references, none of which either check could see. All eleven verified missing
// in production on 2026-09-04.
const SCAN_DIRS = [
  resolve(__dir, "../routes"),
  resolve(__dir, "../services"),
  resolve(__dir, "../lib"),
  resolve(__dir, "../compass"),
  resolve(__dir, "../scripts"),
];
const BASELINE = resolve(API_ROOT, "baseline/20260819_baseline_structure.sql");
const MIGRATION_DIRS = [
  resolve(API_ROOT, "migrations"),
  resolve(API_ROOT, "src/migrations"),
];
const VERBOSE = process.argv.includes("--verbose");

/**
 * Columns that EXIST in the live database but are declared by no migration in
 * this repository — out-of-band DDL. Verified against production on 2026-09-04.
 *
 * These are listed so the static check does not fail on a reference to a column
 * that genuinely exists. That is a concession to reality, not approval: each one
 * is schema the repo cannot reproduce from its own migrations, which is exactly
 * what `audit:schema` exists to flag. The right fix is a migration recording the
 * DDL, after which the entry here should be deleted.
 *
 * This list must SHRINK. A new entry means someone applied DDL out of band
 * again.
 */
const UNDECLARED_LIVE_COLUMNS = new Set<string>([
  "location_sessions.journey_purpose",
  "user_deletion_requests.execution_lease_expires_at",
  "user_deletion_requests.execution_started_at",
  "user_deletion_requests.execution_token",
  "user_location_preferences.journey_consent_granted_at",
  "user_location_preferences.journey_consent_revoked_at",
  "user_location_preferences.journey_consent_scope",
  "user_location_preferences.journey_consent_version",
  "user_location_preferences.journey_observation_enabled",
]);

/**
 * Dead references that ALREADY EXISTED when this check was written — a RATCHET,
 * not an allowlist. Every one is verified MISSING IN PRODUCTION: each fails its
 * whole query at runtime, exactly like `places.country`.
 *
 * They are recorded rather than fixed because each needs its own judgement about
 * which real column carries the intent, and that judgement is the work — the
 * same lesson as the enum-literal class, where the obvious substitution was
 * wrong. Recording them makes eleven invisible defects visible and stops a
 * twelfth appearing; it does not bless them.
 *
 * The count per file is EXACT, so this fails in both directions: a new dead
 * reference in a listed file fails, and a fixed one that was not struck off
 * fails. This list must reach zero.
 */
const KNOWN_DEAD_REFERENCES: Record<string, { count: number; note: string }> = {
  // src/lib/inputAssistance/duplicateDetection.ts (places.country, the founding
  // defect's THIRD recurrence) was struck off: 9e82e8450 moved the read to
  // `country_code` the same day this ratchet landed, and the two met on main
  // with the entry still counting 1 — which is exactly the "fixed; delete the
  // entry" direction of this check firing, on main itself.
  // src/lib/mediaAccess.ts (close_friends.friend_id, user_follows.id) was
  // struck off by the dead-literals batch: isCloseFriend now reads
  // (owner_id, friend_user_id) as routes/stories.ts always has, and the avatar
  // follow check selects `follower_id` as lib/profileVisibility does. Both were
  // media AUTHORIZATION reads that failed 42703 into a `false` verdict, so a
  // close-friends story denied its own close friends.
  "src/lib/places/placeCollectionsWorker.ts": {
    count: 2,
    note: "posts.view_count / posts.qualified_view_count — no such columns; the " +
      "collections worker's ranking read has never returned a row.",
  },
  // ── The four Memory / Compass entries below were STRUCK OFF by the
  // ── memory-compass-lane batch. Each is recorded here rather than deleted
  // ── outright so the next reader can see which real column carried the
  // ── intent — the judgement was the work, exactly as the header says.
  //
  // src/compass/CompassAbuseDefenseEngine.ts (compass_visibility_cooldowns
  //   .updated_at on an UPSERT): struck off. The table is
  //   (id, author_id, cooldown_type, started_at, ends_at, reason); the two
  //   sibling writers in CompassFairExposureEngine.ts:112,218 already write
  //   `started_at` and no `updated_at`, so the intent ("when this cooldown
  //   began", restated when ON CONFLICT extends it) had a correct in-repo
  //   precedent. Every confirmed medium/high/severe abuse pattern had been
  //   logging a warning and leaving the offender's reach untouched.
  //
  // src/compass/CompassSearchDecayService.ts (feature_flags.numeric_value):
  //   struck off. feature_flags is (flag, enabled, description, updated_at,
  //   metadata); the non-boolean payload convention is the `metadata` jsonb,
  //   which lib/featureFlags.ts getFlagRow already selects. Now reads
  //   `enabled, metadata` and takes the half-life from
  //   metadata->>'half_life_days'; migration 2306 seeds the row, which had
  //   also never existed.
  //
  // src/compass/CompassStructuredContext.ts (rent_buddy_bookings.date_from /
  //   date_to): struck off. The table carries booking_date + start_time +
  //   duration_h, and routes/rentABuddy.ts:4625 already proved the mapping by
  //   translating its own ?dateFrom/?dateTo params onto `booking_date`. The
  //   Compass chat prompt had never once known the caller had a booking.
  //
  // src/compass/PassportRemembersService.ts (shared_moments.visibility):
  //   struck off. The table's audience control is `join_policy`
  //   (invite_only | approval_required) — a shared moment is never public —
  //   and its lifecycle control is `status`. The shared-moment group of "What
  //   Portava Remembers" had never rendered a row.
  "src/scripts/seed-demo-social.ts": {
    count: 1,
    note: "passport_postcards.media_type on an INSERT — the demo seeder's postcard " +
      "insert is rejected outright.",
  },
};

/** Non-`public` or non-table sources the column model does not cover. */
const SKIP_TABLES = new Set(["storage.objects", "auth.users"]);

export interface ReferenceFinding {
  table: string;
  column: string;
  where: string[];
}

/** Pure core, so a test can drive it against a fixture schema. */
export function findUndeclaredReferences(
  schema: CanonicalSchema,
  sites: { file: string; line: number; table: string; method: string; columns: string[] }[],
  allowlist: ReadonlySet<string> = UNDECLARED_LIVE_COLUMNS,
): ReferenceFinding[] {
  const byKey = new Map<string, ReferenceFinding>();
  for (const s of sites) {
    if (SKIP_TABLES.has(s.table)) continue;
    if (!isModelled(schema, s.table)) continue; // decline to judge
    const declared = schema.columns.get(s.table)!;
    for (const col of s.columns) {
      const key = `${s.table}.${col}`;
      if (declared.has(col) || allowlist.has(key)) continue;
      const f = byKey.get(key) ?? { table: s.table, column: col, where: [] };
      f.where.push(`${s.file}:${s.line} (${s.method})`);
      byKey.set(key, f);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

// ── Run ───────────────────────────────────────────────────────────────────────

const schema = buildCanonicalSchema(BASELINE, MIGRATION_DIRS);
const { sites, skipped } = extractSchemaReferences(API_ROOT, SCAN_DIRS);

console.log(
  `Canonical schema: ${schema.columns.size} tables from baseline + ` +
    `${schema.sources.migrationFiles} migrations` +
    (schema.unmodelled.size ? ` (${schema.unmodelled.size} unmodelled, not judged)` : ""),
);
console.log(
  `Extracted ${sites.length} statically-resolvable schema references ` +
    `(${skipped.length} sites unresolvable — the live check still covers those).`,
);

const findings = findUndeclaredReferences(schema, sites);

// Split into "already known" and "new", enforcing the ratchet both ways.
const perFile = new Map<string, number>();
for (const f of findings) for (const w of f.where) {
  const file = w.split(":")[0]!;
  perFile.set(file, (perFile.get(file) ?? 0) + 1);
}
const regressions: string[] = [];
for (const [file, n] of perFile) {
  const known = KNOWN_DEAD_REFERENCES[file];
  if (!known) {
    regressions.push(`${file}: ${n} NEW dead reference(s) — not in KNOWN_DEAD_REFERENCES`);
  } else if (n > known.count) {
    regressions.push(`${file}: grew from ${known.count} to ${n} dead reference(s)`);
  }
}
for (const [file, { count }] of Object.entries(KNOWN_DEAD_REFERENCES)) {
  const actual = perFile.get(file) ?? 0;
  if (actual < count) {
    regressions.push(
      `${file}: KNOWN_DEAD_REFERENCES says ${count}, scan finds ${actual}` +
      (actual === 0 ? " — fixed; delete the entry." : ` — partly fixed; set count to ${actual}.`));
  }
}

if (VERBOSE && schema.unmodelled.size) {
  console.log("\nUnmodelled tables (references to these are NOT judged):");
  for (const t of [...schema.unmodelled].sort()) console.log(`  ${t}`);
}

if (regressions.length > 0) {
  console.error("\n✗ Schema-reference ratchet broken:\n");
  for (const r of regressions) console.error(`  ${r}`);
  console.error("\nEvery dead reference below is listed for context:\n");
  for (const f of findings) {
    console.error(`  ${f.table}.${f.column}`);
    for (const w of f.where) console.error(`      ${w}`);
  }
  console.error(
    "\nEach of these fails the WHOLE query at runtime — a missing select-list " +
      "column fails the read with PGRST100, and a missing write column is " +
      "rejected even when the value is null. This is the `places.country` " +
      "class.\nFix the reference, or add the migration that creates the column.",
  );
  process.exit(1);
}

const knownTotal = Object.values(KNOWN_DEAD_REFERENCES).reduce((n, k) => n + k.count, 0);
console.log(
  `\n✓ No NEW undeclared column references. ` +
    `${findings.length} known dead reference(s) across ` +
    `${Object.keys(KNOWN_DEAD_REFERENCES).length} file(s) remain on the ratchet ` +
    `(expected ${knownTotal}); that list must shrink.`,
);
if (UNDECLARED_LIVE_COLUMNS.size > 0) {
  console.log(
    `  (${UNDECLARED_LIVE_COLUMNS.size} live columns are allowlisted as undeclared ` +
      "out-of-band DDL — see UNDECLARED_LIVE_COLUMNS; that list should shrink.)",
  );
}
