/**
 * P1 — PDE-mode serve path over Cache A (ruling D5=B, "rank every request").
 *
 * The gap this covers: before this, DISCOVERY_ENGINE_MODE="pde" was a labelled
 * no-op. Cache A stores the user-INDEPENDENT candidate set; serve points 1/2/3
 * handed that raw order straight to the user with no ranker. So `pde` mode
 * changed nothing anybody received. This wires the real ranker (rankForViewer)
 * into serveCachedPlaces for in-cohort authenticated callers.
 *
 * What must hold:
 *   1. legacy mode — a cache-A serve returns the raw cached order, unchanged
 *      (the Stage-1 invariant: legacy is byte-identical).
 *   2. pde mode + in-cohort — the same cache-A serve is RE-RANKED by PDE, so the
 *      order differs from the raw cached order, and a high-social-proof place is
 *      promoted above a low one.
 *
 * The request is driven to a deterministic Cache A (L1) HIT via
 * _injectTestCacheEntry, so no Overpass/geocode is needed. rankForViewer scores
 * candidates from their intrinsic signals (savedCount social proof), so a benign
 * empty viewer client is enough to make it re-rank. Exploration in portavaRank is
 * DETERMINISTIC (positional, not Math.random), so the order is reproducible.
 *
 * Run: node --import tsx/esm --test src/test/discoveryPdeServePath.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, {
  _setTestDbPlacesOverride,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";

const USER  = "aaaa1111-0000-0000-0000-000000000001";
const TOKEN = "pde-serve-tok";
const KEY   = "miami:for_you:10"; // cacheKey(dest.toLowerCase().trim(), category, radiusKm)

function cand(id: string, savedCount: number): DiscoveryPlace {
  return {
    id: `db/${id}`, name: id, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1.0, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}

// Injection order is P1,P2,P3,P4 but P4 carries a dominant savedCount, so a real
// ranker promotes it while the raw cached order leaves it last.
const INJECT_IDS = ["db/p1", "db/p2", "db/p3", "db/p4"];
function freshCandidates(): DiscoveryPlace[] {
  return [cand("p1", 1), cand("p2", 2), cand("p3", 3), cand("p4", 500)];
}

// Benign service client: every ranker read resolves empty (defaults), plus the
// DISCOVERY_ENGINE_MODE flag row and auth. `mode` selects legacy vs pde.
function fakeClient(mode: "legacy" | "pde") {
  function benign(): any {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, is: () => q, or: () => q,
      gte: () => q, lte: () => q, gt: () => q, lt: () => q, order: () => q,
      limit: () => q, range: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      insert: () => q, upsert: () => q, update: () => q, delete: () => q,
      then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return q;
  }
  return {
    auth: {
      getUser: async (t: string) =>
        t === TOKEN ? { data: { user: { id: USER } }, error: null }
                    : { data: { user: null }, error: null },
    },
    from(table: string) {
      if (table !== "feature_flags") return benign();
      let flag = "";
      const q: any = {
        select: () => q,
        eq: (col: string, val: any) => { if (col === "flag") flag = val; return q; },
        maybeSingle: async () => {
          if (flag === "DISCOVERY_ENGINE_MODE") {
            return { data: { enabled: true, metadata: { mode, cohort: { kind: "all" } } }, error: null };
          }
          if (flag === "disable_discovery_pde") return { data: { enabled: false }, error: null };
          return { data: null, error: null };
        },
        then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  } as any;
}

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use(discoveryRouter);
  return app;
}

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(makeApp());
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function fetchDiscovery(url: string): Promise<string[]> {
  const res = await fetch(`${url}/discovery?destination=Miami&lat=25.77&lng=-80.19`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { places: Array<{ id: string }> };
  return (body.places ?? []).map((p) => p.id);
}

describe("PDE-mode serve path over Cache A (D5=B)", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestDbPlacesOverride(async () => []); // candidates come only from the injected cache
    invalidateDiscoveryEngineModeCache();
  });
  afterEach(async () => {
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    invalidateDiscoveryEngineModeCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("legacy mode serves the raw cached order unchanged", async () => {
    _setTestServiceClient(fakeClient("legacy"));
    _injectTestCacheEntry(KEY, freshCandidates());
    const ids = await fetchDiscovery(url);
    assert.deepEqual(ids, INJECT_IDS, "legacy must serve the cached candidate order, untouched");
  });

  it("pde mode + in-cohort re-ranks the cache-A serve (no longer a no-op)", async () => {
    _setTestServiceClient(fakeClient("pde"));
    _injectTestCacheEntry(KEY, freshCandidates());
    const ids = await fetchDiscovery(url);
    assert.equal(ids.length, INJECT_IDS.length, "same candidates, re-ordered");
    assert.notDeepEqual(ids, INJECT_IDS, "pde must re-rank — a cache-A serve is no longer the raw cached order");
    // Real-signal check: the dominant-social-proof place is promoted above a weak one.
    assert.ok(
      ids.indexOf("db/p4") < ids.indexOf("db/p1"),
      `pde must promote the high-savedCount place above the low one — got ${JSON.stringify(ids)}`,
    );
  });
});
