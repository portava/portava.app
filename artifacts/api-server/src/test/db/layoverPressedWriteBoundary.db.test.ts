/**
 * Lane B1-P — the client write boundary (triage press P12), PRESSED, against
 * the real migrated schema.
 *
 * Rows: L200 ("Users may read/write their own session inputs within allowed
 * fields") and L199 ("Migration postconditions and authorization-contract tests
 * for every client-writable table").
 *
 * THE PRESS: apply 3620 (owner decision L199-b). No flag. Applied nowhere today,
 * so production holds 0127's full client DML on layover_sessions,
 * layover_plan_stops, layover_events and airport_profiles. B1P_ARM=absent (the
 * chain without 3620) reproduces that hole and turns the PRESSED cases red; the
 * flag-off arm is identical to pressed (there is no flag).
 *
 * The client path is the REAL supabase-js client running as `authenticated`
 * with the traveller's `sub` (RLS and grants apply), as the mobile app's
 * PostgREST client would; the allowed path is the API route.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedWriteBoundary.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = { migrations: ["3620"], flags: {} } as const;
const TABLES = ["layover_sessions", "layover_plan_stops", "layover_events", "airport_profiles"] as const;

let db: PressedDb;
let app: PressedApp;
let ana: PressedUser, bob: PressedUser;
let sid = "";
const sessionRow = async () => (await db.query<any>(`SELECT * FROM public.layover_sessions WHERE id = '${sid}'`))[0];

describe("B1-P client write boundary (P12)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    ana = await db.seedUser("ana");
    bob = await db.seedUser("bob");
    sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("W1 L200 — a traveller's own PostgREST client cannot write their session around the routes: status, reminder and sharing are refused", async () => {
      const c = db.userClient(ana.id);
      for (const patch of [{ status: "completed" }, { return_reminder_at: new Date().toISOString() }, { share_city_status: true }]) {
        const r = await c.from("layover_sessions").update(patch).eq("id", sid).select("id");
        assert.ok(r.error, `the client wrote ${JSON.stringify(patch)} straight through PostgREST`);
        assert.equal(r.error.code, "42501", JSON.stringify(r.error));
      }
      const row = await sessionRow();
      assert.equal(row.status, "active");
      assert.equal(row.share_city_status, false);
    });

    it("W2 L200 — nor insert or delete plan stops, events or airport profiles", async () => {
      const c = db.userClient(ana.id);
      const ins = await c.from("layover_plan_stops").insert({ session_id: sid, title: "sneaky", stop_order: 0, duration_min: 30, travel_min: 0, inside_airport: true });
      assert.equal(ins.error?.code, "42501", JSON.stringify(ins.error));
      const ev = await c.from("layover_events").insert({ session_id: sid, user_id: ana.id, event_type: "session_updated", metadata: {} });
      assert.equal(ev.error?.code, "42501", JSON.stringify(ev.error));
      const del = await c.from("layover_sessions").delete().eq("id", sid);
      assert.equal(del.error?.code, "42501", JSON.stringify(del.error));
      assert.ok(await sessionRow(), "the client deleted its session around the route");
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 L200 — the ALLOWED path: the route accepts the traveller's own inputs and ignores fields that are not inputs", async () => {
      const dep = new Date(Date.now() + 8 * 3_600_000).toISOString();
      const r = await app.call("PATCH", `/api/airport/sessions/${sid}`, ana, { departureTime: dep, status: "completed", userId: bob.id, user_id: bob.id });
      assert.equal(r.status, 200, r.raw);
      const row = await sessionRow();
      assert.ok(Math.abs(Date.parse(row.departure_time) - Date.parse(dep)) < 1000, `an allowed input was not written: ${row.departure_time} vs ${dep}`);
      assert.equal(row.status, "active", "a non-input field was accepted by the route");
      assert.equal(row.user_id, ana.id);
    });

    it("A2 L200 — reads stay owner-scoped: the traveller reads their session, another traveller reads nothing", async () => {
      assert.equal((await db.userClient(ana.id).from("layover_sessions").select("id").eq("id", sid)).data?.length, 1);
      assert.equal((await db.userClient(bob.id).from("layover_sessions").select("id").eq("id", sid)).data?.length, 0);
      assert.equal((await app.call("PATCH", `/api/airport/sessions/${sid}`, bob, { departureTime: new Date(Date.now() + 7 * 3_600_000).toISOString() })).status, 404);
    });

    it("A3 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });

  describe(`PRESSED [${PRESS_ARM}] — L199 the authorization contract on the chain`, () => {
    it("W3 L199 — for every client-writable layover table: authenticated SELECT only, anon nothing, service_role full DML", async () => {
      for (const t of TABLES) {
        const p = (await db.query<any>(`SELECT
            has_table_privilege('authenticated', 'public.${t}', 'SELECT') AS a_sel,
            has_table_privilege('authenticated', 'public.${t}', 'INSERT') OR has_table_privilege('authenticated', 'public.${t}', 'UPDATE') OR has_table_privilege('authenticated', 'public.${t}', 'DELETE') AS a_write,
            has_any_column_privilege('authenticated', 'public.${t}', 'UPDATE') AS a_col,
            has_table_privilege('anon', 'public.${t}', 'SELECT') OR has_table_privilege('anon', 'public.${t}', 'INSERT') AS anon_any,
            has_table_privilege('service_role', 'public.${t}', 'UPDATE') AS svc`))[0];
        assert.deepEqual(p, { a_sel: true, a_write: false, a_col: false, anon_any: false, svc: true }, `${t}: ${JSON.stringify(p)}`);
      }
    });

    it("W4 L199 — 3620's own postconditions, re-run standalone on the chain, hold", async () => {
      const sql = readFileSync(new URL("../../migrations/3620_layover_client_write_boundary.sql", import.meta.url), "utf8");
      const post = /DO \$post\$[\s\S]*?\$post\$;/.exec(sql)?.[0];
      assert.ok(post, "no $post$ block");
      await db.exec(post!);
    });
  });
});
