/**
 * census L294 — "C2. Never swallow a schema/data error into plausible empty
 * operational state **without structured logging and degraded confidence**."
 *
 * ── WHY A SWEEP AND NOT MORE CASES ──────────────────────────────────────────
 * Every previous pass on this row counted SITES. §9 found nine bare catches,
 * §13.5 re-counted them as six, §18 re-counted six again, §19 removed all six
 * and then said the honest thing about what that was worth:
 *
 *   > The swallows this pass enumerated are the `catch` ones. A read that
 *   > returns `?? []` on an unbound error is the same defect without the
 *   > keyword, and no exhaustive sweep of THAT shape was done. Claiming `C`
 *   > would be claiming a sweep that was not run.
 *
 * A per-site test proves a site. C2 is a rule over a SURFACE, and the only
 * evidence that fits a rule over a surface is a sweep of the surface that a
 * later reader can re-execute. That is what this file is: it reads every source
 * file the layover surface owns and fails on the SHAPE, so a site that does not
 * exist yet is covered by the same assertion as the sites that do.
 *
 * ── THE THREE SHAPES, AND WHY EACH IS THE SAME DEFECT ───────────────────────
 *   1. A supabase call whose destructure does not bind `error` at all.
 *      supabase-js RESOLVES on a database error — `{ data: null, error }` — so
 *      `const { data } = await db.from(…)` turns an outage into an empty read
 *      with no syntax to notice.
 *   2. An `error` bound and never mentioned again. Identical at runtime to (1)
 *      and harder to see, because the binding makes the file LOOK careful.
 *   3. A bare `catch {` in the two files whose catches wrap database work.
 *      Kept from the §19 suite and widened by the §20 mutation pass, which
 *      found two ways round the line-shaped regexes it used to use.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT ASSERT ──────────────────────────────────
 * That the DISPOSITION of each error is right. Refusing with 503, degrading
 * with a named reason, falling back to the static dataset and saying so — all
 * three are correct in different places, and a test cannot tell which a site
 * owes without knowing what the site answers. Those are the per-site suites'
 * job (`layoverSessionWriteFailClosed`, `layoverPresenceDegraded`,
 * `layoverAirportLookupDegraded`, `layoverExpirySweepVisible`). This asserts
 * only the precondition all of them share: THE ERROR WAS LOOKED AT.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverSurfaceErrorBinding.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../..");

/** The files census-layover.md's ownership list names, minus their tests. */
function surfaceFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["services/airport", "services/safeReturn"]) {
    const abs = path.join(SRC, dir);
    for (const name of readdirSync(abs, { withFileTypes: true })) {
      if (!name.isFile() || !name.name.endsWith(".ts")) continue;
      out.push(path.join(abs, name.name));
    }
  }
  out.push(path.join(SRC, "routes/airport.ts"));
  return out.sort();
}

/**
 * Comments removed, so PROSE about a forbidden shape — this file's own header
 * included — is never a finding. The `[^:]` guard keeps `https://` out of the
 * line-comment rule.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

interface Site { file: string; line: number; excerpt: string }

/**
 * Every `const { … } = await …` whose awaited expression reaches a supabase
 * call. The statement is taken to the first `;` at paren depth 0, which is what
 * lets a builder chain spread over fifteen lines be read as one statement.
 */
function supabaseDestructures(code: string): Array<{ binds: string; stmt: string; index: number }> {
  const out: Array<{ binds: string; stmt: string; index: number }> = [];
  const re = /const\s*\{([^}]*)\}\s*=\s*await\b/g;
  for (const m of code.matchAll(re)) {
    const start = m.index!;
    let depth = 0;
    let end = start;
    for (let i = start; i < code.length; i += 1) {
      const c = code[i];
      if (c === "(" || c === "[") depth += 1;
      else if (c === ")" || c === "]") depth -= 1;
      else if (c === ";" && depth <= 0) { end = i; break; }
      end = i;
    }
    const stmt = code.slice(start, end + 1);
    if (!/\.(from|rpc)\s*\(/.test(stmt)) continue;
    out.push({ binds: m[1]!, stmt, index: start });
  }
  return out;
}

/**
 * How far after a read a check for its error must appear. Twenty-five lines is
 * generous for a disposition that is at most `if (error) { log; return }` and
 * tight enough that an unrelated later `error` cannot satisfy it.
 */
const CHECK_WINDOW_LINES = 25;

/** Offset of the next `const { … } = await` in `tail`, or its length. */
function nextDestructureOffset(tail: string): number {
  const m = /const\s*\{[^}]*\}\s*=\s*await\b/.exec(tail);
  return m ? m.index : tail.length;
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

describe("L294/C2 — every supabase error in the layover surface is BOUND", () => {
  it("no supabase destructure omits `error`", () => {
    const offenders: Site[] = [];
    for (const file of surfaceFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const d of supabaseDestructures(code)) {
        if (/\berror\b/.test(d.binds)) continue;
        offenders.push({
          file: path.relative(SRC, file),
          line: lineOf(code, d.index),
          excerpt: d.stmt.replace(/\s+/g, " ").slice(0, 120),
        });
      }
    }
    assert.deepEqual(
      offenders.map((o) => `${o.file}:${o.line} ${o.excerpt}`),
      [],
      "supabase-js RESOLVES on a database error — an unbound `error` is an outage read as an empty table",
    );
  });

  it("no bound supabase `error` is left unmentioned", () => {
    const offenders: Site[] = [];
    for (const file of surfaceFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const d of supabaseDestructures(code)) {
        const aliased = /\berror\s*:\s*(\w+)/.exec(d.binds);
        const alias = aliased ? aliased[1]! : (/\berror\b/.test(d.binds) ? "error" : null);
        if (!alias) continue; // covered by the assertion above
        // A BOUNDED window, and the bound is the point. Scanning to the end of
        // the file was the first shape of this check and the §20 mutation pass
        // killed it: `error` is the commonest identifier in `routes/airport.ts`,
        // so ANY later read's binding satisfied the search and a genuinely
        // discarded error passed. A check on a read belongs beside the read;
        // one twelve hundred lines later is not a check on this one.
        // The window ENDS at whichever comes first: `CHECK_WINDOW_LINES` lines,
        // or the next supabase destructure — because that read's own `error`
        // binding is not a check on this one. The §20 mutation pass found both
        // ways this leaked: `routes/airport.ts`'s buddies handler discards its
        // `error` eleven lines above a `const { data: blockRows, error: blockErr }`,
        // and an end-of-file scan or a naive `\berror\b` both accepted it.
        const tail = code.slice(d.index + d.stmt.length);
        const nextRead = nextDestructureOffset(tail);
        const after = tail
          .slice(0, nextRead)
          .split("\n").slice(0, CHECK_WINDOW_LINES).join("\n");
        // `(?!\s*:)` drops a later BINDING of the same name — `error: blockErr`
        // mentions `error` and reads nothing.
        if (new RegExp(`\\b${alias}\\b(?!\\s*:)`).test(after)) continue;
        offenders.push({
          file: path.relative(SRC, file),
          line: lineOf(code, d.index),
          excerpt: d.stmt.replace(/\s+/g, " ").slice(0, 120),
        });
      }
    }
    assert.deepEqual(
      offenders.map((o) => `${o.file}:${o.line} binds \`${o.excerpt}\` and never reads it`),
      [],
      "an `error` that is bound and never mentioned is identical at runtime to one that was never bound",
    );
  });

  it("no checked supabase `error` is TESTED and then thrown away", () => {
    // C2 has two clauses and the assertion above only reaches the first. A site
    // may branch on its error, answer an honest 503, and never record WHY —
    // which is "degraded confidence" without "structured logging", and leaves
    // an operator with a refusal nobody can explain. The rule here is that the
    // error must be CARRIED: it appears somewhere that is not the boolean test
    // itself — a log's object, a returned reason, a rethrow.
    const offenders: Site[] = [];
    for (const file of surfaceFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const d of supabaseDestructures(code)) {
        const aliased = /\berror\s*:\s*(\w+)/.exec(d.binds);
        const alias = aliased ? aliased[1]! : (/\berror\b/.test(d.binds) ? "error" : null);
        if (!alias) continue;
        const tail = code.slice(d.index + d.stmt.length);
        const win = tail
          .slice(0, nextDestructureOffset(tail))
          .split("\n").slice(0, CHECK_WINDOW_LINES).join("\n");
        if (!new RegExp(`\\b${alias}\\b(?!\\s*:)`).test(win)) continue; // the assertion above owns this
        // Blank the alias wherever it appears ONLY as a condition, then look
        // again. What survives is a use.
        const tested = win
          .replace(/if\s*\(([^()]|\([^()]*\))*\)/g, (cond) => cond.replace(new RegExp(`\\b${alias}\\b`, "g"), ""))
          .replace(new RegExp(`\\b${alias}\\b\\s*(\\?|&&|\\|\\|)`, "g"), "$1");
        if (new RegExp(`\\b${alias}\\b(?!\\s*:)`).test(tested)) continue;
        offenders.push({
          file: path.relative(SRC, file),
          line: lineOf(code, d.index),
          excerpt: win.trim().replace(/\s+/g, " ").slice(0, 120),
        });
      }
    }
    assert.deepEqual(
      offenders.map((o) => `${o.file}:${o.line} tests \`${o.excerpt}\` and records nothing`),
      [],
      "C2 asks for structured logging AND degraded confidence — a refusal nobody can explain is only half of it",
    );
  });

  it("the sweep actually found the reads it claims to police", () => {
    // A sweep that matches nothing passes every assertion above it. This is the
    // control: the layover surface holds dozens of supabase reads, and if this
    // number collapses the two assertions have stopped meaning anything.
    let total = 0;
    for (const file of surfaceFiles()) {
      total += supabaseDestructures(stripComments(readFileSync(file, "utf8"))).length;
    }
    assert.ok(total >= 40, `the sweep should see the whole surface's reads, saw ${total}`);
  });

  it("the surface file list is non-trivial and includes all three owned areas", () => {
    const rel = surfaceFiles().map((f) => path.relative(SRC, f));
    assert.ok(rel.length >= 15, `expected the whole surface, got ${rel.length} files`);
    assert.ok(rel.some((f) => f.startsWith("services/airport/")), "services/airport is in the sweep");
    assert.ok(rel.some((f) => f.startsWith("services/safeReturn/")), "services/safeReturn is in the sweep");
    assert.ok(rel.includes("routes/airport.ts"), "routes/airport.ts is in the sweep");
  });
});
