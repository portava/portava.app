/**
 * census-layover §84 — 3952 on the full migrated chain (PostgreSQL): deleting expired presence and expired crews is
 * the owner's press, and the crew DELETE re-checks the expiry and counts what it removed.
 *
 *   X0  3952 seeds both flags FALSE.
 *   X1  OFF: an expired presence row and an expired crew (made through the real routes, then aged) survive both sweeps,
 *       and the crew is hidden from the traveller (GET /crew answers no crew).
 *   X2  ON: both are deleted, a live crew stays, and the crew count is the database's.
 *   X3  the rollback refuses while a flag is ON, then removes both rows and its ledger row; 3952 re-applies.
 *
 * Run: LOCAL_DB_URL=… node --import tsx/esm --test src/test/db/layoverPresenceCrewExpiryFlags.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { runLayoverPresenceExpirySweep } from "../../lib/layoverPresenceExpiryScheduler.js";
import { runLayoverCrewExpirySweep } from "../../lib/layoverCrewExpiryScheduler.js";

const FORWARD = readFileSync(new URL("../../migrations/3952_layover_presence_crew_expiry_flags.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../../../../../db/rollback/2026-10-24-3952-layover-presence-crew-expiry-flags-rollback.sql", import.meta.url), "utf8");
const P = "layover_presence_expiry_enabled";
const C = "layover_crew_expiry_enabled";

let db: PressedDb;
let app: PressedApp;
let ana: PressedUser, bo: PressedUser;
const seeded: Record<string, boolean | "absent"> = {};

async function expiredWorld(label: string): Promise<{ sid: string; crewId: string; liveCrewId: string }> {
  ana = await db.seedUser(`expiry_ana_${label}`); bo = await db.seedUser(`expiry_bo_${label}`); // one crew per traveller: fresh people per world
  const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
  await db.exec(`INSERT INTO public.layover_presence (session_id, user_id, intents, available_from, available_until, expires_at) VALUES ('${sid}', '${ana.id}', '{food}', now() - interval '3 hours', now() - interval '1 hour', now() - interval '1 hour')`);
  const c = await app.call("POST", `/api/airport/sessions/${sid}/crew`, ana, { title: `expired ${label}` });
  assert.equal(c.status, 200, c.raw);
  const crewId = c.body.crew.id as string;
  await db.exec(`UPDATE public.layover_crews SET expires_at = now() - interval '1 minute', created_at = now() - interval '13 hours' WHERE id = '${crewId}'`);
  const sidB = (await startSession(app, bo, { iata: "SIN" }, { departsInH: 9 })).id;
  const live = await app.call("POST", `/api/airport/sessions/${sidB}/crew`, bo, { title: `live ${label}` });
  assert.equal(live.status, 200, live.raw);
  return { sid, crewId, liveCrewId: live.body.crew.id as string };
}
const count = async (sql: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`))[0]!.n;

describe("3952 presence and crew expiry flags on the migrated chain", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb();
    seeded[P] = await db.flag(P); seeded[C] = await db.flag(C);
    await productionBaseFlags(db);
    await db.setFlags({ airport_mode_enabled: true, layover_presence_intents_enabled: true });
    app = await startPressedLayoverApp(db);
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("X0 3952 seeds both flags FALSE", () => {
    assert.equal(seeded[P], false);
    assert.equal(seeded[C], false);
  });

  it("X1 OFF: the expired presence row and the expired crew survive both sweeps, and the traveller is shown no crew", async () => {
    await db.setFlags({ [P]: false, [C]: false });
    const w = await expiredWorld("off");
    const p = await runLayoverPresenceExpirySweep({ client: db.client, now: new Date() });
    const c = await runLayoverCrewExpirySweep({ client: db.client, now: new Date() });
    assert.deepEqual([p.reason, c.reason], ["disabled", "disabled"]);
    assert.equal(await count(`public.layover_presence WHERE session_id = '${w.sid}'`), 1);
    assert.equal(await count(`public.layover_crews WHERE id = '${w.crewId}'`), 1);
    const mine = await app.call("GET", `/api/airport/sessions/${w.sid}/crew`, ana);
    assert.equal(mine.status, 200, mine.raw);
    assert.notEqual(mine.body.crew?.id, w.crewId, "an expired crew was served to its member");
  });

  it("X2 ON: both are deleted, the live crew stays, and the crew count is what the database removed", async () => {
    await db.setFlags({ [P]: true, [C]: true });
    const w = await expiredWorld("on");
    const due = await count(`public.layover_crews WHERE expires_at < now()`);
    const p = await runLayoverPresenceExpirySweep({ client: db.client, now: new Date() });
    const c = await runLayoverCrewExpirySweep({ client: db.client, now: new Date() });
    assert.equal(p.outcome, "swept", JSON.stringify(p));
    assert.equal(c.outcome, "swept", JSON.stringify(c));
    assert.equal(c.deleted, due, "the count is the rows the DELETE confirmed");
    assert.equal(await count(`public.layover_presence WHERE session_id = '${w.sid}'`), 0);
    assert.equal(await count(`public.layover_crews WHERE id = '${w.crewId}'`), 0);
    assert.equal(await count(`public.layover_crew_members WHERE crew_id = '${w.crewId}'`), 0, "memberships go with the crew");
    assert.equal(await count(`public.layover_crews WHERE id = '${w.liveCrewId}'`), 1, "a live crew stays");
    await db.setFlags({ [P]: false, [C]: false });
  });

  it("X3 the rollback refuses while a flag is ON, then removes both rows and its ledger row; 3952 re-applies", async () => {
    await db.setFlags({ [P]: false, [C]: false });
    await db.setFlag(C, true);
    await assert.rejects(db.exec(ROLLBACK), /ROLLBACK REFUSED \(3952\): layover_crew_expiry_enabled is TRUE/);
    await db.exec("ROLLBACK");
    await db.setFlag(C, false);
    await db.exec(ROLLBACK);
    assert.deepEqual([await db.flag(P), await db.flag(C)], ["absent", "absent"]);
    assert.equal(await count(`public.schema_migration_ledger WHERE filename = '3952_layover_presence_crew_expiry_flags.sql'`), 0);
    await db.exec(ROLLBACK);
    await db.exec(FORWARD);
    assert.deepEqual([await db.flag(P), await db.flag(C)], [false, false]);
  });
});
