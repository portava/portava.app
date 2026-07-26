/**
 * Integration tests for POST /api/places/:id/image-report
 *
 * Covers: auth required, valid auth inserts row, unknown placeId → 404,
 * invalid reason → 400, unauthenticated → 401.
 *
 * place_id is TEXT matching discovery_places.id (OSM/text keys like "db/<uuid>"),
 * NOT a UUID foreign-key to the `places` table — see migration comment in
 * src/migrations/20260810_place_image_reports.sql.
 *
 * Run: node --import tsx/esm --test src/test/placeImageReport.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import placesRouter from "../routes/places.js";

// ── Test identities ────────────────────────────────────────────────────────────

const ALICE_ID    = "aaaaaaaa-0000-0000-0000-aaaaaaaaaa01";
const ALICE_TOKEN = "tok-alice";

// Discovery-style place IDs — the shape real clients send (TEXT, not UUID).
// "db/<uuid>" is the canonical format for Portava-catalogued places.
const PLACE_ID_DB  = "db/cc000000-0000-4000-8000-000000000001";
const PLACE_ID_OSM = "osm/node/123456789";

// ── Fake client factory ────────────────────────────────────────────────────────

function makeFakeSc(opts: {
  placeExists: boolean;
  insertError?: { message: string } | null;
}) {
  const inserts: any[] = [];
  // Set of known place IDs for the fake discovery_places table.
  const knownPlaceIds = opts.placeExists
    ? new Set([PLACE_ID_DB, PLACE_ID_OSM])
    : new Set<string>();

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === ALICE_TOKEN) return { data: { user: { id: ALICE_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from(table: string) {
      const eqCol: Record<string, any> = {};
      let pendingInsert: any = null;

      const b: any = {
        select()                  { return b; },
        eq(col: string, val: any) { eqCol[col] = val; return b; },
        insert(row: any)          { pendingInsert = row; inserts.push({ table, row }); return b; },
        update()                  { return b; },
        delete()                  { return b; },
        in()                      { return b; },
        limit()                   { return b; },
        order()                   { return b; },
        maybeSingle()             { return b.single(); },
        async single() {
          if (table === "profiles" && eqCol.id === ALICE_ID) {
            // requireUser account-status check — not banned.
            return { data: { account_status: "active", role: "member" }, error: null };
          }
          // Existence guard: route now queries discovery_places, not places.
          if (table === "discovery_places") {
            const id = eqCol["id"];
            if (id && knownPlaceIds.has(id)) {
              return { data: { id }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === "place_image_reports" && pendingInsert) {
            if (opts.insertError) return { data: null, error: opts.insertError };
            return { data: { id: "rr000000-0000-0000-0000-000000000001", ...pendingInsert }, error: null };
          }
          return { data: null, error: null };
        },
        async then(onF: any) { return onF({ data: [], error: null, count: 0 }); },
      };
      return b;
    },
    __inserts: inserts,
  };
}

// ── Minimal Express server ─────────────────────────────────────────────────────

interface TestApp {
  baseUrl: string;
  close: () => Promise<void>;
  client: ReturnType<typeof makeFakeSc>;
}

async function startTestApp(fakeSc: ReturnType<typeof makeFakeSc>): Promise<TestApp> {
  _setTestClient(fakeSc as any, true);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", placesRouter);

  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        client: fakeSc,
        close: () =>
          new Promise<void>((res, rej) => {
            srv.closeAllConnections?.();
            srv.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
    srv.on("error", reject);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/places/:id/image-report", () => {
  let app: TestApp;

  before(async () => {
    app = await startTestApp(makeFakeSc({ placeExists: true }));
  });

  after(async () => {
    await app.close();
    _setTestClient(null as any, false);
  });

  it("returns 200 and ok:true for a valid authenticated request (db/<uuid> ID)", async () => {
    const encodedId = encodeURIComponent(PLACE_ID_DB);
    const res = await fetch(
      `${app.baseUrl}/api/places/${encodedId}/image-report`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ALICE_TOKEN}`,
        },
        body: JSON.stringify({
          imageUrl: "https://cdn.example.com/wrong-place.jpg",
          reason: "wrong_place",
        }),
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
  });

  it("returns 200 and ok:true for a valid OSM-style place ID (osm/node/<id>)", async () => {
    const encodedId = encodeURIComponent(PLACE_ID_OSM);
    const res = await fetch(
      `${app.baseUrl}/api/places/${encodedId}/image-report`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ALICE_TOKEN}`,
        },
        body: JSON.stringify({
          imageUrl: "https://cdn.example.com/wrong-place.jpg",
          reason: "wrong_place",
        }),
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
  });

  it("inserts a place_image_reports row on success", async () => {
    const fakeSc = makeFakeSc({ placeExists: true });
    const a = await startTestApp(fakeSc);
    try {
      const encodedId = encodeURIComponent(PLACE_ID_DB);
      await fetch(
        `${a.baseUrl}/api/places/${encodedId}/image-report`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${ALICE_TOKEN}`,
          },
          body: JSON.stringify({
            imageUrl: "https://cdn.example.com/img.jpg",
            reason: "wrong_place",
          }),
        },
      );
      const reportInserts = fakeSc.__inserts.filter((i) => i.table === "place_image_reports");
      assert.equal(reportInserts.length, 1, "exactly one place_image_reports row must be inserted");
      const inserted = reportInserts[0].row;
      assert.equal(inserted.place_id, PLACE_ID_DB);
      assert.equal(inserted.report_reason, "wrong_place");
      assert.equal(inserted.reported_by, ALICE_ID);
      assert.equal(inserted.status, "pending");
    } finally {
      await a.close();
      _setTestClient(null as any, false);
    }
  });
});

describe("POST /api/places/:id/image-report — unauthenticated", () => {
  let app: TestApp;

  before(async () => {
    app = await startTestApp(makeFakeSc({ placeExists: true }));
  });

  after(async () => {
    await app.close();
    _setTestClient(null as any, false);
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const encodedId = encodeURIComponent(PLACE_ID_DB);
    const res = await fetch(
      `${app.baseUrl}/api/places/${encodedId}/image-report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: "https://cdn.example.com/img.jpg", reason: "wrong_place" }),
      },
    );
    assert.equal(res.status, 401);
  });

  it("returns 401 when bearer token is invalid", async () => {
    const encodedId = encodeURIComponent(PLACE_ID_DB);
    const res = await fetch(
      `${app.baseUrl}/api/places/${encodedId}/image-report`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer tok-invalid",
        },
        body: JSON.stringify({ imageUrl: "https://cdn.example.com/img.jpg", reason: "wrong_place" }),
      },
    );
    assert.equal(res.status, 401);
  });
});

describe("POST /api/places/:id/image-report — unknown placeId", () => {
  let app: TestApp;

  before(async () => {
    // placeExists: false → discovery_places lookup returns null → 404
    app = await startTestApp(makeFakeSc({ placeExists: false }));
  });

  after(async () => {
    await app.close();
    _setTestClient(null as any, false);
  });

  it("returns 404 when discovery_places has no row for the given ID", async () => {
    const unknownId = encodeURIComponent("db/ffffffff-ffff-ffff-ffff-ffffffffffff");
    const res = await fetch(
      `${app.baseUrl}/api/places/${unknownId}/image-report`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ALICE_TOKEN}`,
        },
        body: JSON.stringify({ imageUrl: "https://cdn.example.com/img.jpg", reason: "wrong_place" }),
      },
    );
    assert.equal(res.status, 404);
    const body = await res.json() as any;
    assert.equal(body.error, "not_found");
  });

  it("returns 404 for an OSM-style ID that is not in discovery_places", async () => {
    const unknownOsm = encodeURIComponent("osm/node/9999999999");
    const res = await fetch(
      `${app.baseUrl}/api/places/${unknownOsm}/image-report`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ALICE_TOKEN}`,
        },
        body: JSON.stringify({ imageUrl: "https://cdn.example.com/img.jpg", reason: "wrong_place" }),
      },
    );
    assert.equal(res.status, 404);
  });

  it("does not insert any place_image_reports row when the place is not found", async () => {
    const fakeSc = makeFakeSc({ placeExists: false });
    const a = await startTestApp(fakeSc);
    try {
      const unknownId = encodeURIComponent("db/ffffffff-ffff-ffff-ffff-ffffffffffff");
      await fetch(
        `${a.baseUrl}/api/places/${unknownId}/image-report`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${ALICE_TOKEN}`,
          },
          body: JSON.stringify({ imageUrl: "https://cdn.example.com/img.jpg", reason: "wrong_place" }),
        },
      );
      const reportInserts = fakeSc.__inserts.filter((i) => i.table === "place_image_reports");
      assert.equal(reportInserts.length, 0, "no place_image_reports row must be inserted for an unknown place");
    } finally {
      await a.close();
      _setTestClient(null as any, false);
    }
  });
});

describe("POST /api/places/:id/image-report — invalid reason", () => {
  let app: TestApp;

  before(async () => {
    app = await startTestApp(makeFakeSc({ placeExists: true }));
  });

  after(async () => {
    await app.close();
    _setTestClient(null as any, false);
  });

  it("returns 400 for an unrecognised reason value", async () => {
    const encodedId = encodeURIComponent(PLACE_ID_DB);
    const res = await fetch(
      `${app.baseUrl}/api/places/${encodedId}/image-report`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ALICE_TOKEN}`,
        },
        body: JSON.stringify({ imageUrl: "https://cdn.example.com/img.jpg", reason: "not_a_real_reason" }),
      },
    );
    assert.equal(res.status, 400);
  });

  it("returns 400 when reason is missing entirely", async () => {
    const encodedId = encodeURIComponent(PLACE_ID_DB);
    const res = await fetch(
      `${app.baseUrl}/api/places/${encodedId}/image-report`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ALICE_TOKEN}`,
        },
        body: JSON.stringify({ imageUrl: "https://cdn.example.com/img.jpg" }),
      },
    );
    assert.equal(res.status, 400);
  });

  it("returns 400 when imageUrl is missing", async () => {
    const encodedId = encodeURIComponent(PLACE_ID_DB);
    const res = await fetch(
      `${app.baseUrl}/api/places/${encodedId}/image-report`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ALICE_TOKEN}`,
        },
        body: JSON.stringify({ reason: "wrong_place" }),
      },
    );
    assert.equal(res.status, 400);
  });
});
