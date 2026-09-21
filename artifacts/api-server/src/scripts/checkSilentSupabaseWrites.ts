/**
 * check-silent-supabase-writes — no dead catch around a resolving PostgREST call.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * supabase-js RESOLVES (does not throw) on a DB error: `await sc.from(...)
 * .insert/update/upsert/delete()` and `await sc.rpc(...)` return `{ error }`
 * instead of rejecting. Two consequences the 2026-08-30 audit proved over and
 * over (H2, H4, H5, M1, M2 — and the batch-2 triage that followed):
 *
 *   1. An EMPTY `catch {}` wrapped around such a call is dead code for the
 *      failure that matters — the DB error was already swallowed by the
 *      unread resolved value, so the code reads as "handled" while the
 *      failure vanishes without a trace (a feel-unsafe report that nobody
 *      receives, a GDPR erasure that quietly stops, an admin audit trail
 *      with holes).
 *   2. An EMPTY promise-`.catch(() => {})` on the same chains is the same
 *      bug in method-chain clothing.
 *
 * This guard flags both shapes. It does NOT demand the call be fatal — it
 * demands the failure be OBSERVABLE: put a log call (or any real handling) in
 * the catch, destructure and check `{ error }`, or — for a genuinely
 * intentional silent path — say so explicitly with an escape hatch:
 *
 *      } catch {
 *        // resolves-not-throws-ok: <why silence is the intended behavior>
 *      }
 *
 * ── LIMITS, STATED RATHER THAN IMPLIED ──────────────────────────────────────
 *   * Text-level, not type-level: it keys on `.from(` / `.rpc(` calls under
 *     `await` inside the try body. A supabase call reached through a helper
 *     function is invisible here (the helper's own body is scanned instead).
 *   * It does not verify that a non-empty catch is CORRECT — only that the
 *     catch is not empty. A catch containing only comments is still empty
 *     unless the comment carries the escape hatch.
 *   * An awaited call inside a NESTED try with its own catch does not
 *     implicate the outer catch.
 *
 * Static, so it needs no database and runs on every push.
 * Run: node --import tsx/esm src/scripts/checkSilentSupabaseWrites.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sanitize,
  matchBrace,
  stripNestedTry,
  lineOf,
  compareToBaseline,
} from "./lib/supabaseCallScan.js";

// Re-exported from their original home so this guard's unit tests (and anyone
// else) keep importing them from where they have always lived. The bodies moved
// to scripts/lib/supabaseCallScan.ts when the READ guard was written and needed
// the identical primitives; sharing them is what keeps the two guards' notion
// of "a supabase call" from drifting apart.
export { sanitize, compareToBaseline };

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dir, "..");

/** Test trees and generated types are exempt (fakes legitimately swallow). */
const SKIP_DIRS = new Set(["test", "__tests__", "node_modules"]);
const SKIP_FILES = new Set([
  "database.types.ts",
  // This guard's own pattern literals would self-match.
  "checkSilentSupabaseWrites.ts",
]);

export const ESCAPE_HATCH = "resolves-not-throws-ok";

export interface SilentWrite {
  file: string;
  /** 1-indexed line of the offending catch. */
  line: number;
  /** "try-catch" or "promise-catch". */
  shape: "try-catch" | "promise-catch";
  /** Short excerpt of the supabase call the catch shadows. */
  call: string;
}

// WRITE shapes only: a fail-soft READ with an empty catch is a legitimate
// graceful-degradation idiom all over the compass engines; the audit class is
// the silently-discarded WRITE (insert/update/upsert/delete) and RPC.
const AWAIT_SUPA = /\bawait\b[^;]*?\.(insert|update|upsert|delete|rpc)\s*\(/;

/** Scan one file's source for silent-supabase-write shapes. */
export function findSilentSupabaseWrites(src: string, file: string): SilentWrite[] {
  const code = sanitize(src);
  const found: SilentWrite[] = [];

  // Shape 1: try { …await sc.from/rpc(…)… } catch <empty>
  const tryRe = /\btry\s*\{/g;
  let tm: RegExpExecArray | null;
  while ((tm = tryRe.exec(code)) !== null) {
    const tryOpen = tm.index + tm[0].length - 1;
    const tryClose = matchBrace(code, tryOpen);
    if (tryClose === -1) continue;
    const afterTry = code.slice(tryClose + 1);
    const cm = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(afterTry);
    if (!cm) continue;
    const catchOpen = tryClose + 1 + cm[0].length - 1;
    const catchClose = matchBrace(code, catchOpen);
    if (catchClose === -1) continue;

    const catchBodySanitized = code.slice(catchOpen + 1, catchClose);
    if (catchBodySanitized.trim() !== "") continue; // real handling present

    const catchBodyOriginal = src.slice(catchOpen + 1, catchClose);
    if (catchBodyOriginal.includes(ESCAPE_HATCH)) continue; // declared intentional

    const tryBody = stripNestedTry(code.slice(tryOpen + 1, tryClose));
    const am = AWAIT_SUPA.exec(tryBody);
    if (!am) continue;

    found.push({
      file,
      line: lineOf(src, catchOpen),
      shape: "try-catch",
      call: am[0].replace(/\s+/g, " ").slice(0, 80),
    });
  }

  // Shape 2: <chain with .from/.rpc>.catch(() => {}) / .catch(e => {})
  const pcRe = /\.\s*catch\s*\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*\{\s*\}\s*\)/g;
  let pm: RegExpExecArray | null;
  while ((pm = pcRe.exec(code)) !== null) {
    // Escape hatch on the same or preceding line still applies (read original).
    const stmtStart = Math.max(code.lastIndexOf(";", pm.index), 0);
    const chain = code.slice(stmtStart, pm.index);
    if (!/\.(insert|update|upsert|delete|rpc)\s*\(/.test(chain)) continue;
    const origAround = src.slice(Math.max(0, pm.index - 200), pm.index + pm[0].length);
    if (origAround.includes(ESCAPE_HATCH)) continue;
    found.push({
      file,
      line: lineOf(src, pm.index),
      shape: "promise-catch",
      call: chain.replace(/\s+/g, " ").trim().slice(-80),
    });
  }

  return found;
}

// ── Tree walk + CLI ─────────────────────────────────────────────────────────

export function scanTree(root: string = SRC_ROOT): SilentWrite[] {
  const all: SilentWrite[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(p);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !SKIP_FILES.has(name)) {
        const rel = relative(root, p);
        all.push(...findSilentSupabaseWrites(readFileSync(p, "utf8"), rel));
      }
    }
  };
  walk(root);
  return all;
}

// ── Baseline ratchet ────────────────────────────────────────────────────────
// Pre-existing sites (2026-08-30 triage) are recorded per-file in the baseline
// so the guard blocks NEW silent writes without demanding a 39-site cleanup in
// one PR. Keyed by per-file COUNT (not line numbers) so unrelated edits to a
// file don't churn the baseline. Fixing a site requires LOWERING its baseline
// entry — a stale (too-high) entry fails the check, keeping the baseline honest
// over time, exactly like UNREGISTERED_TESTS_ALLOWLIST.json.
const BASELINE_PATH = resolve(__dir, "../../scripts/SILENT_SUPABASE_WRITES_BASELINE.json");

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let baseline: Record<string, number> = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    // No baseline file — every violation is new.
  }
  const violations = scanTree();
  const { newViolations, staleEntries } = compareToBaseline(violations, baseline);

  if (newViolations.length === 0 && staleEntries.length === 0) {
    const baselined = violations.length;
    console.log(
      `✅ check-silent-supabase-writes: no NEW dead catch around a resolving PostgREST write` +
        (baselined > 0 ? ` (${baselined} pre-existing site(s) baselined for burn-down).` : "."),
    );
    process.exit(0);
  }
  if (newViolations.length > 0) {
    console.error(
      `\n✘ check-silent-supabase-writes: ${newViolations.length} NEW silent supabase write(s).\n\n` +
        "supabase-js RESOLVES (does not throw) on a DB error, so an empty catch\n" +
        "around an awaited write (.insert/.update/.upsert/.delete) or .rpc() call\n" +
        "silently discards the failure.\n" +
        "Fix: destructure { error } and handle/log it, put a log call in the catch,\n" +
        `or mark genuinely intentional silence with a "// ${ESCAPE_HATCH}: <reason>" comment.\n`,
    );
    for (const v of newViolations) {
      console.error(`  ${v.file}:${v.line}  [${v.shape}]  ${v.call}`);
    }
  }
  if (staleEntries.length > 0) {
    console.error(
      `\n✘ stale baseline entries (site was fixed — lower the count in ${relative(process.cwd(), BASELINE_PATH)} so it cannot regress):`,
    );
    for (const s of staleEntries) {
      console.error(`  ${s.file}: baselined ${s.baselined}, found ${s.found}`);
    }
  }
  process.exit(1);
}
