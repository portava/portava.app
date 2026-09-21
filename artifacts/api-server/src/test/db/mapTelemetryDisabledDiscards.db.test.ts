/**
 * mapTelemetryDisabledDiscards.db.test.ts — 2964, against a real PostgreSQL.
 *
 * WHY THIS IS NOT A UNIT TEST
 * ═══════════════════════════
 * mapTelemetry.test.ts drives the route against a recorder and can establish
 * what the route SENDS: a function name and a count, with no viewer id and no
 * session id anywhere in the arguments. It cannot establish what the database
 * would ACCEPT, because a recorder answers every call the same way. The claim
 * this file exists to prove is the other half, and it is a claim about shape
 * rather than about conduct:
 *
 *   the collection-off path CANNOT store an identifier, because there is
 *   nowhere to put one and no grant that would let it try.
 *
 * A comment saying "we do not write viewer_id here" is worth exactly as much as
 * the next person's care. A table with no identity column, a service_role that
 * holds no INSERT on it, and a writer function whose entire argument list is an
 * integer are worth more, and those are what these cases read out of a live
 * catalog.
 *
 * 2202_map_telemetry.sql states the contract being kept: "OFF by default: the
 * route answers { ok: true, accepted: 0, enabled: false } and the client keeps
 * queueing locally. Nothing is collected until switched on."
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { HAVE_DB, exec, rows, scalar } from "./localDb.js";

const TABLE = "public.map_telemetry_disabled_discards";
const WRITER = "public.record_map_telemetry_disabled_discard";

describe("2964 — the collection-off counter cannot hold an identity", { skip: !HAVE_DB }, () => {
  before(() => {
    // These suites share a database, so start from a known-empty counter rather
    // than from whatever a previous file left. The table is per-hour, not
    // per-user, so there is nothing here to preserve for anyone.
    exec(`DELETE FROM ${TABLE};`);
  });

  after(() => {
    exec(`DELETE FROM ${TABLE};`);
  });

  // ── shape ──────────────────────────────────────────────────────────────────

  test("the table exists and has exactly the four non-identifying columns", () => {
    const cols = rows<{ attname: string; typ: string }>(`
      SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
      FROM pg_attribute a
      WHERE a.attrelid = '${TABLE}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `);
    assert.deepEqual(
      cols.map((c) => c.attname),
      ["bucket_hour", "batches", "events", "expires_at"],
      "an extra column here is how an identifier gets back in",
    );
    // No uuid, whatever a column is called. `viewer_id` was the original
    // defect; a uuid named `ref` would be the same defect renamed.
    assert.equal(
      cols.some((c) => c.typ === "uuid"),
      false,
      "a uuid column is an identifier regardless of its name",
    );
    // No free-text column either: `map_session_id` was text, and a text column
    // is where a session id or a token would land.
    assert.equal(
      cols.some((c) => c.typ === "text" || c.typ.startsWith("character")),
      false,
      "a text column is where a session id would go",
    );
  });

  test("bucket_hour must be an hour boundary, so a row cannot become a request timestamp", () => {
    // One row per POST is a timing trace even with the ids removed: arrival
    // times and batch sizes fingerprint a session on their own.
    assert.throws(
      () =>
        exec(
          `INSERT INTO ${TABLE} (bucket_hour, batches, events) VALUES (clock_timestamp(), 1, 1);`,
        ),
      /map_telemetry_disabled_discards_bucket_is_hour_check/,
    );
    assert.equal(scalar(`SELECT count(*)::text FROM ${TABLE}`), "0");
  });

  // ── grants ─────────────────────────────────────────────────────────────────

  test("no client role can read or write the counter", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(
          scalar(`SELECT has_table_privilege('${role}', '${TABLE}', '${priv}')::text`),
          "false",
          `${role} must not hold ${priv}`,
        );
      }
      assert.equal(
        scalar(`SELECT has_function_privilege('${role}', '${WRITER}(integer)', 'EXECUTE')::text`),
        "false",
        `${role} must not be able to call the writer`,
      );
    }
  });

  test("service_role reaches the counter ONLY through the function", () => {
    // The route holds no INSERT, so it cannot write a column this migration did
    // not choose — including one a later migration might add.
    assert.equal(scalar(`SELECT has_table_privilege('service_role', '${TABLE}', 'INSERT')::text`), "false");
    assert.equal(scalar(`SELECT has_table_privilege('service_role', '${TABLE}', 'UPDATE')::text`), "false");
    assert.equal(scalar(`SELECT has_table_privilege('service_role', '${TABLE}', 'SELECT')::text`), "true");
    assert.equal(scalar(`SELECT has_table_privilege('service_role', '${TABLE}', 'DELETE')::text`), "true");
    assert.equal(
      scalar(`SELECT has_function_privilege('service_role', '${WRITER}(integer)', 'EXECUTE')::text`),
      "true",
    );
  });

  test("the writer takes a count and nothing else, and there is exactly one of it", () => {
    const sigs = rows<{ sig: string }>(`
      SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_map_telemetry_disabled_discard'
    `);
    // An overload is how a second, wider argument list gets added without
    // touching the one this file reads.
    assert.deepEqual(sigs.map((s) => s.sig), [
      "record_map_telemetry_disabled_discard(integer)",
    ]);
  });

  // ── behaviour ──────────────────────────────────────────────────────────────

  test("concurrent refusals in one hour accumulate into a single row", () => {
    exec(`
      SELECT ${WRITER}(16);
      SELECT ${WRITER}(4);
      SELECT ${WRITER}(1);
    `);
    const r = rows<{ batches: string; events: string; is_hour: boolean }>(`
      SELECT batches::text, events::text, (bucket_hour = date_trunc('hour', bucket_hour)) AS is_hour
      FROM ${TABLE}
    `);
    assert.equal(r.length, 1, "three refusals in one hour are one row, not three");
    assert.equal(r[0]!.batches, "3", "batches counts requests: 'clients still trying'");
    assert.equal(r[0]!.events, "21", "events counts what was lost: 16 + 4 + 1");
    assert.equal(r[0]!.is_hour, true);
  });

  test("a refusal that discarded nothing is not recorded", () => {
    // Otherwise "the discard is counted" is satisfied by counting
    // unconditionally, and an empty keep-alive POST becomes a stored fact.
    exec(`DELETE FROM ${TABLE};`);
    exec(`SELECT ${WRITER}(0); SELECT ${WRITER}(NULL);`);
    assert.equal(scalar(`SELECT count(*)::text FROM ${TABLE}`), "0");
  });

  test("an earlier hour stays its own row — the counter can locate an outage", () => {
    // This is the whole point of keeping it: commit 63772b76c's investigation
    // needed to know WHEN the silent discard began, and an all-time total
    // cannot answer that.
    exec(`DELETE FROM ${TABLE};`);
    exec(`
      INSERT INTO ${TABLE} (bucket_hour, batches, events)
      VALUES (date_trunc('hour', now()) - interval '3 hours', 5, 50);
      SELECT ${WRITER}(7);
    `);
    const r = rows<{ events: string }>(`SELECT events::text FROM ${TABLE} ORDER BY bucket_hour`);
    assert.deepEqual(r.map((x) => x.events), ["50", "7"]);
  });

  // ── retention ──────────────────────────────────────────────────────────────

  test("2960's purge, as 2964 replaced it, sweeps this table too and still sweeps the other two", () => {
    exec(`DELETE FROM ${TABLE};`);
    exec(`
      INSERT INTO ${TABLE} (bucket_hour, batches, events, expires_at)
      VALUES (date_trunc('hour', now()) - interval '100 days', 1, 9, now() - interval '10 days');
    `);
    const fresh = `date_trunc('hour', now())`;
    exec(`
      INSERT INTO ${TABLE} (bucket_hour, batches, events, expires_at)
      VALUES (${fresh}, 1, 3, now() + interval '90 days');
    `);
    const purged = scalar(`SELECT public.purge_expired_map_telemetry()::text`);
    assert.equal(purged, "1", "exactly the expired row");
    assert.equal(scalar(`SELECT events::text FROM ${TABLE}`), "3", "the unexpired row survives");

    // The replacement is additive, not a narrowing. Comments are stripped so
    // prose naming a table cannot satisfy a check that the body deletes from it.
    // Through rows(), not scalar(): a function definition is multi-line and
    // scalar() returns psql's FIRST line, which would silently reduce this
    // assertion to a check on `CREATE OR REPLACE FUNCTION`. json_agg carries
    // the newlines across intact.
    const body = rows<{ src: string }>(`
      SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'purge_expired_map_telemetry'
    `)[0]!.src;
    for (const t of [
      "DELETE FROM public.map_telemetry_events",
      "DELETE FROM public.map_telemetry_drops",
      "DELETE FROM public.map_telemetry_disabled_discards",
    ]) {
      assert.ok(body.includes(t), `the purge must still contain: ${t}`);
    }
  });

  // ── the separation, stated as a comparison ─────────────────────────────────

  test("map_telemetry_drops still carries viewer_id — the tables are separate, not merged", () => {
    // Anti-vacuity for the whole file. If this suite passed because
    // map_telemetry_drops had also lost its identity column, the fix would have
    // broken the ENABLED path's legitimate per-user drop accounting, which 2202
    // designed and §35 needs. The separation is the point: identity on the path
    // where collection is switched on, none on the path where it is off.
    assert.equal(
      scalar(`
        SELECT count(*)::text FROM pg_attribute
        WHERE attrelid = 'public.map_telemetry_drops'::regclass
          AND attname = 'viewer_id' AND NOT attisdropped
      `),
      "1",
    );
    assert.equal(
      scalar(`
        SELECT count(*)::text FROM pg_attribute
        WHERE attrelid = '${TABLE}'::regclass
          AND attname = 'viewer_id' AND NOT attisdropped
      `),
      "0",
    );
  });
});
