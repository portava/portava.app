/**
 * census-layover L159 on the REAL migrated schema: "Operational checkpoints —
 * short-lived operational + bounded diagnostics" (spec §17).
 *
 * The rows are written the way production writes them — POST
 * /airport/sessions/:id/checkpoints through the real router, 2992's table,
 * `layover_decision_persistence_enabled` ON (production since 2026-10-22) — and
 * the sweep runs with the service client the routes use. It proves:
 *   E1 a check-in past its own `expires_at` is DELETED from 2992's table, and a
 *      live one is kept;
 *   E2 deleting it changes NO answer: GET /checkpoints returns byte-identical
 *      bodies before and after the pass, because the reader already hid it;
 *   E3 the pass is bounded and idempotent: the second pass is `idle`;
 *   E4 retention is not gated on the write flag: with persistence OFF an
 *      expired row is still removed (a flag must not be a way to keep data).
 *
 * Run: LOCAL_DB_URL=… node --import tsx/esm --test src/test/db/layoverCheckpointExpiry.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { runLayoverCheckpointExpirySweep } from "../../lib/layoverCheckpointExpirySweep.js";

const PRESS = {
  migrations: ["2700", "2992"],
  flags: { layover_decision_persistence_enabled: true },
} as const;

let db: PressedDb;
let app: PressedApp;
let ana: PressedUser;

const rowsOf = (sid: string) => db.query<any>(`SELECT id, checkpoint_type, expires_at FROM public.layover_checkpoints WHERE session_id = '${sid}' ORDER BY observed_at`);
const report = (u: PressedUser, sid: string, type: string) =>
  app.call("POST", `/api/airport/sessions/${sid}/checkpoints`, u, { type, operationId: `op-${randomUUID()}` });

describe("L159 checkpoint expiry on the migrated chain", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS, "pressed");
    await productionBaseFlags(db);
    await applyPress(db, PRESS, "pressed");
    app = await startPressedLayoverApp(db);
    ana = await db.seedUser("ana-checkpoints");
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("E1-E3 an expired check-in leaves 2992's table, a live one stays, no answer changes, and a second pass is idle", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 6 })).id;
    const exit = await report(ana, sid, "LANDSIDE_EXIT");
    assert.equal(exit.status, 201, exit.raw);
    const back = await report(ana, sid, "AIRPORT_REENTRY");
    assert.equal(back.status, 201, back.raw);
    const written = await rowsOf(sid);
    assert.equal(written.length, 2, "both check-ins were written by the route");
    // Both rows carry the writer's own bound (departure + 6 h). Age the EXIT row past it, as time would.
    const exitRow = written.find((r) => r.checkpoint_type === "LANDSIDE_EXIT")!;
    await db.exec(`UPDATE public.layover_checkpoints SET expires_at = now() - interval '1 minute' WHERE id = '${exitRow.id}'`);

    const before = await app.call("GET", `/api/airport/sessions/${sid}/checkpoints`, ana);
    assert.equal(before.status, 200, before.raw);

    const pass = await runLayoverCheckpointExpirySweep({ client: db.client, now: new Date() });
    assert.equal(pass.outcome, "swept", JSON.stringify(pass));
    assert.ok(pass.deleted >= 1, JSON.stringify(pass));
    const left = await rowsOf(sid);
    assert.deepEqual(left.map((r) => r.checkpoint_type), ["AIRPORT_REENTRY"], "the expired EXIT row is gone; the live re-entry stays");
    assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_checkpoints WHERE id = '${exitRow.id}'`)).length, 0);

    const after = await app.call("GET", `/api/airport/sessions/${sid}/checkpoints`, ana);
    assert.equal(after.status, 200, after.raw);
    assert.equal(after.raw, before.raw, "the reader had already hidden the expired row, so deleting it changed no answer");

    const again = await runLayoverCheckpointExpirySweep({ client: db.client, now: new Date() });
    assert.equal(again.outcome, "idle", JSON.stringify(again));
    assert.equal((await rowsOf(sid)).length, 1);
  });

  it("E4 retention is not the write flag's: with persistence OFF an expired check-in is still removed", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 5 })).id;
    const exit = await report(ana, sid, "LANDSIDE_EXIT");
    assert.equal(exit.status, 201, exit.raw);
    await db.exec(`UPDATE public.layover_checkpoints SET expires_at = now() - interval '1 minute' WHERE session_id = '${sid}'`);
    await db.setFlag("layover_decision_persistence_enabled", false);
    try {
      const pass = await runLayoverCheckpointExpirySweep({ client: db.client, now: new Date() });
      assert.equal(pass.outcome, "swept", JSON.stringify(pass));
      assert.equal((await rowsOf(sid)).length, 0);
    } finally {
      await db.setFlag("layover_decision_persistence_enabled", true);
    }
  });
});
