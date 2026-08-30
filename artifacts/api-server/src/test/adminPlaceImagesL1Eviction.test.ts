/**
 * Tests confirming that admin moderation actions (reject, approve, downgrade,
 * replace, report-resolve) evict the L1 in-memory discovery cache alongside the
 * L2 Postgres invalidation.
 *
 * Strategy:
 *   1. Unit tests for evictCacheEntriesForEntity() directly — no HTTP needed.
 *   2. Route-level test: inject an L1 entry, POST /admin/place-images/:id/reject,
 *      confirm the L1 entry is gone without querying any live DB.
 *
 * Each assertion checks cache STATE via _hasTestCacheEntry — a no-op eviction now
 * fails, where the previous inject/clear round-trips passed regardless of whether
 * anything was evicted.
 *
 * Run: node --import tsx/esm --test src/test/adminPlaceImagesL1Eviction.test.ts
 */
import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pino from "pino";
import {
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  _hasTestCacheEntry,
  evictCacheEntriesForEntity,
} from "../routes/discovery.js";
import { _setTestClient } from "../lib/http.js";
import adminRouter from "../routes/adminPlaceImages.js";

// ── Shared identifiers ─────────────────────────────────────────────────────────

const ENTITY_ID   = "aaaa0000-0000-0000-0000-000000000001";
const OTHER_ID    = "bbbb0000-0000-0000-0000-000000000002";
const VISUAL_ID   = "cccc0000-0000-0000-0000-000000000001";
const ADMIN_ID    = "dddd0000-0000-0000-0000-000000000001";
const ADMIN_TOKEN = "tok-admin-eviction";

// ── Test cache key helpers ─────────────────────────────────────────────────────

function key(dest: string, cat = "for_you", radius = 10) {
  return `${dest.toLowerCase().trim()}:${cat}:${radius}`;
}

function place(id: string) {
  return {
    id,
    name:         "Test Place",
    category:     "for_you" as const,
    type:         "traveler_pick" as const,
    description:  "desc",
    distanceKm:   1.0,
    lat:          25.77,
    lng:          -80.19,
    tags:         [],
    address:      "Miami, FL",
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       4.0,
    isOpenNow:    null,
  };
}

// ── Unit tests for evictCacheEntriesForEntity ──────────────────────────────────

describe("evictCacheEntriesForEntity", () => {
  beforeEach(() => {
    // Clean up any entries left by previous tests
    for (const d of ["miami", "paris", "tokyo", "berlin"]) {
      _clearTestCacheEntry(key(d));
      _clearTestCacheEntry(key(d, "restaurants", 5));
    }
  });

  it("removes an entry whose places array contains id === 'db/<entityId>'", () => {
    const k = key("miami");
    _injectTestCacheEntry(k, [place(`db/${ENTITY_ID}`)]);
    assert.equal(_hasTestCacheEntry(k), true, "precondition: entry present");

    evictCacheEntriesForEntity(ENTITY_ID);

    assert.equal(_hasTestCacheEntry(k), false, "entry containing db/<entityId> must be evicted");
  });

  it("removes only entries that contain the targeted entity — others survive", () => {
    const kTarget  = key("miami");
    const kOther   = key("paris");
    const kMixed   = key("tokyo");

    _injectTestCacheEntry(kTarget, [place(`db/${ENTITY_ID}`)]);
    _injectTestCacheEntry(kOther,  [place(`db/${OTHER_ID}`)]);
    // Mixed: contains both — should also be evicted because it contains ENTITY_ID
    _injectTestCacheEntry(kMixed,  [place(`db/${ENTITY_ID}`), place(`db/${OTHER_ID}`)]);

    evictCacheEntriesForEntity(ENTITY_ID);

    assert.equal(_hasTestCacheEntry(kTarget), false, "target evicted");
    assert.equal(_hasTestCacheEntry(kMixed),  false, "mixed entry (contains entity) evicted");
    assert.equal(_hasTestCacheEntry(kOther),  true,  "unrelated entity's entry survives");

    _clearTestCacheEntry(kOther); // clean up the survivor
  });

  it("is a no-op when no entry contains the entity", () => {
    const k = key("miami");
    _injectTestCacheEntry(k, [place(`db/${OTHER_ID}`)]);

    evictCacheEntriesForEntity(ENTITY_ID);

    assert.equal(_hasTestCacheEntry(k), true, "entry without the entity is left intact");
    _clearTestCacheEntry(k); // clean up
  });

  it("removes multiple entries that each contain the same entity", () => {
    const k1 = key("miami",  "restaurants", 5);
    const k2 = key("miami",  "for_you",    10);
    const k3 = key("berlin", "for_you",    10);

    _injectTestCacheEntry(k1, [place(`db/${ENTITY_ID}`)]);
    _injectTestCacheEntry(k2, [place(`db/${ENTITY_ID}`), place("node/other")]);
    _injectTestCacheEntry(k3, [place(`db/${OTHER_ID}`)]);

    evictCacheEntriesForEntity(ENTITY_ID);

    assert.equal(_hasTestCacheEntry(k1), false, "bucket 1 evicted");
    assert.equal(_hasTestCacheEntry(k2), false, "bucket 2 (mixed) evicted");
    assert.equal(_hasTestCacheEntry(k3), true,  "unrelated bucket survives");

    _clearTestCacheEntry(k3); // clean up
  });
});

// ── Route-level test: POST /reject evicts the L1 entry ────────────────────────

function makeApp(fakeSc: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = pino({ level: "silent" });
    next();
  });
  app.use("/api", adminRouter);
  return app;
}

function post(server: http.Server, path: string, token: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const port = (server.address() as any).port as number;
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: `Bearer ${token}` } },
      (res) => {
        let raw = "";
        res.on("data", (c: string) => { raw += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("POST /admin/place-images/:visualId/reject — L1 eviction", () => {
  let server: http.Server;

  const visual: Record<string, any> = {
    [VISUAL_ID]: {
      id:                 VISUAL_ID,
      entity_type:        "place",
      entity_id:          ENTITY_ID,
      canonical_place_id: ENTITY_ID,
      image_source_type:  "reference_grounded_ai",
      accuracy_status:    "unverified",
      source_url:         "https://cdn.example.com/img.webp",
      status:             "ready",
    },
  };

  const fakeSc = {
    auth: {
      getUser: async (token: string) => {
        if (token === ADMIN_TOKEN) return { data: { user: { id: ADMIN_ID } }, error: null };
        return { data: { user: null }, error: { message: "bad token" } };
      },
    },
    from(table: string) {
      const eqFilters: Record<string, any> = {};
      let updatePatch: any = null;
      const b: any = {
        select()                  { return b; },
        eq(col: string, val: any) { eqFilters[col] = val; return b; },
        update(patch: any)        { updatePatch = patch; return b; },
        delete()                  { return b; },
        filter()                  { return b; },
        maybeSingle()             { return b.single(); },
        async then(onF: any) {
          // best-effort places update — just resolve
          if (typeof onF === "function") onF({ data: null, error: null });
        },
        async single() {
          if (updatePatch !== null) {
            if (table === "generated_visuals") {
              const id = eqFilters["id"];
              if (id && visual[id]) Object.assign(visual[id], updatePatch);
            }
            return { data: null, error: null };
          }
          // SELECT
          if (table === "profiles") {
            if (eqFilters["id"] === ADMIN_ID) {
              return { data: { role: "admin", display_name: "Admin", username: "admin", handle: "admin" }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === "generated_visuals") {
            const id = eqFilters["id"];
            return { data: id ? (visual[id] ?? null) : null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return b;
    },
  };

  before(async () => {
    _setTestClient(fakeSc as any, true);
    server = http.createServer(makeApp(fakeSc));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });

  after(async () => {
    _setTestClient(null as any, false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("evicts the L1 cache entry for the rejected place", async () => {
    // Inject an L1 entry that contains the place being rejected, plus a sibling
    // that must survive so we prove targeted (not wholesale) eviction.
    const cacheK   = key("miami");
    const siblingK = key("paris");
    _injectTestCacheEntry(cacheK,   [place(`db/${ENTITY_ID}`)]);
    _injectTestCacheEntry(siblingK, [place(`db/${OTHER_ID}`)]);
    assert.equal(_hasTestCacheEntry(cacheK), true, "precondition: target cached");

    // Call the reject endpoint
    const res = await post(server, `/api/admin/place-images/${VISUAL_ID}/reject`, ADMIN_TOKEN, {
      reason: "Wrong image for this place",
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);

    // L1 entry for the rejected place must be gone; the unrelated sibling stays.
    assert.equal(_hasTestCacheEntry(cacheK),   false, "rejected place's L1 entry evicted");
    assert.equal(_hasTestCacheEntry(siblingK), true,  "unrelated L1 entry survives");

    _clearTestCacheEntry(siblingK); // clean up the survivor
  });
});
