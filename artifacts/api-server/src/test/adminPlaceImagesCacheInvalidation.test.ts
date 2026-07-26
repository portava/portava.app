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
