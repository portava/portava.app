/**
 * census-layover §83 L25 — 3951 and its rollback on the full migrated chain (PostgreSQL).
 *
 *   R0  3951 is in the chain: the nullable column, its CHECK, the flag seeded FALSE; nothing else on the table moved.
 *   R1  the CHECK admits exactly the service's vocabulary.
 *   R2  the rollback refuses while a stored snapshot holds a ref, and while the flag is ON; nothing changes on refusal.
 *   R3  the rollback removes the flag, the CHECK, the column and the ledger row; a second run is a no-op; 3951 re-applies.
 *
 * Run: LOCAL_DB_URL=… node --import tsx/esm --test src/test/db/layoverSnapshotEnvelopeRefMigration.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb } from "./pressedLayoverDb.js";
import { SAFE_ENVELOPE_REF_PATTERN } from "../../services/layover/LayoverSnapshotEnvelopeRef.js";
import { keepConstraintsUndeclared, productionBaseFlags, seedConfirmedCorridor, seedCuratedAirport, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const FORWARD = readFileSync(new URL("../../migrations/3951_layover_snapshot_safe_envelope_ref.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../../../../../db/rollback/2026-10-23-3951-layover-snapshot-safe-envelope-ref-rollback.sql", import.meta.url), "utf8");
const FLAG = "layover_snapshot_envelope_ref_enabled";

let db: PressedDb;
let app: PressedApp;
const column = async () => (await db.query<any>(`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'layover_certified_computations' AND column_name = 'safe_envelope_ref'`))[0] ?? null;
/** A refused rollback raises inside its own BEGIN; the session's transaction is then aborted, so end it. */
const refused = async (why: RegExp) => { await assert.rejects(db.exec(ROLLBACK), why); await db.exec("ROLLBACK"); };
const check = async () => (await db.query<any>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.layover_certified_computations'::regclass AND conname = 'layover_certcomp_safe_envelope_ref_shape'`))[0]?.def ?? null;

describe("3951 safe_envelope_ref — forward and rollback on the migrated chain", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb();
    keepConstraintsUndeclared(); // R2 declares for itself, after the flag is ON, so its snapshot is a new one
    await productionBaseFlags(db);
    const fx = JSON.parse(readFileSync(new URL("./fixtures/productionFlags20261023.json", import.meta.url), "utf8")) as { flags: Record<string, boolean> };
    await db.setFlags(fx.flags); // production's own flag state (persistence ON), so the router stores snapshots as it does there
    app = await startPressedLayoverApp(db);
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("R0 the column is nullable text with its CHECK, and the flag is seeded FALSE", async () => {
    assert.deepEqual(await column(), { is_nullable: "YES", data_type: "text" });
    assert.match(String(await check()), /safe_envelope_ref IS NULL/);
    assert.equal(await db.flag(FLAG), false);
  });

  it("R1 the CHECK admits exactly the service's vocabulary", async () => {
    const def = String(await check());
    for (const ok of [`env:${"a".repeat(64)}`, "env:withheld:landside_closed", "env:withheld:no_airport_coordinate"]) {
      assert.match(ok, SAFE_ENVELOPE_REF_PATTERN);
      assert.equal((await db.query<any>(`SELECT ('${ok}' ~ '^env:([a-f0-9]{64}|withheld:(landside_closed|no_airport_coordinate))$') AS m`))[0].m, true, ok);
    }
    for (const bad of ["env:", `env:${"A".repeat(64)}`, `env:${"a".repeat(63)}`, "env:withheld:other", "sha256:abc"]) {
      assert.doesNotMatch(bad, SAFE_ENVELOPE_REF_PATTERN);
      assert.equal((await db.query<any>(`SELECT ('${bad}' ~ '^env:([a-f0-9]{64}|withheld:(landside_closed|no_airport_coordinate))$') AS m`))[0].m, false, bad);
    }
    assert.ok(def.includes("landside_closed") && def.includes("no_airport_coordinate"));
  });

  it("R2 the rollback refuses while the flag is ON, and while a stored snapshot holds a ref; nothing changes", async () => {
    const u = await db.seedUser("envref_mig");
    await seedConfirmedCorridor(db, u.id, "US", "SG");
    await seedCuratedAirport(app, db, "SIN");
    const sid = (await startSession(app, u, { iata: "SIN" }, { departsInH: 9 })).id as string;
    await db.setFlag(FLAG, true);
    try {
      // a snapshot stored through the traveller's own declaration, with the flag ON, so it carries a ref
      const d = await app.call("PUT", `/api/airport/sessions/${sid}/constraints`, u, { baggageMode: "CARRY_ON_ONLY", recheckRequired: false, airportChangeRequired: false });
      assert.equal(d.status, 200, d.raw);
      const refs = await db.query<any>(`SELECT safe_envelope_ref FROM public.layover_certified_computations WHERE session_id = '${sid}' AND safe_envelope_ref IS NOT NULL`);
      assert.ok(refs.length > 0, "the traveller's declaration stored a snapshot with its ref");
      await refused(/ROLLBACK REFUSED \(3951\): layover_snapshot_envelope_ref_enabled is TRUE/);
    } finally {
      await db.setFlag(FLAG, false);
    }
    await refused(/ROLLBACK REFUSED \(3951\): \d+ stored snapshot\(s\) record which safe envelope they published/);
    assert.ok(await column(), "the refusal changed nothing");
    assert.equal(await db.flag(FLAG), false);
    // bounded retention's own door: DELETE (3896 permits it; UPDATE it refuses)
    await db.exec(`UPDATE public.layover_sessions SET active_snapshot_id = NULL WHERE id = '${sid}'; DELETE FROM public.layover_certified_computations WHERE safe_envelope_ref IS NOT NULL`);
  });

  it("R3 the rollback removes the flag, the CHECK, the column and the ledger row; a second run is a no-op; 3951 re-applies", async () => {
    await db.exec(ROLLBACK);
    assert.equal(await column(), null);
    assert.equal(await check(), null);
    assert.equal(await db.flag(FLAG), "absent");
    assert.equal((await db.query<any>(`SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3951_layover_snapshot_safe_envelope_ref.sql'`)).length, 0);
    await db.exec(ROLLBACK); // idempotent
    await db.exec(FORWARD);
    assert.deepEqual(await column(), { is_nullable: "YES", data_type: "text" });
    assert.equal(await db.flag(FLAG), false);
  });
});
