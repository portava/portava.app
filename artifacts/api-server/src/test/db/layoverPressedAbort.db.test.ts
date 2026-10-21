/**
 * Lane B1-P — the one-tap abort (triage presses P11 + P15), PRESSED, against
 * the real migrated schema.
 *
 * Row: L147 — "The abort action cancels optional itinerary state, marks the
 * session RETURNING, surfaces the fastest certified route, notifies crew/buddy
 * flows, preserves the offline route/deadline, and records the transition in
 * the decision ledger."
 *
 * THE PRESS: flip `layover_safe_return_status_enabled` (2741 is applied in
 * production; the flag is FALSE there) → RETURNING; apply 3786 and flip
 * `layover_crew_abort_notify_enabled` → the crew notice. Whether the abort may
 * tell the crew, and how much, is the owner's open ruling R9 / OQ-3: the code's
 * default is proven here, the ruling is not made here.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedAbort.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = {
  migrations: ["3786"],
  flags: { layover_safe_return_status_enabled: true, layover_crew_abort_notify_enabled: true },
} as const;

let db: PressedDb;
let app: PressedApp;
let ana: PressedUser, ben: PressedUser;
let anaSid = "", benSid = "";
let abort: any = null;

describe("B1-P the abort (P11 + P15)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    ana = await db.seedUser("ana");
    ben = await db.seedUser("ben");
    anaSid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    benSid = (await startSession(app, ben, { iata: "SIN" }, { departsInH: 9 })).id;
    const c = await app.call("POST", `/api/airport/sessions/${benSid}/crew`, ben, { title: "abort crew" });
    if (c.status !== 200) throw new Error(c.raw);
    const j = await app.call("POST", `/api/airport/sessions/${anaSid}/crew/${c.body.crew.id}/join`, ana);
    if (j.status !== 200) throw new Error(j.raw);
    // one landside and one airside stop in ana's plan
    for (const s of [
      { title: "Gardens by the Bay", durationMin: 60, travelMin: 30, insideAirport: false },
      { title: "Jewel waterfall", durationMin: 30, insideAirport: true },
    ]) {
      const r = await app.call("POST", `/api/airport/sessions/${anaSid}/stops`, ana, s);
      if (r.status >= 300) throw new Error(`stop: ${r.raw}`);
    }
    const r = await app.call("POST", `/api/airport/sessions/${anaSid}/return-now`, ana, { tellCrew: true });
    abort = r;
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("B1 L147 — the abort answers ok, and the session is RETURNING in the table (2741's status, under its flag)", async () => {
      assert.equal(abort.status, 200, abort.raw);
      assert.equal(abort.body.statusApplied, true);
      assert.equal(abort.body.statusCapability, "enabled");
      assert.ok(abort.body.effects.includes("status_marked_returning"), JSON.stringify(abort.body.effects));
      const row = await db.query<any>(`SELECT status FROM public.layover_sessions WHERE id = '${anaSid}'`);
      assert.equal(row[0].status, "returning");
    });

    it("B2 L147 — optional itinerary state is cancelled (the landside stop), the airport-side stop is kept", async () => {
      assert.equal(abort.body.cancelledStopIds.length, 1);
      const left = await db.query<any>(`SELECT title, inside_airport FROM public.layover_plan_stops WHERE session_id = '${anaSid}'`);
      assert.deepEqual(left.map((s) => s.title), ["Jewel waterfall"]);
    });

    it("B3 L147 — the crew is told (P15), and only the crewmate", async () => {
      assert.equal(abort.body.crewNotifiedCount, 1, `crew notice: ${abort.body.crewNotifyUnavailableReason}`);
      assert.ok(abort.body.effects.includes("crew_notified"));
      const n = await db.query<any>(`SELECT user_id FROM public.notifications WHERE user_id IN ('${ana.id}', '${ben.id}') AND (source_type LIKE 'layover%' OR event_type LIKE 'layover%')`);
      assert.ok(n.some((r) => r.user_id === ben.id), `no notification row for the crewmate: ${JSON.stringify(n)}`);
    });

    it("B4 L147 — the certified return contract (deadline) is surfaced, the transition is in the ledger with its certification, and the offline deadline survives the abort", async () => {
      assert.ok(abort.body.returnContract?.hardReturnTime, JSON.stringify(abort.body.returnContract));
      const ev = await db.query<any>(`SELECT metadata FROM public.layover_events WHERE session_id = '${anaSid}' AND event_type = 'safe_return_aborted'`);
      assert.equal(ev.length, 1);
      assert.equal(ev[0].metadata.statusApplied, true);
      assert.ok(ev[0].metadata.inputHash && ev[0].metadata.engineVersion, "the ledger row carries the certification it acted on");
      const o = await app.call("GET", `/api/airport/sessions/${anaSid}/overview`, ana);
      assert.equal(o.status, 200, `a RETURNING session must still be readable: ${o.raw.slice(0, 300)}`);
      assert.ok(o.body.offlineBundle, "the offline bundle is gone after the abort");
      assert.equal(o.body.session.status, "returning");
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 flags OFF (production today) → nothing marks RETURNING and nobody is told; the stops are still cancelled and the ledger still records the abort", async () => {
      await db.setFlag("layover_safe_return_status_enabled", false);
      await db.setFlag("layover_crew_abort_notify_enabled", false);
      const u = await db.seedUser("cy");
      const s = (await startSession(app, u, { iata: "SIN" }, { departsInH: 9 })).id;
      const r = await app.call("POST", `/api/airport/sessions/${s}/return-now`, u, { tellCrew: true });
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.statusApplied, false);
      assert.equal(r.body.statusCapability, "flag_off");
      assert.equal(r.body.crewNotifiedCount, 0);
      assert.equal((await db.query<any>(`SELECT status FROM public.layover_sessions WHERE id = '${s}'`))[0].status, "active");
      assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_events WHERE session_id = '${s}' AND event_type = 'safe_return_aborted'`)).length, 1);
    });

    it("A2 owner-scoped: a stranger cannot abort someone else's layover", async () => {
      const x = await db.seedUser("stranger");
      assert.equal((await app.call("POST", `/api/airport/sessions/${benSid}/return-now`, x, {})).status, 404);
      assert.equal((await db.query<any>(`SELECT status FROM public.layover_sessions WHERE id = '${benSid}'`))[0].status, "active");
    });

    it("A3 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
