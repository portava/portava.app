/**
 * verify-backfill-0200.mjs
 *
 * Migration 0200 is a BACKFILL: it re-declares objects that already exist in
 * the live database so that a clean rebuild reproduces production. Its entire
 * value depends on the declarations being IDENTICAL to live. A backfill that
 * has drifted is worse than no backfill at all, because it looks authoritative
 * and is wrong.
 *
 * So this script does not parse or "understand" the SQL. It reads the four
 * function definitions straight from the live database with
 * pg_get_functiondef() and asserts that each returned string appears
 * byte-for-byte inside 0200. Same for pg_get_triggerdef() for the two triggers.
 *
 * It is read-only (read_only: true on every query) and it never writes.
 *
 * WHY search_path IS EXCLUDED FROM THE BYTE COMPARISON (migration 0201)
 * ---------------------------------------------------------------------
 * 0201 pinned `SET search_path TO 'public', 'pg_catalog'` on these four
 * functions (and twelve more) to close a demonstrated shadowing hazard. That
 * changes what pg_get_functiondef() returns — it now carries a SET line that
 * 0200's text does not — so a naive byte comparison started failing on all four.
 *
 * There were two ways to resolve that, and the choice is deliberate:
 *
 *   (a) rewrite 0200 to include the SET line, or
 *   (b) exclude search_path from 0200's comparison and let 0201 own it.
 *
 * This script does (b). 0200 is already committed and pushed, and the migration
 * chain is CORRECT as it stands: a clean rebuild replays 0200 (bodies, unpinned)
 * and then 0201 (adds the pin), arriving at exactly the live state. Editing a
 * released migration to reflect a later one would break chain immutability and
 * would make 0200 describe a state that never existed at 0200's point in the
 * sequence. So 0200's contract is narrowed to what it actually owns — the
 * BODIES — and the pin is verified separately below rather than dropped, so the
 * coverage is not lost, only reattributed.
 *
 * Note this only relaxes proconfig. SECURITY DEFINER, volatility, language,
 * argument list and body text are all still compared byte-for-byte.
 *
 * Exit codes:
 *   0  every object in 0200 byte-matches live
 *   2  cannot run (no credentials / unparsable SUPABASE_URL / file missing)
 *   3  drift detected, or an object is missing live
 *
 * Note: 2 and 3 are distinct on purpose. A backfill verifier that silently
 * passes when it has no credentials is not a verifier.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_CANNOT_RUN = 2;
const EXIT_DRIFT = 3;

/**
 * Backfilled functions and the proconfig each is EXPECTED to carry live.
 *
 * `proconfig` is asserted positively but excluded from the byte comparison — see
 * the header. `""` means "no setting expected", which is itself checked: a
 * function that silently GAINS a search_path is drift too, in the other
 * direction.
 *
 * Despite the filename this now covers two backfills. Kept as one script (and
 * one `check:backfill-0200` entry point) because the discipline is identical and
 * splitting it would duplicate every line of it.
 */
const FUNCTIONS = [
  // migration 0200 (bodies) + 0201 (pin)
  { name: "is_accepted_trip_member", proconfig: "search_path=public, pg_catalog", from: "0200+0201" },
  { name: "can_post_to_trip",        proconfig: "search_path=public, pg_catalog", from: "0200+0201" },
  { name: "can_see_post",            proconfig: "search_path=public, pg_catalog", from: "0200+0201" },
  { name: "can_see_postcard",        proconfig: "search_path=public, pg_catalog", from: "0200+0201" },
  // migration 0203
  { name: "increment_counter",       proconfig: "search_path=public",             from: "0203" },
  // Was deliberately expected UNPINNED while 0203 reproduced the known defect
  // verbatim. Migration 0204 pinned it, and this assertion is what caught that
  // landing rather than absorbing it silently — which is exactly why the empty
  // expectation was asserted instead of skipped. Updated, not deleted.
  { name: "purge_old_ranking_debug_samples", proconfig: "search_path=public, pg_catalog", from: "0203+0204" },
];
const TRIGGERS = ["trg_posts_updated", "trg_postcards_updated"];

/** Remove the proconfig line pg_get_functiondef emits, so 0200 compares bodies only. */
function stripSearchPath(text) {
  return text.replace(/^[ \t]*SET search_path TO [^\n]*\n/gm, "");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = path.join(__dirname, "..", "src", "migrations");
/**
 * Both backfills are searched as one corpus. A definition may live in either
 * file; what matters is that every backfilled object appears byte-for-byte in
 * the chain, not which file happens to hold it.
 */
const MIGRATIONS = [
  "0200_backfill_unrecorded_live_objects.sql",
  "0203_backfill_counter_and_purge_functions.sql",
].map((f) => path.join(MIGRATION_DIR, f));

function fail(code, msg) {
  console.error(`  ✘  ${msg}`);
  process.exit(code);
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const token =
    process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

  if (!supabaseUrl || !token) {
    fail(
      EXIT_CANNOT_RUN,
      "SUPABASE_URL and a Supabase token are required — nothing was verified.\n" +
        "     Set SUPABASE_PROJECT_TOKEN (preferred for CI) or SUPABASE_ACCESS_TOKEN.",
    );
  }

  let projectRef;
  try {
    projectRef = new URL(supabaseUrl).hostname.split(".")[0];
  } catch (e) {
    fail(EXIT_CANNOT_RUN, `SUPABASE_URL is not parsable: ${String(e)}`);
  }
  if (!projectRef) fail(EXIT_CANNOT_RUN, "no project ref derived from SUPABASE_URL");

  for (const m of MIGRATIONS) {
    if (!fs.existsSync(m)) fail(EXIT_CANNOT_RUN, `migration not found: ${m}`);
  }
  const sql = MIGRATIONS.map((m) => fs.readFileSync(m, "utf8")).join("\n");

  const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  async function query(q) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: q, read_only: true }),
    });
    const text = await res.text();
    if (!res.ok) fail(EXIT_CANNOT_RUN, `Management API HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  console.log("── verifying 0200 backfill against live ──");

  const fnRows = await query(
    `SELECT p.proname,
            pg_get_functiondef(p.oid) AS def,
            COALESCE(array_to_string(p.proconfig, ','), '') AS proconfig
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (${FUNCTIONS.map((f) => `'${f.name}'`).join(",")})`,
  );
  const trgRows = await query(
    `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND t.tgname IN (${TRIGGERS.map((t) => `'${t}'`).join(",")})`,
  );

  let bad = 0;

  for (const fn of FUNCTIONS) {
    const { name } = fn;
    const matches = fnRows.filter((r) => r.proname === name);
    if (matches.length === 0) {
      console.error(`  ✘  ${name}: NOT PRESENT in the live database`);
      bad++;
      continue;
    }
    if (matches.length > 1) {
      console.error(
        `  ✘  ${name}: ${matches.length} overloads live — the backfill declares one`,
      );
      bad++;
      continue;
    }
    // Strip the SET search_path line before comparing: proconfig is owned by the
    // pinning migration, not the backfill. See the header for why the backfills
    // are not rewritten to include it.
    const liveBody = stripSearchPath(matches[0].def);
    if (stripSearchPath(sql).includes(liveBody)) {
      console.log(`  ✔  ${name}: body byte-identical to live  [${fn.from}]`);
    } else {
      console.error(
        `  ✘  ${name}: DRIFT — no backfill migration contains the live definition`,
      );
      console.error("     live definition (search_path line excluded) is:");
      console.error(liveBody.split("\n").map((l) => "       " + l).join("\n"));
      bad++;
    }

    // proconfig verified positively, per function. Excluded from the byte
    // comparison, NOT from checking — including the deliberate "" cases, where
    // an unexpectedly PRESENT setting is drift just as much as a missing one.
    if (matches[0].proconfig !== fn.proconfig) {
      console.error(
        `  ✘  ${name}: expected proconfig '${fn.proconfig || "(none)"}', ` +
          `live is '${matches[0].proconfig || "(none)"}'`,
      );
      bad++;
    }
  }

  for (const name of TRIGGERS) {
    const row = trgRows.find((r) => r.tgname === name);
    if (!row) {
      console.error(`  ✘  ${name}: NOT PRESENT in the live database`);
      bad++;
      continue;
    }
    if (sql.includes(row.def)) {
      console.log(`  ✔  ${name}: byte-identical to live`);
    } else {
      console.error(`  ✘  ${name}: DRIFT — 0200 does not contain the live definition`);
      console.error(`     live definition is:\n       ${row.def}`);
      bad++;
    }
  }

  // Ordering is load-bearing: check_function_bodies validates a LANGUAGE sql
  // body at CREATE time, so the callee must be declared before its callers.
  const calleeAt = sql.indexOf("FUNCTION public.is_accepted_trip_member");
  for (const caller of ["can_post_to_trip", "can_see_post", "can_see_postcard"]) {
    const callerAt = sql.indexOf(`FUNCTION public.${caller}`);
    if (calleeAt === -1 || callerAt === -1 || calleeAt > callerAt) {
      console.error(
        `  ✘  ordering: is_accepted_trip_member must be declared before ${caller}`,
      );
      bad++;
    }
  }
  if (bad === 0) console.log("  ✔  ordering: is_accepted_trip_member precedes all three callers");

  if (bad > 0) {
    console.error(`\n  ${bad} problem(s). 0200 has drifted from live — fix it before trusting it.`);
    process.exit(EXIT_DRIFT);
  }

  console.log(
    `\nPASS — the backfills reproduce live exactly ` +
      `(${FUNCTIONS.length} functions, ${TRIGGERS.length} triggers).`,
  );
  process.exit(EXIT_OK);
}

main().catch((e) => {
  console.error(`  ✘  unexpected failure: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(EXIT_DRIFT);
});
