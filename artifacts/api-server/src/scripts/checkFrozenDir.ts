/**
 * Frozen-dir guard — standalone
 *
 * Checks that no new .sql files have been added to either of the two frozen
 * migration directories:
 *
 *   1. artifacts/api-server/migrations/  — the legacy dir, frozen 2026-07-17
 *   2. migrations/                       — the repo-root historical dir,
 *                                          formally archived 2026-08-08
 *
 * All new database changes must go into artifacts/api-server/src/migrations/.
 *
 * This script needs NO database credentials and is safe to run in any CI
 * environment, including branch preview builds and forks.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:frozen-dir
 * or directly:
 *   node --import tsx/esm src/scripts/checkFrozenDir.ts
 *
 * Exit code 0 → both frozen dirs contain only the known frozen sets (or don't exist)
 * Exit code 1 → one or more unexpected .sql files found in either frozen dir
 */

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FROZEN_LEGACY_FILES } from "./frozenLegacyFiles.js";
import { FROZEN_ROOT_FILES } from "./frozenRootFiles.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Scan a directory recursively for .sql files and return any that are not
 * in the provided frozen set.  Returns an empty array if the dir doesn't
 * exist (treated as passing).
 */
function findRogueFiles(dir: string, frozenSet: Set<string>): string[] {
  let entries: string[] = [];
  try {
    entries = (readdirSync(dir, { recursive: true }) as string[]).filter((f) =>
      f.endsWith(".sql"),
    );
  } catch {
    // Directory does not exist — nothing to check.
    return [];
  }
  // A frozen file is stored as a bare filename (no path separator).
  // Any entry that contains "/" (nested) or is not in the known set is rogue.
  return entries.filter((f) => !frozenSet.has(f));
}

// ── Checks ────────────────────────────────────────────────────────────────────

let anyFailed = false;

// 1. Legacy dir: artifacts/api-server/migrations/
{
  const legacyDir = resolve(__dir, "../../migrations");
  const rogueFiles = findRogueFiles(legacyDir, FROZEN_LEGACY_FILES);

  if (rogueFiles.length > 0) {
    console.error(
      "\nERROR: The legacy migrations directory (artifacts/api-server/migrations/) is frozen.\n" +
        "       New database changes must go into artifacts/api-server/src/migrations/ instead.\n" +
        "       See artifacts/api-server/migrations/README.md for details.\n\n" +
        "       Unexpected file(s) found in the frozen directory:\n" +
        rogueFiles.map((f) => `         • ${f}`).join("\n") +
        "\n",
    );
    anyFailed = true;
  } else {
    const total = (() => {
      try {
        return (readdirSync(legacyDir, { recursive: true }) as string[]).filter(
          (f) => f.endsWith(".sql"),
        ).length;
      } catch {
        return 0;
      }
    })();
    console.log(
      `check:frozen-dir [legacy] PASSED (${total} known file(s), 0 rogue)`,
    );
  }
}

// 2. Repo-root dir: migrations/
{
  // Resolve from the api-server package root up four levels to the repo root.
  // __dir is artifacts/api-server/src/scripts — so ../../../.. lands at root.
  const rootMigrationsDir = resolve(__dir, "../../../../migrations");
  const rogueFiles = findRogueFiles(rootMigrationsDir, FROZEN_ROOT_FILES);

  if (rogueFiles.length > 0) {
    console.error(
      "\nERROR: The repo-root migrations/ directory is archived.\n" +
        "       New database changes must go into artifacts/api-server/src/migrations/ instead.\n" +
        "       See migrations/README.md for details.\n\n" +
        "       Unexpected file(s) found in the archived directory:\n" +
        rogueFiles.map((f) => `         • ${f}`).join("\n") +
        "\n",
    );
    anyFailed = true;
  } else {
    const total = (() => {
      try {
        return (
          readdirSync(rootMigrationsDir, { recursive: true }) as string[]
        ).filter((f) => f.endsWith(".sql")).length;
      } catch {
        return 0;
      }
    })();
    console.log(
      `check:frozen-dir [root]   PASSED (${total} known file(s), 0 rogue)`,
    );
  }
}

if (anyFailed) {
  process.exit(1);
}
process.exit(0);
