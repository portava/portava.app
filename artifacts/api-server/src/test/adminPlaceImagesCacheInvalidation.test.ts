/**
 * Admin place-image cache-invalidation tests
 *
 * Confirms that approve / reject / downgrade / report-resolve each evict the
 * discovery_cache entry for the affected entity_id so resolveHeaderImage does
 * not continue serving the stale visual until TTL expiry.
 *
 * Routes under test (artifacts/api-server/src/routes/adminPlaceImages.ts):
 *   POST /admin/place-images/:visualId/approve
 *   POST /admin/place-images/:visualId/reject
 *   POST /admin/place-images/:visualId/downgrade
 *   POST /admin/place-images/reports/:reportId/resolve  (action=image_rejected)
 *
 * Run: node --import tsx/esm --test src/test/adminPlaceImagesCacheInvalidation.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminPlaceImagesRouter from "../routes/adminPlaceImages.js";
import discoveryRouter, {
  _setTestDbPlacesOverride,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  type DiscoveryPlace,
} from "../routes/discovery.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN  = "fake.jwt.token";
const ADMIN_ID    = "aaaaaaaa-0000-0000-0000-000000000001";
const VISUAL_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const ENTITY_ID   = "cccccccc-0000-0000-0000-000000000003";
const REPORT_ID   = "dddddddd-0000-0000-0000-000000000004";
const IMAGE_URL   = "https://cdn.example.com/img.jpg";

// ── HTTP helper ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function req(
  method: string,
  path:   string,
  body?:  unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": `Bearer ${FAKE_TOKEN}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data",  (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client builder ───────────────────────────────────────────────────────

/**
 * Returns a fake Supabase client.
 *
 * `cacheDeletes` is an array that accumulates every `.delete().filter()` call
 * made against the `discovery_cache` table so tests can assert invalidation.
 */
function makeFakeClient(opts: {
  visualRow?:   Record<string, unknown> | null;
  reportRow?:   Record<string, unknown> | null;
  /** Rows returned by multi-row generated_visuals queries (report resolve lookup). */
  visualRows?:  Record<string, unknown>[];
  cacheDeletes: Array<{ filter: string; value: string }>;
}) {
  const {
    visualRow = {
      id:                 VISUAL_ID,
      accuracy_status:    "unverified",
      image_source_type:  "reference_grounded_ai",
      entity_type:        "place",
      entity_id:          ENTITY_ID,
      canonical_place_id: null,
    },
    reportRow = {
      id:        REPORT_ID,
      status:    "pending",
      image_url: IMAGE_URL,
      place_id:  ENTITY_ID,
    },
    // Default empty — only report-resolve tests need a multi-row override.
    visualRows = [],
    cacheDeletes,
  } = opts;

  function builder(table: string, rows: unknown[]) {
    let _rows = [...rows];
    let _pendingFilter: { col: string; op: string; val: string } | null = null;

    const b: any = {
      select:      (..._: any[]) => b,
      insert:      (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      update:      (data: any) => { _rows = _rows.map((r: any) => ({ ...r, ...data })); return b; },
      delete:      () => b,
      upsert:      (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      eq:          (..._: any[]) => b,
      neq:         (..._: any[]) => b,
      not:         (..._: any[]) => b,
      in:          (..._: any[]) => b,
      is:          (..._: any[]) => b,
      ilike:       (..._: any[]) => b,
      or:          (..._: any[]) => b,
      order:       (..._: any[]) => b,
      limit:       (..._: any[]) => b,
      range:       (..._: any[]) => b,
      filter:      (col: string, op: string, val: string) => {
        if (table === "discovery_cache") {
          cacheDeletes.push({ filter: col, value: val });
        }
        _pendingFilter = { col, op, val };
        return b;
      },
      then:        (resolve: any) => Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve),
      maybeSingle: () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles") {
        return builder(table, [{ id: ADMIN_ID, role: "admin" }]);
      }
      if (table === "generated_visuals") {
        const rows = visualRows.length > 0 ? visualRows : (visualRow ? [visualRow] : []);
        return builder(table, rows);
      }
      if (table === "place_image_reports") {
        return builder(table, reportRow ? [reportRow] : []);
      }
      if (table === "discovery_cache") {
        return builder(table, []);
      }
      return builder(table, []);
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: ADMIN_ID } }, error: null }),
    },
  } as any;
}

function setClients(client: any) {
  _setTestClient(client, true);
  _setTestServiceClient(client);
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminPlaceImagesRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  server.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("approve — cache invalidation", () => {
  it("issues a discovery_cache delete for the entity after approving", async () => {
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      visualRow: {
        id:                VISUAL_ID,
        accuracy_status:   "unverified",
        image_source_type: "official",
        entity_type:       "place",
        entity_id:         ENTITY_ID,
        canonical_place_id: null,
      },
    }));

    const { status, body } = await req("POST", `/admin/place-images/${VISUAL_ID}/approve`);
    assert.equal(status, 200, `expected 200 got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);

    // Allow the fire-and-forget void promise to settle
    await new Promise((r) => setImmediate(r));

    assert.ok(
      cacheDeletes.length > 0,
      "expected at least one discovery_cache delete after approve",
    );
    const hit = cacheDeletes.some((d) => d.value.includes(ENTITY_ID));
    assert.ok(hit, `expected delete to reference entity_id ${ENTITY_ID}, got: ${JSON.stringify(cacheDeletes)}`);
  });

  it("does NOT issue a cache delete when entity_type is not 'place'", async () => {
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      visualRow: {
        id:                VISUAL_ID,
        accuracy_status:   "unverified",
        image_source_type: "official",
        entity_type:       "event",
        entity_id:         ENTITY_ID,
        canonical_place_id: null,
      },
    }));

    const { status } = await req("POST", `/admin/place-images/${VISUAL_ID}/approve`);
    assert.equal(status, 200);

    await new Promise((r) => setImmediate(r));

    assert.equal(
      cacheDeletes.length,
      0,
      "expected no discovery_cache delete for non-place entity",
    );
  });

  it("uses canonical_place_id over entity_id when both are set", async () => {
    const CANONICAL_ID = "eeeeeeee-0000-0000-0000-000000000005";
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      visualRow: {
        id:                VISUAL_ID,
        accuracy_status:   "unverified",
        image_source_type: "official",
        entity_type:       "place",
        entity_id:         ENTITY_ID,
        canonical_place_id: CANONICAL_ID,
      },
    }));

    const { status } = await req("POST", `/admin/place-images/${VISUAL_ID}/approve`);
    assert.equal(status, 200);

    await new Promise((r) => setImmediate(r));

    const hit = cacheDeletes.some((d) => d.value.includes(CANONICAL_ID));
    assert.ok(hit, `expected delete to reference canonical_place_id ${CANONICAL_ID}`);
    const wrongHit = cacheDeletes.some(
      (d) => d.value.includes(ENTITY_ID) && !d.value.includes(CANONICAL_ID),
    );
    assert.equal(wrongHit, false, "should not delete using raw entity_id when canonical_place_id is set");
  });
});

describe("reject — cache invalidation", () => {
  it("issues a discovery_cache delete for the entity after rejecting", async () => {
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({ cacheDeletes }));

    const { status, body } = await req(
      "POST",
      `/admin/place-images/${VISUAL_ID}/reject`,
      { reason: "wrong place" },
    );
    assert.equal(status, 200, `expected 200 got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);

    await new Promise((r) => setImmediate(r));

    assert.ok(
      cacheDeletes.length > 0,
      "expected at least one discovery_cache delete after reject",
    );
    const hit = cacheDeletes.some((d) => d.value.includes(ENTITY_ID));
    assert.ok(hit, `expected delete to reference entity_id ${ENTITY_ID}`);
  });
});

describe("downgrade — cache invalidation", () => {
  it("issues a discovery_cache delete for the entity after downgrading", async () => {
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      visualRow: {
        id:                VISUAL_ID,
        accuracy_status:   "unverified",
        image_source_type: "reference_grounded_ai",
        entity_type:       "place",
        entity_id:         ENTITY_ID,
        canonical_place_id: null,
      },
    }));

    const { status, body } = await req("POST", `/admin/place-images/${VISUAL_ID}/downgrade`);
    assert.equal(status, 200, `expected 200 got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);

    await new Promise((r) => setImmediate(r));

    assert.ok(
      cacheDeletes.length > 0,
      "expected at least one discovery_cache delete after downgrade",
    );
    const hit = cacheDeletes.some((d) => d.value.includes(ENTITY_ID));
    assert.ok(hit, `expected delete to reference entity_id ${ENTITY_ID}`);
  });
});

describe("report resolve (image_rejected) — cache invalidation", () => {
  it("issues a discovery_cache delete for the place after image_rejected action", async () => {
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      reportRow: {
        id:        REPORT_ID,
        status:    "pending",
        image_url: IMAGE_URL,
        place_id:  ENTITY_ID,
      },
      visualRows: [{ id: VISUAL_ID, accuracy_status: "unverified" }],
    }));

    const { status, body } = await req(
      "POST",
      `/admin/place-images/reports/${REPORT_ID}/resolve`,
      { action: "image_rejected", adminNotes: "AI hallucination" },
    );
    assert.equal(status, 200, `expected 200 got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);

    await new Promise((r) => setImmediate(r));

    assert.ok(
      cacheDeletes.length > 0,
      "expected at least one discovery_cache delete after image_rejected resolve",
    );
    const hit = cacheDeletes.some((d) => d.value.includes(ENTITY_ID));
    assert.ok(hit, `expected delete to reference place entity_id ${ENTITY_ID}`);
  });

  it("issues a discovery_cache delete when place_id uses the 'db/<uuid>' discovery format", async () => {
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      reportRow: {
        id:        REPORT_ID,
        status:    "pending",
        image_url: IMAGE_URL,
        // Discovery-style prefixed place_id — the route must strip "db/" before
        // calling isUuid and before querying entity_id.
        place_id:  `db/${ENTITY_ID}`,
      },
      visualRows: [{ id: VISUAL_ID, accuracy_status: "unverified" }],
    }));

    const { status, body } = await req(
      "POST",
      `/admin/place-images/reports/${REPORT_ID}/resolve`,
      { action: "image_rejected", adminNotes: "wrong image" },
    );
    assert.equal(status, 200, `expected 200 got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);

    await new Promise((r) => setImmediate(r));

    assert.ok(
      cacheDeletes.length > 0,
      "expected discovery_cache delete even when place_id has 'db/' prefix",
    );
    const hit = cacheDeletes.some((d) => d.value.includes(ENTITY_ID));
    assert.ok(hit, `expected delete to reference raw entity_id ${ENTITY_ID} after stripping 'db/' prefix`);
  });

  it("does NOT issue a cache delete when action is no_action", async () => {
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      reportRow: {
        id:        REPORT_ID,
        status:    "pending",
        image_url: IMAGE_URL,
        place_id:  ENTITY_ID,
      },
      visualRows: [],
    }));

    const { status } = await req(
      "POST",
      `/admin/place-images/reports/${REPORT_ID}/resolve`,
      { action: "no_action" },
    );
    assert.equal(status, 200);

    await new Promise((r) => setImmediate(r));

    assert.equal(
      cacheDeletes.length,
      0,
      "expected no discovery_cache delete for no_action resolve",
    );
  });
});

describe("replace — cache invalidation", () => {
  it("issues a discovery_cache delete for the entity after a replace action", async () => {
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      visualRow: {
        id:                VISUAL_ID,
        accuracy_status:   "unverified",
        image_source_type: "official",
        entity_type:       "place",
        entity_id:         ENTITY_ID,
        canonical_place_id: null,
      },
    }));

    const { status, body } = await req(
      "POST",
      `/admin/place-images/${VISUAL_ID}/replace`,
      { imageUrl: IMAGE_URL, imageSourceType: "official" },
    );
    assert.equal(status, 200, `expected 200 got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);

    // Allow the fire-and-forget void promise to settle
    await new Promise((r) => setImmediate(r));

    assert.ok(
      cacheDeletes.length > 0,
      "expected at least one discovery_cache delete after replace",
    );
    const hit = cacheDeletes.some((d) => d.value.includes(ENTITY_ID));
    assert.ok(hit, `expected delete to reference entity_id ${ENTITY_ID}, got: ${JSON.stringify(cacheDeletes)}`);
  });

  it("uses canonical_place_id over entity_id when replacing", async () => {
    const CANONICAL_ID = "eeeeeeee-0000-0000-0000-000000000005";
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      visualRow: {
        id:                VISUAL_ID,
        accuracy_status:   "unverified",
        image_source_type: "official",
        entity_type:       "place",
        entity_id:         ENTITY_ID,
        canonical_place_id: CANONICAL_ID,
      },
    }));

    const { status } = await req(
      "POST",
      `/admin/place-images/${VISUAL_ID}/replace`,
      { imageUrl: IMAGE_URL, imageSourceType: "official" },
    );
    assert.equal(status, 200);

    await new Promise((r) => setImmediate(r));

    const hit = cacheDeletes.some((d) => d.value.includes(CANONICAL_ID));
    assert.ok(hit, `expected delete to reference canonical_place_id ${CANONICAL_ID}`);
  });

  it("does NOT issue a cache delete when entity_type is not 'place'", async () => {
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({
      cacheDeletes,
      visualRow: {
        id:                VISUAL_ID,
        accuracy_status:   "unverified",
        image_source_type: "official",
        entity_type:       "event",
        entity_id:         ENTITY_ID,
        canonical_place_id: null,
      },
    }));

    const { status } = await req(
      "POST",
      `/admin/place-images/${VISUAL_ID}/replace`,
      { imageUrl: IMAGE_URL, imageSourceType: "official" },
    );
    assert.equal(status, 200);

    await new Promise((r) => setImmediate(r));

    assert.equal(
      cacheDeletes.length,
      0,
      "expected no discovery_cache delete for non-place entity",
    );
  });
});

// ── End-to-end: reject → discovery route no longer serves the rejected image ──
//
// This suite mounts both the admin and discovery routers on a single test
// server and verifies the full round-trip:
//
//   1. A place with a specific headerImageUrl is visible in GET /discovery.
//   2. POST /admin/place-images/:id/reject is called for the visual.
//   3. L1 in-memory cache is cleared (simulating the effect of L2 invalidation
//      after a restart / autoscale event).
//   4. A fresh GET /discovery for the same destination must NOT include the
//      rejected image URL.
//
// The DB-places query is intercepted via _setTestDbPlacesOverride so the test
// does not require Overpass or Nominatim network calls.
// L1 is re-seeded with an empty OSM list between calls so serveCachedPlaces()
// is reached without triggering the full OSM pipeline.

describe("reject → discovery: rejected image no longer appears after L1 eviction", () => {
  const DEST         = "TestCity";
  const CATEGORY     = "for_you";
  const RADIUS       = 10;
  // Cache key format: `${dest.toLowerCase().trim()}:${cat}:${radius}`
  const CACHE_KEY    = `${DEST.toLowerCase()}:${CATEGORY}:${RADIUS}`;
  const REJECTED_URL = "https://cdn.example.com/rejected-visual-e2e.jpg";

  /** Minimal valid DiscoveryPlace for the test place. */
  const makePlaceRow = (imageUrl: string | null): DiscoveryPlace => ({
    id:           `db/${ENTITY_ID}`,
    name:         "Test Venue",
    category:     CATEGORY,
    type:         null,
    description:  null,
    distanceKm:   null,
    lat:          null,
    lng:          null,
    tags:         [],
    address:      null,
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       null,
    isOpenNow:    null,
    savedCount:   0,
    headerImageUrl: imageUrl,
    headerImageSource: null,
    imageSourceType:   null,
    accuracyStatus:    null,
    disclaimerRequired: false,
    disclaimerText:     null,
  });

  let e2eServer: http.Server;
  let e2eBase: string;

  function reqE2e(
    method: string,
    path:   string,
    body?:  unknown,
    noAuth  = false,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url     = new URL(path, e2eBase);
      const payload = body ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (!noAuth) headers["authorization"] = `Bearer ${FAKE_TOKEN}`;
      const r = http.request(
        {
          hostname: url.hostname,
          port:     Number(url.port),
          path:     url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          let raw = "";
          res.on("data",  (c) => (raw += c));
          res.on("end", () => {
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  before(async () => {
    const app = express();
    app.use(express.json());
    // Attach req.log shim so both routers can call req.log.info / .error
    app.use((r: any, _res: any, next: any) => {
      r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      next();
    });
    app.use(adminPlaceImagesRouter);
    app.use(discoveryRouter);
    e2eServer = http.createServer(app);
    await new Promise<void>((r) => e2eServer.listen(0, "127.0.0.1", r));
    const addr = e2eServer.address() as { port: number };
    e2eBase = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    _setTestDbPlacesOverride(null);
    _clearTestCacheEntry(CACHE_KEY);
    _setTestClient(null as any, false);
    _setTestServiceClient(null);
    e2eServer.close();
  });

  it("rejected image URL does not appear in discovery results after L1 eviction", async () => {
    // ── Step 0: wire up fakes ────────────────────────────────────────────────
    const cacheDeletes: Array<{ filter: string; value: string }> = [];
    setClients(makeFakeClient({ cacheDeletes }));

    // ── Step 1: seed DB so discovery returns the place with the rejected URL ─
    _setTestDbPlacesOverride(async () => [makePlaceRow(REJECTED_URL)]);

    // Seed L1 with empty OSM list so serveCachedPlaces() is reached without
    // an Overpass round-trip.  DB places are always re-fetched live.
    _injectTestCacheEntry(CACHE_KEY, []);

    const { status: s1, body: b1 } = await reqE2e(
      "GET",
      `/discovery?destination=${encodeURIComponent(DEST)}&category=${CATEGORY}&radiusKm=${RADIUS}`,
      undefined,
      /* noAuth */ true,
    );
    assert.equal(s1, 200, `first discovery call: expected 200 got ${s1}: ${JSON.stringify(b1)}`);

    const urlsBefore: (string | null)[] = (b1.places ?? []).map((p: any) => p.headerImageUrl ?? null);
    assert.ok(
      urlsBefore.includes(REJECTED_URL),
      `sanity check: rejected URL should appear before reject action; got: ${JSON.stringify(urlsBefore)}`,
    );

    // ── Step 2: reject the visual via the admin endpoint ─────────────────────
    const { status: rs, body: rb } = await reqE2e(
      "POST",
      `/admin/place-images/${VISUAL_ID}/reject`,
      { reason: "wrong place" },
    );
    assert.equal(rs, 200, `reject: expected 200 got ${rs}: ${JSON.stringify(rb)}`);
    assert.equal(rb.ok, true);

    // Allow fire-and-forget (L2 cache delete) to settle
    await new Promise((r) => setImmediate(r));

    // Verify L2 invalidation fired for the entity
    assert.ok(
      cacheDeletes.some((d) => d.value.includes(ENTITY_ID)),
      `expected L2 discovery_cache delete for entity_id ${ENTITY_ID}; got: ${JSON.stringify(cacheDeletes)}`,
    );

    // ── Step 3: clear L1 — simulating effect of L2 eviction on a fresh worker ─
    _clearTestCacheEntry(CACHE_KEY);

    // ── Step 4: update DB stub — post-reject the row has no image ───────────
    _setTestDbPlacesOverride(async () => [makePlaceRow(null)]);

    // Re-seed L1 with empty OSM list so the route uses serveCachedPlaces()
    // (avoiding Overpass) and hits the updated DB override.
    _injectTestCacheEntry(CACHE_KEY, []);

    // ── Step 5: call discovery — rejected URL must be absent ─────────────────
    const { status: s2, body: b2 } = await reqE2e(
      "GET",
      `/discovery?destination=${encodeURIComponent(DEST)}&category=${CATEGORY}&radiusKm=${RADIUS}`,
      undefined,
      /* noAuth */ true,
    );
    assert.equal(s2, 200, `second discovery call: expected 200 got ${s2}: ${JSON.stringify(b2)}`);

    const urlsAfter: (string | null)[] = (b2.places ?? []).map((p: any) => p.headerImageUrl ?? null);
    assert.ok(
      !urlsAfter.includes(REJECTED_URL),
      `rejected image URL must not appear in discovery results after L1 eviction; got: ${JSON.stringify(urlsAfter)}`,
    );
  });
});
