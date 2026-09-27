/**
 * discoveryTelemetryIdempotency.db.test.ts — census-discovery DV-37 (`04` §3
 * "idempotent where retried"), proved on a REAL PostgreSQL with the statements
 * the writers issue, including two sessions racing each other.
 *
 * What the application relies on, each case pinning one:
 *
 *   I1  A replayed serve batch (the plain multi-row INSERT lib/discoveryServeLog
 *       and lib/rankLog issue) is refused WHOLE by 2891's (recommendation_id,
 *       outcome) index — and Postgres's own error text satisfies the predicate
 *       the writers classify it with (`isDuplicateExposureReplay`). A predicate
 *       tested only against a hand-written error proves nothing about this one.
 *   I2  WHY THE PLAIN INSERT AND NOT `ON CONFLICT DO NOTHING`: after an outcome
 *       moved one row (impression → tap), a replay under DO NOTHING RESURRECTS
 *       that item's impression; the plain insert is still refused whole.
 *   I3  A CONCURRENT duplicate: the second session blocks on the index until the
 *       first commits, then is refused. Exactly one batch lands.
 *   I4  A partial failure (one row refused by a CHECK) writes NOTHING; the
 *       corrected retry lands every row; a replay of that is refused.
 *   I5  The outcome route's COMPARE-AND-SET under a race: of two sessions moving
 *       the same row, exactly one UPDATE … WHERE outcome IN (…) returns a row.
 *   I6  A keyed direct impression under ON CONFLICT DO NOTHING lands once.
 *   I7  3376's door, called concurrently with one request id: one 'written',
 *       one 'duplicate', one row — run as service_role.
 *   I8  The analytics upsert (ON CONFLICT DO UPDATE) converges on one row.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { HAVE_DB, LOCAL_DB_URL, psql, exec, scalar, seedUser, deleteUser } from "./localDb.js";
import { isDuplicateExposureReplay } from "../../lib/discoveryRecommendationRecord.js";

let user = "";

function psqlAsync(script: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", LOCAL_DB_URL]);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
    p.stdin.end(script);
  });
}

/** Postgres's error, shaped the way PostgREST hands it to supabase-js. */
function pgError(stderr: string): { code: string; message: string; details: string } {
  const message = /ERROR:\s+(?:[0-9A-Z]{5}:\s+)?(.*)/.exec(stderr)?.[1]?.trim() ?? "";
  const details = /DETAIL:\s+(.*)/.exec(stderr)?.[1]?.trim() ?? "";
  const code = /ERROR:\s+([0-9A-Z]{5}):/.exec(stderr)?.[1] ?? (message.includes("duplicate key") ? "23505" : "");
  return { code, message, details };
}

/** The serve batch the writer builds: one token per exposure, shared session and clock. */
function batch(tag: string, n = 3, override: (i: number) => string = () => "'place'"): string {
  const values = Array.from({ length: n }, (_, i) =>
    `('${user}', '${tag}-item-${i}', ${override(i)}, ${i}, '{}'::jsonb, 'impression', '2026-09-27T10:00:00Z', 'discovery', '6b1c0000-0000-4000-8000-00000000000${i % 10}', 1, 'raw_behavioral_event', '${tag.padEnd(20, "x").slice(0, 20)}${String(i).padStart(2, "0")}')`,
  ).join(",\n  ");
  return `INSERT INTO public.rank_events (user_id, item_id, item_kind, position, features, outcome, served_at, surface, session_id, schema_version, privacy_class, recommendation_id) VALUES\n  ${values}`;
}
const count = (tag: string) => Number(scalar(`SELECT count(*) FROM public.rank_events WHERE item_id LIKE '${tag}-item-%'`));

describe("DV-37 — idempotent where retried, on a real database", { skip: !HAVE_DB }, () => {
  before(() => { user = seedUser("dv37"); });
  after(() => {
    exec(`DELETE FROM public.rank_events WHERE user_id = '${user}';\nDELETE FROM public.recommendations WHERE id LIKE 'I7%';`);
    deleteUser(user);
  });

  test("I1. a replayed serve batch is refused WHOLE, and Postgres's error is what the writers read as a replay", () => {
    exec(`${batch("i1")};`);
    assert.equal(count("i1"), 3);
    const r = psql(`\\set VERBOSITY verbose\n${batch("i1")};`);
    assert.notEqual(r.status, 0, "the replay must be refused");
    const err = pgError(r.stderr);
    assert.equal(err.code, "23505");
    assert.equal(isDuplicateExposureReplay(err), true,
      `the writers' predicate must recognise the REAL error, or a replay is counted as a lost write:\n${r.stderr}`);
    assert.equal(count("i1"), 3, "nothing was written twice");
  });

  test("I2. after one row moved to 'tap', a replay is STILL refused whole — DO NOTHING would have resurrected it", () => {
    exec(`${batch("i2")};\nUPDATE public.rank_events SET outcome = 'tap' WHERE item_id = 'i2-item-1' AND user_id = '${user}';`);
    const plain = psql(`${batch("i2")};`);
    assert.notEqual(plain.status, 0, "the untouched rows still collide, so the replay lands nothing");
    assert.equal(count("i2"), 3);
    // The alternative, measured rather than argued, inside a rolled-back transaction:
    const dn = exec(`BEGIN;\n${batch("i2")} ON CONFLICT (recommendation_id, outcome) DO NOTHING RETURNING item_id;\nROLLBACK;`);
    assert.deepEqual(dn, ["i2-item-1"], "ON CONFLICT DO NOTHING would re-insert the tapped item's impression: a second exposure for one serve");
  });

  test("I3. a CONCURRENT duplicate: the second session waits on the index, then is refused; one batch lands", async () => {
    const a = psqlAsync(`BEGIN;\n${batch("i3")};\nSELECT pg_sleep(0.6);\nCOMMIT;`);
    await new Promise((r) => setTimeout(r, 150));
    const b = psqlAsync(`${batch("i3")};`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.notEqual(rb.status, 0, "the racing replay must not land");
    assert.equal(isDuplicateExposureReplay(pgError(rb.stderr)), true, rb.stderr);
    assert.equal(count("i3"), 3);
  });

  test("I4. a partial failure writes nothing; the corrected retry lands every row; its replay is refused", () => {
    const bad = psql(`${batch("i4", 3, (i) => (i === 2 ? "'trail'" : "'place'"))};`);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /rank_events_item_kind_check/);
    assert.equal(count("i4"), 0, "a statement is atomic: the two good rows did not land without the third");
    exec(`${batch("i4")};`);
    assert.equal(count("i4"), 3, "the retry lands the whole batch");
    assert.notEqual(psql(`${batch("i4")};`).status, 0);
    assert.equal(count("i4"), 3);
  });

  test("I5. compare-and-set: of two sessions moving one row, exactly one UPDATE returns it", async () => {
    exec(`${batch("i5", 1)};`);
    const id = scalar(`SELECT id FROM public.rank_events WHERE item_id = 'i5-item-0'`)!;
    const cas = `UPDATE public.rank_events SET outcome = 'dismiss', outcome_at = now() WHERE id = '${id}' AND outcome = ANY (ARRAY['impression']) RETURNING id`;
    const a = psqlAsync(`BEGIN;\n${cas};\nSELECT pg_sleep(0.6);\nCOMMIT;`);
    await new Promise((r) => setTimeout(r, 150));
    const b = psqlAsync(`${cas};`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.equal(rb.status, 0, rb.stderr);
    const moved = [ra.stdout, rb.stdout].map((s) => s.split("\n").filter((l) => l === id).length);
    assert.deepEqual(moved.sort(), [0, 1], `exactly one session moved the row: ${JSON.stringify(moved)}`);
    assert.equal(scalar(`SELECT outcome FROM public.rank_events WHERE id = '${id}'`), "dismiss");
  });

  test("I6. a keyed direct impression under ON CONFLICT DO NOTHING lands once however often it is retried", () => {
    const ins = `INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, features, event_type, recommendation_id)
      VALUES ('${user}', 'i6-item-0', 'living_page', 'impression', now(), '{}'::jsonb, 'place_view', 'I6keyedxxxxxxxxxxxxxx0')
      ON CONFLICT (recommendation_id, outcome) DO NOTHING RETURNING id`;
    assert.equal(exec(`${ins};`).length, 1, "the first landing");
    assert.equal(exec(`${ins};`).length, 0, "the retry lands nothing");
    assert.equal(exec(`${ins};`).length, 0);
    assert.equal(count("i6"), 1);
  });

  test("I7. 3376's door, raced with one request id as service_role: one 'written', one 'duplicate', one row", async () => {
    const call = `SET ROLE service_role;\nSELECT public.record_discovery_serve_request('{"id":"I7racexxxxxxxxxxxxxxx0","viewer_class":"anonymous","session_id":"7e7e0000-0000-4000-8000-000000000001","surface":"discovery","serve_point":1,"model_version":"m","served_count":1,"item_ids":["node/1"],"item_kinds":["place"],"served_at":"2026-09-27T10:00:00Z"}'::jsonb)`;
    const a = psqlAsync(`BEGIN;\n${call};\nSELECT pg_sleep(0.6);\nCOMMIT;`);
    await new Promise((r) => setTimeout(r, 150));
    const b = psqlAsync(`${call};`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.equal(rb.status, 0, rb.stderr);
    const answers = [ra.stdout, rb.stdout].map((s) => s.split("\n").find((l) => l === "written" || l === "duplicate"));
    assert.deepEqual(answers.sort(), ["duplicate", "written"]);
    assert.equal(scalar(`SELECT count(*) FROM public.recommendations WHERE id = 'I7racexxxxxxxxxxxxxxx0'`), "1");
  });

  test("I8. the analytics upsert (ON CONFLICT DO UPDATE) converges on one row per exposure", () => {
    const up = (ev: string) => `INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, features, event_type, recommendation_id)
      VALUES ('${user}', 'i8-item-0', 'discovery', 'analytics', now(), '{}'::jsonb, '${ev}', 'I8analyticsxxxxxxxxxx0')
      ON CONFLICT (recommendation_id, outcome) DO UPDATE SET event_type = EXCLUDED.event_type`;
    exec(`${up("ranking_item_tapped")};\n${up("ranking_item_tapped")};\n${up("ranking_item_saved")};`);
    assert.equal(count("i8"), 1);
    assert.equal(scalar(`SELECT event_type FROM public.rank_events WHERE item_id = 'i8-item-0'`), "ranking_item_saved");
  });
});
