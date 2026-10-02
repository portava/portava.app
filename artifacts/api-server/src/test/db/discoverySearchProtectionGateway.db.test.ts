/**
 * discoverySearchProtectionGateway — census-discovery §80 (lane W10-S1), B04,
 * register D-W10-S1-3, on the local PostgreSQL 16 harness. CONTROLLED DATA:
 * zones this file inserts and deletes; nothing here is production evidence.
 *
 * §46 built the protected-zone pass behind 3366 and proved it over the real
 * `protected_zones` table with the flag's value passed in by hand. This suite
 * proves the pass THROUGH THE FLAG, as a serve would reach it:
 *
 *   W0  3460 is in force: the flag's description names every serve point it now
 *       governs (the gateway included), the flag is still FALSE, and a re-run
 *       with the flag ON leaves it ON — 3460 can change words, never state;
 *   W1  flag OFF (the seed): `protectSearchResults` returns the served array
 *       itself and never reads `protected_zones`, zones registered or not;
 *   W2  flag ON, zones registered: through the real flag row and the real zone
 *       rows, a shelter suppresses, a clinic coarsens to its anchor, and a place
 *       outside every zone is the same object — on the route's entry point and
 *       on the gateway's per-type splitter (`protectGatewayCandidates`);
 *   W3  flag ON, no ACTIVE zone: identity by reference (production's state on
 *       2026-09-27: 2217 applied, 0 rows).
 *
 * Run through scripts/local-db/run-tests.sh, which sets LOCAL_DB_URL.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, scalar } from "./localDb.js";
import { psqlReadClient } from "./discoverySearchPsqlClient.js";
import {
  DISCOVERY_SEARCH_PROTECTION_FLAG,
  invalidateSearchProtectionFlagCache,
  protectSearchResults,
} from "../../lib/discoverySearchProtection.js";
import { clearProtectedZoneCache } from "../../lib/protectedZoneStore.js";
import { protectGatewayCandidates } from "../../lib/inputAssistance/gateway.js";
import type { SearchResult } from "../../lib/inputAssistance/searchCandidates.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const M3460 = resolve(__dir, "../../migrations/3460_discovery_search_protection_scope.sql");

const SHELTER = { lat: 38.72, lng: -9.13 };
const CLINIC = { lat: 38.74, lng: -9.15 };

function row(id: string, type: SearchResult["type"], lat: number, lng: number): SearchResult {
  return {
    id, type, title: `zork ${id}`, subtitle: null, avatarUrl: null, imageUrl: null, fallbackInitials: null,
    locationPreview: "Lisbon", matchedReason: null, actionState: null, privacyState: null, accessState: null,
    destinationRoute: `/place/${id}`, metadata: { lat, lng }, createdAt: null, startsAt: null,
  };
}
const ROWS = [
  row("in-shelter", "places", 38.72004, -9.13004),
  row("in-clinic", "places", 38.74002, -9.15003),
  row("outside", "places", 38.76, -9.2),
];
const EVENT_IN_SHELTER = row("event-in-shelter", "events", 38.72003, -9.13002);

const zoneIds: string[] = [];
const setFlag = (on: boolean) =>
  exec(`UPDATE public.feature_flags SET enabled = ${on} WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}';`);

describe("B04 through the flag (census-discovery §80): 3460, and the pass on the route's and the gateway's entry points", { skip: !HAVE_DB }, () => {
  before(() => {
    assert.equal(scalar(`SELECT to_regclass('public.protected_zones')::text`), "protected_zones", "2217 did not replay");
    assert.equal(scalar(`SELECT count(*)::text FROM public.feature_flags WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}'`), "1", "3366 did not replay");
  });
  beforeEach(() => { clearProtectedZoneCache(); invalidateSearchProtectionFlagCache(); });
  after(() => {
    clearProtectedZoneCache();
    invalidateSearchProtectionFlagCache();
    if (zoneIds.length) exec(`DELETE FROM public.protected_zones WHERE id IN (${zoneIds.map((i) => `'${i}'`).join(", ")});`);
    // Leave the harness as the chain replay left it: the flag FALSE, 3460's wording.
    setFlag(false);
    exec(readFileSync(M3460, "utf8"));
  });

  it("W0 — 3460 names the gateway, leaves the flag FALSE, and on re-run with the flag ON leaves it ON", () => {
    // Applied here rather than assumed from the chain replay: the §46 suite's Z4
    // rolls 3366 back and re-applies it, which restores 3366's own wording.
    exec(readFileSync(M3460, "utf8"));
    const d = scalar(`SELECT description FROM public.feature_flags WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}'`) ?? "";
    assert.match(d, /\/input-assistance\/suggest/);
    assert.match(d, /map\.search/);
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}'`), "false");
    const sql = readFileSync(M3460, "utf8");
    exec(sql); // idempotent
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}'`), "false");
    setFlag(true);
    try {
      exec(sql);
      assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${DISCOVERY_SEARCH_PROTECTION_FLAG}'`), "true", "3460 changed the flag's state");
    } finally {
      setFlag(false);
    }
  });

  it("W1 — flag OFF: the served array itself, and protected_zones is never read", async () => {
    const s = randomUUID();
    zoneIds.push(s);
    exec(`INSERT INTO public.protected_zones (id, category, shape, center_lat, center_lng, radius_meters, policy_ref)
          VALUES ('${s}', 'shelter', 'circle', ${SHELTER.lat}, ${SHELTER.lng}, 60, 'w10s1-test');`);
    setFlag(false);
    const client = psqlReadClient();
    const out = await protectSearchResults(client, ROWS);
    assert.equal(out, ROWS, "flag OFF must be the identity by reference");
    const perType = [ROWS, [EVENT_IN_SHELTER]];
    const [split, extra] = await protectGatewayCandidates(client, perType, []);
    assert.equal(split, perType, "the gateway splitter with the flag OFF must hand back the same arrays");
    assert.deepEqual(extra, []);
  });

  it("W2 — flag ON, zones registered: shelter suppressed, clinic coarsened to its anchor, the rest the same object", async () => {
    const c = randomUUID();
    zoneIds.push(c);
    exec(`INSERT INTO public.protected_zones (id, category, shape, center_lat, center_lng, radius_meters, policy_ref)
          VALUES ('${c}', 'medical_facility', 'circle', ${CLINIC.lat}, ${CLINIC.lng}, 80, 'w10s1-test');`);
    setFlag(true);
    try {
      const client = psqlReadClient();
      const out = await protectSearchResults(client, ROWS);
      assert.deepEqual(out.map((r) => r.id), ["in-clinic", "outside"]);
      const clinic = out[0]!.metadata!;
      assert.ok(Math.abs((clinic.lat as number) - CLINIC.lat) < 1e-9 && Math.abs((clinic.lng as number) - CLINIC.lng) < 1e-9);
      assert.equal(clinic.coordsPrecision, "approximate");
      assert.equal(out[1], ROWS[2]);

      clearProtectedZoneCache(); invalidateSearchProtectionFlagCache();
      const [split] = await protectGatewayCandidates(client, [ROWS, [EVENT_IN_SHELTER]], []);
      assert.deepEqual(split.map((rows) => rows.map((r) => r.id)), [["in-clinic", "outside"], []],
        "the gateway must drop the shelter place AND the event inside the shelter, per type");
    } finally {
      setFlag(false);
    }
  });

  it("W3 — flag ON, no ACTIVE zone (production's 2026-09-27 state): identity by reference", async () => {
    exec(`UPDATE public.protected_zones SET active = false WHERE id IN (${zoneIds.map((i) => `'${i}'`).join(", ")});`);
    setFlag(true);
    try {
      const out = await protectSearchResults(psqlReadClient(), ROWS);
      assert.equal(out, ROWS);
    } finally {
      setFlag(false);
      exec(`UPDATE public.protected_zones SET active = true WHERE id IN (${zoneIds.map((i) => `'${i}'`).join(", ")});`);
    }
  });
});
