/**
 * check-direct-trip-writes — the distance between here and a load-bearing Trip Kernel.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The owner's ruling on Trips v4: "Consequential Trip state mutations must
 * ultimately pass through the canonical Trip Kernel." Today they do not. Roughly
 * sixty mutating routes across src/routes/trips.ts and src/routes/trips-expansion.ts
 * write the trip tables directly, plus the schedulers, services and admin
 * surfaces that reach the same tables from elsewhere.
 *
 * That migration cannot be one pull request, and a migration with no meter is a
 * migration that quietly stops. So this counts the direct writes, records the
 * count per file as a baseline, and enforces one rule in both directions:
 *
 *     THE COUNT MAY ONLY GO DOWN.
 *
 * A NEW direct write in a file fails the check — the debt cannot grow while
 * someone is not looking. A file whose count DROPS below its baseline entry also
 * fails, until the entry is lowered — so the baseline can never become a stale
 * over-allowance that quietly re-admits the writes it was meant to retire. This
 * is the shape checkSilentSupabaseWrites.ts uses for its own burn-down, and it
 * is deliberately the same shape here.
 *
 * ── WHAT COUNTS AS A DIRECT TRIP WRITE ──────────────────────────────────────
 * A supabase-js chain rooted at `.from("<trip table>")` that reaches
 * `.insert(`, `.update(`, `.upsert(` or `.delete(` before its statement ends,
 * anywhere under src/ EXCEPT:
 *
 *   * src/lib/tripKernel/  — the kernel itself. It is the sanctioned writer;
 *     that is the whole point.
 *   * test trees and *.test.ts — a fixture that seeds a trip is not product
 *     code writing around the kernel.
 *   * database.types.ts — generated.
 *   * this file — its own pattern literals would self-match.
 *   * a site carrying the `trip-kernel-bypass-ok:` escape hatch WITH A REASON —
 *     for a write that touches a trip table without being a trip state mutation.
 *     Exactly one exists today: the right-to-erasure null-out of
 *     trip_events.actor_id in AccountDeletionService.
 *
 * A "trip table" is `public.trips` or any table whose name begins with `trip_`.
 * That is computed from the identifier at the call site, not from a hand-kept
 * list, so a trip table added by a future migration is in scope on the day it
 * gets its first writer — including public.trip_events itself. trip_events has
 * no baseline entry, so ANY write to the kernel's own log from outside the
 * kernel fails this check immediately rather than being absorbed as debt.
 *
 * ── LIMITS, STATED RATHER THAN IMPLIED ──────────────────────────────────────
 *   * Text-level, not type-level. A trip write reached through a helper that
 *     takes the table name as a parameter is invisible; the count of such
 *     dynamic `.from(<expr>)` sites is PRINTED on every run so the blind spot
 *     is visible rather than implied.
 *   * Server-side only. The mobile client writes trip tables through PostgREST
 *     too; those are a separate problem and this check does not pretend to see
 *     them.
 *   * It counts CALL SITES, not consequential mutations. A route that writes two
 *     trip tables counts twice. That is the right bias for a burn-down meter:
 *     every one of them is a write the kernel does not yet mediate.
 *   * It says nothing about whether a write is correct. A direct write can be
 *     perfectly correct and still be debt, because it bypasses the version
 *     bump and leaves no event.
 *
 * Static, so it needs no database and runs on every push.
 * Run: node --import tsx/esm src/scripts/checkDirectTripWrites.ts
 *      node --import tsx/esm src/scripts/checkDirectTripWrites.ts --verbose
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dir, "..");

const SKIP_DIRS = new Set(["test", "__tests__", "node_modules", "migrations"]);
const SKIP_FILES = new Set([
  "database.types.ts",
  // This guard's own pattern literals would self-match.
  "checkDirectTripWrites.ts",
]);

/** The kernel is the sanctioned writer. Relative to SRC_ROOT, posix-style. */
const KERNEL_DIR = "lib/tripKernel/";

/**
 * Per-site escape hatch, for a write that touches a trip table but is NOT a
 * consequential trip state mutation and so has no business being a TripCommand.
 * The one that exists today is the right-to-erasure null-out of
 * trip_events.actor_id in AccountDeletionService: a data-rights anonymisation,
 * not a change to any trip's state.
 *
 * The token MUST be followed by `:` and a reason of at least ten characters. A
 * hatch with no reason is a bypass wearing a note, and this repo has watched
 * that happen to enough allowlists to insist.
 *
 *     // trip-kernel-bypass-ok: <why this is not a trip state mutation>
 */
export const ESCAPE_HATCH = "trip-kernel-bypass-ok";
// `[ \t]*`, deliberately not `\s*`: `\s` matches a newline, so a bare
// `// trip-kernel-bypass-ok:` would borrow the NEXT line as its reason.
const ESCAPE_HATCH_RE = new RegExp(`${ESCAPE_HATCH}:[ \\t]*\\S[^\\n]{9,}`);
/** How far BEFORE the `.from(` an escape-hatch comment may sit. */
const HATCH_LOOKBEHIND = 400;

/** Write methods that make a chain a mutation. */
const WRITE_METHOD = /\.\s*(insert|update|upsert|delete)\s*\(/;

/** How far past a `.from(...)` to look for the write, when no `;` intervenes. */
const CHAIN_WINDOW = 800;

export interface DirectTripWrite {
  file: string;
  /** 1-indexed line of the `.from(` call. */
  line: number;
  table: string;
  method: string;
}

/** True for the trips aggregate root and every trip_* child table. */
export function isTripTable(name: string): boolean {
  return name === "trips" || name.startsWith("trip_");
}

/**
 * Blank comment spans while leaving STRING CONTENTS intact.
 *
 * This is the opposite trade-off from checkSilentSupabaseWrites' sanitizer,
 * and deliberately so: that guard needed brace structure and did not care about
 * literals, whereas the whole subject here is the table name inside
 * `.from("trips")`. Comments still have to go — a header that describes the
 * pattern (this file's own does) would otherwise be counted as a call site.
 * Lengths and newlines are preserved so line numbers stay true.
 */
export function stripComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      // Skip OVER the literal without blanking it.
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        if (c !== "`" && src[j] === "\n") break; // unterminated — bail at line end
        j++;
      }
      i = Math.min(j, n) + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

const FROM_LITERAL = /\.\s*from\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g;
const FROM_ANY = /\.\s*from\s*\(/g;

/** Scan one file's source for direct trip-table writes. */
export function findDirectTripWrites(
  src: string,
  file: string,
): { writes: DirectTripWrite[]; dynamicFrom: number } {
  const code = stripComments(src);
  const writes: DirectTripWrite[] = [];

  FROM_LITERAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FROM_LITERAL.exec(code)) !== null) {
    const table = m[1];
    if (!isTripTable(table)) continue;

    const start = m.index + m[0].length;
    const semi = code.indexOf(";", start);
    const end = Math.min(semi === -1 ? code.length : semi, start + CHAIN_WINDOW);
    const chain = code.slice(start, end);
    const wm = WRITE_METHOD.exec(chain);
    if (!wm) continue;

    // Escape hatch, read from the ORIGINAL source — the comment carrying it was
    // blanked in `code`.
    const around = src.slice(Math.max(0, m.index - HATCH_LOOKBEHIND), start + chain.length);
    if (ESCAPE_HATCH_RE.test(around)) continue;

    writes.push({ file, line: lineOf(src, m.index), table, method: wm[1] });
  }

  // Blind-spot meter: `.from(` calls whose argument is not a string literal.
  FROM_ANY.lastIndex = 0;
  let dynamicFrom = 0;
  let a: RegExpExecArray | null;
  while ((a = FROM_ANY.exec(code)) !== null) {
    const after = code.slice(a.index + a[0].length, a.index + a[0].length + 2).trim();
    if (!after.startsWith('"') && !after.startsWith("'") && !after.startsWith("`")) dynamicFrom++;
  }

  return { writes, dynamicFrom };
}

export function scanTree(root: string = SRC_ROOT): { writes: DirectTripWrite[]; dynamicFrom: number } {
  const all: DirectTripWrite[] = [];
  let dynamicFrom = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(p);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !SKIP_FILES.has(name)) {
        const rel = relative(root, p).split("\\").join("/");
        if (rel.startsWith(KERNEL_DIR)) continue;
        const r = findDirectTripWrites(readFileSync(p, "utf8"), rel);
        all.push(...r.writes);
        dynamicFrom += r.dynamicFrom;
      }
    }
  };
  walk(root);
  return { writes: all, dynamicFrom };
}

// ── Baseline ratchet ────────────────────────────────────────────────────────
// Per-file COUNT, not line numbers, so an unrelated edit to a file does not
// churn the baseline. Moving a write behind the kernel requires LOWERING its
// entry; a stale (too-high) entry FAILS, which is what makes the ratchet
// shrink-only rather than merely non-growing.
const BASELINE_PATH = resolve(__dir, "../../scripts/DIRECT_TRIP_WRITES_BASELINE.json");

export function compareToBaseline(
  writes: DirectTripWrite[],
  baseline: Record<string, number>,
): {
  newViolations: DirectTripWrite[];
  staleEntries: Array<{ file: string; baselined: number; found: number }>;
} {
  const byFile = new Map<string, DirectTripWrite[]>();
  for (const w of writes) {
    const list = byFile.get(w.file);
    if (list) list.push(w);
    else byFile.set(w.file, [w]);
  }
  const newViolations: DirectTripWrite[] = [];
  const staleEntries: Array<{ file: string; baselined: number; found: number }> = [];
  for (const [file, ws] of byFile) {
    const allowed = baseline[file] ?? 0;
    if (ws.length > allowed) newViolations.push(...ws.slice(0, ws.length - allowed));
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const found = byFile.get(file)?.length ?? 0;
    if (found < allowed) staleEntries.push({ file, baselined: allowed, found });
  }
  return { newViolations, staleEntries };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const verbose = process.argv.includes("--verbose");
  let baseline: Record<string, number> = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    // No baseline file — every direct write is new.
  }
  const { writes, dynamicFrom } = scanTree();
  const { newViolations, staleEntries } = compareToBaseline(writes, baseline);
  const total = writes.length;
  const baselinedTotal = Object.values(baseline).reduce((a, b) => a + b, 0);

  // VACUITY IS FAILURE. A scanner that finds nothing at all is broken, not clean:
  // the premise of this ratchet is that 103 direct writes exist today (the seed).
  if (total === 0) {
    console.error(
      "\n✘ check-direct-trip-writes: scanned the tree and found ZERO direct trip writes.\n" +
        "  That is not plausible while the trips routers still exist. The scanner is broken.\n",
    );
    process.exit(1);
  }

  if (verbose) {
    const byFile = new Map<string, number>();
    for (const w of writes) byFile.set(w.file, (byFile.get(w.file) ?? 0) + 1);
    for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${file}`);
    }
  }

  if (newViolations.length === 0 && staleEntries.length === 0) {
    console.log(
      `✅ check-direct-trip-writes: ${total} direct trip-table write(s) outside the kernel, ` +
        `all within the ${baselinedTotal}-site baseline. The ratchet only turns down.\n` +
        `   Blind spot: ${dynamicFrom} dynamic \`.from(<expr>)\` site(s) this scanner cannot attribute.`,
    );
    process.exit(0);
  }

  if (newViolations.length > 0) {
    console.error(
      `\n✘ check-direct-trip-writes: ${newViolations.length} NEW direct trip-table write(s).\n\n` +
        "Consequential trip state mutations must go through the Trip Kernel\n" +
        "(src/lib/tripKernel — executeTripCommand). A direct write skips the aggregate\n" +
        "version bump and leaves no row in trip_events, so nothing downstream can tell\n" +
        "it happened.\n\n" +
        "Fix: express the change as a TripCommand and route it through the kernel. If the\n" +
        "command it needs does not exist yet, add it there — do not add a write here.\n",
    );
    for (const v of newViolations) {
      console.error(`  ${v.file}:${v.line}  ${v.table}.${v.method}()`);
    }
  }
  if (staleEntries.length > 0) {
    console.error(
      `\n✘ stale baseline entries — these writes moved behind the kernel (or went away).\n` +
        `  Lower the count in ${relative(process.cwd(), BASELINE_PATH)} so the ratchet cannot slip back:`,
    );
    for (const s of staleEntries) {
      console.error(`  ${s.file}: baselined ${s.baselined}, found ${s.found}`);
    }
  }
  process.exit(1);
}
