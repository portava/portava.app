/**
 * creatorFatigueIncrementRpc.db.test.ts — 3560 increment_creator_fatigue_batch,
 * EXECUTED against PostgreSQL with 3560 applied (FLAGS lane).
 *
 * lib/rankLog.ts calls this RPC after every impression batch while
 * CREATOR_FATIGUE_ENABLED is ON; before 3560 it existed only in the frozen root
 * supabase/migrations/20260804_creator_fatigue_expires.sql, so every call failed
 * 42883. This suite holds the ported body to what the frozen file computes and
 * to the four reviewed differences 3560's header names:
 *
 *   F1  rankLog's exact call shape (p_viewer_id, p_creator_ids only) inserts one
 *       row per creator at 1 impression / score 1.00, updated_at set
 *   F2  a repeat decays the score by elapsed time over the half-life, adds 1.0,
 *       caps at 10, and opens expires_at one half-life out at the threshold
 *   F3  NULL / empty creator lists and NULL elements are no-ops; non-positive
 *       half-life or threshold is refused (the frozen body divided by zero)
 *   F4  service_role may EXECUTE; anon and authenticated may not; search_path
 *       is pinned
 *
 * Controlled data on the harness only: no production claim. Every write runs in
 * a transaction this suite rolls back.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, exec, psql, scalar, seedUser, deleteUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";
const FN = "public.increment_creator_fatigue_batch(uuid,uuid[],integer,integer)";

/** Run `body` as service_role inside a transaction that is rolled back; return its output lines. */
function rolledBack(body: string): string[] {
  return exec(`BEGIN;\nSET LOCAL ROLE service_role;\n${body}\nROLLBACK;`);
}

describe("3560 increment_creator_fatigue_batch on a real database", { skip: SKIP }, () => {
  let viewer = "";
  let c1 = "";
  let c2 = "";

  before(() => {
    assert.ok(scalar(`SELECT to_regprocedure('${FN}')::text`), "3560 is applied to this database");
    viewer = seedUser("fatigue_viewer");
    c1 = seedUser("fatigue_creator_a");
    c2 = seedUser("fatigue_creator_b");
  });
  after(() => { for (const id of [viewer, c1, c2]) if (id) deleteUser(id); });

  const row = (creator: string) =>
    `SELECT recent_impressions || '|' || fatigue_score || '|' || (expires_at IS NULL) || '|' || (updated_at = now()) FROM public.viewer_creator_fatigue WHERE viewer_id = '${viewer}' AND creator_id = '${creator}';`;

  it("F1 rankLog's call shape inserts one row per creator at 1 impression, score 1.00, updated_at stamped", () => {
    const out = rolledBack([
      `SELECT public.increment_creator_fatigue_batch(p_viewer_id => '${viewer}', p_creator_ids => ARRAY['${c1}','${c2}']::uuid[]);`,
      `SELECT count(*) FROM public.viewer_creator_fatigue WHERE viewer_id = '${viewer}';`,
      row(c1),
      row(c2),
    ].join("\n"));
    assert.deepEqual(out.slice(-3), ["2", "1|1.00|true|true", "1|1.00|true|true"]);
  });

  it("F2 a repeat decays over the half-life, adds 1.0, caps at 10, and opens expires_at at the threshold", () => {
    const out = rolledBack([
      // One half-life ago at score 4 with 3 impressions: 4 * 0.5 + 1 = 3.00, impressions 4, no window yet (threshold 5).
      `INSERT INTO public.viewer_creator_fatigue (viewer_id, creator_id, recent_impressions, last_impression_at, fatigue_score, updated_at)
         VALUES ('${viewer}', '${c1}', 3, now() - interval '48 hours', 4, now() - interval '48 hours');`,
      `SELECT public.increment_creator_fatigue_batch('${viewer}', ARRAY['${c1}']::uuid[]);`,
      row(c1),
      // The 5th impression reaches the threshold: expires_at = now() + 48 h.
      `SELECT public.increment_creator_fatigue_batch('${viewer}', ARRAY['${c1}']::uuid[]);`,
      `SELECT recent_impressions || '|' || fatigue_score || '|' || (expires_at = now() + interval '48 hours') FROM public.viewer_creator_fatigue WHERE viewer_id = '${viewer}' AND creator_id = '${c1}';`,
      // A score at the cap stays at 10.
      `INSERT INTO public.viewer_creator_fatigue (viewer_id, creator_id, recent_impressions, last_impression_at, fatigue_score)
         VALUES ('${viewer}', '${c2}', 1, now(), 10);`,
      `SELECT public.increment_creator_fatigue_batch('${viewer}', ARRAY['${c2}']::uuid[], 12, 2);`,
      `SELECT recent_impressions || '|' || fatigue_score || '|' || (expires_at = now() + interval '12 hours') FROM public.viewer_creator_fatigue WHERE viewer_id = '${viewer}' AND creator_id = '${c2}';`,
    ].join("\n"));
    const lines = out.filter((l) => l.includes("|"));
    assert.deepEqual(lines, ["4|3.00|true|true", "5|4.00|true", "2|10.00|true"]);
  });

  it("F3 NULL/empty lists and NULL elements write nothing; a non-positive half-life or threshold is refused", () => {
    const out = rolledBack([
      `SELECT public.increment_creator_fatigue_batch('${viewer}', NULL);`,
      `SELECT public.increment_creator_fatigue_batch('${viewer}', ARRAY[]::uuid[]);`,
      `SELECT public.increment_creator_fatigue_batch('${viewer}', ARRAY[NULL]::uuid[]);`,
      `SELECT 'rows=' || count(*) FROM public.viewer_creator_fatigue WHERE viewer_id = '${viewer}';`,
    ].join("\n"));
    assert.equal(out.at(-1), "rows=0");
    for (const args of ["0, 5", "48, 0", "-1, 5"]) {
      const r = psql(`BEGIN; SET LOCAL ROLE service_role; SELECT public.increment_creator_fatigue_batch('${viewer}', ARRAY['${c1}']::uuid[], ${args}); ROLLBACK;`);
      assert.notEqual(r.status, 0, `(${args}) must be refused`);
      assert.match(r.stderr, /must be positive/);
    }
  });

  it("F4 only service_role may execute it, and its search_path is pinned", () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', '${FN}', 'EXECUTE')::text`), "false", role);
      const r = psql(`BEGIN; SET LOCAL ROLE ${role}; SELECT public.increment_creator_fatigue_batch('${viewer}', ARRAY['${c1}']::uuid[]); ROLLBACK;`);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /permission denied/);
    }
    assert.equal(scalar(`SELECT has_function_privilege('service_role', '${FN}', 'EXECUTE')::text`), "true");
    assert.equal(scalar(`SELECT ('search_path=""' = ANY (proconfig))::text FROM pg_proc WHERE oid = to_regprocedure('${FN}')`), "true");
    assert.equal(scalar(`SELECT prosecdef::text FROM pg_proc WHERE oid = to_regprocedure('${FN}')`), "true");
  });
});
