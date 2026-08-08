/**
 * Admin-guard duplication check — standalone CI check
 *
 * Scans src/routes/ and fails if any file declares its OWN admin
 * authorisation guard instead of importing the shared one from lib/requireAdmin.
 *
 * WHY
 * ---
 * This repo had 30 local admin guards across 30 route files, under four names
 * (requireAdmin, requireAdminGuard, requireAdminCtx, requireAdminForStamps).
 * An audit before consolidation found all 30 fail closed, but also found two
 * genuine divergences that a careless merge would have turned into a silent
 * security change:
 *
 *   - rentABuddyRollout.ts accepted role 'owner' as well as 'admin'
 *   - hiddenGems.ts used a predicate shape that never sends 403 itself
 *
 * Both are now expressed as options on the shared guard. The risk is that the
 * 31st route re-hand-rolls one, drifts, and nobody notices — an authorisation
 * check is exactly the wrong thing to re-implement per file. This check exists
 * so that cannot happen quietly.
 *
 * WHAT IT DETECTS
 * ---------------
 * A function declaration in src/routes/ whose name starts with `requireAdmin`
 * (any suffix, any casing of the remainder) — i.e. a locally declared guard.
 * Imports of the shared guard are fine and are what this check is pushing you
 * toward.
 *
 * DELIBERATELY NOT DETECTED
 * -------------------------
 * - Inline role comparisons that are not a declared guard function. Those are
 *   a different smell and a name-based check cannot reliably tell an
 *   authorisation gate from an ordinary role read.
 * - Anything outside src/routes/. lib/requireAdmin.ts is the definition and
 *   must obviously be allowed to declare it.
 *
 * This check is zero-dependency and does not type-check, so it is name-based
 * by design. Anything it gets wrong belongs in ALLOWED with a stated reason —
 * not silently removed.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:admin-guard
 * or directly:
 *   node --import tsx/esm src/scripts/checkAdminGuard.ts
 *
 * Exit code 0 → every route file uses the shared guard
 * Exit code 1 → one or more route files declare their own
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const routesDir = resolve(__dir, "../routes");

/**
 * Files permitted to declare a local admin guard.
 *
 * Each entry needs a NOTE saying why. An allowlist without reasons becomes a
 * dumping ground for whatever was inconvenient that afternoon, and then the
 * check stops meaning anything.
 *
 * This starts EMPTY on purpose: the consolidation removed every local guard,
 * so any future entry represents a deliberate, argued exception.
 */
const ALLOWED: Record<string, string> = {
  // NOTE example (keep this shape):
  // "someRoute.ts": "Guard needs X which the shared helper cannot express because Y.",
};

/** Matches a locally declared admin guard, e.g. `async function requireAdminGuard(` */
const LOCAL_GUARD = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(requireAdmin\w*)\s*\(/g;

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name)
    .sort();
}

const violations: Array<{ file: string; fn: string }> = [];

for (const file of tsFilesIn(routesDir)) {
  if (file in ALLOWED) continue;
  const source = readFileSync(join(routesDir, file), "utf8");
  LOCAL_GUARD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOCAL_GUARD.exec(source))) {
    violations.push({ file, fn: m[1] });
  }
}

if (violations.length === 0) {
  const skipped = Object.keys(ALLOWED).length;
  console.log(
    `check-admin-guard PASSED — no local admin guards in src/routes/` +
      (skipped ? ` (${skipped} allowlisted)` : ""),
  );
  process.exit(0);
}

console.error(
  `\ncheck-admin-guard FAILED — ${violations.length} locally declared admin guard(s):\n`,
);
for (const v of violations) {
  console.error(`  src/routes/${v.file}  →  ${v.fn}()`);
}
console.error(`
An admin guard re-implemented per file is how authorisation drifts. This repo
already carried 30 copies under 4 different names; two of them had diverged in
ways a careless merge would have turned into either a privilege widening or a
broken feature.

FIX — import the shared guard instead:

  import { requireAdmin } from "../lib/requireAdmin";

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;                       // 403 already sent

  // wider role set (this is what rentABuddyRollout needs):
  const ctx = await requireAdmin(req, res, { roles: ["admin", "owner"] });

  // needs display_name for audit labelling:
  const ctx = await requireAdmin(req, res, { withDisplayName: true });

  // predicate form, sends nothing, caller owns the response:
  import { isAdmin } from "../lib/requireAdmin";
  if (!(await isAdmin(sc, userId))) { /* caller's own 403 */ }

If the shared guard genuinely cannot express what this route needs, add the
file to ALLOWED in src/scripts/checkAdminGuard.ts with a NOTE explaining why.
Do not delete the check.
`);
process.exit(1);
