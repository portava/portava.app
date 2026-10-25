/**
 * census-map §55 — one reader of the protected-zone policy.
 *
 *   Z1  every server read of `protected_zones` goes through lib/protectedZoneStore.ts,
 *       except the two exceptions named here with their reasons; a third copy of the
 *       loader anywhere in src/ fails this test
 *   Z2  routes/mapProjectionTemporal.ts reads the policy through the store (its old
 *       private copy is gone) and its cache seam clears the store's one cache
 *   Z3  the store's contract, which the temporal route now inherits: a read error is
 *       null, a THROW is null (the old copy let it escape to a 500), an empty table is
 *       [], a malformed ring is kept
 *   Z4  behaviour unchanged: for the same rows the store returns exactly what the
 *       route's removed private copy returned, and issues the same query
 * The route's own behaviour (refusal on an unreadable policy, the protection pass) is
 * pinned by src/test/mapProjectionTemporalRoute.test.ts, which passes unchanged.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { clearProtectedZoneCache, loadActiveProtectedZones } from "../lib/protectedZoneStore.js";
import { _clearTemporalProtectedZoneCache } from "../routes/mapProjectionTemporal.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The reads that may stay outside the store, each with the reason it is not a copy of the policy loader. */
const ALLOWED_OUTSIDE_STORE: Record<string, string> = {
  // Its in-file reason ("another route's module-private cache") stopped holding when the loader moved to the
  // store. The reason that does hold: it reads the policy FRESH on every live-location read (Locate Friends and
  // routes/layoverCrewLocation.ts), where the store reuses a read for 30 s — moving it would let a newly active
  // zone wait up to 30 s before it suppresses a live position (census-map §55.1).
  "lib/locateFriendsSession.ts": "an uncached loader with the same select, mapping and null contract, kept because live-location reads must see a newly active zone at once",
  "lib/discoveryTrendProducerPrivacy.ts": "not a policy load: an existence probe (select id, limit 1) answering whether ANY active zone exists",
};

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "test" || e === "migrations" || e === "node_modules" || e === "snapshots") continue;
      yield* walk(p);
    } else if (/\.(ts|mts|js|mjs)$/.test(e) && !/\.test\.|\.d\.ts$/.test(e)) yield p;
  }
}

function fakeClient(answer: { data?: unknown; error?: unknown } | "throw") {
  let reads = 0;
  return {
    get reads() { return reads; },
    from(t: string) {
      assert.equal(t, "protected_zones");
      reads++;
      if (answer === "throw") throw new Error("socket closed");
      const b: any = { select: () => b, eq: () => Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null }) };
      return b;
    },
  };
}

beforeEach(() => clearProtectedZoneCache());

describe("census-map §55 — one reader of the protected-zone policy", () => {
  it("Z1 no third copy of the loader: every read of protected_zones outside the store is a named exception", () => {
    const readers: string[] = [];
    for (const f of walk(SRC)) {
      const text = readFileSync(f, "utf8");
      if (/\.from\(\s*["'`]protected_zones["'`]\s*\)/.test(text)) readers.push(relative(SRC, f));
    }
    const outside = readers.filter((r) => r !== "lib/protectedZoneStore.ts").sort();
    assert.ok(readers.includes("lib/protectedZoneStore.ts"), "the store itself reads the table");
    assert.deepEqual(outside, Object.keys(ALLOWED_OUTSIDE_STORE).sort(),
      `a read of protected_zones outside lib/protectedZoneStore.ts: ${outside.join(", ")} — call loadActiveProtectedZones instead, or name the exception and its reason here`);
  });

  it("Z2 the temporal route reads through the store, and its cache seam clears the store's cache", async () => {
    const route = readFileSync(join(SRC, "routes/mapProjectionTemporal.ts"), "utf8");
    assert.match(route, /import \{ clearProtectedZoneCache, loadActiveProtectedZones \} from "\.\.\/lib\/protectedZoneStore\.js";/);
    assert.match(route, /async function loadProtectedZones\(sc: any\): Promise<ProtectedZone\[\] \| null> \{\n  return loadActiveProtectedZones\(sc\);\n\}/);
    const a = fakeClient({ data: [] });
    assert.deepEqual(await loadActiveProtectedZones(a), []);
    assert.deepEqual(await loadActiveProtectedZones(a), [], "cached");
    assert.equal(a.reads, 1, "one read within the TTL");
    _clearTemporalProtectedZoneCache();
    const b = fakeClient({ data: [{ id: "z1", category: "shelter", shape: "circle", center_lat: 1, center_lng: 2, radius_meters: 50, active: true }] });
    const zones = await loadActiveProtectedZones(b);
    assert.equal(b.reads, 1, "the route's seam cleared the shared cache");
    assert.equal(zones?.length, 1);
  });

  it("Z3 the contract the temporal route inherits: error → null, throw → null, empty → [], malformed ring kept", async () => {
    assert.equal(await loadActiveProtectedZones(fakeClient({ error: { code: "42P01", message: "relation does not exist" } })), null);
    clearProtectedZoneCache();
    assert.equal(await loadActiveProtectedZones(fakeClient("throw")), null, "a throw is a failed read, not a 500");
    clearProtectedZoneCache();
    assert.deepEqual(await loadActiveProtectedZones(fakeClient({ data: [] })), []);
    clearProtectedZoneCache();
    const z = await loadActiveProtectedZones(fakeClient({ data: [{ id: "z2", category: "clinic", shape: "polygon", ring: "not-a-ring" }] }));
    assert.equal(z?.length, 1, "unparseable geometry stays in the list, so applyProtection suppresses it");
  });

  it("Z4 behaviour unchanged: the store answers what the temporal route's old private copy answered, row for row", async () => {
    // The removed copy, verbatim from routes/mapProjectionTemporal.ts before §55 (census-map b1, 2dbb4e5ae),
    // minus its cache: the reference the consolidation is measured against.
    async function oldTemporalLoader(sc: any): Promise<unknown[] | null> {
      const { data, error } = await sc
        .from("protected_zones")
        .select("id, category, action, privacy_floor, shape, center_lat, center_lng, radius_meters, ring, jurisdiction, policy_ref")
        .eq("active", true);
      if (error || !Array.isArray(data)) return null;
      const zones: unknown[] = [];
      for (const row of data as any[]) {
        const base = {
          id: String(row.id), category: String(row.category), action: row.action ?? undefined,
          privacyFloor: row.privacy_floor ?? undefined, jurisdiction: row.jurisdiction ?? undefined, policyRef: row.policy_ref ?? undefined,
        };
        if (row.shape === "circle") {
          zones.push({ ...base, shape: "circle", center: { lat: Number(row.center_lat), lng: Number(row.center_lng) }, radiusMeters: Number(row.radius_meters) });
        } else {
          zones.push({ ...base, shape: "polygon", ring: row.ring });
        }
      }
      return zones;
    }
    function recordingClient(answer: { data?: unknown; error?: unknown }) {
      const calls: string[] = [];
      return {
        calls,
        from(t: string) {
          calls.push(`from:${t}`);
          const b: any = {
            select: (cols: string) => { calls.push(`select:${cols}`); return b; },
            eq: (c: string, v: unknown) => { calls.push(`eq:${c}=${String(v)}`); return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null }); },
          };
          return b;
        },
      };
    }
    const ROWS = [
      { id: 1, category: "shelter", action: "suppress", privacy_floor: "k20", shape: "circle", center_lat: "10.5", center_lng: 106.7, radius_meters: "250", jurisdiction: "VN", policy_ref: "p-1" },
      { id: "z-poly", category: "clinic", action: null, privacy_floor: null, shape: "polygon", ring: [[1, 2], [3, 4], [5, 6], [1, 2]], jurisdiction: null, policy_ref: null },
      { id: "z-bad", category: "school", shape: "polygon", ring: "not-a-ring" },
      { id: "z-odd", category: 7, shape: "hexagon", center_lat: 1, center_lng: 2, radius_meters: 3, ring: null, extra: "ignored" },
      { id: "z-nan", category: "shelter", shape: "circle", center_lat: null, center_lng: "x", radius_meters: undefined },
    ];
    const answers: { data?: unknown; error?: unknown }[] = [
      { data: ROWS }, { data: [] }, { error: { code: "42P01", message: "relation does not exist" } }, { data: null }, { data: { not: "an array" } },
    ];
    for (const answer of answers) {
      clearProtectedZoneCache();
      const a = recordingClient(answer);
      const b = recordingClient(answer);
      const store = await loadActiveProtectedZones(a);
      const old = await oldTemporalLoader(b);
      assert.deepEqual(store, old, `same answer for ${JSON.stringify(answer).slice(0, 60)}`);
      assert.deepEqual(a.calls, b.calls, "same table, same columns, same filter");
    }
  });
});
