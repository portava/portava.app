/**
 * Frozen-dir guard — standalone
 *
 * Verifies every non-canonical migration root in the repo (everything except
 * artifacts/api-server/src/migrations/) is EXACTLY what it was when frozen:
 * no files added, none removed, none modified in place. Also fails if a new
 * root appears anywhere in the repo that is neither the canonical dir nor one
 * of the explicitly-listed frozen roots — an unlisted root is an error, not a
 * silent pass, because that is exactly how artifacts/api-server/supabase/
 * migrations/ went unnoticed: a directory named like the others, holding
 * migration-shaped files, absent from every doc and guard that claimed to
 * enumerate the trees.
 *
 * The actual detection logic lives in frozenDirCheck.ts, parameterized on
 * repoRoot/manifest so it's testable against a temp directory. This file is
 * just the real-repo wiring plus reporting/exit-code plumbing.
 *
 * This script needs NO database credentials and is safe to run in any CI
 * environment, including branch preview builds and forks.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:frozen-dir
 * or directly:
 *   node --import tsx/esm src/scripts/checkFrozenDir.ts
 *
 * Exit code 0 → every known root matches its manifest exactly, and no
 *               unlisted root exists
 * Exit code 1 → added, removed, or modified files in a known root, or an
 *               unlisted root/file was found
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FROZEN_ROOTS, FROZEN_LOOSE_FILES } from "./frozenMigrationRoots.js";
import { runFrozenDirCheck } from "./frozenDirCheck.js";

const __dir = dirname(fileURLToPath(import.meta.url));
// __dir is artifacts/api-server/src/scripts — four levels up is the repo root.
const REPO_ROOT = resolve(__dir, "../../../..");
const CANONICAL_REL = "artifacts/api-server/src/migrations";

const result = runFrozenDirCheck(REPO_ROOT, CANONICAL_REL, FROZEN_ROOTS, FROZEN_LOOSE_FILES);
const fileCountByRelPath = new Map(FROZEN_ROOTS.map((r) => [r.relPath, Object.keys(r.files).length]));

let anyFailed = false;

for (const diff of result.rootDiffs) {
  const problems = diff.added.length + diff.removed.length + diff.modified.length;
  if (diff.missingDirEntirely) {
    console.error(
      `\nERROR: Frozen root "${diff.relPath}" (${diff.label}) is GONE entirely — ` +
        `${diff.removed.length} known file(s) vanished with it:\n` +
        diff.removed.map((f) => `         • ${f}`).join("\n") + "\n",
    );
    anyFailed = true;
    continue;
  }
  if (problems > 0) {
    console.error(`\nERROR: Frozen root "${diff.relPath}" (${diff.label}) has changed.`);
    if (diff.added.length) {
      console.error("       New file(s) added (frozen roots accept none):");
      for (const f of diff.added) console.error(`         + ${f}`);
    }
    if (diff.removed.length) {
      console.error("       Known file(s) deleted:");
      for (const f of diff.removed) console.error(`         - ${f}`);
    }
    if (diff.modified.length) {
      console.error("       Known file(s) modified in place (content hash changed):");
      for (const f of diff.modified) console.error(`         ~ ${f}`);
    }
    console.error();
    anyFailed = true;
  } else {
    console.log(
      `check:frozen-dir [${diff.relPath}] PASSED (${fileCountByRelPath.get(diff.relPath)} known file(s), unchanged)`,
    );
  }
}

const looseProblems = result.looseDiffs.filter((d) => d.status !== "ok");
if (looseProblems.length > 0) {
  console.error("\nERROR: Individually-pinned loose migration file(s) changed:");
  for (const d of looseProblems) {
    console.error(`         ${d.status === "missing" ? "-" : "~"} ${d.relPath} (${d.status})`);
  }
  console.error();
  anyFailed = true;
} else {
  console.log(`check:frozen-dir [loose files] PASSED (${result.looseDiffs.length} known file(s), unchanged)`);
}

if (result.unlistedHits.length > 0) {
  console.error(
    "\nERROR: Found migration-shaped .sql file(s) outside the canonical dir and every\n" +
      "       known frozen root/loose-file entry. A new root must be added to\n" +
      "       frozenMigrationRoots.ts explicitly — or, if these files belong in the\n" +
      "       canonical chain, moved to artifacts/api-server/src/migrations/ instead.\n" +
      "       This is exactly how artifacts/api-server/supabase/migrations/ went\n" +
      "       unnoticed: do not let this pass silently.\n\n" +
      "       Unlisted file(s):\n" +
      result.unlistedHits.map((f) => `         • ${f}`).join("\n") + "\n",
  );
  anyFailed = true;
} else {
  console.log("check:frozen-dir [unlisted-root sweep] PASSED (no migration-shaped files outside known roots)");
}

if (anyFailed) {
  process.exit(1);
}
process.exit(0);
