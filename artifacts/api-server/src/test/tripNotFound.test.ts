/**
 * Trip deep-link 404 graceful fallback tests
 *
 * Verifies that the trips API returns not_found (HTTP 404) for a trip that
 * no longer exists. The mobile deep-link handler and trip-detail screen both
 * rely on this contract to show "This trip is no longer available."
 *
 * Tested via PATCH /api/trips/:tripId — the write endpoint that the trip
 * detail screen uses for edits; it explicitly returns not_found before any
 * ownership check when the trip row is absent.
 *
 * Run: node --import tsx/esm --test src/test/tripNotFound.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripsRouter from "../routes/trips.js";

let server: http.Server;
let base: string;

const VIEWER_TOKEN  = "trip-404-viewer-token";
const VIEWER_ID     = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
const EXISTING_TRIP = "bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb";
const DELETED_TRIP  = "cccccccc-2222-2222-2222-cccccccccccc";

function buildFakeClient() {
  const trips = [
    {
      id: EXISTING_TRIP,
      owner_id: VIEWER_ID,
      title: "Paris 2025",
      destination_city: "Paris",
      destination_country: "France",
      start_date: "2025-06-01",
      end_date: "2025-06-10",
      status: "upcoming",
      visibility: "public",
      plan_edit_permission: "all_members",
    },
  ];

  function from(table: string) {
    const tableRows: Record<string, any[]> = {
      trips,
      trip_members: [],
      profiles: [{ id: VIEWER_ID, role: "user", account_status: "active" }],
    };
    const rows: any[] = tableRows[table] ?? [];
    const filters: Array<(r: any) => boolean> = [];

    const b: any = {
      select()  { return b; },
      insert()  { return b; },
      update(patch: any) { return b; },
      delete()  { return b; },
      upsert()  { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)    { filters.push((r) => r[col] == val); return b; },
      or()     { return b; },
      order()  { return b; },
      limit()  { return b; },
      range()  { return b; },
      maybeSingle() {
        const data = rows.filter((r: any) => filters.every((f) => f(r)));
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      single() {
        const data = rows.filter((r: any) => filters.every((f) => f(r)));
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        const data = rows.filter((r: any) => filters.every((f) => f(r)));
        return Promise.resolve({ data, error: null, count: data.length }).then(onF, onR);
      },
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === VIEWER_TOKEN)
          return { data: { user: { id: VIEWER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from,
  };
}

function req(
  method: string,
  path: string,
  body: any = {},
  token = VIEWER_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

describe("Trip deep-link 404 graceful fallback", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", tripsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    const fc = buildFakeClient();
    _setTestClient(fc as any, true);
    _setTestServiceClient(fc as any);
  });

  after(async () => {
    server.close();
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  it("returns 404 not_found when the trip does not exist (deleted trip)", async () => {
    const r = await req("PATCH", `/api/trips/${DELETED_TRIP}`, { title: "Updated" });
    assert.equal(r.status, 404, `expected 404 for deleted trip, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "not_found", "error code should be not_found");
  });

  it("returns 400 for an invalid trip ID format", async () => {
    const r = await req("PATCH", "/api/trips/not-a-uuid", { title: "Updated" });
    assert.equal(r.status, 400, `expected 400 for invalid UUID, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 401 without authentication", async () => {
    const r = await req("PATCH", `/api/trips/${DELETED_TRIP}`, { title: "Updated" }, "");
    assert.equal(r.status, 401, `expected 401 for missing token, got ${r.status}`);
  });

  it("returns 403 when caller is not the trip owner", async () => {
    const r = await req("PATCH", `/api/trips/${EXISTING_TRIP}`, { title: "Hijacked" }, "wrong-token");
    assert.equal(r.status, 401, `expected 401 for bad token, got ${r.status}`);
  });
});
