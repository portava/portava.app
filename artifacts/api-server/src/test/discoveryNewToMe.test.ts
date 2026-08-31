/**
 * New-to-Me (§7) + the Discovery memory-consumer (§13) — WIRING PROOF.
 *
 * What this locks down (see lib/placeIdBridge.ts + migration 2205):
 *
 *  1. THE ID BRIDGE maps the Discovery serve id space to the discovery_places.id
 *     space place memory keys on:
 *       - db/<discovery_places.id>  → that same uuid (direct row)
 *       - db/<places.id>            → the discovery_places.id whose
 *                                     canonical_location_id = places.id (the
 *                                     mirror). This is the case that, WITHOUT the
 *                                     bridge, reports a genuinely-saved canonical
 *                                     place as "new" — the bug the bridge exists
 *                                     to prevent.
 *       - node/<id> (OSM)           → the discovery_places.id whose osm_id matches
 *       - never-in-discovery_places → no mapping (⇒ genuinely new)
 *
 *  2. THE SERVE ANNOTATION, with memory_projection ON, marks a place the viewer
 *     has memory of newToMe:false and an unseen place newToMe:true — and NEVER
 *     touches serve ORDER. With the flag OFF it is a complete no-op: no newToMe
 *     field, and byte-identical serve order to the flag-on run.
 *
 *  3. THE already_known EMITTER bridges the served id and writes the suppression
 *     signal via the existing memory_feedback path, keyed on the canonical id.
 *
 * RED→GREEN: on origin/main the lib and the discovery wiring do not exist, so the
 * serve response carries no `newToMe` and there is no bridge to import — every
 * assertion here fails. With this slice they pass.
 *
 * Run: SUPABASE creds are supplied by the package.json test script (a dead host);
 * these tests never reach the network — the service client is a fake.
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
import {
  resolvePlaceIdBridge,
  recordDiscoveryAlreadyKnown,
  parseServedPlaceId,
  _clearPlaceIdBridgeCache,
} from "../lib/placeIdBridge.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
const USER  = "aaaa1111-0000-0000-0000-000000000001";
const TOKEN = "newtome-tok";
// discovery_places.id values (the canonical place-memory id space).
const DP_DIRECT = "dddddddd-0000-0000-0000-00000000d1d1"; // served directly as db/<DP_DIRECT>
const DP_MIRROR = "dddddddd-0000-0000-0000-00000000d2d2"; // mirror of a canonical place
const DP_OSM    = "dddddddd-0000-0000-0000-00000000d3d3"; // mirror of an OSM element
const DP_UNSEEN = "dddddddd-0000-0000-0000-00000000d4d4"; // a served place with no memory
// A public.places.id — served as db/<PLACES_ID> by queryCanonicalPlaces.
const PLACES_ID = "eeeeeeee-0000-0000-0000-0000000000a1";
const OSM_KEY   = "node/12345678";

// ── Configurable fake service client ─────────────────────────────────────────
interface FakeCfg {
  memoryProjectionOn: boolean;
  /** rows the bridge .or() query over discovery_places returns */
  discoveryPlacesRows?: Array<{ id: string; canonical_location_id: string | null; osm_id: string | null }>;
  /** subject_ids that are KNOWN (is_new === false) */
  knownSubjectIds?: Set<string>;
  /** sink for a memory_feedback insert */
  onFeedbackInsert?: (row: Record<string, unknown>) => void;
  /** engine mode for the serve path (default legacy → raw cached order) */
  mode?: "legacy" | "pde";
}

function makeFakeClient(cfg: FakeCfg): any {
  const known = cfg.knownSubjectIds ?? new Set<string>();
  const mode = cfg.mode ?? "legacy";

  function benign(): any {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, is: () => q, or: () => q,
      like: () => q, gte: () => q, lte: () => q, gt: () => q, lt: () => q,
      order: () => q, limit: () => q, range: () => q,
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
      if (table === "feature_flags") {
        let flag = "";
        const q: any = {
          select: () => q,
          eq: (col: string, val: any) => { if (col === "flag") flag = val; return q; },
          like: () => q,
          maybeSingle: async () => {
            if (flag === "DISCOVERY_ENGINE_MODE") {
              return { data: { enabled: true, metadata: { mode, cohort: { kind: "all" } } }, error: null };
            }
            if (flag === "disable_discovery_pde") return { data: { enabled: false }, error: null };
            if (flag === "memory_projection") return { data: { enabled: cfg.memoryProjectionOn }, error: null };
            return { data: null, error: null };
          },
          then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
        };
        return q;
      }
      if (table === "discovery_places") {
        let orUsed = false;
        const q: any = {
          select: () => q,
          eq: () => q, in: () => q, is: () => q,
          or: () => { orUsed = true; return q; },
          then: (r: any) =>
            Promise.resolve({ data: orUsed ? (cfg.discoveryPlacesRows ?? []) : [], error: null }).then(r),
        };
        return q;
      }
      if (table === "memory_feedback") {
        const q: any = {
          insert: (row: Record<string, unknown>) => {
            cfg.onFeedbackInsert?.(row);
            return { then: (r: any) => Promise.resolve({ data: null, error: null }).then(r) };
          },
        };
        return q;
      }
      return benign();
    },
    rpc: async (fn: string, args: Record<string, any>) => {
      if (fn === "memory_are_new_to_user") {
        const ids: string[] = args.p_subject_ids ?? [];
        return { data: ids.map((id) => ({ subject_id: id, is_new: !known.has(id) })), error: null };
      }
      return { data: null, error: null };
    },
  };
}

// ── 1. The id bridge ──────────────────────────────────────────────────────────
describe("placeIdBridge — served id space ↔ discovery_places.id", () => {
  beforeEach(() => _clearPlaceIdBridgeCache());
  afterEach(() => _clearPlaceIdBridgeCache());

  it("parseServedPlaceId classifies each space", () => {
    assert.deepEqual(parseServedPlaceId(`db/${DP_DIRECT}`), { kind: "db", uuid: DP_DIRECT });
    assert.deepEqual(parseServedPlaceId(OSM_KEY), { kind: "osm", osmKey: OSM_KEY });
    assert.deepEqual(parseServedPlaceId(`osm/${OSM_KEY}`), { kind: "osm", osmKey: OSM_KEY });
    assert.equal(parseServedPlaceId("garbage").kind, "unknown");
    assert.equal(parseServedPlaceId("db/not-a-uuid").kind, "unknown");
  });

  it("db/<discovery_places.id> maps to that same uuid (direct row)", async () => {
    const sc = makeFakeClient({
      memoryProjectionOn: true,
      discoveryPlacesRows: [{ id: DP_DIRECT, canonical_location_id: null, osm_id: null }],
    });
    const b = await resolvePlaceIdBridge(sc, [`db/${DP_DIRECT}`]);
    assert.deepEqual([...(b.toCanonical.get(`db/${DP_DIRECT}`) ?? [])], [DP_DIRECT]);
    assert.equal(b.toServed.get(DP_DIRECT), `db/${DP_DIRECT}`);
  });

  it("db/<places.id> maps to the discovery_places MIRROR (canonical_location_id) — the saved-place bug the bridge prevents", async () => {
    const sc = makeFakeClient({
      memoryProjectionOn: true,
      discoveryPlacesRows: [{ id: DP_MIRROR, canonical_location_id: PLACES_ID, osm_id: null }],
    });
    const b = await resolvePlaceIdBridge(sc, [`db/${PLACES_ID}`]);
    // Without the canonical_location_id bridge this set would be empty and the
    // saved place would be reported new.
    assert.deepEqual([...(b.toCanonical.get(`db/${PLACES_ID}`) ?? [])], [DP_MIRROR]);
  });

  it("node/<id> (OSM) maps to the discovery_places row via osm_id", async () => {
    const sc = makeFakeClient({
      memoryProjectionOn: true,
      discoveryPlacesRows: [{ id: DP_OSM, canonical_location_id: null, osm_id: OSM_KEY }],
    });
    const b = await resolvePlaceIdBridge(sc, [OSM_KEY]);
    assert.deepEqual([...(b.toCanonical.get(OSM_KEY) ?? [])], [DP_OSM]);
  });

  it("a place never in discovery_places has no mapping (⇒ genuinely new)", async () => {
    const sc = makeFakeClient({ memoryProjectionOn: true, discoveryPlacesRows: [] });
    const b = await resolvePlaceIdBridge(sc, ["node/999999"]);
    const set = b.toCanonical.get("node/999999");
    assert.ok(!set || set.size === 0, "unsaved place must not bridge to any canonical id");
  });
});

// ── HTTP harness ──────────────────────────────────────────────────────────────
function makeApp() {
  const app = express();
  app.use(express.json());
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

const KEY = "miami:for_you:10"; // cacheKey(dest.toLowerCase().trim(), category, radiusKm)
function cand(dpId: string): DiscoveryPlace {
  return {
    id: `db/${dpId}`, name: dpId, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1.0, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount: 0,
  } as DiscoveryPlace;
}
async function fetchDiscovery(url: string): Promise<Array<{ id: string; newToMe?: boolean }>> {
  const res = await fetch(`${url}/discovery?destination=Miami&lat=25.77&lng=-80.19`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { places: Array<{ id: string; newToMe?: boolean }> };
  return body.places ?? [];
}

// ── 2. Serve annotation (flag on/off) ─────────────────────────────────────────
describe("Discovery serve — New-to-Me annotation (flag-gated, order-preserving)", () => {
  let server: Server;
  let url: string;
  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestDbPlacesOverride(async () => []); // candidates come only from the injected cache
    _injectTestCacheEntry(KEY, [cand(DP_DIRECT), cand(DP_UNSEEN)]);
    invalidateDiscoveryEngineModeCache();
    _clearPlaceIdBridgeCache();
  });
  afterEach(async () => {
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    invalidateDiscoveryEngineModeCache();
    _clearPlaceIdBridgeCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("flag ON: a place with memory is newToMe:false, an unseen place is newToMe:true", async () => {
    _setTestServiceClient(makeFakeClient({
      memoryProjectionOn: true,
      discoveryPlacesRows: [
        { id: DP_DIRECT, canonical_location_id: null, osm_id: null },
        { id: DP_UNSEEN, canonical_location_id: null, osm_id: null },
      ],
      knownSubjectIds: new Set([DP_DIRECT]), // DP_DIRECT is remembered
    }));
    const places = await fetchDiscovery(url);
    assert.deepEqual(places.map((p) => p.id), [`db/${DP_DIRECT}`, `db/${DP_UNSEEN}`], "serve order unchanged");
    const byId = new Map(places.map((p) => [p.id, p.newToMe]));
    assert.equal(byId.get(`db/${DP_DIRECT}`), false, "remembered place must be newToMe:false");
    assert.equal(byId.get(`db/${DP_UNSEEN}`), true, "unseen place must be newToMe:true");
  });

  it("flag OFF: no annotation, and serve order/shape identical to flag-on", async () => {
    // Flag-on order (for the regression comparison).
    _setTestServiceClient(makeFakeClient({
      memoryProjectionOn: true,
      discoveryPlacesRows: [
        { id: DP_DIRECT, canonical_location_id: null, osm_id: null },
        { id: DP_UNSEEN, canonical_location_id: null, osm_id: null },
      ],
      knownSubjectIds: new Set([DP_DIRECT]),
    }));
    const onIds = (await fetchDiscovery(url)).map((p) => p.id);

    // Flag-off run.
    _clearPlaceIdBridgeCache();
    _setTestServiceClient(makeFakeClient({ memoryProjectionOn: false }));
    const offPlaces = await fetchDiscovery(url);

    assert.deepEqual(offPlaces.map((p) => p.id), onIds, "serve ORDER must be identical with the flag on vs off");
    for (const p of offPlaces) {
      assert.equal("newToMe" in p, false, `flag off must omit newToMe (got ${JSON.stringify(p)})`);
    }
  });
});

// ── 3. already_known emitter ───────────────────────────────────────────────────
describe("POST /discovery/already-known — bridged suppression emit", () => {
  let server: Server;
  let url: string;
  let captured: Record<string, unknown> | null;
  beforeEach(async () => {
    ({ server, url } = await startServer());
    captured = null;
    _clearPlaceIdBridgeCache();
  });
  afterEach(async () => {
    _setTestServiceClient(null);
    _clearPlaceIdBridgeCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function post(placeId: string): Promise<Response> {
    return fetch(`${url}/discovery/already-known`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ placeId }),
    });
  }

  it("bridges a served canonical id and writes already_known on the discovery_places mirror", async () => {
    _setTestServiceClient(makeFakeClient({
      memoryProjectionOn: true,
      discoveryPlacesRows: [{ id: DP_MIRROR, canonical_location_id: PLACES_ID, osm_id: null }],
      onFeedbackInsert: (row) => { captured = row; },
    }));
    const res = await post(`db/${PLACES_ID}`);
    assert.equal(res.status, 201);
    assert.ok(captured, "a memory_feedback row must be written");
    assert.equal(captured!.user_id, USER, "ownership is enforced from auth");
    assert.equal(captured!.kind, "already_known");
    assert.equal(captured!.subject_type, "place");
    assert.equal(captured!.subject_id, DP_MIRROR, "feedback must key on the canonical mirror id, not the served id");
  });

  it("returns 404 for a served id that maps to no discovery_places row", async () => {
    _setTestServiceClient(makeFakeClient({
      memoryProjectionOn: true,
      discoveryPlacesRows: [],
      onFeedbackInsert: (row) => { captured = row; },
    }));
    const res = await post("node/999999");
    assert.equal(res.status, 404);
    assert.equal(captured, null, "no feedback row for an unmappable id");
  });
});
