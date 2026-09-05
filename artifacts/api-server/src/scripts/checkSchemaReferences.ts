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
  // EMPTY — the ratchet reached zero on 2026-09-05, and the goal now is to keep
  // it there. An entry added here is a defect the build has agreed to certify as
  // known-and-fine; two of the original eleven turned out to sit inside media
  // AUTHORIZATION, where close-friends stories denied their own close friends.
  // Nothing about "it is on the ratchet" makes a dead reference harmless.
  //
  // HOW THE ELEVEN WENT, so the next one is not re-argued from scratch:
  //   src/lib/inputAssistance/duplicateDetection.ts  places.country (the founding
  //     defect's THIRD recurrence) — 9e82e8450 moved the read to `country_code`.
  //   src/lib/mediaAccess.ts  close_friends.friend_id, user_follows.id — struck
  //     off by the dead-literals batch; isCloseFriend now reads (owner_id,
  //     friend_user_id) and the avatar follow check selects `follower_id`.
  //   src/lib/places/placeCollectionsWorker.ts  posts.view_count /
  //     qualified_view_count — no such columns and no producer (post_impressions
  //     is never aggregated onto posts); dropped from the select, the two
  //     ranking terms stay optional and score 0. Best-of ranking now runs.
  //   src/compass/CompassAbuseDefenseEngine.ts  compass_visibility_cooldowns
  //     .updated_at on an UPSERT — the table has `started_at`; the reach
  //     reduction is now actually recorded.
  //   src/compass/CompassSearchDecayService.ts  feature_flags.numeric_value —
  //     no numeric column exists; moved onto jsonb `metadata`, where every other
  //     structured flag setting already lives.
  //   src/compass/CompassStructuredContext.ts  rent_buddy_bookings.date_from /
  //     date_to — a booking is single-day (booking_date, start_time, duration_h).
  //   src/compass/PassportRemembersService.ts  shared_moments.visibility — the
  //     table has none; the read no longer names it and the group is populated.
  //   src/scripts/seed-demo-social.ts  passport_postcards.media_type on an
  //     INSERT — the real trio is (media_count, has_video, primary_media_type).
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
  // `process.exitCode`, NOT `process.exit(1)`. An explicit exit tears the
  // process down before an async stderr pipe has drained, which truncated a
  // sibling guard's failure report on roughly one run in eight — the report is
  // the only thing that tells you WHICH reference broke, so losing it turns a
  // precise failure into a mystery. Setting the code lets node exit naturally,
  // after the writes above have flushed. There is no work after this block.
  process.exitCode = 1;
} else {
  const knownTotal = Object.values(KNOWN_DEAD_REFERENCES).reduce((n, k) => n + k.count, 0);
  console.log(
    knownTotal === 0
      ? "\n✓ No undeclared column references, and the ratchet is EMPTY — " +
          "KNOWN_DEAD_REFERENCES has reached zero. Keep it there: a new entry is " +
          "a defect the build agrees to certify as known-and-fine."
      : `\n✓ No NEW undeclared column references. ` +
          `${findings.length} known dead reference(s) across ` +
          `${Object.keys(KNOWN_DEAD_REFERENCES).length} file(s) remain on the ratchet ` +
          `(expected ${knownTotal}); that list must shrink.`,
  );
}
if (UNDECLARED_LIVE_COLUMNS.size > 0) {
  console.log(
    `  (${UNDECLARED_LIVE_COLUMNS.size} live columns are allowlisted as undeclared ` +
      "out-of-band DDL — see UNDECLARED_LIVE_COLUMNS; that list should shrink.)",
  );
}
