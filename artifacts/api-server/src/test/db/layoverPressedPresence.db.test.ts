/**
 * Lane B1-P — presence (triage press P5) and the §26 index families, PRESSED,
 * against the real migrated schema.
 *
 * Rows: L127, L128 (2740 → layover_presence_ladder_enabled), L187 (3900 →
 * layover_presence_intents_enabled, with the ladder), L196 (3900's restrictive
 * table + the expiry sweep, lib/layoverPresenceExpiryScheduler.ts), L198 (the
 * five index families: active-session lookup, session event ordering, unexpired
 * presence 3900, snapshot versioning 3623, impacted-session fan-out 2986).
 *
 * THE PRESS (this file): 2740 → 2986 → 2700 → 2992 → 3623 → 3900, then
 * `layover_presence_ladder_enabled` and `layover_presence_intents_enabled` ON
 * (2740 and 3900 seed them FALSE).
 *
 * Falsified by B1P_ARM=flag-off and B1P_ARM=absent.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedPresence.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { runLayoverPresenceExpirySweep } from "../../lib/layoverPresenceExpiryScheduler.js";
import { _resetIntentCountSnapshots } from "../../services/layover/LayoverPresenceStore.js";

const PRESS = {
  migrations: ["2740", "2986", "2700", "2992", "3623", "3900"],
  flags: { layover_presence_ladder_enabled: true, layover_presence_intents_enabled: true },
} as const;

let db: PressedDb;
let app: PressedApp;
const sin: Array<{ u: PressedUser; sid: string }> = [];
const bkk: Array<{ u: PressedUser; sid: string }> = [];
const seeds: Record<string, boolean | "absent"> = {};

async function sharer(label: string, iata: string): Promise<{ u: PressedUser; sid: string }> {
  const u = await db.seedUser(label);
  const sid = (await startSession(app, u, { iata }, { departsInH: 10 })).id;
  const r = await app.call("PATCH", `/api/airport/sessions/${sid}/share`, u, { enabled: true });
  if (r.status !== 200) throw new Error(`share: ${r.raw}`);
  return { u, sid };
}

describe("B1-P presence and indexes (P5)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    for (const f of Object.keys(PRESS.flags)) seeds[f] = await db.flag(f);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    _resetIntentCountSnapshots();
    for (let i = 0; i < 6; i++) sin.push(await sharer(`sin${i}`, "SIN"));
    for (let i = 0; i < 3; i++) bkk.push(await sharer(`bkk${i}`, "BKK"));
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("Q0 the press: 2740 and 3900 seed both flags FALSE", () => {
      for (const f of Object.keys(PRESS.flags)) assert.equal(seeds[f], false, `${f} = ${String(seeds[f])}`);
    });

    it("Q1 L128 L127 — L0 aggregate is the DEFAULT: '6 travellers connecting here', and nobody is named", async () => {
      const r = await app.call("GET", `/api/airport/sessions/${sin[0]!.sid}/presence`, sin[0]!.u);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.level, "L0_AGGREGATE", r.raw);
      assert.equal(r.body.count, 6, `count: ${r.raw}`);
      assert.deepEqual(r.body.travelers, [], "identity is not disclosed at L0");
      for (const s of sin) assert.ok(!r.raw.includes(s.u.id) && !r.raw.includes(s.u.handle), "a traveller's identity reached the aggregate rung");
      const o = await app.call("GET", `/api/airport/sessions/${sin[1]!.sid}/overview`, sin[1]!.u);
      assert.equal(o.body.share.othersInCity, 6, "the overview's count is the same door");
    });

    it("Q2 L128 — below k the aggregate is withheld, never a small number that names someone", async () => {
      const r = await app.call("GET", `/api/airport/sessions/${bkk[0]!.sid}/presence`, bkk[0]!.u);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.count, null);
      assert.equal(r.body.countWithheld, "below_k");
      assert.deepEqual(r.body.travelers, []);
    });

    it("Q3 L127 — consent on BOTH sides: a traveller who has not opted in sees no count; one who paused sharing is not counted", async () => {
      const x = await db.seedUser("notsharing");
      const sid = (await startSession(app, x, { iata: "SIN" }, { departsInH: 9 })).id;
      const r = await app.call("GET", `/api/airport/sessions/${sid}/presence`, x);
      assert.equal(r.body.sharing, false);
      assert.equal(r.body.count, 0);
      assert.deepEqual(r.body.travelers, []);
    });

    it("Q4 L187 — updatePresence(sessionId, input): the traveller's intents are stored in layover_presence and read back", async () => {
      const { u, sid } = sin[2]!;
      const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
      const p = await app.call("PUT", `/api/airport/sessions/${sid}/presence/intents`, u, { intents: ["food", "culture"], availableUntil: until, maxTravelMinutes: 30 });
      assert.equal(p.status, 200, p.raw);
      const rows = await db.query<any>(`SELECT * FROM public.layover_presence WHERE session_id = '${sid}'`);
      assert.equal(rows.length, 1);
      assert.deepEqual([...rows[0].intents].sort(), ["culture", "food"]);
      assert.equal(rows[0].precise_location_enabled, false, "precise location is never stored here");
      const g = await app.call("GET", `/api/airport/sessions/${sid}/presence/intents`, u);
      assert.equal(g.status, 200, g.raw);
      assert.equal(g.body.available, true);
      assert.deepEqual([...g.body.own.intents].sort(), ["culture", "food"]);
      const again = await app.call("PUT", `/api/airport/sessions/${sid}/presence/intents`, u, { intents: ["meetups"], availableUntil: until, maxTravelMinutes: 30 });
      assert.equal(again.status, 200, again.raw);
      const after = await db.query<any>(`SELECT intents FROM public.layover_presence WHERE session_id = '${sid}'`);
      assert.equal(after.length, 1, "one record per session (upsert on session_id)");
      assert.deepEqual(after[0].intents, ["meetups"]);
      const bad = await app.call("PUT", `/api/airport/sessions/${sid}/presence/intents`, u, { intents: ["food"], availableUntil: new Date(Date.now() + 48 * 3_600_000).toISOString() });
      assert.equal(bad.status, 400, "open after the flight leaves is refused");
    });

    it("Q5 L196 — restrictive policies: no client can read or write layover_presence; expired records are swept", async () => {
      const { u, sid } = sin[3]!;
      await assert.rejects(db.asUser(u.id, `SELECT * FROM public.layover_presence`), (e: any) => e?.code === "42501", "authenticated must have no privilege on layover_presence");
      const s4 = sin[4]!;
      await db.exec(`INSERT INTO public.layover_presence (session_id, user_id, intents, available_from, available_until, expires_at) VALUES ('${sid}', '${u.id}', '{food}', now() - interval '3 hours', now() - interval '1 hour', now() - interval '1 hour')`);
      await db.exec(`INSERT INTO public.layover_presence (session_id, user_id, intents, available_from, available_until, expires_at) VALUES ('${s4.sid}', '${s4.u.id}', '{food}', now(), now() + interval '2 hours', now() + interval '2 hours')`);
      await db.setFlag("layover_presence_expiry_enabled", true); const r = await runLayoverPresenceExpirySweep({ client: db.client, now: new Date() }); // 3952: the owner's press, ON for this case
      assert.equal(r.outcome, "swept", JSON.stringify(r));
      assert.ok(r.deleted >= 1);
      assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_presence WHERE session_id = '${sid}'`)).length, 0, "the expired record survived the sweep");
      assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_presence WHERE session_id = '${s4.sid}'`)).length, 1, "a live record was swept");
    });

    it("Q6 L198 — the five index families exist on the pressed chain and the planner can serve each read the code issues from them", async () => {
      const idx = await db.query<any>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
      const has = (n: string) => idx.some((r) => r.indexname === n);
      const families: Array<[string, string, string]> = [
        ["active-session lookup", "layover_sessions_user_status_idx", `SELECT id FROM public.layover_sessions WHERE user_id = '00000000-0000-0000-0000-000000000001' AND status = 'active'`],
        ["session event ordering", "layover_events_session_idx", `SELECT id FROM public.layover_events WHERE session_id = '00000000-0000-0000-0000-000000000001' ORDER BY created_at DESC`],
        ["unexpired presence (3900)", "layover_presence_expiry_idx", `SELECT session_id FROM public.layover_presence WHERE expires_at <= now() ORDER BY expires_at LIMIT 100`],
        ["snapshot versioning (3623)", "layover_certcomp_session_version_uidx", `SELECT snapshot_version FROM public.layover_certified_computations WHERE session_id = '00000000-0000-0000-0000-000000000001' AND snapshot_version IS NOT NULL ORDER BY snapshot_version DESC LIMIT 1`],
        ["impacted-session fan-out (2986)", "layover_sessions_airport_active_idx", `SELECT id FROM public.layover_sessions WHERE status = 'active' AND airport_id IS NOT NULL AND airport_id = '00000000-0000-0000-0000-000000000001'`],
      ];
      for (const [family, name, sql] of families) {
        assert.ok(has(name), `${family}: ${name} is not on the chain`);
        const plan = await db.explain(sql);
        assert.ok(plan.includes(name), `${family}: the planner did not use ${name}: ${plan.slice(0, 300)}`);
      }
      assert.ok(has("layover_sessions_manual_iata_active_idx"), "2986's second fan-out axis");
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 ladder OFF → the L2 roster is what is shown and the count is withheld beside it (today's production behaviour, unchanged)", async () => {
      await db.setFlag("layover_presence_ladder_enabled", false);
      try {
        const r = await app.call("GET", `/api/airport/sessions/${sin[0]!.sid}/presence`, sin[0]!.u);
        assert.equal(r.status, 200, r.raw);
        assert.equal(r.body.level, "L2_DISCOVERY");
        assert.equal(r.body.count, null);
        assert.equal(r.body.countWithheld, "roster_visible");
      } finally { await db.setFlag("layover_presence_ladder_enabled", PRESS_ARM === "pressed"); }
    });

    it("A2 intents flag OFF → PUT refuses 404 feature_disabled and writes nothing; GET says unavailable", async () => {
      await db.setFlag("layover_presence_intents_enabled", false);
      const { u, sid } = sin[5]!;
      const p = await app.call("PUT", `/api/airport/sessions/${sid}/presence/intents`, u, { intents: ["food"], availableUntil: new Date(Date.now() + 3_600_000).toISOString() });
      assert.equal(p.status, 404, p.raw);
      const g = await app.call("GET", `/api/airport/sessions/${sid}/presence/intents`, u);
      assert.equal(g.body.available, false);
      if (await db.hasTable("layover_presence")) assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_presence WHERE session_id = '${sid}'`)).length, 0);
    });

    it("A3 owner-scoped: another traveller cannot set or read intents on this session", async () => {
      const r = await app.call("PUT", `/api/airport/sessions/${sin[0]!.sid}/presence/intents`, sin[1]!.u, { intents: ["food"], availableUntil: new Date(Date.now() + 3_600_000).toISOString() });
      assert.equal(r.status, 404);
      assert.equal((await app.call("GET", `/api/airport/sessions/${sin[0]!.sid}/presence`, sin[1]!.u)).status, 404);
    });

    // Defined in the migration-absent arm only (a skip would be counted, and run-tests.sh refuses skips).
    if (PRESS_ARM === "absent") it("A4 the sweep on a chain WITHOUT 3900 refuses (table_absent) instead of reporting 0 deleted", async () => {
      assert.equal(await db.hasTable("layover_presence"), false);
      await db.setFlag("layover_presence_expiry_enabled", true); const r = await runLayoverPresenceExpirySweep({ client: db.client, now: new Date() }); // 3952: the owner's press, ON for this case
      assert.equal(r.outcome, "refused");
    });

    it("A5 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
