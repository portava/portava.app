/**
 * Migration prefix-collision guard
 *
 * Scans src/migrations/ and fails (exit 1) if any two files share the same
 * four-digit numeric prefix, which would cause migration runners applying
 * files in lexicographic order to apply them in an ambiguous or wrong sequence.
 *
 * This script needs NO database credentials and is safe to run in any CI
 * environment.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:migration-prefixes
 * or directly:
 *   node --import tsx/esm src/scripts/checkMigrationPrefixes.ts
 *
 * Exit code 0 → every prefix is unique
 * Exit code 1 → one or more prefix collisions detected
 */

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAllPrefixBands } from "./migrationPrefixRules.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dir, "../migrations");

let files: string[];
try {
  files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
} catch {
  console.error(`ERROR: Could not read migrations directory: ${migrationsDir}`);
  process.exit(1);
}

// Extract the numeric prefix (leading digits) from each filename.
const PREFIX_RE = /^(\d+)/;

// ── Documented collisions ─────────────────────────────────────────────────────
//
// A prefix collision is normally fixed by renumbering the file that has NOT yet
// been applied. That option only exists while one of the two is unapplied.
//
// There is no `schema_migrations` table in this project (verified 2026-08-09:
// no table matching '%migration%' in `public` or `supabase_migrations`), so the
// only way to know whether a file has been applied is to check whether its
// objects exist live. For prefix 2059 BOTH files were verified applied against
// the live database, so neither can be renumbered to reflect what happened —
// renaming an applied file would only make the record less accurate.
//
// Each entry below therefore records a collision that is permanent and
// harmless, and must be justified in docs/migrations.md. The match is on the
// EXACT file set: if a third file ever takes a documented prefix, the set no
// longer matches and the check fails as it should. This allowlist can only
// excuse the specific collision that was investigated — never a new one.
const DOCUMENTED_COLLISIONS: Record<string, readonly string[]> = {
  // Both applied live; the two files touch unrelated objects
  // (content_distribution_stats vs. stamp_artwork_versions), so their relative
  // order is immaterial on a fresh replay. See docs/migrations.md
  // "Prefix collisions".
  "2059": [
    "2059_content_distribution_stats.sql",
    "2059_stamp_artwork_generation_source_placeholder.sql",
  ],
  // Both applied live on 2026-08-14, within hours of each other, by two agents
  // working the same branch concurrently — neither could see the other's file
  // until both had merged.
  //
  // VERIFIED APPLIED BEFORE DOCUMENTING, because the rule this script prints is
  // "renumber the one that has NOT been applied", and renumbering is only wrong
  // when both have:
  //   * 2089_revoke_post_media_public_read      — pg_policies shows
  //     post_media_storage_public_read ABSENT; the audit exits 3 (AFTER state).
  //   * 2089_media_assets_ready_requires_dimensions — pg_constraint shows
  //     media_assets_ready_has_dimensions present with convalidated=false,
  //     which is exactly what its NOT VALID clause produces.
  //
  // The two files touch unrelated objects — a storage.objects RLS policy vs. a
  // CHECK constraint on public.media_assets — so their relative order is
  // immaterial on a fresh replay. Renaming either would break the
  // correspondence between the filename and what was actually run against
  // production, which is the only record that a migration WAS run: there is no
  // schema_migrations table here. See docs/migrations.md "Prefix collisions".
  "2089": [
    "2089_media_assets_ready_requires_dimensions.sql",
    "2089_revoke_post_media_public_read.sql",
  ],
};

/** True when `names` is exactly the documented file set for `prefix`. */
function isDocumented(prefix: string, names: string[]): boolean {
  const documented = DOCUMENTED_COLLISIONS[prefix];
  if (!documented) return false;
  if (documented.length !== names.length) return false;
  const a = [...documented].sort();
  const b = [...names].sort();
  return a.every((n, i) => n === b[i]);
}

const byPrefix = new Map<string, string[]>();
for (const file of files) {
  const m = PREFIX_RE.exec(file);
  if (!m) continue; // non-prefixed files (shouldn't exist) — ignore
  const prefix = m[1];
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
  byPrefix.get(prefix)!.push(file);
}

const collisions: Array<{ prefix: string; files: string[] }> = [];
const excused: Array<{ prefix: string; files: string[] }> = [];
for (const [prefix, names] of byPrefix) {
  if (names.length <= 1) continue;
  if (isDocumented(prefix, names)) excused.push({ prefix, files: names });
  else collisions.push({ prefix, files: names });
}

if (collisions.length > 0) {
  console.error(
    "\nERROR: Duplicate migration prefixes found in src/migrations/.\n" +
      "       Migration runners apply files in lexicographic order; shared\n" +
      "       prefixes produce an ambiguous sequence and can cause 500 errors\n" +
      "       when columns or tables are referenced before they are created.\n\n" +
      "       Before renumbering: there is no schema_migrations table, so check\n" +
      "       whether each file's objects already exist LIVE. Renumber the one\n" +
      "       that has NOT been applied. If both are already applied, document\n" +
      "       the collision in docs/migrations.md and add it to\n" +
      "       DOCUMENTED_COLLISIONS in this script.\n",
  );
  for (const { prefix, files: names } of collisions) {
    console.error(`  Prefix ${prefix}:`);
    for (const name of names) console.error(`    • ${name}`);
  }
  console.error();
  process.exit(1);
}

// ── New-numeric-prefix band ──────────────────────────────────────────────────
//
// Closes the gap where a future 8-digit dated filename (e.g.
// 20270101_foo.sql) would sort lexicographically BELOW the string "2100",
// which some future tooling could otherwise use as a naive "authored after
// baseline" boundary test. See migrationPrefixRules.ts for the full
// reasoning. Reserves 2096-2099 as an unusable buffer and requires any new
// 4-digit numeric prefix to land in 2100-2999.

const bandViolations = validateAllPrefixBands(files);
if (bandViolations.length > 0) {
  console.error(
    "\nERROR: Migration filename(s) violate the new-numeric-prefix band.\n" +
      "       4-digit prefixes 2096-2099 are a reserved, permanently-unusable\n" +
      "       buffer. A NEW 4-digit numeric prefix must be in 2100-2999\n" +
      "       (matching /^2[1-9]\\d{2}_/) — this keeps the numbering convention\n" +
      "       structurally distinct from the 8-digit dated convention\n" +
      "       (20260815_...), so a filename >= \"2100\" test can never again be\n" +
      "       fooled by a dated file sorting below it. If you meant to author a\n" +
      "       dated migration, use the full YYYYMMDD_ prefix instead.\n",
  );
  for (const { file, reason } of bandViolations) {
    console.error(`  • ${file}: ${reason}`);
  }
  console.error();
  process.exit(1);
}

for (const { prefix, files: names } of excused) {
  console.log(
    `check:migration-prefixes NOTE: prefix ${prefix} is a documented collision ` +
      `(both applied live; see docs/migrations.md):`,
  );
  for (const name of names) console.log(`    • ${name}`);
}

console.log(
  `check:migration-prefixes PASSED (${files.length} file(s), ` +
    `${excused.length} documented collision(s), no undocumented collisions, ` +
    "new-numeric-prefix band clean)",
);
process.exit(0);
