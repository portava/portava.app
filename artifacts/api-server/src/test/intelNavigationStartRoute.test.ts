import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import router from "../routes/intel.js";
import { _setTestClient, _setTestServiceClient } from "../lib/http.js";

const TOKEN = "route-token";
const ACTOR = "11111111-1111-4111-8111-111111111111";

function fakeClient(protectedDestination = false) {
  const events: any[] = [];
  const selects: string[] = [];
  const tables: Record<string, any[]> = {
    canonical_locations: [{ id: "zone-a", lat: 1, lng: 1 }, { id: "zone-b", lat: 2, lng: 2 }],
    protected_zones: protectedDestination
      ? [{ shape: "circle", category: "shelter", center_lat: 2, center_lng: 2, radius_meters: 1000 }]
      : [],
  };
  const client: any = {
    events, selects,
    auth: { getUser: async () => ({ data: { user: { id: ACTOR } }, error: null }) },
    rpc: async (name: string) => {
      if (name === "consume_intel_sensing_credential") return { data: { outcome: "authorized", actor_id: ACTOR, device_id: "device-1" }, error: null };
      if (name === "is_sensing_device_eligible") return { data: true, error: null };
      return { data: null, error: null };
    },
    from(table: string) {
      let payload: any;
      let filters: Record<string, any> = {};
      const b: any = {
        select(columns: string) { selects.push(`${table}:${columns}`); return b; },
        eq(column: string, value: any) { filters[column] = value; return b; },
        is() { return b; }, in() { return b; }, gte() { return b; }, lte() { return b; },
        maybeSingle: async () => {
          if (table === "feature_flags") return { data: { enabled: true }, error: null };
          if (table === "intel_contribution_consent") return { data: { enabled: true, withdrawn_at: null, consent_version: "v1" }, error: null };
          if (table === "canonical_locations") return { data: tables[table].find((r) => r.id === filters.id) ?? null, error: null };
          return { data: null, error: null };
        },
        insert(row: any) { payload = row; events.push(...(Array.isArray(row) ? row : [row])); return b; },
        then(resolve: any) {
          if (table === "protected_zones") return Promise.resolve({ data: tables[table], error: null }).then(resolve);
          if (table === "active_crews") return Promise.resolve({ data: [], error: null }).then(resolve);
          if (table === "intel_contribution_consent") return Promise.resolve({ data: { enabled: true, withdrawn_at: null }, error: null }).then(resolve);
          if (table === "canonical_events") return Promise.resolve({ data: payload, error: null }).then(resolve);
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return b;
    },
  };
  return client;
}

let server: http.Server;
let base: string;
function request(body: any) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(`${base}/api/v1/intel/navigation-start`, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Sensing-Credential": "c".repeat(64), "X-Sensing-Nonce": "n".repeat(64), "X-Sensing-Device": "device-1" },
    }, (res) => { let raw = ""; res.on("data", (c) => raw += c); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw) })); });
    req.on("error", reject); req.write(JSON.stringify(body)); req.end();
  });
}

before(() => {
  const app = express(); app.use(express.json()); app.use("/api", router);
  return new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); }); });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("POST /api/v1/intel/navigation-start", () => {
  it("records ordinary canonical zones and requests lat,lng", async () => {
    const c = fakeClient(); _setTestClient(c, true); _setTestServiceClient(c);
    const r = await request({ fromZoneId: "zone-a", toZoneId: "zone-b" });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(c.events.length, 1);
    assert.equal(c.events[0].verb, "direction"); assert.ok(c.selects.includes("canonical_locations:lat,lng"));
  });
  it("denies a protected endpoint without recording", async () => {
    const c = fakeClient(true); _setTestClient(c, true); _setTestServiceClient(c);
    const r = await request({ fromZoneId: "zone-a", toZoneId: "zone-b" });
    assert.equal(r.status, 403); assert.equal(c.events.length, 0);
  });
});