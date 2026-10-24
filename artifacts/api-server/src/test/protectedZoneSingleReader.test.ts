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
  "lib/locateFriendsSession.ts": "a deliberate separate loader with the same select and null contract, recorded in-file so Locate Friends' and the Map's failure modes are not coupled (census-map §54.4)",
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
});
