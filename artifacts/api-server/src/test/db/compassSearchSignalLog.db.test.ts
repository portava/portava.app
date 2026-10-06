/**
 * compassSearchSignalLog.db.test.ts — 3561 compass_search_signal_log,
 * upsert_compass_search_signal and purge_compass_search_signal_log, EXECUTED
 * against PostgreSQL with 2306 and 3561 applied (FLAGS lane).
 *
 * Before 3561 these objects existed only in the frozen root
 * supabase/migrations/20260812_compass_search_signal_log.sql, so every Compass
 * search nudge failed 42883 and decay never applied (2306's header). The
 * route (routes/compass.ts) logs a nudge whatever SEARCH_SIGNAL_DECAY_DAYS says
 * and no retention period for these rows is stated anywhere, so 3561 gates
 * COLLECTION on the flag and leaves the purge period unset:
 *
 *   S1  flag OFF (2306's seed) or ABSENT: the RPC records nothing, returns false
 *   S2  flag ON: the RPC records, accumulates search_weight, moves
 *       last_nudge_at, returns true — the frozen file's semantics
 *   S3  a non-positive delta and an over-long category are refused
 *   S4  the purge refuses a NULL / non-positive period (the owner's decision),
 *       and with a period deletes only rows older than it and returns the count
 *   S5  anon/authenticated hold no table privilege and cannot execute either
 *       function; service_role can; a user's rows go with the user
 *
 * Controlled data on the harness only: no production claim. Every flag change
 * and write runs in a transaction this suite rolls back, so the shared flag row
 * is never left changed.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, exec, psql, scalar, seedUser, deleteUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";
const UPSERT = "public.upsert_compass_search_signal(uuid,text,integer)";
const PURGE = "public.purge_compass_search_signal_log(interval)";
const FLAG = "SEARCH_SIGNAL_DECAY_DAYS";

/** Run `body` inside a transaction that is rolled back; return its output lines. */
function rolledBack(body: string): string[] {
  return exec(`BEGIN;\n${body}\nROLLBACK;`);
}

describe("3561 compass_search_signal_log on a real database", { skip: SKIP }, () => {
  let user = "";
  let other = "";

  before(() => {
    assert.ok(scalar(`SELECT to_regclass('public.compass_search_signal_log')::text`), "3561 is applied to this database");
    assert.ok(scalar(`SELECT flag FROM public.feature_flags WHERE flag = '${FLAG}'`), "2306 seeded the flag row");
    user = seedUser("search_signal_user");
    other = seedUser("search_signal_other");
  });
  after(() => { for (const id of [user, other]) if (id) deleteUser(id); });

  const count = (id: string) => `SELECT 'n=' || count(*) FROM public.compass_search_signal_log WHERE user_id = '${id}';`;

  it("S1 with the flag OFF or ABSENT nothing is recorded and the RPC says so", () => {
    const off = rolledBack([
      `UPDATE public.feature_flags SET enabled = false WHERE flag = '${FLAG}';`,
      `SET LOCAL ROLE service_role;`,
      `SELECT 'r=' || public.upsert_compass_search_signal('${user}', 'food', 2);`,
      count(user),
    ].join("\n"));
    assert.deepEqual(off.filter((l) => /^(r|n)=/.test(l)), ["r=false", "n=0"]);
    const absent = rolledBack([
      `DELETE FROM public.feature_flags WHERE flag = '${FLAG}';`,
      `SET LOCAL ROLE service_role;`,
      `SELECT 'r=' || public.upsert_compass_search_signal('${user}', 'food', 2);`,
      count(user),
    ].join("\n"));
    assert.deepEqual(absent.filter((l) => /^(r|n)=/.test(l)), ["r=false", "n=0"]);
  });

  it("S2 with the flag ON a nudge is recorded, accumulates, and moves last_nudge_at", () => {
    const out = rolledBack([
      `UPDATE public.feature_flags SET enabled = true WHERE flag = '${FLAG}';`,
      `SET LOCAL ROLE service_role;`,
      `SELECT 'r=' || public.upsert_compass_search_signal('${user}', 'food', 2);`,
      `UPDATE public.compass_search_signal_log SET last_nudge_at = now() - interval '3 days' WHERE user_id = '${user}';`,
      `SELECT 'r=' || public.upsert_compass_search_signal('${user}', 'food', 1);`,
      `SELECT 'r=' || public.upsert_compass_search_signal('${user}', 'museums', 1);`,
      `SELECT 'w=' || category || ':' || search_weight || ':' || (last_nudge_at = now()) FROM public.compass_search_signal_log WHERE user_id = '${user}' ORDER BY category;`,
    ].join("\n"));
    assert.deepEqual(out.filter((l) => /^(r|w)=/.test(l)), ["r=true", "r=true", "r=true", "w=food:3:true", "w=museums:1:true"]);
  });

  it("S3 a non-positive delta and an over-long category are refused", () => {
    for (const [args, re] of [
      [`'${user}', 'food', 0`, /p_delta must be positive/],
      [`'${user}', 'food', -2`, /p_delta must be positive/],
      [`'${user}', repeat('x', 101), 1`, /compass_search_signal_log_category_check|violates check constraint/],
    ] as const) {
      const r = psql(`BEGIN; UPDATE public.feature_flags SET enabled = true WHERE flag = '${FLAG}'; SET LOCAL ROLE service_role; SELECT public.upsert_compass_search_signal(${args}); ROLLBACK;`);
      assert.notEqual(r.status, 0, args);
      assert.match(r.stderr, re);
    }
  });

  it("S4 the purge refuses to choose a period, and with one deletes only older rows and reports the count", () => {
    for (const p of ["NULL", "interval '0'", "interval '-1 day'"]) {
      const r = psql(`BEGIN; SET LOCAL ROLE service_role; SELECT public.purge_compass_search_signal_log(${p}); ROLLBACK;`);
      assert.notEqual(r.status, 0, p);
      assert.match(r.stderr, /open owner decision/);
    }
    const out = rolledBack([
      `UPDATE public.feature_flags SET enabled = true WHERE flag = '${FLAG}';`,
      `SET LOCAL ROLE service_role;`,
      `SELECT public.upsert_compass_search_signal('${user}', 'old', 1);`,
      `SELECT public.upsert_compass_search_signal('${user}', 'new', 1);`,
      `UPDATE public.compass_search_signal_log SET last_nudge_at = now() - interval '40 days' WHERE user_id = '${user}' AND category = 'old';`,
      `SELECT 'p=' || public.purge_compass_search_signal_log(interval '30 days');`,
      `SELECT 'k=' || string_agg(category, ',') FROM public.compass_search_signal_log WHERE user_id = '${user}';`,
    ].join("\n"));
    assert.deepEqual(out.filter((l) => /^(p|k)=/.test(l)), ["p=1", "k=new"]);
  });

  it("S5 client roles hold no privilege; service_role does; a user's rows go with the user", () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.compass_search_signal_log', 'SELECT,INSERT,UPDATE,DELETE')::text`), "false", role);
      for (const fn of [UPSERT, PURGE]) {
        assert.equal(scalar(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE')::text`), "false", `${role} ${fn}`);
      }
      const r = psql(`BEGIN; SET LOCAL ROLE ${role}; SELECT count(*) FROM public.compass_search_signal_log; ROLLBACK;`);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /permission denied/);
    }
    for (const fn of [UPSERT, PURGE]) {
      assert.equal(scalar(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE')::text`), "true", fn);
    }
    const out = rolledBack([
      `UPDATE public.feature_flags SET enabled = true WHERE flag = '${FLAG}';`,
      `SET LOCAL ROLE service_role;`,
      `SELECT public.upsert_compass_search_signal('${other}', 'food', 1);`,
      `RESET ROLE;`,
      `DELETE FROM auth.users WHERE id = '${other}';`,
      count(other),
    ].join("\n"));
    assert.equal(out.at(-1), "n=0");
  });
});
