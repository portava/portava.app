/**
 * Country essentials — data + route tests.
 *
 * Data tests validate the curated dataset's shape/accuracy invariants (no
 * fabrication slips: valid plug letters, sane voltage/frequency, drive side).
 * Route tests cover flag gating, DB-first-then-lib resolution, honest-unknown
 * for uncovered countries, and the trip-destination aggregation.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import countryEssentialsRouter from "../routes/countryEssentials.js";
import {
  COUNTRY_ESSENTIALS,
  essentialsFor,
  CONFIRM_DISCLAIMER,
} from "../lib/countryEssentials.js";

// ── Data invariants ───────────────────────────────────────────────────────────

describe("country essentials dataset", () => {
  const VALID_PLUGS = new Set("ABCDEFGHIJKLMNO".split(""));

  it("every entry has valid plug letters, sane voltage/frequency, drive side", () => {
    for (const [code, e] of Object.entries(COUNTRY_ESSENTIALS)) {
      assert.match(code, /^[A-Z]{2}$/, `bad code ${code}`);
      assert.ok(e.plugTypes.length > 0, `${code} has no plugs`);
      for (const p of e.plugTypes) assert.ok(VALID_PLUGS.has(p), `${code} bad plug ${p}`);
      assert.ok(e.voltage >= 100 && e.voltage <= 240, `${code} voltage ${e.voltage}`);
      assert.ok(e.frequency === 50 || e.frequency === 60, `${code} freq ${e.frequency}`);
      assert.ok(e.driveSide === "left" || e.driveSide === "right", `${code} drive ${e.driveSide}`);
      assert.ok(Object.keys(e.emergency).length > 0, `${code} has no emergency number`);
    }
  });

  it("spot-checks known-good values", () => {
    assert.deepEqual(essentialsFor("us")!.emergency, { all: "911" });
    assert.equal(essentialsFor("GB")!.plugTypes[0], "G");
    assert.equal(essentialsFor("jp")!.voltage, 100);
    assert.equal(essentialsFor("JP")!.emergency.police, "110");
    assert.equal(essentialsFor("au")!.driveSide, "left");
    assert.equal(essentialsFor("fr")!.emergency.all, "112");
  });

  it("returns null for uncovered / bad input (honest unknown)", () => {
    assert.equal(essentialsFor("ZZ"), null);
    assert.equal(essentialsFor(null), null);
    assert.equal(essentialsFor(""), null);
  });
});

// ── Route tests ────────────────────────────────────────────────────────────────

function makeSc(opts: { flagOn?: boolean; dbRow?: any; dests?: any[]; trip?: any } = {}) {
  return {
    auth: { getUser: async (t: string) => (t ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: {} }) },
    from(table: string) {
      const b: any = {
        _f: [] as Array<[string, any]>,
        select() { return b; },
        eq(k: string, v: any) { b._f.push([k, v]); return b; },
        order() { return b; },
        maybeSingle: async () => {
          if (table === "feature_flags") return { data: { enabled: opts.flagOn === true }, error: null };
          if (table === "country_essentials") return { data: opts.dbRow ?? null, error: null };
          if (table === "trips") return { data: opts.trip ?? null, error: null };
          if (table === "trip_members") return { data: { role: "owner" }, error: null };
          return { data: null, error: null };
        },
        then(resolve: any) {
          if (table === "trip_destinations") { resolve({ data: opts.dests ?? [], error: null }); return; }
          resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as any;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error() {}, warn() {}, info() {} }; next(); });
  app.use("/api", countryEssentialsRouter);
  return app;
}

function get(server: http.Server, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as any;
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method: "GET", headers: { authorization: "Bearer t" } },
      (res) => { let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); }); },
    );
    r.on("error", reject);
    r.end();
  });
}

let server: http.Server;
function useClient(sc: any) { _setTestClient(sc, true); _setTestServiceClient(sc); }

before(async () => {
  server = http.createServer(buildApp());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
after(async () => { _clearTestClient(); _setTestServiceClient(null as any); await new Promise<void>((r) => server.close(() => r())); });

describe("GET /countries/:code/essentials", () => {
  it("is flag-gated", async () => {
    useClient(makeSc({ flagOn: false }));
    const { body } = await get(server, "/api/countries/US/essentials");
    assert.equal(body.enabled, false);
    assert.equal(body.essentials, null);
  });

  it("returns curated lib data when no DB row (fallback)", async () => {
    useClient(makeSc({ flagOn: true, dbRow: null }));
    const { body } = await get(server, "/api/countries/JP/essentials");
    assert.equal(body.enabled, true);
    assert.equal(body.essentials.voltage, 100);
    assert.equal(body.essentials.emergency.police, "110");
    assert.equal(body.essentials.disclaimer, CONFIRM_DISCLAIMER);
  });

  it("prefers the DB row over lib data (admin edits win)", async () => {
    useClient(makeSc({ flagOn: true, dbRow: { code: "US", plug_types: ["A"], voltage: 120, frequency: 60, drive_side: "right", emergency: { all: "911-edited" }, confidence: "curated", source: "admin", last_verified_at: "2026-07-24" } }));
    const { body } = await get(server, "/api/countries/US/essentials");
    assert.equal(body.essentials.emergency.all, "911-edited");
  });

  it("resolves a country NAME to ISO2", async () => {
    useClient(makeSc({ flagOn: true }));
    const { body } = await get(server, "/api/countries/Japan/essentials");
    assert.equal(body.essentials?.code, "JP");
  });

  it("returns null essentials for an uncovered country (honest unknown, not a guess)", async () => {
    useClient(makeSc({ flagOn: true }));
    const { body } = await get(server, "/api/countries/AQ/essentials");
    assert.equal(body.enabled, true);
    assert.equal(body.essentials, null);
  });
});

describe("GET /trips/:tripId/essentials", () => {
  const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
  it("aggregates destination countries from trip_destinations", async () => {
    useClient(makeSc({ flagOn: true, dests: [{ country: "France", position: 0 }, { country: "IT", position: 1 }] }));
    const { body } = await get(server, `/api/trips/${TRIP}/essentials`);
    assert.equal(body.enabled, true);
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].country, "FR");
    assert.equal(body.items[0].essentials.emergency.all, "112");
    assert.equal(body.items[1].country, "IT");
    assert.equal(body.disclaimer, CONFIRM_DISCLAIMER);
  });

  it("falls back to the trip's primary destination_country", async () => {
    useClient(makeSc({ flagOn: true, dests: [], trip: { destination_country: "Thailand" } }));
    const { body } = await get(server, `/api/trips/${TRIP}/essentials`);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].country, "TH");
    assert.equal(body.items[0].essentials.emergency.police, "191");
  });

  it("is flag-gated", async () => {
    useClient(makeSc({ flagOn: false }));
    const { body } = await get(server, `/api/trips/${TRIP}/essentials`);
    assert.equal(body.enabled, false);
    assert.deepEqual(body.items, []);
  });
});
