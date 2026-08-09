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

/**
 * Detect a local admin guard by SHAPE, not by name prefix.
 *
 * The original matcher was `/function\s+(requireAdmin\w*)\s*\(/` — keyed on the
 * name. It missed `requireVisualAdmin` in adminVisuals.ts, a full admin guard
 * that reads profiles.role and sends 403, purely because the name does not
 * begin with "requireAdmin". Worse, the "30 local guards" baseline that the
 * whole consolidation was scoped against came from this same matcher, so the
 * baseline inherited the blind spot. A name-keyed check only ever finds guards
 * someone remembered to name conventionally — which is not the population you
 * need to worry about.
 *
 * Shape test: a function declaration whose body both
 *   (a) queries the `profiles` table for `role`, and
 *   (b) compares that role against a literal role name.
 * Both must be present, so a plain profile read (name, avatar) is not flagged.
 *
 * Scanning is brace-balanced from the declaration so a match is attributed to
 * the function it is actually inside, rather than to the nearest preceding
 * `function` keyword.
 */
const FUNCTION_DECL =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;

/** Body reads profiles.role. */
const READS_ROLE = /\.from\(\s*["'`]profiles["'`]\s*\)[\s\S]{0,400}?\.select\(\s*["'`][^"'`]*\brole\b/;
/** Body compares a role against a literal — 'admin', 'owner', 'moderator', … */
const COMPARES_ROLE =
  /\brole\b[\s\S]{0,80}?(?:===|!==|==|!=)\s*["'`](?:admin|owner|moderator|superadmin|staff)["'`]|(?:===|!==|==|!=)\s*["'`](?:admin|owner|moderator|superadmin|staff)["'`][\s\S]{0,40}?\brole\b|\broles\b\s*\.\s*includes\s*\(/;

/**
 * Extract the body of the function whose declaration starts at `declIdx`.
 *
 * The opening brace is NOT simply the next `{`. A return-type annotation can
 * contain one:
 *
 *   async function requireAdmin(req, res): Promise<{ user: any } | null> {
 *                                                  ^ not the body
 *
 * Taking that brace yields `{ user: any }` as the "body", which contains no
 * role check, so the guard reads as clean. Four of the six known guards are
 * written exactly this way — the first version of this shape check silently
 * under-reported because of it. So: balance the parameter parens first, then
 * take the first brace at angle-bracket depth zero.
 */
function functionBody(source: string, declIdx: number): string {
  // Balance the parameter list.
  let i = source.indexOf("(", declIdx);
  if (i === -1) return "";
  let paren = 0;
  for (; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "(") paren++;
    else if (ch === ")") { paren--; if (paren === 0) { i++; break; } }
  }
  // Skip the return-type annotation: the body brace is the first `{` that is
  // not nested inside `<...>`.
  let angle = 0;
  let open = -1;
  for (; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "<") angle++;
    else if (ch === ">") { if (angle > 0) angle--; }
    else if (ch === "{" && angle === 0) { open = i; break; }
    // An overload signature ends at a semicolon with no body — but only count
    // one at angle depth 0. `Promise<{ user: any; sc: any } | null>` contains a
    // semicolon INSIDE the type, and treating that as an overload made four
    // guards vanish from this check.
    else if (ch === ";" && angle === 0) return "";
  }
  if (open === -1) return "";

  // Balance braces, skipping strings AND comments. Comments matter: a stray
  // `{` in prose (`// build the { thing }`) or an unbalanced brace in a block
  // comment desynchronises the counter, the closing brace is never matched,
  // and the "body" runs to the end of the file. That produced a real false
  // positive here — compass.ts's streamModelRound came back as a 106,910-char
  // body and matched both shape patterns from unrelated code far below it.
  let depth = 0;
  let inStr: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  // Never found the closing brace — the scan desynchronised. Return nothing
  // rather than a runaway slice, so this reports no guard instead of a
  // spurious one. A missed guard is caught by review; a false positive
  // teaches people to ignore the check.
  return "";
}

/** Every locally declared admin guard in `source`, found by shape. */
function findLocalGuards(source: string): string[] {
  const found: string[] = [];
  FUNCTION_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNCTION_DECL.exec(source))) {
    const name = m[1]!;
    const body = functionBody(source, m.index);
    if (READS_ROLE.test(body) && COMPARES_ROLE.test(body)) found.push(name);
  }
  return found;
}

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
  for (const fn of findLocalGuards(source)) {
    violations.push({ file, fn });
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
