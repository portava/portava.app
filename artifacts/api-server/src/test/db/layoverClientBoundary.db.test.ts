/**
 * census-layover L236 / L295 — the layover tables' CLIENT boundary, EXECUTED on
 * a real PostgreSQL rather than read as text.
 *
 * L236 asks for "database tests against a real CI schema for … RLS and
 * migration postconditions", and L295 for "live-schema/literal checks [that]
 * cover safety-critical query paths". Every layover route suite runs through
 * `fakeLayoverDb`, whose own header says it models no RLS, no grants, no FK and
 * no CHECK. The static suite for 3620 (`layoverClientWriteBoundary.test.ts`)
 * reads the migration's text. This file runs the chain's real objects:
 *
 *   B1  3620's catalogue: on the four 0127 tables RLS is on, `authenticated`
 *       holds SELECT and no write verb (table or column), `anon` holds nothing,
 *       and `service_role` keeps every DML verb its writers use.
 *   B2  0127's owner policies, as PostgREST would run them: a signed-in
 *       traveller reads their OWN session, stops and events, never another's;
 *       the airport catalogue reads for every signed-in user.
 *   B3  every client write is refused, and the rows are unchanged afterwards —
 *       a traveller cannot set their own session's status, add a stop, delete
 *       an event or mark an airport verified.
 *   B4  `anon` reads nothing.
 *   B5  3900's `layover_presence`: no coordinate column, no client privilege,
 *       `precise_location_enabled` refused at TRUE even for the service role,
 *       and the row leaves with its session.
 *   B6  the cascades: closing a session takes its stops and presence with it.
 *   B7  3621 (census-layover L163, OD-MAP-4): a pseudonymised event OUTLIVES its
 *       session with no user and no session; the CHECK refuses a pseudonym
 *       beside a user id and a retention past 12 months.
 *
 * Skips when LOCAL_DB_URL is unset; `scripts/local-db/run-tests.sh` (CI's
 * kernel-SQL job) is the run that refuses skipped > 0. NOT RUN ON THE AUTHORING
 * MACHINE, which has no PostgreSQL: CI's job is this file's first run.
 *
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, asUser, deleteUser, exec, rows, scalar, seedUser } from "./localDb.js";

const TABLES = ["layover_sessions", "layover_plan_stops", "layover_events", "airport_profiles"] as const;
const WRITE_VERBS = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const SERVICE_DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/** The same three steps as `asUser`, for the anonymous PostgREST role. */
function asAnon(script: string): string[] {
  return exec(
    [`SELECT set_config('request.jwt.claim.role', 'anon', true);`, `SET LOCAL ROLE anon;`, script].join("\n"),
    { single: true },
  ).slice(1);
}

function asService(script: string): string[] {
  return exec([`SET LOCAL ROLE service_role;`, script].join("\n"), { single: true });
}

/** A five-letter code no other suite seeds; `iata_code` is UNIQUE. */
function testIata(): string {
  return "Q" + randomUUID().replace(/-/g, "").slice(0, 4).split("").map((c) => String.fromCharCode(65 + (parseInt(c, 16) % 26))).join("");
}

describe("census-layover L236/L295 — the layover client boundary on a real database (0127 RLS, 3620 grants, 3900 presence)", { skip: !HAVE_DB }, () => {
  let A = "";
  let B = "";
  let AIR = "";
  let SA = "";
  let SB = "";

  before(() => {
    A = seedUser("lay_bound_a");
    B = seedUser("lay_bound_b");
    AIR = randomUUID();
    SA = randomUUID();
    SB = randomUUID();
    exec(`
      INSERT INTO public.airport_profiles (id, iata_code, name, city, country, country_code)
        VALUES ('${AIR}', '${testIata()}', 'Boundary Test Airport', 'Testville', 'Testland', 'TL');
      INSERT INTO public.layover_sessions (id, user_id, airport_id, arrival_time, departure_time, flight_type) VALUES
        ('${SA}', '${A}', '${AIR}', now(), now() + interval '8 hours', 'international'),
        ('${SB}', '${B}', '${AIR}', now(), now() + interval '8 hours', 'international');
      INSERT INTO public.layover_plan_stops (session_id, title) VALUES ('${SA}', 'A stop'), ('${SB}', 'B stop');
      INSERT INTO public.layover_events (session_id, user_id, event_type) VALUES
        ('${SA}', '${A}', 'session_created'), ('${SB}', '${B}', 'session_created');
    `);
  });

  after(() => {
    if (!HAVE_DB) return;
    exec(`DELETE FROM public.layover_events WHERE session_id IN ('${SA}', '${SB}') OR user_id IN ('${A}', '${B}');
          DELETE FROM public.layover_sessions WHERE id IN ('${SA}', '${SB}');
          DELETE FROM public.airport_profiles WHERE id = '${AIR}';`);
    deleteUser(A);
    deleteUser(B);
  });

  it("B1. 3620's catalogue: RLS on; authenticated SELECT only (table and column); anon nothing; service_role keeps its DML", () => {
    const failures: string[] = [];
    for (const t of TABLES) {
      if (scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${t}'::regclass;`) !== "t") failures.push(`${t}: RLS off`);
      if (scalar(`SELECT has_table_privilege('authenticated', 'public.${t}', 'SELECT');`) !== "t") failures.push(`${t}: authenticated lost SELECT`);
      if (scalar(`SELECT has_table_privilege('anon', 'public.${t}', 'SELECT');`) !== "f") failures.push(`${t}: anon holds SELECT`);
      for (const v of WRITE_VERBS) {
        for (const role of ["anon", "authenticated"]) {
          if (scalar(`SELECT has_table_privilege('${role}', 'public.${t}', '${v}');`) !== "f") failures.push(`${t}: ${role} holds ${v}`);
        }
      }
      for (const v of ["INSERT", "UPDATE"]) {
        for (const role of ["anon", "authenticated"]) {
          if (scalar(`SELECT has_any_column_privilege('${role}', 'public.${t}', '${v}');`) !== "f") failures.push(`${t}: ${role} holds a column ${v}`);
        }
      }
      for (const v of SERVICE_DML) {
        if (scalar(`SELECT has_table_privilege('service_role', 'public.${t}', '${v}');`) !== "t") failures.push(`${t}: service_role lost ${v}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("B2. 0127's owner policies: a traveller reads their OWN session, stops and events, never another's; the airport catalogue reads", () => {
    assert.deepEqual(asUser(A, `SELECT id FROM public.layover_sessions WHERE id IN ('${SA}', '${SB}') ORDER BY id;`), [SA]);
    assert.deepEqual(asUser(B, `SELECT id FROM public.layover_sessions WHERE id IN ('${SA}', '${SB}') ORDER BY id;`), [SB]);
    assert.deepEqual(asUser(A, `SELECT title FROM public.layover_plan_stops WHERE session_id IN ('${SA}', '${SB}');`), ["A stop"]);
    assert.deepEqual(asUser(A, `SELECT session_id FROM public.layover_events WHERE session_id IN ('${SA}', '${SB}');`), [SA]);
    assert.deepEqual(asUser(B, `SELECT count(*) FROM public.airport_profiles WHERE id = '${AIR}';`), ["1"]);
  });

  it("B3. every client write is refused — and nothing changed", () => {
    const refusals: Array<[string, string]> = [
      ["layover_sessions", `UPDATE public.layover_sessions SET status = 'cancelled', share_city_status = true WHERE id = '${SA}';`],
      ["layover_sessions", `INSERT INTO public.layover_sessions (user_id, arrival_time, departure_time) VALUES ('${A}', now(), now() + interval '3 hours');`],
      ["layover_plan_stops", `INSERT INTO public.layover_plan_stops (session_id, title) VALUES ('${SA}', 'smuggled');`],
      ["layover_events", `DELETE FROM public.layover_events WHERE session_id = '${SA}';`],
      ["airport_profiles", `UPDATE public.airport_profiles SET verified = true, international_buffer_min = 5 WHERE id = '${AIR}';`],
    ];
    for (const [table, sql] of refusals) {
      assert.throws(() => asUser(A, sql), new RegExp(`permission denied for table ${table}`), sql);
    }
    assert.deepEqual(
      rows(`SELECT status, share_city_status FROM public.layover_sessions WHERE id = '${SA}'`),
      [{ status: "active", share_city_status: false }],
    );
    assert.equal(scalar(`SELECT count(*) FROM public.layover_sessions WHERE user_id = '${A}';`), "1");
    assert.equal(scalar(`SELECT count(*) FROM public.layover_plan_stops WHERE session_id = '${SA}';`), "1");
    assert.equal(scalar(`SELECT count(*) FROM public.layover_events WHERE session_id = '${SA}';`), "1");
    assert.deepEqual(
      rows(`SELECT verified, international_buffer_min FROM public.airport_profiles WHERE id = '${AIR}'`),
      [{ verified: false, international_buffer_min: 120 }],
    );
  });

  it("B4. anon reads nothing on the four tables", () => {
    for (const t of TABLES) {
      assert.throws(() => asAnon(`SELECT count(*) FROM public.${t};`), new RegExp(`permission denied for table ${t}`), t);
    }
  });

  it("B5. 3900's layover_presence: no coordinate column, no client privilege, precise location refused even for the service role, gone with its session", () => {
    const coords = rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'layover_presence'
          AND column_name ~ '(^|_)(lat|lng|lon|latitude|longitude|geom|point|location)($|_)'`,
    );
    assert.deepEqual(coords, []);
    for (const role of ["anon", "authenticated"]) {
      for (const v of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.layover_presence', '${v}');`), "f", `${role} ${v}`);
      }
    }
    assert.throws(() => asUser(A, `SELECT count(*) FROM public.layover_presence;`), /permission denied for table layover_presence/);
    assert.throws(
      () => asService(`INSERT INTO public.layover_presence (session_id, user_id, intents, available_until, expires_at, precise_location_enabled)
                       VALUES ('${SA}', '${A}', ARRAY['food'], now() + interval '2 hours', now() + interval '2 hours', true);`),
      /violates check constraint/,
    );
    asService(`INSERT INTO public.layover_presence (session_id, user_id, intents, available_until, expires_at)
               VALUES ('${SB}', '${B}', ARRAY['food'], now() + interval '2 hours', now() + interval '2 hours');`);
    assert.equal(scalar(`SELECT count(*) FROM public.layover_presence WHERE session_id = '${SB}';`), "1");
  });

  it("B6. closing a session takes its stops and presence with it (0127 / 3900 ON DELETE CASCADE)", () => {
    const S = randomUUID();
    exec(`
      INSERT INTO public.layover_sessions (id, user_id, arrival_time, departure_time) VALUES ('${S}', '${B}', now(), now() + interval '6 hours');
      INSERT INTO public.layover_plan_stops (session_id, title) VALUES ('${S}', 'gone');
      INSERT INTO public.layover_presence (session_id, user_id, intents, available_until, expires_at)
        VALUES ('${S}', '${B}', ARRAY['culture'], now() + interval '2 hours', now() + interval '2 hours');
      DELETE FROM public.layover_sessions WHERE id = '${S}';
    `);
    for (const t of ["layover_plan_stops", "layover_presence"]) {
      assert.equal(scalar(`SELECT count(*) FROM public.${t} WHERE session_id = '${S}';`), "0", t);
    }
  });

  it("B7. 3621: a pseudonymised event outlives its session, unnamed; a pseudonym beside a user, or past 12 months, is refused", () => {
    const S = randomUUID();
    const E = randomUUID();
    const P = randomUUID();
    exec(`
      INSERT INTO public.layover_sessions (id, user_id, arrival_time, departure_time) VALUES ('${S}', '${B}', now(), now() + interval '6 hours');
      INSERT INTO public.layover_events (id, session_id, user_id, event_type, metadata) VALUES ('${E}', '${S}', '${B}', 'session_created', '{"city":"x"}');
    `);
    assert.throws(
      () => exec(`UPDATE public.layover_events SET erasure_pseudonym = '${P}', pseudonymised_at = now(), retain_until = now() + interval '30 days' WHERE id = '${E}';`),
      /layover_events_identity_or_pseudonym/,
      "a pseudonym next to a user id",
    );
    assert.throws(
      () => exec(`UPDATE public.layover_events SET user_id = NULL, session_id = NULL, erasure_pseudonym = '${P}', pseudonymised_at = now(), retain_until = now() + interval '13 months' WHERE id = '${E}';`),
      /layover_events_identity_or_pseudonym/,
      "kept past 12 months",
    );
    exec(`
      UPDATE public.layover_events SET user_id = NULL, session_id = NULL, erasure_pseudonym = '${P}', pseudonymised_at = now(),
             retain_until = now() + interval '365 days', metadata = '{}'::jsonb WHERE id = '${E}';
      DELETE FROM public.layover_sessions WHERE id = '${S}';
    `);
    assert.deepEqual(
      rows(`SELECT user_id, session_id, erasure_pseudonym FROM public.layover_events WHERE id = '${E}'`),
      [{ user_id: null, session_id: null, erasure_pseudonym: P }],
    );
    assert.equal(scalar(`SELECT confdeltype FROM pg_constraint WHERE conname = 'layover_events_session_id_fkey';`), "n");
    exec(`DELETE FROM public.layover_events WHERE id = '${E}';`);
  });
});
