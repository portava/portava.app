/**
 * Frozen-dir guard — standalone
 *
 * Checks that no new .sql files have been added to the legacy migrations
 * directory (artifacts/api-server/migrations/).  That directory is frozen
 * as of 2026-07-17; all new database changes must go into src/migrations/.
 *
 * This script needs NO database credentials and is safe to run in any CI
 * environment, including branch preview builds and forks.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:frozen-dir
 * or directly:
 *   node --import tsx/esm src/scripts/checkFrozenDir.ts
 *
 * Exit code 0 → legacy dir contains only the known frozen set (or doesn't exist)
 * Exit code 1 → one or more unexpected .sql files found in the legacy dir
 */

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FROZEN_LEGACY_FILES } from "./frozenLegacyFiles.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Check ─────────────────────────────────────────────────────────────────────

const legacyDir = resolve(__dir, "../../migrations");

let legacyEntries: string[] = [];
try {
  legacyEntries = (
    readdirSync(legacyDir, { recursive: true }) as string[]
  ).filter((f) => f.endsWith(".sql"));
} catch {
  // Directory does not exist — nothing to check; pass immediately.
  console.log("check:frozen-dir PASSED (legacy migrations dir not present)");
  process.exit(0);
}

// A frozen file is stored as a bare filename (no path separator).
// Any entry that contains "/" (nested) or is not in the known set is rogue.
const rogueFiles = legacyEntries.filter((f) => !FROZEN_LEGACY_FILES.has(f));

if (rogueFiles.length > 0) {
  console.error(
    "\nERROR: The legacy migrations directory (artifacts/api-server/migrations/) is frozen.\n" +
      "       New database changes must go into artifacts/api-server/src/migrations/ instead.\n" +
      "       See artifacts/api-server/migrations/README.md for details.\n\n" +
      "       Unexpected file(s) found in the frozen directory:\n" +
      rogueFiles.map((f) => `         • ${f}`).join("\n") +
      "\n",
  );
  process.exit(1);
}

console.log(
  `check:frozen-dir PASSED (${legacyEntries.length} known file(s), 0 rogue)`,
);
process.exit(0);
