/**
 * GPS check-in range gate — focused integration tests
 *
 * Covers the four behaviours the verify-visit route must always satisfy:
 *   1. Within-range (success path) — ok=true, visit + verification row inserted
 *   2. Out-of-range  — withinRange=false, error=too_far, visit recorded for audit
 *   3. Suspicious    — at exact gem location but flagged by trust history
 *   4. Upgrade       — unverified gem promoted to community on 5th confirmation
 *
 * Uses the same node:test + fake-client pattern as hiddenGems.test.ts.
 * The fake client here adds `count: r.length` to resolveList so that
 * Supabase `.select("id", { count: "exact", head: true })` works correctly
 * for the upgrade-threshold check inside HiddenGemVerificationService.
 *
 * Run: node --import tsx/esm --test src/test/hiddenGemCheckin.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "checkin-gate-token";
const USER_ID    = "user-cg-1";
const GEM_ID     = "gem-cg-1";

const GEM_LAT = 35.6762;  // Tokyo
const GEM_LNG = 139.6503;

// ~111 m north of the gem — within 200 m threshold
const NEAR_LAT  = GEM_LAT + 0.001;
const NEAR_LNG  = GEM_LNG;

// London — ~9000 km from Tokyo
const FAR_LAT   = 51.5074;
const FAR_LNG   = -0.1278;

const COMMUNITY_CONFIRMATIONS_NEEDED = 5; // mirrors constant in HiddenGemVerificationService

// ── Server setup ──────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", hiddenGemsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

// ── HTTP helper ───────────────────────────────────────────────────────────────

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
    };
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
        res.on("data", (c) => (raw += c));
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

// ── Fake client ───────────────────────────────────────────────────────────────

interface FakeState {
  featureFlags?:    Record<string, boolean>;
  gems?:            Record<string, any>[];
  gemVisits?:       Record<string, any>[];
  gemVerifications?: Record<string, any>[];
  locationTrust?:   Record<string, any>[];
}

function makeFakeClient(state: FakeState, userId: string) {
  const inserted: Array<{ table: string; row: any }> = [];
  const updated:  Array<{ table: string; patch: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;

    const builder: any = {
      select()               { return builder; },
      insert(row: any)       { pendingInsert = row; inserted.push({ table, row }); return builder; },
      update(patch: any)     { updated.push({ table, patch }); return builder; },
      upsert(row: any)       { inserted.push({ table, row }); return builder; },
      delete()               { return builder; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return builder; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any)    {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return builder;
      },
      gt(col: string, val: any)    { filters.push((r) => r[col] > val); return builder; },
      lte(col: string, val: any)   { filters.push((r) => r[col] <= val); return builder; },
      ilike(col: string, val: any) {
        filters.push((r) => typeof r[col] === "string" && r[col].toLowerCase() === val.toLowerCase());
        return builder;
      },
      not(col: string, op: string, val: any) {
        if (op === "eq") filters.push((r) => r[col] !== val);
        return builder;
      },
      order()  { return builder; },
      limit()  { return builder; },
      range()  { return builder; },
      maybeSingle() { return resolveSingle(true); },
      single() {
        if (pendingInsert) {
          const id = pendingInsert.id ?? `generated-${Date.now()}`;
          return Promise.resolve({ data: { ...pendingInsert, id }, error: null });
        }
        return resolveSingle(false);
      },
      // count: r.length is required so HiddenGemVerificationService's
      // `.select("id", { count: "exact", head: true })` returns a real count
      // rather than undefined, enabling the upgrade-threshold check to work.
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): any[] {
      const tableData: Record<string, any[]> = {
        feature_flags:            Object.entries(state.featureFlags ?? {}).map(([key, enabled]) => ({ flag: key, enabled })),
        hidden_gems:              state.gems ?? [],
        hidden_gem_visits:        state.gemVisits ?? [],
        hidden_gem_verifications: state.gemVerifications ?? [],
        location_trust_events:    state.locationTrust ?? [],
        // location_snapshots always empty → checkAndRecordSnapshot returns trusted
        location_snapshots:       [],
      };
      return (tableData[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }

    function resolveSingle(nullable: boolean) {
      const filtered = rows();
      if (filtered.length === 0) {
        if (nullable) return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: null, error: { message: "not found", code: "PGRST116" } });
      }
      return Promise.resolve({ data: filtered[0], error: null });
    }

    function resolveList() {
      const r = rows();
      // count mirrors Supabase's { count: "exact" } behaviour so threshold
      // comparisons in HiddenGemVerificationService work correctly.
      return Promise.resolve({ data: r, error: null, count: r.length });
    }

    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) return { data: { user: { id: userId } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from,
    rpc: async () => ({ data: null, error: null }),
    _inserted: inserted,
    _updated:  updated,
  };

  return client;
}

// ── Gem helper ────────────────────────────────────────────────────────────────

function makeGem(overrides: Partial<any> = {}): any {
  return {
    id:                GEM_ID,
    name:              "Hidden Courtyard",
    category:          "viewpoint",
    city:              "Tokyo",
    country:           "Japan",
    latitude:          GEM_LAT,
    longitude:         GEM_LNG,
    approx_latitude:   GEM_LAT,
    approx_longitude:  GEM_LNG,
    verification_level: "community",
    status:            "active",
    submitted_by:      "other-user",
    visit_count:       3,
    save_count:        7,
    sensitivity_level: "public",
    created_at:        "2026-01-01T00:00:00Z",
    updated_at:        "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 1. Within-range check-in — success path
// ─────────────────────────────────────────────────────────────────────────────

describe("GPS check-in — within range (success path)", () => {
  it("returns ok=true and withinRange=true when user is within 200 m", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems:            [makeGem()],
        gemVisits:       [],
        gemVerifications: [],
        locationTrust:   [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: NEAR_LAT, longitude: NEAR_LNG,
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.withinRange, true);
    assert.equal(r.body.isSuspicious, false);
    assert.ok(r.body.distanceM !== null, "distanceM should be set");
    assert.ok(r.body.distanceM <= 200, `distanceM should be ≤ 200 m, got ${r.body.distanceM}`);
  });

  it("inserts a visit row and an approved verification row on a clean check-in", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems:            [makeGem()],
        gemVisits:       [],
        gemVerifications: [],
        locationTrust:   [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: NEAR_LAT, longitude: NEAR_LNG,
    });

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("hidden_gem_visits"), "visit row must be recorded");
    assert.ok(tables.includes("hidden_gem_verifications"), "verification row must be recorded");

    const verRow = client._inserted.find((i: any) => i.table === "hidden_gem_verifications");
    assert.equal(verRow?.row?.result, "approved", "verification result must be 'approved'");
    assert.equal(verRow?.row?.method, "gps_proximity");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Out-of-range rejection — range gate
// ─────────────────────────────────────────────────────────────────────────────

describe("GPS check-in — out-of-range rejection", () => {
  it("returns withinRange=false and error=too_far when user is far away", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems:            [makeGem()],
        gemVisits:       [],
        gemVerifications: [],
        locationTrust:   [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // London is ~9000 km from Tokyo — clearly outside the 200 m threshold
    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: FAR_LAT, longitude: FAR_LNG,
    });

    assert.equal(r.body.withinRange, false);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "too_far");
    assert.ok(r.body.distanceM > 200, `distanceM should be > 200 m, got ${r.body.distanceM}`);
  });

  it("still inserts a visit row for audit trail when out of range", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems:            [makeGem()],
        gemVisits:       [],
        gemVerifications: [],
        locationTrust:   [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: FAR_LAT, longitude: FAR_LNG,
    });

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("hidden_gem_visits"), "audit visit row must be recorded even when too_far");
    // No approved verification row should be written for out-of-range
    const approvedVer = client._inserted.find(
      (i: any) => i.table === "hidden_gem_verifications" && i.row?.result === "approved",
    );
    assert.equal(approvedVer, undefined, "no approved verification row for out-of-range check-in");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Suspicious location detection
// ─────────────────────────────────────────────────────────────────────────────

describe("GPS check-in — suspicious location (fake GPS history)", () => {
  it("flags isSuspicious=true when user has a high-confidence trust event", async () => {
    // User is physically at the gem location (distance = 0) but their account
    // has a prior high-confidence fake-GPS event, so the check-in is flagged.
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems:            [makeGem()],
        gemVisits:       [],
        gemVerifications: [],
        locationTrust: [
          {
            user_id:     USER_ID,
            event_type:  "impossible_speed",
            confidence:  "high",
            created_at:  new Date().toISOString(), // within 7-day window
            reviewed_at: null,
          },
        ],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // User at exact gem coords — distance = 0, clearly within range
    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: GEM_LAT, longitude: GEM_LNG,
    });

    assert.equal(r.body.withinRange, true, "within range despite suspicion");
    assert.equal(r.body.isSuspicious, true, "must be flagged suspicious");
    assert.ok(r.body.distanceM === 0 || r.body.distanceM === null || r.body.distanceM <= 5,
      `distance should be near-zero, got ${r.body.distanceM}`);
  });

  it("writes a suspicious verification row, not an approved one, when flagged", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems:            [makeGem()],
        gemVisits:       [],
        gemVerifications: [],
        locationTrust: [
          {
            user_id:     USER_ID,
            event_type:  "impossible_speed",
            confidence:  "high",
            created_at:  new Date().toISOString(),
            reviewed_at: null,
          },
        ],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: GEM_LAT, longitude: GEM_LNG,
    });

    const verRows = client._inserted.filter((i: any) => i.table === "hidden_gem_verifications");
    assert.ok(verRows.length >= 1, "a verification row should be written for audit");
    const suspicious = verRows.find((i: any) => i.row?.result === "suspicious");
    assert.ok(suspicious, "verification result must be 'suspicious'");
    const approved = verRows.find((i: any) => i.row?.result === "approved");
    assert.equal(approved, undefined, "no approved verification row for suspicious check-in");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Verification level upgrade
// ─────────────────────────────────────────────────────────────────────────────

describe("GPS check-in — verification level upgrade", () => {
  it(`upgrades an unverified gem to community when ${COMMUNITY_CONFIRMATIONS_NEEDED} GPS confirmations are recorded`, async () => {
    // Seed exactly COMMUNITY_CONFIRMATIONS_NEEDED existing approved verifications.
    // resolveList() returns count = rows().length, so the threshold check fires.
    const existingVerifications = Array.from({ length: COMMUNITY_CONFIRMATIONS_NEEDED }, (_, i) => ({
      id:      `ver-existing-${i}`,
      gem_id:  GEM_ID,
      user_id: `other-user-${i}`,
      result:  "approved",
      method:  "gps_proximity",
    }));

    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems:            [makeGem({ verification_level: "unverified" })],
        gemVisits:       [],
        gemVerifications: existingVerifications,
        locationTrust:   [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: NEAR_LAT, longitude: NEAR_LNG,
    });

    assert.equal(r.body.ok, true);
    assert.equal(r.body.withinRange, true);
    assert.equal(r.body.isSuspicious, false);
    assert.equal(r.body.verificationUpgraded, true, "gem should be upgraded to community level");

    // The hidden_gems table should have received an update with verification_level=community
    const upgradeUpdate = client._updated.find(
      (u: any) => u.table === "hidden_gems" && u.patch?.verification_level === "community",
    );
    assert.ok(upgradeUpdate, "hidden_gems must be updated with verification_level=community");
  });

  it("does not upgrade a gem that is already at community level", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems:            [makeGem({ verification_level: "community" })],
        gemVisits:       [],
        gemVerifications: [],
        locationTrust:   [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: NEAR_LAT, longitude: NEAR_LNG,
    });

    assert.equal(r.body.ok, true);
    assert.equal(r.body.verificationUpgraded, false, "community gem should not be re-upgraded");

    const upgradeUpdate = client._updated.find(
      (u: any) => u.table === "hidden_gems" && u.patch?.verification_level === "community",
    );
    assert.equal(upgradeUpdate, undefined, "no upgrade update should be written for already-community gem");
  });
});
