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

const FUNCTIONS = [
  "is_accepted_trip_member",
  "can_post_to_trip",
  "can_see_post",
  "can_see_postcard",
];
const TRIGGERS = ["trg_posts_updated", "trg_postcards_updated"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(
  __dirname,
  "..",
  "src",
  "migrations",
  "0200_backfill_unrecorded_live_objects.sql",
);

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

  if (!fs.existsSync(MIGRATION)) {
    fail(EXIT_CANNOT_RUN, `migration not found: ${MIGRATION}`);
  }
  const sql = fs.readFileSync(MIGRATION, "utf8");

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
    `SELECT p.proname, pg_get_functiondef(p.oid) AS def
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (${FUNCTIONS.map((f) => `'${f}'`).join(",")})`,
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

  for (const name of FUNCTIONS) {
    const matches = fnRows.filter((r) => r.proname === name);
    if (matches.length === 0) {
      console.error(`  ✘  ${name}: NOT PRESENT in the live database`);
      bad++;
      continue;
    }
    if (matches.length > 1) {
      console.error(`  ✘  ${name}: ${matches.length} overloads live — 0200 declares one`);
      bad++;
      continue;
    }
    if (sql.includes(matches[0].def)) {
      console.log(`  ✔  ${name}: byte-identical to live`);
    } else {
      console.error(`  ✘  ${name}: DRIFT — 0200 does not contain the live definition`);
      console.error("     live definition is:");
      console.error(matches[0].def.split("\n").map((l) => "       " + l).join("\n"));
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

  console.log("\nPASS — 0200 reproduces live exactly (4 functions, 2 triggers).");
  process.exit(EXIT_OK);
}

main().catch((e) => {
  console.error(`  ✘  unexpected failure: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(EXIT_DRIFT);
});
