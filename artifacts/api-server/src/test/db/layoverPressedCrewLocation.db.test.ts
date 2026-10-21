/**
 * Lane B1-P — crew location sharing (triage press P6), PRESSED, against the
 * real migrated schema.
 *
 * Row: L137 — "Crew location sharing expires on dissolution, re-entry,
 * boarding, session expiry or revocation." Every terminator is driven through
 * the real routes (routes/layoverCrewLocation.ts, routes/airport.ts) over the
 * real grant store and its triggers (3996).
 *
 * THE PRESS: 3996 (addendum-3996-3999, step 297) → `layover_crew_location_enabled`
 * ON. RE-ENTRY additionally needs the traveller's checkpoint to be readable,
 * i.e. 2700 → 2992 + `layover_decision_persistence_enabled` (with persistence
 * OFF a re-entry is unknowable and the share runs to its other terminators —
 * case K3 states it).
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedCrewLocation.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = {
  migrations: ["3996", "2700", "2992"],
  flags: { layover_crew_location_enabled: true, layover_decision_persistence_enabled: true },
} as const;

let db: PressedDb;
let app: PressedApp;
let seeded: boolean | "absent" = "absent";

interface Member { u: PressedUser; sid: string }
const locPath = (m: Member) => `/api/airport/sessions/${m.sid}/crew/location`;
const share = (m: Member, minutes = 60) => app.call("POST", locPath(m), m.u, { label: "By gate B4", expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() });
const view = (m: Member) => app.call("GET", locPath(m), m.u);
const grants = (m: Member) => db.query<any>(`SELECT * FROM public.layover_crew_location_grants WHERE user_id = '${m.u.id}'`);

/** Two travellers at SIN in one crew. `boardingInH` sets the sharer's boarding time. */
async function crewOfTwo(label: string, boardingInH?: number): Promise<{ a: Member; b: Member; crewId: string }> {
  const ua = await db.seedUser(`${label}a`), ub = await db.seedUser(`${label}b`);
  const now = Date.now();
  const over = boardingInH === undefined ? {} : { boardingTime: new Date(now + boardingInH * 3_600_000).toISOString() };
  const a: Member = { u: ua, sid: (await startSession(app, ua, { iata: "SIN", ...over }, { departsInH: 9 })).id };
  const b: Member = { u: ub, sid: (await startSession(app, ub, { iata: "SIN" }, { departsInH: 9 })).id };
  // b founds the crew (no boarding time of its own), a joins: a's boarding then binds only a's share
  const c = await app.call("POST", `/api/airport/sessions/${b.sid}/crew`, ub, { title: `crew ${label}` });
  if (c.status !== 200) throw new Error(`crew: ${c.raw}`);
  const j = await app.call("POST", `/api/airport/sessions/${a.sid}/crew/${c.body.crew.id}/join`, ua);
  if (j.status !== 200) throw new Error(`join: ${j.raw}`);
  return { a, b, crewId: c.body.crew.id };
}
const seesShareOf = async (viewer: Member, sharer: Member) => {
  const r = await view(viewer);
  if (r.status !== 200) throw new Error(`view: ${r.raw}`);
  return (r.body.crewmates ?? []).some((c: any) => c.userId === sharer.u.id);
};

describe("B1-P crew location (P6)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    seeded = await db.flag("layover_crew_location_enabled");
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("K0 the press: 3996 seeds layover_crew_location_enabled FALSE", () => { assert.equal(seeded, false); });

    it("K1 L137 revocation — a share the crewmate sees ends the moment its owner stops it", async () => {
      const { a, b } = await crewOfTwo("rev");
      const s = await share(a);
      assert.equal(s.status, 200, s.raw);
      assert.equal((await grants(a)).length, 1);
      assert.equal(await seesShareOf(b, a), true, "the crewmate does not see the live share");
      const d = await app.call("DELETE", locPath(a), a.u);
      assert.equal(d.status, 200, d.raw);
      assert.equal(d.body.stopped, 1);
      assert.equal((await grants(a)).length, 0);
      assert.equal(await seesShareOf(b, a), false);
    });

    it("K2 L137 dissolution — leaving the crew ends the share (3996's member-left trigger deletes the grant)", async () => {
      const { a, b } = await crewOfTwo("dis");
      assert.equal((await share(a)).status, 200);
      const l = await app.call("POST", `/api/airport/sessions/${a.sid}/crew/leave`, a.u);
      assert.equal(l.status, 200, l.raw);
      assert.equal((await grants(a)).length, 0, "the grant outlived the membership");
      assert.equal(await seesShareOf(b, a), false);
    });

    it("K3 L137 re-entry — the sharer's AIRPORT_REENTRY checkpoint ends the share (needs 2992 + persistence: the checkpoint must be readable)", async () => {
      const { a, b } = await crewOfTwo("reent");
      assert.equal((await share(a)).status, 200);
      assert.equal(await seesShareOf(b, a), true);
      const c = await app.call("POST", `/api/airport/sessions/${a.sid}/checkpoints`, a.u, { type: "AIRPORT_REENTRY", operationId: `op-${randomUUID()}` });
      assert.equal(c.status, 201, c.raw);
      assert.equal(await seesShareOf(b, a), false, "a share outlived its owner's re-entry");
      assert.equal((await grants(a)).length, 0, "the ended share was not purged");
    });

    it("K4 L137 boarding — a share asked to run past boarding is cut at the sharer's boarding time", async () => {
      const { a } = await crewOfTwo("board", 2);
      const s = await share(a, 180);
      assert.equal(s.status, 200, s.raw);
      assert.equal(s.body.endsBecause, "boarding");
      const g = await grants(a);
      const boarding = await db.query<any>(`SELECT boarding_time FROM public.layover_sessions WHERE id = '${a.sid}'`);
      assert.ok(Date.parse(g[0].expires_at) <= Date.parse(boarding[0].boarding_time), "the stored share runs past boarding");
    });

    it("K5 L137 session expiry — ending the layover ends the share", async () => {
      const { a, b } = await crewOfTwo("end");
      assert.equal((await share(a)).status, 200);
      const e = await app.call("DELETE", `/api/airport/sessions/${a.sid}`, a.u, { outcome: "completed" });
      assert.equal(e.status, 200, e.raw);
      assert.equal(await seesShareOf(b, a), false, "a share outlived the session");
    });

    it("K6 L137 TTL — a share past its own expiry is not shown and is purged", async () => {
      const { a, b } = await crewOfTwo("ttl");
      assert.equal((await share(a, 30)).status, 200);
      await db.exec(`UPDATE public.layover_crew_location_grants SET granted_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE user_id = '${a.u.id}'`);
      assert.equal(await seesShareOf(b, a), false);
      assert.equal((await grants(a)).length, 0);
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 flag OFF → GET says unavailable, POST refuses 404, and DELETE still runs (a switch never strands a share)", async () => {
      await db.setFlag("layover_crew_location_enabled", true);
      const { a } = await crewOfTwo("off");
      if (PRESS_ARM !== "absent") assert.equal((await share(a)).status, 200);
      await db.setFlag("layover_crew_location_enabled", false);
      try {
        assert.equal((await view(a)).body.available, false);
        assert.equal((await share(a)).status, 404);
        const d = await app.call("DELETE", locPath(a), a.u);
        if (PRESS_ARM !== "absent") { assert.equal(d.status, 200, d.raw); assert.equal((await grants(a)).length, 0); }
      } finally { await db.setFlag("layover_crew_location_enabled", PRESS_ARM === "pressed"); }
    });

    it("A2 no client role can read or write the grant store (service-role only)", async () => {
      const u = await db.seedUser("nosy");
      // 42501 on the pressed chain; 42P01 where 3996 is absent (nothing to read either way)
      await assert.rejects(db.asUser(u.id, "SELECT * FROM public.layover_crew_location_grants"), (e: any) => e?.code === "42501" || e?.code === "42P01");
    });

    it("A3 owner-scoped: a stranger cannot share or stop sharing through someone else's session", async () => {
      await db.setFlag("layover_crew_location_enabled", PRESS_ARM === "pressed");
      const { a } = await crewOfTwo("own");
      const x = await db.seedUser("stranger");
      assert.equal((await app.call("POST", locPath(a), x, { label: "x", expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).status, 404);
      assert.equal((await app.call("DELETE", locPath(a), x)).status, 404);
    });

    it("A4 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
