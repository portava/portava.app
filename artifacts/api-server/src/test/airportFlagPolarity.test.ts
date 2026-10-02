/**
 * Airport / Layover Mode — feature-flag gates are FAIL-CLOSED.
 *
 * RED-PROOF. routes/airport.ts used to define its own `isFlagEnabled` under the
 * same name as the shared helper in lib/featureFlags.ts, with the polarity
 * inverted:
 *
 *     if (error)       return true;   // DB error       → feature ON
 *     if (data == null) return true;  // flag not seeded → feature ON
 *     catch            { return true; }
 *
 * Every other reader of a capability flag in this codebase — the shared helper
 * and all five remaining declared shadows — returns false in exactly those
 * cases. A caller reading `isFlagEnabled` in airport.ts therefore got the
 * OPPOSITE of what the same call spelled the same way meant anywhere else.
 *
 * These tests go through the real routes rather than the helper, so they hold
 * regardless of whether the helper is local, imported, or refactored again
 * later. Each one FAILS against the inverted implementation (the route reports
 * featureEnabled:true / serves content) and passes against the shared contract.
 *
 * Run: node --import tsx/esm --test src/test/airportFlagPolarity.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import airportRouter from "../routes/airport.js";

let server: http.Server;
let base: string;
const TOKEN = "airport-polarity-token";
const USER_ID = "d0000000-0000-4000-a000-000000000001";

function req(
  method: string,
  path: string,
  body?: any,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    };
    if (payload) headers["content-length"] = Buffer.byteLength(payload).toString();
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * `mode` describes what the feature_flags table does:
 *   "norow"  — table healthy, no row for the flag  (data: null, error: null)
 *   "error"  — query returns an error object       (data: null, error: {...})
 *   "throw"  — the query throws
 *   "on"     — row present and enabled
 * Every other table answers empty so routes that get past the gate still run.
 */
function makeClient(mode: "norow" | "error" | "throw" | "on") {
  function builder(table: string) {
    const b: any = {
      select() { return b; },
      insert() { return b; },
      update() { return b; },
      delete() { return b; },
      eq() { return b; }, neq() { return b; }, in() { return b; }, not() { return b; },
      // `ilike` was missing: the airport resolvers filter with it, so calling
      // them against this fake threw a TypeError that the service used to
      // swallow as "not in the DB". Now that a failed read is reported rather
      // than swallowed, the gap is visible — a real PostgREST builder has it.
      ilike() { return b; },
      is() { return b; }, gte() { return b; }, lte() { return b; }, gt() { return b; },
      lt() { return b; }, or() { return b; }, order() { return b; }, limit() { return b; },
      range() { return b; }, single() { return b.maybeSingle(); },
      maybeSingle() {
        if (table === "feature_flags") {
          if (mode === "throw") throw new Error("feature_flags unreachable");
          if (mode === "error") {
            return Promise.resolve({ data: null, error: { message: "relation does not exist" } });
          }
          if (mode === "norow") return Promise.resolve({ data: null, error: null });
          return Promise.resolve({ data: { enabled: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  } as any;
}

function setClients(c: any) {
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});

after(() => new Promise<void>((r) => server.close(() => r())));

// ── The inversion, one case per failure mode ─────────────────────────────────

describe("airport gates fail CLOSED (shared isFlagEnabled contract)", () => {
  // Under the old shadow: `if (data == null) return true` → featureEnabled true.
  it("no feature_flags row → search reports featureEnabled:false", async () => {
    setClients(makeClient("norow"));
    const r = await req("GET", "/api/airport/search?iata=CEB");
    assert.equal(r.status, 200);
    assert.equal(
      r.body.featureEnabled,
      false,
      "an unseeded airport_mode_enabled must leave the feature OFF, not ON",
    );
    assert.deepEqual(r.body.airports, []);
  });

  // Under the old shadow: `if (error) return true` → featureEnabled true.
  it("feature_flags read errors → search reports featureEnabled:false", async () => {
    setClients(makeClient("error"));
    const r = await req("GET", "/api/airport/search?iata=CEB");
    assert.equal(r.status, 200);
    assert.equal(
      r.body.featureEnabled,
      false,
      "an unhealthy DB must leave the feature OFF, not ON",
    );
  });

  // Under the old shadow: `catch { return true }` → featureEnabled true.
  it("feature_flags read throws → search reports featureEnabled:false", async () => {
    setClients(makeClient("throw"));
    const r = await req("GET", "/api/airport/search?iata=CEB");
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, false);
  });

  // The error-shaped gate, same inversion: under the old shadow this route let
  // the request through to session creation instead of refusing it.
  // `feature_disabled` maps to 404 in lib/http.ts's status table.
  it("no feature_flags row → session create is refused as feature_disabled", async () => {
    setClients(makeClient("norow"));
    const r = await req("POST", "/api/airport/sessions", {
      iata: "CEB",
      arrivalWallTime: "2026-08-12T10:00",
      departureWallTime: "2026-08-12T18:00",
    });
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(r.status, 404);
  });

  it("no feature_flags row → pulse reports featureEnabled:false", async () => {
    setClients(makeClient("norow"));
    const r = await req("GET", "/api/airport/pulse?iata=CEB");
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, false);
  });

  // Control: the gate is not simply stuck closed. A present, enabled row still
  // opens it — so the three assertions above are about polarity, not about the
  // fake client failing to answer at all.
  it("row present and enabled → gate opens", async () => {
    setClients(makeClient("on"));
    const r = await req("GET", "/api/airport/search?iata=CEB");
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
  });
});
