/**
 * checkMemoryTableOwnership — two event logs, one prefix, and no way to tell
 * them apart by name alone.
 *
 * `public.memory_events` is the Memory + Experience Intelligence PROJECTION
 * family's log (migrations 2183-2214), live in production, read by the
 * account-deletion cascade. `public.memory_domain_events` is the
 * Highlights/Memories spec §17 COMMAND log, not applied anywhere yet. They
 * share a prefix, a suffix, and nothing else.
 *
 * Migration 2710 was written to call the second one `memory_events`. With
 * `CREATE TABLE IF NOT EXISTS` that would not have created it and would not
 * have complained; the command kernel would have written domain events into the
 * projection family's table. The rename fixed the table, and a second pass
 * found nine dependent objects still named `memory_events_*` while operating on
 * the new one. This check is what stops the third instance.
 *
 * ── WHAT IT ENFORCES ─────────────────────────────────────────────────────────
 * 1. EVERY file naming either table is CLASSIFIED as legacy-side or kernel-side.
 *    An unclassified file fails: "which log does this touch" must have an
 *    answer, and a new file gets one by being added to the list deliberately.
 * 2. NO FILE names both, except the ones explicitly allowed to (2710's header
 *    explains the rename, and this checker itself has to name both).
 * 3. No object name says `memory_events_*` while belonging to the kernel
 *    migrations -- the exact ambiguity that survived the first rename.
 * 4. Application code (not tests, not migrations) may name
 *    `memory_domain_events` in ONE module only. Spec §17 asks for a command
 *    boundary; a boundary any file may write around is not one.
 *
 * ── WHAT IT DOES NOT COVER, STATED RATHER THAN IMPLIED ───────────────────────
 * (1) It reads the REPOSITORY, not the database. A hand-created table is
 *     invisible to it; the production enumeration in lib/memoryTableOwnership.ts
 *     is the live-side record and it has a date on it, not a guarantee.
 * (2) It cannot tell whether a classified file uses its table CORRECTLY -- only
 *     that somebody decided which side it is on.
 * (3) It matches text, over comment-stripped TypeScript but raw SQL. A SQL
 *     comment naming a table still counts, which is why 2710's explanatory
 *     header needs the explicit allowance in (2) rather than being missed.
 *
 * Run: node --import tsx/esm src/scripts/checkMemoryTableOwnership.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "./lib/stripComments.js";
import { MEMORY_TABLE_OWNERSHIP, MEMORY_DOMAIN_EVENTS_CANONICAL_WRITER } from "../lib/memoryTableOwnership.js";

const SRC = new URL("../", import.meta.url).pathname;

/** A tree where neither name appears is a tree this check could not find. */
const MIN_LEGACY_FILES = 10;
const MIN_KERNEL_FILES = 3;

/** Files that touch the PROJECTION family's log. */
const LEGACY_SIDE = new Set([
  "migrations/2183_memory_projection_contract.sql",
  "migrations/2184_memory_projector.sql",
  "migrations/2186_memory_projector_taxonomy.sql",
  "migrations/2187_memory_deletion_cascade.sql",
  "migrations/2190_memory_lifecycle_fixes.sql",
  "migrations/2192_memory_provenance_policy.sql",
  "migrations/2193_memory_projector_provenance.sql",
  "migrations/2194_memory_reset_export.sql",
  "migrations/2197_memory_reset_category_scope.sql",
  "migrations/2200_memory_projection_exclude_deleted_profiles.sql",
  "migrations/2333_derived_memory_and_consent_grant_boundary.sql",
  "lib/deletionDispositions.ts",
  "lib/memoryProjectionScheduler.ts",
  "services/accountDeletion/AccountDeletionService.ts",
  "test/memoryLifecycleLive.test.ts",
  "test/memoryProjectionLifecycleLive.test.ts",
  "test/liveFixtureEmails.test.ts",
  "test/migrationDeployability.test.ts",
]);

/** Files that touch the COMMAND kernel's log. */
const KERNEL_SIDE = new Set([
  "migrations/2711_memory_kernel_execute.sql",
  "lib/memoryOutbox.ts",
  "test/memoryCommandKernelFake.ts",
  "test/memoryCommandRoutes.test.ts",
  "test/memoryOutbox.test.ts",
]);

/**
 * Allowed to name BOTH. 2710 creates the kernel table and its header explains,
 * at length, why it is not called memory_events -- that explanation is the
 * point and must survive. The ownership record and this checker necessarily
 * name both as data.
 */
const BOTH_ALLOWED = new Set([
  "migrations/2710_memory_command_kernel_tables.sql",
  "lib/memoryTableOwnership.ts",
  "scripts/checkMemoryTableOwnership.ts",
  // The guard registry's `responsibility` string states what this check is FOR,
  // which cannot be said without naming both logs. It is a description, not a
  // reference: nothing in that file reads or writes either table. Caught by
  // this check on its own registration, which is the correct answer -- a string
  // is not a comment, and the strip-comments pass rightly left it alone.
  "scripts/guardRegistry.ts",
]);

/** The migrations that belong to the kernel; no object in them may say memory_events_*. */
const KERNEL_MIGRATIONS = [
  "migrations/2710_memory_command_kernel_tables.sql",
  "migrations/2711_memory_kernel_execute.sql",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") || name.endsWith(".sql")) out.push(p);
  }
  return out;
}

const problems: string[] = [];
let legacyFiles = 0;
let kernelFiles = 0;
let bothFiles = 0;
let scanned = 0;

for (const abs of walk(SRC)) {
  const rel = relative(SRC, abs).replace(/\\/g, "/");
  const raw = readFileSync(abs, "utf8");
  // TypeScript is comment-stripped; SQL is not, because a SQL comment naming a
  // table is exactly the case 2710's header represents and it must be seen.
  const text = abs.endsWith(".ts") ? stripComments(raw) : raw;
  const hasKernel = /\bmemory_domain_events\b/.test(text);
  // The legacy name, NOT counting the kernel one that contains no such boundary.
  const hasLegacy = /\bmemory_events\b/.test(text);
  if (!hasKernel && !hasLegacy) continue;
  scanned++;

  if (hasKernel && hasLegacy) {
    bothFiles++;
    if (!BOTH_ALLOWED.has(rel)) {
      problems.push(
        `::error::${rel} names BOTH public.memory_events and public.memory_domain_events. Those are two different logs — ` +
          `the projection family's (live, read by the deletion cascade) and the §17 command kernel's (not applied). A file ` +
          `that touches both is the shape the 2710 collision came from. Split it, or add it to BOTH_ALLOWED with a reason.`,
      );
    }
    continue;
  }

  if (hasKernel) {
    kernelFiles++;
    if (!KERNEL_SIDE.has(rel)) {
      problems.push(
        `::error::${rel} names public.memory_domain_events but is not classified in KERNEL_SIDE. Add it deliberately — ` +
          `"which of the two memory event logs does this file touch" must have a written answer, not an inferred one.`,
      );
    }
    // Rule 4: one canonical writer in application code.
    const isApp = !rel.startsWith("test/") && !rel.startsWith("migrations/") && !rel.startsWith("scripts/");
    if (isApp && rel !== relative("src", MEMORY_DOMAIN_EVENTS_CANONICAL_WRITER).replace(/\\/g, "/")) {
      problems.push(
        `::error::${rel} names public.memory_domain_events directly. Application code must go through ` +
          `${MEMORY_DOMAIN_EVENTS_CANONICAL_WRITER}. Spec §17 asks for a command boundary; a boundary any module may ` +
          `write around is not one, and scattered raw table strings are how the two logs get confused.`,
      );
    }
    continue;
  }

  legacyFiles++;
  if (!LEGACY_SIDE.has(rel)) {
    problems.push(
      `::error::${rel} names public.memory_events but is not classified in LEGACY_SIDE. That table is the projection ` +
        `family's log and the account-deletion cascade reads it — a new reference to it needs a deliberate entry, not a default.`,
    );
  }
}

// Rule 3: no kernel object may still be named memory_events_*.
for (const rel of KERNEL_MIGRATIONS) {
  const text = readFileSync(join(SRC, rel), "utf8");
  const stray = [...text.matchAll(/\b(?:idx_|trg_)?memory_events_[a-z_]+/g)].map((m) => m[0]);
  const unique = [...new Set(stray)];
  if (unique.length > 0) {
    problems.push(
      `::error::${rel} declares object(s) named ${unique.join(", ")} — a memory_events_* name on an object belonging to ` +
        `memory_domain_events. The table was renamed and these were not; that is the same ambiguity one level down, and it ` +
        `is how an index or trigger ends up attached to the wrong log.`,
    );
  }
}

// Staleness: a classification for a file that no longer names the table.
for (const [label, set] of [["LEGACY_SIDE", LEGACY_SIDE], ["KERNEL_SIDE", KERNEL_SIDE], ["BOTH_ALLOWED", BOTH_ALLOWED]] as const) {
  for (const rel of set) {
    let text: string;
    try { text = readFileSync(join(SRC, rel), "utf8"); } catch {
      problems.push(`::error::${label} names ${rel}, which does not exist. Delete the entry.`);
      continue;
    }
    if (!/\bmemory_events\b|\bmemory_domain_events\b/.test(text)) {
      problems.push(`::error::${label} names ${rel}, which no longer references either table. Delete the entry.`);
    }
  }
}

if (legacyFiles < MIN_LEGACY_FILES) problems.push(`::error::found ${legacyFiles} legacy-side file(s), expected at least ${MIN_LEGACY_FILES} — this check did not find the projection family.`);
if (kernelFiles < MIN_KERNEL_FILES) problems.push(`::error::found ${kernelFiles} kernel-side file(s), expected at least ${MIN_KERNEL_FILES} — this check did not find the command kernel.`);

for (const p of problems) console.error(p);

console.log(
  `\nNOTE: ${scanned} file(s) reference a memory event log — ${legacyFiles} the projection family's ` +
    `public.memory_events, ${kernelFiles} the §17 command kernel's public.memory_domain_events, ${bothFiles} both ` +
    `(allowed, with a reason). ${MEMORY_TABLE_OWNERSHIP.length} memory_* tables carry a written owner in ` +
    `lib/memoryTableOwnership.ts; ${MEMORY_TABLE_OWNERSHIP.filter((o) => o.liveInProduction).length} of them are live in ` +
    `production and ${MEMORY_TABLE_OWNERSHIP.filter((o) => !o.liveInProduction).length} are provided by migrations that ` +
    `are written and NOT APPLIED.`,
);
console.log(
  `NOTE: DOES NOT COVER — (1) the live database; the production enumeration in lib/memoryTableOwnership.ts is dated, ` +
    `not guaranteed; (2) whether a classified file uses its table CORRECTLY, only that somebody decided which side it is ` +
    `on; (3) SQL comments count as references, which is deliberate — 2710's header explains the rename and that ` +
    `explanation is the thing worth keeping.`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("\ncheck:memory-table-ownership PASSED");
