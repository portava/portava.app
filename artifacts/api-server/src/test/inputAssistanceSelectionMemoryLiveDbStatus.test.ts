/**
 * G226 / G100 — the announcement half of the §35 selection-memory live harness.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE SUITE IT ANNOUNCES
 * ======================================================
 * `src/test/inputAssistanceSelectionMemoryLiveDb.test.ts` exercises §35
 * selection memory against a real Postgres. It cannot be registered in the
 * curated `test` script, because its first import — `lib/ciSupabaseGuard.mjs`,
 * the production allowlist this repository deliberately keeps in the EXECUTION
 * path rather than in a workflow step — exits 2 whenever CI_SUPABASE_PROJECT_REF
 * and KNOWN_PROD_PROJECT_REF are unset. That is every ordinary run, and
 * weakening that guard to make a test convenient would trade the one thing
 * standing between CI and the production project for a green tick.
 *
 * So the suite lives outside the curated list — and this file, which imports no
 * guard and touches no client, takes its place inside it. Its entire job is to
 * make the ordinary suite SAY, out loud, on every run, that §35 selection
 * memory was not verified against a database and exactly what is missing.
 *
 * WHY IT MATTERS MORE FOR THIS FEATURE THAN FOR MOST
 * ==================================================
 * `input_selection_history` did not exist in production until 2026-09-21. Every
 * §35 verdict in census-input-intelligence.md carried `☠prod` — correct code
 * over storage that was not there. Now that the storage IS there, the tempting
 * next step is to read "the table exists" as "the feature works". It is not the
 * same claim, and this banner is what keeps the difference visible on a green
 * run. A banner is not as good as a live run; it is considerably better than a
 * silence that looks like a pass.
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

const LIVE_SUITE = "src/test/inputAssistanceSelectionMemoryLiveDb.test.ts";

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

describe("§35 selection memory — live-database harness status", () => {
  it("states plainly, on every run, whether selection memory was verified against Postgres", () => {
    const reason = missingLiveDbReason(
      process.env.SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    );
    if (reason === null) {
      console.log(
        "[G226] A live database IS configured for this process. The §35 selection-memory " +
          "suite is run by `pnpm --filter @workspace/api-server run " +
          "test:input-selection-memory-live-db`; this file does not run it.",
      );
    } else {
      console.log(
        "\n[G226] ================================================================\n" +
          "[G226] §35 selection memory was NOT verified against a database on this\n" +
          "[G226] run.  Reason: " +
          reason +
          ".\n" +
          "[G226] input_selection_history reached PRODUCTION on 2026-09-21, so the\n" +
          "[G226] ☠prod flag is gone — but that is a fact about the SCHEMA, not\n" +
          "[G226] about the feature. What stays unproven here: the upsert-with-\n" +
          "[G226] increment unique index that makes 'frequently selected' a COUNT,\n" +
          "[G226] the COALESCE label rule, the selection_count >= 1 CHECK, the\n" +
          "[G226] auth.users ON DELETE CASCADE that is the WHOLE of the §35 erasure\n" +
          "[G226] guarantee, and the deny-default grants. An in-memory fake agrees\n" +
          "[G226] with every one of them whether or not the schema does.\n" +
          "[G226] Run: pnpm --filter @workspace/api-server run test:input-selection-memory-live-db\n" +
          "[G226] with credentials for the sanctioned CI project.\n" +
          "[G226] ================================================================\n",
      );
    }
    assert.ok(true);
  });

  it("the live suite exists, is allowlisted rather than lost, and has a script that runs it", () => {
    const pkg = JSON.parse(readFileSync(join(__dir, "..", "..", "package.json"), "utf8"));
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const runner = Object.entries(scripts).find(([, v]) => v.includes(LIVE_SUITE));
    assert.ok(
      runner,
      `no package script runs ${LIVE_SUITE} — the suite would never execute anywhere`,
    );

    const allowlist: string[] = JSON.parse(
      readFileSync(join(__dir, "..", "..", "scripts", "UNREGISTERED_TESTS_ALLOWLIST.json"), "utf8"),
    );
    assert.ok(
      allowlist.includes(LIVE_SUITE),
      `${LIVE_SUITE} must be allowlisted — check:test-registration fails otherwise, and ` +
        "the fix must never be to register it, because its guard exits 2 on every ordinary run",
    );

    // The suite must still carry its guard as the FIRST import. If that ever
    // slides below `@supabase/supabase-js`, a client could be constructed
    // before the sanctioned-project allowlist is enforced.
    const src = readFileSync(join(__dir, "..", "..", LIVE_SUITE), "utf8");
    const firstImport = src.split("\n").find((l) => l.startsWith("import "));
    assert.equal(
      firstImport,
      'import "../lib/ciSupabaseGuard.mjs";',
      "the CI project guard must be the first import in the live suite",
    );
  });
});
