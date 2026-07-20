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

const byPrefix = new Map<string, string[]>();
for (const file of files) {
  const m = PREFIX_RE.exec(file);
  if (!m) continue; // non-prefixed files (shouldn't exist) — ignore
  const prefix = m[1];
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
  byPrefix.get(prefix)!.push(file);
}

const collisions: Array<{ prefix: string; files: string[] }> = [];
for (const [prefix, names] of byPrefix) {
  if (names.length > 1) collisions.push({ prefix, files: names });
}

if (collisions.length > 0) {
  console.error(
    "\nERROR: Duplicate migration prefixes found in src/migrations/.\n" +
      "       Migration runners apply files in lexicographic order; shared\n" +
      "       prefixes produce an ambiguous sequence and can cause 500 errors\n" +
      "       when columns or tables are referenced before they are created.\n" +
      "       Renumber the colliding files to unique prefixes.\n",
  );
  for (const { prefix, files: names } of collisions) {
    console.error(`  Prefix ${prefix}:`);
    for (const name of names) console.error(`    • ${name}`);
  }
  console.error();
  process.exit(1);
}

console.log(
  `check:migration-prefixes PASSED (${files.length} file(s), all prefixes unique)`,
);
process.exit(0);
