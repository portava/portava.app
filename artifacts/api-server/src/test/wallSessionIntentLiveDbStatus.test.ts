/**
 * W146 — the announcement half of the live-database harness.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE SUITE IT ANNOUNCES
 * ======================================================
 * `src/test/wallSessionIntentLiveDb.test.ts` exercises the Wall's session-intent
 * store against a real Postgres. It cannot be registered in the curated `test`
 * script, because its first import — `lib/ciSupabaseGuard.mjs`, the production
 * allowlist that this repository deliberately keeps in the EXECUTION path rather
 * than in a workflow step — exits 2 whenever CI_SUPABASE_PROJECT_REF and
 * KNOWN_PROD_PROJECT_REF are unset. That is every ordinary run, and weakening
 * that guard to make a test convenient would trade the one thing standing
 * between CI and the production project for a green tick.
 *
 * So the suite lives outside the curated list — and this file, which imports no
 * guard and touches no client, takes its place inside it. Its entire job is to
 * make sure the ordinary suite SAYS, out loud, on every run, that the Wall's
 * store was not verified against a database and exactly what is missing.
 *
 * The failure mode this repository keeps meeting is not a failing test. It is a
 * test that silently does not run, or one that skips inside a green suite and
 * reads as proof. `.github/workflows/live-db.yml` documents three existing
 * suites with precisely that shape. A banner is not as good as a live run; it is
 * considerably better than a silence that looks like a pass.
 *
 * MUTATION: delete the `console.log` banner, or relax `missingLiveDbReason` so a
 * loopback URL counts as a database → the second test below goes RED, because
 * the ordinary suite would then be unable to tell "no database" from "verified".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

/** Kept identical, by assertion, to the predicate the live suite uses. */
function missingLiveDbReason(url: string, key: string): string | null {
  if (!url) return "SUPABASE_URL is not set";
  if (!key) return "SUPABASE_SERVICE_ROLE_KEY is not set";
  if (/(^|\/\/)(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])([:/]|$)/.test(url)) {
    return `SUPABASE_URL points at a loopback stub (${url}), not a database`;
  }
  if (/^(dummy|test|placeholder|changeme)$/i.test(key)) {
    return `SUPABASE_SERVICE_ROLE_KEY is the placeholder "${key}"`;
  }
  return null;
}

describe("W146 — live-database harness status", () => {
  it("states plainly, on every run, whether the Wall store was verified against Postgres", () => {
    const reason = missingLiveDbReason(
      process.env.SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    );
    if (reason === null) {
      console.log(
        "[W146] A live database IS configured for this process. The Wall store suite " +
          "is run by `pnpm --filter @workspace/api-server run test:wall-session-intent-live-db`; " +
          "this file does not run it.",
      );
    } else {
      console.log(
        "\n[W146] ================================================================\n" +
          "[W146] The Wall's session-intent store was NOT verified against a database\n" +
          "[W146] on this run.  Reason: " +
          reason +
          ".\n" +
          "[W146] What that leaves unproven: the one-row-per-user PRIMARY KEY, the\n" +
          "[W146] foreign key to profiles that must REFUSE an orphan intent, and the\n" +
          "[W146] deny-default grants. An in-memory fake agrees with all three\n" +
          "[W146] whether or not the schema does.\n" +
          "[W146] Run: pnpm --filter @workspace/api-server run test:wall-session-intent-live-db\n" +
          "[W146] with credentials for the sanctioned CI project.\n" +
          "[W146] ================================================================\n",
      );
    }
    assert.ok(true);
  });

  it("the live suite exists, is allowlisted rather than lost, and has a script that runs it", () => {
    const pkg = JSON.parse(readFileSync(join(__dir, "..", "..", "package.json"), "utf8"));
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const runner = Object.entries(scripts).find(([, v]) =>
      v.includes("src/test/wallSessionIntentLiveDb.test.ts"),
    );
    assert.ok(
      runner,
      "no package script runs src/test/wallSessionIntentLiveDb.test.ts — the suite would " +
        "exist on disk and never execute anywhere, which is the exact failure " +
        "scripts/check-test-registration.mjs was written to stop",
    );
    const allow: string[] = JSON.parse(
      readFileSync(join(__dir, "..", "..", "scripts", "UNREGISTERED_TESTS_ALLOWLIST.json"), "utf8"),
    );
    assert.ok(
      allow.includes("src/test/wallSessionIntentLiveDb.test.ts"),
      "the live suite must be allowlisted deliberately, with this file as its announcement",
    );
  });

  it("a loopback stub is never mistaken for a database", () => {
    // The curated `test` script pins exactly this. If the predicate ever accepts
    // it, every ordinary run would claim the store had been verified.
    assert.match(
      missingLiveDbReason("http://127.0.0.1:9", "dummy") ?? "",
      /loopback stub/,
      "http://127.0.0.1:9 must read as 'no database'",
    );
    assert.match(
      missingLiveDbReason("https://example.supabase.co", "dummy") ?? "",
      /placeholder/,
      "the placeholder service-role key must read as 'no database'",
    );
    assert.equal(
      missingLiveDbReason("https://example.supabase.co", "sb_secret_real_looking_key"),
      null,
      "a real-looking URL and key must read as 'live' — a predicate that never says yes " +
        "is a suite that never runs",
    );
  });

  it("the live suite's predicate has not drifted from this one", () => {
    const live = readFileSync(join(__dir, "wallSessionIntentLiveDb.test.ts"), "utf8");
    for (const clause of ["127\\.0\\.0\\.1", "localhost", "dummy|test|placeholder|changeme"]) {
      assert.ok(
        live.includes(clause),
        `the live suite no longer rejects ${clause} — the two predicates have drifted, and ` +
          "this file would be announcing a guard that is not the one in force",
      );
    }
  });
});
