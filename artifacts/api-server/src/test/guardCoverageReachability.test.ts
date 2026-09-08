/**
 * `check:guard-coverage` must classify reachability from CODE, not from prose.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * The Supabase guard is opt-in: every file under src/ that can reach the
 * database must either import a front door or carry a written exemption. The
 * question "can this file reach Supabase" was answered by matching the raw file
 * text for a credential env var name or `createClient(`.
 *
 * Raw text includes COMMENTS. Every fail-closed unit test in this suite carries
 * its own run instruction in its header —
 *
 *     * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *
 * — so 32 pure unit tests, which construct no client and issue no request, were
 * classified as able to reach the database and reported as unguarded. That took
 * check:guard-coverage — the FIRST check in check:all — permanently red on
 * nothing at all, and this repo has written down twice what happens next: "a
 * permanently-red check is one `|| true` away from being no check at all", which
 * is exactly how `living_page` spent months silently dropping rows.
 *
 * The script's own header had already recorded the over-count and deferred the
 * narrowing ("it needs its own review"). This is that review, pinned.
 *
 * ── WHY THE STRING-LITERAL CASE IS HERE TOO ──────────────────────────────────
 * The narrowing is scoped to comments and MUST NOT go further. The precedent is
 * in the script: routes/trips.ts was once classified reachable by
 * `"Server not configured: SUPABASE_SERVICE_ROLE_KEY is missing"` — a string
 * literal in an error message. A string holding a credential name is code that
 * ran; only a comment is guaranteed not to be. So the string case must still be
 * REACHABLE, and it is asserted here so a later "cleanup" cannot quietly widen
 * the narrowing into a blind spot.
 *
 * ── AND THE DIRECTION THAT MATTERS MOST ──────────────────────────────────────
 * Comments are stripped before the GUARD-IMPORT question as well, so a
 * commented-out `import "…/ciSupabaseGuard.mjs";` does not count as opting in.
 * Without that half, making the scan comment-aware would have handed the tree a
 * one-line way to look guarded while being unguarded.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/guardCoverageReachability.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const CHECKER = join(API_ROOT, "scripts", "check-guard-coverage.mjs");

/**
 * The checker walks the real tree from its own location and takes no SRC
 * override, so the only way to exercise it end to end is to put a probe file
 * INTO the tree and take it out again. The name is deliberately unmistakable and
 * `after` removes it even if a case throws.
 */
const PROBE = join(API_ROOT, "src", "lib", "__guardCoverageProbe.ts");
after(() => { if (existsSync(PROBE)) rmSync(PROBE, { force: true }); });

function runWith(content: string | null) {
  if (content === null) { if (existsSync(PROBE)) rmSync(PROBE, { force: true }); }
  else writeFileSync(PROBE, content);
  const r = spawnSync(process.execPath, [CHECKER], {
    cwd: API_ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/\| can reach Supabase directly \| (\d+) \|/);
  return {
    code: r.status,
    out,
    reach: m ? Number(m[1]) : NaN,
    flagged: out.includes("__guardCoverageProbe.ts can reach Supabase"),
  };
}

let baseline = NaN;

describe("check:guard-coverage — reachability is judged on code", () => {
  it("CONTROL — the real tree passes, and every reacher is accounted for", () => {
    const r = runWith(null);
    // A green here is load-bearing: this check gates check:all, and a check that
    // fails on correct code is a check somebody eventually suppresses.
    assert.equal(r.code, 0, r.out.slice(-3000));
    assert.match(r.out, /Supabase-reaching file\(s\) accounted for/);
    assert.ok(Number.isFinite(r.reach), "the reachability count must be printed");
    baseline = r.reach;
  });

  it("FLAGS a real credential read in code", () => {
    const r = runWith(`export const k = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";\n`);
    assert.equal(r.flagged, true, "a genuine unguarded reacher must still be reported");
    assert.equal(r.reach, baseline + 1);
    assert.notEqual(r.code, 0);
  });

  it("FLAGS a real createClient( call", () => {
    const r = runWith(
      `import { createClient } from "@supabase/supabase-js";\n` +
        `export const c = createClient("https://x.supabase.co", "k");\n`,
    );
    assert.equal(r.flagged, true);
    assert.equal(r.reach, baseline + 1);
  });

  it("does NOT flag a credential name that appears only in a LINE comment", () => {
    const r = runWith(
      `// export const k = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";\n` + `export const k = "";\n`,
    );
    assert.equal(r.flagged, false);
    assert.equal(r.reach, baseline, "a commented-out credential read is not a credential read");
  });

  it("does NOT flag the run instruction in a BLOCK comment — the actual 32-file case", () => {
    const r = runWith(
      `/**\n * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node x\n */\n` +
        `export const k = "";\n`,
    );
    assert.equal(r.flagged, false);
    assert.equal(r.reach, baseline);
  });

  it("STILL flags a credential name inside a STRING LITERAL", () => {
    // The narrowing is scoped to comments and must not creep. routes/trips.ts
    // was classified by exactly this shape, and a string is code that ran.
    const r = runWith(
      `export const msg = "Server not configured: SUPABASE_SERVICE_ROLE_KEY is missing";\n`,
    );
    assert.equal(r.flagged, true, "a credential name in a string literal must remain REACHABLE");
    assert.equal(r.reach, baseline + 1);
  });

  it("does NOT accept a COMMENTED-OUT guard import as opting in", () => {
    // The half that keeps the narrowing honest: without it, `// import "…";`
    // would be a one-line way to look guarded while being unguarded.
    const r = runWith(
      `// import "../lib/ciSupabaseGuard.mjs";\n` +
        `export const k = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";\n`,
    );
    assert.equal(r.flagged, true, "a commented-out guard import is not a guard import");
  });

  it("leaves the tree exactly as it found it", () => {
    const r = runWith(null);
    assert.equal(existsSync(PROBE), false);
    assert.equal(r.reach, baseline);
    assert.equal(r.code, 0);
  });
});
