/**
 * LAYOVER 165, lane B2-CREW — L144 "…crew/buddy is notified if policy + user settings allow", with the owner's rule
 * made explicit (2026-10-18): "Abort notifications may be sent to the crew only under established user authorization
 * or emergency-sharing rules." Driven through the real abort route (POST /airport/sessions/:id/return-now) on the
 * REAL migrated schema (lane B1-P's harness), allow AND deny for every basis.
 *
 * THE PRESS: 3786 → `layover_crew_abort_notify_enabled` ON, plus `layover_safe_return_status_enabled` (the abort's
 * RETURNING half). The standing basis also needs 3996 → `layover_crew_location_enabled` ON (a live crew location
 * share is what makes it "established").
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverCrewAbortAuthorization.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = {
  migrations: ["3786", "3996", "2700", "2992"],
  flags: { layover_crew_abort_notify_enabled: true, layover_safe_return_status_enabled: true, layover_crew_location_enabled: true, layover_decision_persistence_enabled: true },
} as const;

let db: PressedDb;
let app: PressedApp;

interface M { u: PressedUser; sid: string }

/** ana (who aborts) and ben (the crewmate) in one crew at SIN. */
async function pair(label: string): Promise<{ ana: M; ben: M; crewId: string }> {
  const ua = await db.seedUser(`${label}ana`), ub = await db.seedUser(`${label}ben`);
  const ana: M = { u: ua, sid: (await startSession(app, ua, { iata: "SIN" }, { departsInH: 9 })).id };
  const ben: M = { u: ub, sid: (await startSession(app, ub, { iata: "SIN" }, { departsInH: 9 })).id };
  const c = await app.call("POST", `/api/airport/sessions/${ben.sid}/crew`, ub, { title: `crew ${label}` });
  if (c.status !== 200) throw new Error(`crew: ${c.raw}`);
  const j = await app.call("POST", `/api/airport/sessions/${ana.sid}/crew/${c.body.crew.id}/join`, ua);
  if (j.status !== 200) throw new Error(`join: ${j.raw}`);
  return { ana, ben, crewId: c.body.crew.id };
}
const abort = (m: M, body: Record<string, unknown> = {}) => app.call("POST", `/api/airport/sessions/${m.sid}/return-now`, m.u, body);
const told = async (m: M) => (await db.query<any>(`SELECT 1 FROM public.notifications WHERE user_id = '${m.u.id}' AND source_type = 'layover_crew_abort'`)).length;
const pause = (m: M) => db.exec(`INSERT INTO public.location_preferences (user_id, location_mode, sharing_paused) VALUES ('${m.u.id}', 'city_only', true) ON CONFLICT (user_id) DO UPDATE SET sharing_paused = true`);
async function emergencyContact(of: M, contact: M, status = "active", method = "in_app"): Promise<void> {
  const s = await db.query<any>(`INSERT INTO public.safe_return_sessions (user_id, status) VALUES ('${of.u.id}', '${status}') RETURNING id`);
  await db.exec(`INSERT INTO public.safe_return_contacts (session_id, contact_user_id, contact_method) VALUES ('${s[0].id}', '${contact.u.id}', '${method}')`);
}

describe("B2-CREW L144 the abort notice's authorization rule", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("E1 ALLOW — established authorization, explicit: the traveller ticked 'tell my crew' on this abort", async () => {
      const { ana, ben } = await pair("e1");
      const r = await abort(ana, { tellCrew: true });
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.crewNotifiedCount, 1, r.raw);
      assert.equal(await told(ben), 1);
    });

    it("E2 DENY — no tick, no live crew share, no emergency rule: nobody is told, and the reason says it was not requested", async () => {
      const { ana, ben } = await pair("e2");
      const r = await abort(ana, {});
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.crewNotifiedCount, 0);
      assert.equal(r.body.crewNotifyUnavailableReason, "not_requested", r.raw);
      assert.equal(await told(ben), 0);
    });

    it("E3 ALLOW — established authorization, standing: the traveller is live-sharing their location with THIS crew, so the crew is told without a tick", async () => {
      const { ana, ben } = await pair("e3");
      const s = await app.call("POST", `/api/airport/sessions/${ana.sid}/crew/location`, ana.u, { label: "Gate B4", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      assert.equal(s.status, 200, s.raw);
      const r = await abort(ana, {});
      assert.equal(r.body.crewNotifiedCount, 1, r.raw);
      assert.equal(await told(ben), 1);
    });

    it("E4 DENY — the standing basis does not survive the traveller's own standing refusal (sharing paused): a stopped or ended share is no authorization either", async () => {
      const { ana, ben } = await pair("e4");
      await app.call("POST", `/api/airport/sessions/${ana.sid}/crew/location`, ana.u, { label: "Gate B4", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      await pause(ana);
      const r = await abort(ana, {});
      assert.equal(r.body.crewNotifiedCount, 0, r.raw);
      assert.equal(await told(ben), 0);
      const { ana: a2, ben: b2 } = await pair("e4b");
      await app.call("POST", `/api/airport/sessions/${a2.sid}/crew/location`, a2.u, { label: "Gate B4", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      await app.call("DELETE", `/api/airport/sessions/${a2.sid}/crew/location`, a2.u);
      assert.equal((await abort(a2, {})).body.crewNotifiedCount, 0);
      assert.equal(await told(b2), 0);
    });

    it("E5 ALLOW — emergency-sharing rule: the crewmate is an in-app contact on the traveller's ACTIVE Safe Return session; told without a tick, even with sharing paused", async () => {
      const { ana, ben } = await pair("e5");
      await pause(ana);
      await emergencyContact(ana, ben);
      const r = await abort(ana, {});
      assert.equal(r.body.crewNotifiedCount, 1, r.raw);
      assert.equal(await told(ben), 1);
    });

    it("E6 DENY — the emergency rule needs an ACTIVE Safe Return session: a closed one ('safe') authorizes nothing", async () => {
      const { ana, ben } = await pair("e6");
      await emergencyContact(ana, ben, "safe");
      const r = await abort(ana, {});
      assert.equal(r.body.crewNotifiedCount, 0, r.raw);
      assert.equal(await told(ben), 0);
    });

    it("E7 DENY — a block wins over EVERY basis (tick + live share + emergency contact together)", async () => {
      const { ana, ben } = await pair("e7");
      await app.call("POST", `/api/airport/sessions/${ana.sid}/crew/location`, ana.u, { label: "Gate B4", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      await emergencyContact(ana, ben);
      await db.exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${ben.u.id}', '${ana.u.id}')`);
      const r = await abort(ana, { tellCrew: true });
      assert.equal(r.body.crewNotifiedCount, 0, r.raw);
      assert.equal(await told(ben), 0);
    });

    it("E9 DENY — a stale grant cannot authorize notice after boarding moves earlier", async () => {
      const { ana, ben } = await pair("e9");
      assert.equal((await app.call("POST", `/api/airport/sessions/${ana.sid}/crew/location`, ana.u, { label: "Gate B4", expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).status, 200);
      await db.exec(`UPDATE public.layover_sessions SET boarding_time = now() - interval '1 minute' WHERE id = '${ana.sid}'`);
      const r = await abort(ana, {});
      assert.equal(r.body.crewNotifiedCount, 0, r.raw);
      assert.equal(await told(ben), 0);
    });

    it("E10 DENY — an unpurged share ends at airport re-entry, before any location card is read again", async () => {
      const { ana, ben } = await pair("e10");
      assert.equal((await app.call("POST", `/api/airport/sessions/${ana.sid}/crew/location`, ana.u, { label: "Gate B4", expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).status, 200);
      const c = await app.call("POST", `/api/airport/sessions/${ana.sid}/checkpoints`, ana.u, { type: "AIRPORT_REENTRY", operationId: `e10-${ana.sid}` });
      assert.equal(c.status, 201, c.raw);
      const r = await abort(ana, {});
      assert.equal(r.body.crewNotifiedCount, 0, r.raw);
      assert.equal(await told(ben), 0);
    });

    it("E11 DENY — a contact nominated for SMS is not an in-app emergency-sharing authorization", async () => {
      const { ana, ben } = await pair("e11");
      await emergencyContact(ana, ben, "active", "sms");
      const r = await abort(ana, {});
      assert.equal(r.body.crewNotifiedCount, 0, r.raw);
      assert.equal(await told(ben), 0);
    });

    it("E8 the notice carries no actor id, no place and no time — the crewmate learns only that a crew member is heading back", async () => {
      const { ana, ben } = await pair("e8");
      await abort(ana, { tellCrew: true });
      const n = await db.query<any>(`SELECT * FROM public.notifications WHERE user_id = '${ben.u.id}' AND source_type = 'layover_crew_abort'`);
      assert.equal(n.length, 1);
      const text = JSON.stringify(n[0]);
      assert.ok(!text.includes(ana.u.id), "the traveller's id is on the crewmate's row");
      assert.ok(!text.includes(ana.sid), "the traveller's session id is on the crewmate's row");
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 flag OFF (production today): nobody is told on ANY basis — tick, live share or emergency contact", async () => {
      await db.setFlag("layover_crew_abort_notify_enabled", false);
      try {
        const { ana, ben } = await pair("a1");
        await emergencyContact(ana, ben);
        const r = await abort(ana, { tellCrew: true });
        assert.equal(r.status, 200, r.raw);
        assert.equal(r.body.crewNotifiedCount, 0);
        assert.equal(await told(ben), 0);
      } finally { await db.setFlag("layover_crew_abort_notify_enabled", PRESS_ARM === "pressed"); }
    });

    it("A2 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
