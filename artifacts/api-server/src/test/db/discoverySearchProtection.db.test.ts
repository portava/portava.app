/**
 * discoverySearchProtection.db — census-discovery B04 (§46), EXECUTED on
 * PostgreSQL 16: migration 3366 and its rollback, and the search adapter over
 * lib/protectedLocations reading the REAL `protected_zones` (migration 2217)
 * through the ONE reader of it, lib/protectedZoneStore.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/discoverySearchProtection.db.test.ts
 *      (or scripts/local-db/run-tests.sh). Skips without a database.
 *
 *   Z0  3366 is in force: the flag exists and is FALSE — the seed changes
 *       nothing that is served.
 *   Z1  zero ACTIVE zones (production's state, integrator-read 2026-09-27) read
 *       as `[]`, and the pass returns the input array itself: byte-identical.
 *       An INACTIVE zone is not a zone.
 *   Z2  a shelter and a clinic registered as rows: the place inside the
 *       shelter is suppressed, the one inside the clinic is snapped to the
 *       clinic's centre, the one outside is untouched.
 *   Z3  the table ABSENT (renamed away inside the test): PostgreSQL's 42P01
 *       reaches the store, which answers null — and the pass withholds every
 *       position and keeps every row. The table is renamed back after.
 *   Z4  3366's rollback refuses while the flag is ON, deletes the row and its
 *       ledger row while it is OFF, and 3366 re-applies to the same state.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, scalar } from "./localDb.js";
import { psqlReadClient } from "./discoverySearchPsqlClient.js";
import { applySearchProtection, DISCOVERY_SEARCH_PROTECTION_FLAG, type ProtectableSearchRow } from "../../lib/discoverySearchProtection.js";
import { clearProtectedZoneCache, loadActiveProtectedZones } from "../../lib/protectedZoneStore.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3366_discovery_search_protected_zones_flag.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-09-27-3366-discovery-search-protected-zones-flag-rollback.sql");
const LEDGER_NAME = "3366_discovery_search_protected_zones_flag.sql";

const SHELTER = { lat: 38.7200, lng: -9.1300 };
const CLINIC = { lat: 38.7400, lng: -9.1500 };
const place = (id: string, lat: number, lng: number): ProtectableSearchRow =>
  ({ id, type: "places", title: `place ${id}`, metadata: { category: "food", lat, lng } });
const ROWS = [
  place("in-shelter", 38.72004, -9.13004),
  place("in-clinic", 38.74002, -9.15003),
  place("outside", 38.7600, -9.2000),
];

const zoneIds: string[] = [];

describe("B04 — the search pass over the real protected_zones, and 3366", { skip: !HAVE_DB }, () => {
  before(() => {
    // The harness may have seeded nothing; this suite only ever deletes what it inserted.
    assert.equal(scalar(`SELECT to_regclass('public.protected_zones')::text`), "protected_zones", "2217 did not replay");
  });
  beforeEach(() => clearProtectedZoneCache());
  after(() => {
    clearProtectedZoneCache();
    if (scalar(`SELECT to_regclass('public.protected_zones_p1_hidden')::text`) === "protected_zones_p1_hidden") {
      exec(`ALTER TABLE public.protected_zones_p1_hidden RENAME TO protected_zones;`);
    }
    if (zoneIds.length) exec(`DELETE FROM public.protected_zones WHERE id IN (${zoneIds.map((i) => `'${i}'`).join(", ")});`);
    // Leave the harness as the chain replay left it — the seed row present and FALSE —
    // whatever Z4 (or a mutated rollback under P24) did to it. 3366 is idempotent.
    exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}';`);
    exec(readFileSync(MIGRATION, "utf8"));
  });

  it("Z0 — 3366 is in force: the flag exists, FALSE, and the shared reader reads it as off", async () => {
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}'`), "false");
    assert.equal(await isFlagEnabled(psqlReadClient(), DISCOVERY_SEARCH_PROTECTION_FLAG), false);
  });

  it("Z1 — zero ACTIVE zones read as [] and the pass is the identity by reference; an inactive zone is not a zone", async () => {
    const inactive = randomUUID();
    zoneIds.push(inactive);
    exec(`INSERT INTO public.protected_zones (id, category, shape, center_lat, center_lng, radius_meters, policy_ref, active)
          VALUES ('${inactive}', 'shelter', 'circle', ${SHELTER.lat}, ${SHELTER.lng}, 80, 'p1-test', false);`);
    const zones = await loadActiveProtectedZones(psqlReadClient());
    assert.deepEqual(zones, []);
    const out = applySearchProtection(ROWS, zones);
    assert.equal(out.results, ROWS, "zero zones must return the served array itself");
  });

  it("Z2 — a registered shelter suppresses, a registered clinic coarsens, the rest is untouched", async () => {
    const s = randomUUID(); const c = randomUUID();
    zoneIds.push(s, c);
    exec(`INSERT INTO public.protected_zones (id, category, shape, center_lat, center_lng, radius_meters, policy_ref)
          VALUES ('${s}', 'shelter', 'circle', ${SHELTER.lat}, ${SHELTER.lng}, 60, 'p1-test'),
                 ('${c}', 'medical_facility', 'circle', ${CLINIC.lat}, ${CLINIC.lng}, 80, 'p1-test');`);
    const zones = await loadActiveProtectedZones(psqlReadClient());
    assert.equal(zones?.length, 2);
    const out = applySearchProtection(ROWS, zones);
    assert.deepEqual(out.results.map((r) => r.id), ["in-clinic", "outside"]);
    const clinic = out.results[0]!.metadata!;
    assert.ok(Math.abs((clinic.lat as number) - CLINIC.lat) < 1e-9 && Math.abs((clinic.lng as number) - CLINIC.lng) < 1e-9,
      `the clinic's place was not snapped to the zone anchor: ${JSON.stringify(clinic)}`);
    assert.equal(clinic.coordsPrecision, "approximate");
    assert.equal(out.results[1], ROWS[2], "a row outside every zone is the same object");
  });

  it("Z3 — the table ABSENT: PostgreSQL's 42P01 makes the store answer null; positions withheld, every row kept", async () => {
    exec(`ALTER TABLE public.protected_zones RENAME TO protected_zones_p1_hidden;`);
    try {
      const raw: any = await psqlReadClient().from("protected_zones").select("id").eq("active", true);
      assert.equal(raw.error?.code, "42P01", `expected PostgreSQL's undefined_table, got ${JSON.stringify(raw.error)}`);
      const zones = await loadActiveProtectedZones(psqlReadClient());
      assert.equal(zones, null, "an absent policy table must read as UNREADABLE, never as 'no zones'");
      const out = applySearchProtection(ROWS, zones);
      assert.deepEqual(out.results.map((r) => r.id), ROWS.map((r) => r.id), "an absent policy emptied the search");
      for (const r of out.results) {
        assert.equal(r.metadata!.lat, null);
        assert.equal(r.metadata!.lng, null);
        assert.equal(r.metadata!.coordsPrecision, "hidden");
      }
    } finally {
      exec(`ALTER TABLE public.protected_zones_p1_hidden RENAME TO protected_zones;`);
    }
  });

  it("Z4 — the rollback refuses while ON, removes the row and the ledger row while OFF, and 3366 re-applies", () => {
    exec(`INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
          VALUES ('${LEDGER_NAME}', 'test', 'manual', 'discoverySearchProtection.db.test.ts') ON CONFLICT (filename) DO NOTHING;`);
    exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}';`);
    const refused = psql(readFileSync(ROLLBACK, "utf8"));
    assert.notEqual(refused.status, 0, "the rollback deleted an ON flag");
    assert.match(refused.stderr, /ROLLBACK REFUSED \(3366\)/);
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}'`), "true");

    exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}';`);
    exec(readFileSync(ROLLBACK, "utf8"));
    assert.equal(scalar(`SELECT count(*)::text FROM public.feature_flags WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}'`), "0");
    assert.equal(scalar(`SELECT count(*)::text FROM public.schema_migration_ledger WHERE filename = '${LEDGER_NAME}'`), "0");

    exec(readFileSync(MIGRATION, "utf8"));
    exec(readFileSync(MIGRATION, "utf8")); // idempotent
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}'`), "false");

    // The postcondition refuses a database where the flag reads ON.
    exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}';`);
    const onReapply = psql(readFileSync(MIGRATION, "utf8"));
    assert.notEqual(onReapply.status, 0);
    assert.match(onReapply.stderr, /POSTCONDITION FAILED \(3366\)/);
    exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}';`);
  });
});
