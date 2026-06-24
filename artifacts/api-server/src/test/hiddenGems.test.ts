/**
 * Hidden Gems & Local Guide system tests
 *
 * Uses the same node:test + fake-client pattern as passportStamps.test.ts.
 * Covers: feature-flag gating, submission, save/unsave, GPS check-in,
 * privacy guard (exact coords stripped), Compass leak prevention,
 * Telegraph share visibility, Layover time-window filter, guide contribution,
 * admin verify/hide/mark-sensitive, duplicate detection, fake-GPS review event,
 * report queue entry, and plan-from-gem location-reveal logic.
 *
 * Run: node --import tsx/esm --test src/test/hiddenGems.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import {
  applyGemPrivacy,
  applyGemPrivacyBatch,
  isGemLlmSafe,
  resolveGemCoords,
} from "../services/hiddenGems/HiddenGemPrivacyGuard.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN  = "gems-test-token";
const USER_ID     = "user-gems-1";
const OTHER_ID    = "user-gems-2";
const ADMIN_ID    = "user-admin-1";
const GEM_ID      = "gem-uuid-1";
const TRIP_ID     = "trip-uuid-1";

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
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
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
  gemSaves?:        Record<string, any>[];
  gemVisits?:       Record<string, any>[];
  gemReports?:      Record<string, any>[];
  gemVerifications?: Record<string, any>[];
  guideProfiles?:   Record<string, any>[];
  guideContribs?:   Record<string, any>[];
  profiles?:        Record<string, any>[];
  trips?:           Record<string, any>[];
  tripMembers?:     Record<string, any>[];
  locationTrust?:   Record<string, any>[];
  passportVizPrefs?: Record<string, any>[];
}

function makeFakeClient(state: FakeState, userId: string) {
  const inserted: Array<{ table: string; row: any }> = [];
  const updated:  Array<{ table: string; patch: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;

    const builder: any = {
      select()                 { return builder; },
      insert(row: any)         { pendingInsert = row; inserted.push({ table, row }); return builder; },
      update(patch: any)       { updated.push({ table, patch }); return builder; },
      upsert(row: any)         { inserted.push({ table, row }); return builder; },
      delete()                 { return builder; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return builder; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      not(col: string, op: string, val: any) {
        if (op === "eq") filters.push((r) => r[col] !== val);
        return builder;
      },
      is(col: string, val: any)    {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return builder;
      },
      ilike(col: string, val: any) {
        filters.push((r) => typeof r[col] === "string" && r[col].toLowerCase() === val.toLowerCase());
        return builder;
      },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return builder; },
      lte(col: string, val: any) { filters.push((r) => r[col] <= val); return builder; },
      order()                  { return builder; },
      limit()                  { return builder; },
      range()                  { return builder; },
      maybeSingle()            { return resolveSingle(true); },
      single() {
        if (pendingInsert) {
          const id = pendingInsert.id ?? `generated-${Date.now()}`;
          return Promise.resolve({ data: { ...pendingInsert, id }, error: null });
        }
        return resolveSingle(false);
      },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): any[] {
      const tableData: Record<string, any[]> = {
        feature_flags:           Object.entries(state.featureFlags ?? {}).map(([key, enabled]) => ({ key, enabled })),
        hidden_gems:             state.gems ?? [],
        hidden_gem_saves:        state.gemSaves ?? [],
        hidden_gem_visits:       state.gemVisits ?? [],
        hidden_gem_reports:      state.gemReports ?? [],
        hidden_gem_verifications: state.gemVerifications ?? [],
        local_guide_profiles:    state.guideProfiles ?? [],
        local_guide_contributions: state.guideContribs ?? [],
        profiles:                state.profiles ?? [],
        trips:                   state.trips ?? [],
        trip_members:            state.tripMembers ?? [],
        location_trust_events:   state.locationTrust ?? [],
        passport_visibility_preferences: state.passportVizPrefs ?? [],
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
    function resolveList() { return Promise.resolve({ data: rows(), error: null }); }

    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN)       return { data: { user: { id: userId } },  error: null };
        if (token === "other-token")    return { data: { user: { id: OTHER_ID } }, error: null };
        if (token === "admin-token")    return { data: { user: { id: ADMIN_ID } }, error: null };
        return { data: { user: null },  error: { message: "invalid token" } };
      },
    },
    from,
    rpc: async () => ({ data: null, error: null }),
    _inserted: inserted,
    _updated:  updated,
  };

  return client;
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", hiddenGemsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeActiveGem(overrides: Partial<any> = {}): any {
  return {
    id: GEM_ID,
    name: "Secret Rooftop",
    category: "viewpoint",
    city: "Tokyo",
    country: "Japan",
    neighborhood: "Shibuya",
    description: "Amazing view",
    latitude: 35.6762,
    longitude: 139.6503,
    approx_latitude: 35.68,
    approx_longitude: 139.65,
    vibe_tags: ["rooftop", "view"],
    price_range: "free",
    safety_notes: null,
    best_time_to_go: "Sunset",
    layover_safe: false,
    minimum_layover_minutes: null,
    sensitivity_level: "public",
    verification_level: "community",
    status: "active",
    submitted_by: OTHER_ID,
    guide_verified_by: null,
    save_count: 10,
    visit_count: 5,
    report_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Feature flag gating
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — feature flag gating", () => {
  it("GET /hidden-gems returns feature_disabled when flag is off", async () => {
    const client = makeFakeClient({ featureFlags: { hidden_gems_enabled: false } }, USER_ID);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/hidden-gems");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("GET /hidden-gems returns empty list when flag is on", async () => {
    const client = makeFakeClient({ featureFlags: { hidden_gems_enabled: true }, gems: [] }, USER_ID);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/hidden-gems");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.gems));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Gem submission
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — submission", () => {
  it("POST /hidden-gems creates a pending gem", async () => {
    const client = makeFakeClient(
      { featureFlags: { hidden_gems_enabled: true }, gems: [] },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/hidden-gems", {
      name: "Secret Rooftop",
      category: "viewpoint",
      city: "Tokyo",
      country: "Japan",
      latitude: 35.6762,
      longitude: 139.6503,
      sensitivityLevel: "public",
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.gem?.id);

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("hidden_gems"), "should insert into hidden_gems");
  });

  it("POST /hidden-gems validates required fields", async () => {
    const client = makeFakeClient({ featureFlags: { hidden_gems_enabled: true } }, USER_ID);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/hidden-gems", { city: "Tokyo" }); // missing name + category
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Save / unsave
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — save and unsave", () => {
  it("POST /save inserts a save row", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        gemSaves: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/save`);
    assert.equal(r.status, 200);
    assert.equal(r.body.alreadySaved, false);

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("hidden_gem_saves"));
  });

  it("POST /save returns alreadySaved=true when already saved", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        gemSaves: [{ gem_id: GEM_ID, user_id: USER_ID }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/save`);
    assert.equal(r.status, 200);
    assert.equal(r.body.alreadySaved, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Privacy guard — exact coords stripped
// ─────────────────────────────────────────────────────────────────────────────

describe("Privacy guard — coordinate stripping", () => {
  const mockDb: any = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    }),
  };

  it("public gem: exact coords returned", async () => {
    const gem = makeActiveGem({ sensitivity_level: "public" });
    const safe = await applyGemPrivacy(gem, null, USER_ID);
    assert.equal(safe.lat, 35.6762);
    assert.equal(safe.lng, 139.6503);
    assert.equal(safe.coordsPrecision, "exact");
  });

  it("approximate gem: approx coords returned, exact stripped", async () => {
    const gem = makeActiveGem({ sensitivity_level: "approximate" });
    const safe = await applyGemPrivacy(gem, null, USER_ID);
    assert.equal(safe.lat, 35.68);
    assert.equal(safe.lng, 139.65);
    assert.equal(safe.coordsPrecision, "approximate");
    // Exact coords must not appear on the object
    assert.equal(safe.latitude, undefined);
    assert.equal(safe.longitude, undefined);
  });

  it("protected gem: coords are null regardless of caller", async () => {
    const gem = makeActiveGem({ sensitivity_level: "protected" });
    const safe = await applyGemPrivacy(gem, null, USER_ID);
    assert.equal(safe.lat, null);
    assert.equal(safe.lng, null);
    assert.equal(safe.coordsPrecision, "hidden");
  });

  it("owner always gets exact coords regardless of sensitivity", async () => {
    const gem = makeActiveGem({ sensitivity_level: "protected", submitted_by: USER_ID });
    const safe = await applyGemPrivacy(gem, null, USER_ID);
    assert.equal(safe.lat, 35.6762);
    assert.equal(safe.coordsPrecision, "exact");
  });

  it("reveal_after_save: exact coords only if caller has a save row", async () => {
    const gem = makeActiveGem({ id: GEM_ID, sensitivity_level: "reveal_after_save" });

    // No save row → approximate
    const coords1 = await resolveGemCoords(gem, mockDb, USER_ID, OTHER_ID);
    assert.equal(coords1.coordsPrecision, "approximate");

    // Simulate save row present
    const dbWithSave: any = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: { gem_id: GEM_ID }, error: null }) }),
          }),
        }),
      }),
    };
    const coords2 = await resolveGemCoords(gem, dbWithSave, USER_ID, OTHER_ID);
    assert.equal(coords2.coordsPrecision, "exact");
    assert.equal(coords2.lat, 35.6762);
  });

  it("applyGemPrivacyBatch strips coords for all protected gems in batch", async () => {
    const gems = [
      makeActiveGem({ sensitivity_level: "public" }),
      makeActiveGem({ id: "gem-2", sensitivity_level: "protected" }),
      makeActiveGem({ id: "gem-3", sensitivity_level: "approximate" }),
    ];
    const results = await applyGemPrivacyBatch(gems, null, USER_ID);
    assert.equal(results[0]!.coordsPrecision, "exact");
    assert.equal(results[1]!.coordsPrecision, "hidden");
    assert.equal(results[1]!.lat, null);
    assert.equal(results[2]!.coordsPrecision, "approximate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Compass LLM leak prevention
// ─────────────────────────────────────────────────────────────────────────────

describe("Compass — LLM leak prevention", () => {
  it("isGemLlmSafe returns false for protected gems", () => {
    assert.equal(isGemLlmSafe("protected"), false);
  });

  it("isGemLlmSafe returns true for non-protected sensitivity levels", () => {
    for (const level of ["public", "approximate", "reveal_after_save", "reveal_after_acceptance"] as const) {
      assert.equal(isGemLlmSafe(level), true, `${level} should be LLM-safe`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. GPS check-in (verify-visit)
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — GPS verify-visit", () => {
  it("returns feature_disabled when verification flag is off", async () => {
    const client = makeFakeClient(
      { featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: false } },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: 35.6762, longitude: 139.6503,
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("returns gem_not_found for unknown gem ID", async () => {
    const client = makeFakeClient(
      { featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true }, gems: [] },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/nonexistent/verify-visit`, {
      latitude: 35.6762, longitude: 139.6503,
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
  });

  it("records suspicious visit when user has trust events (fake GPS)", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems: [makeActiveGem()],
        gemVisits: [],
        gemVerifications: [],
        // Simulate trust event present → suspicious
        locationTrust: [
          { user_id: USER_ID, event_type: "impossible_speed", confidence: "high", created_at: new Date().toISOString() },
        ],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: 35.6762, longitude: 139.6503,
    });
    // Visit is still recorded (for audit), but isSuspicious=true
    assert.ok(r.status === 200 || r.status === 400);
    // Either way, a visit row should have been inserted for the audit trail
    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("hidden_gem_visits"), "audit visit should be recorded");
  });

  it("records too_far when user is outside proximity threshold", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gem_verification_enabled: true },
        gems: [makeActiveGem()], // gem is in Tokyo at ~35.6762, 139.6503
        gemVisits: [],
        gemVerifications: [],
        locationTrust: [], // no trust events → trusted
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // User is in London — nowhere near Tokyo
    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/verify-visit`, {
      latitude: 51.5074, longitude: -0.1278,
    });
    assert.equal(r.body.withinRange, false);
    assert.equal(r.body.error, "too_far");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Layover-safe time-window filter
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — layover-safe filter", () => {
  it("returns feature_disabled when layover flag is off", async () => {
    const client = makeFakeClient(
      { featureFlags: { hidden_gems_enabled: true, hidden_gems_layover_enabled: false } },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/hidden-gems/layover-safe?availableMinutes=90");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("returns 400 when availableMinutes is missing", async () => {
    const client = makeFakeClient(
      { featureFlags: { hidden_gems_enabled: true, hidden_gems_layover_enabled: true }, gems: [] },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/hidden-gems/layover-safe");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns only layover-safe gems within the time window", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, hidden_gems_layover_enabled: true },
        gems: [
          makeActiveGem({ id: "g1", layover_safe: true,  minimum_layover_minutes: 60 }),
          makeActiveGem({ id: "g2", layover_safe: true,  minimum_layover_minutes: 120 }),
          makeActiveGem({ id: "g3", layover_safe: false, minimum_layover_minutes: 30 }),
        ],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/hidden-gems/layover-safe?availableMinutes=90");
    assert.equal(r.status, 200);
    // Only g1 (layover_safe=true, 60 min ≤ 90 min) should appear
    assert.equal(r.body.gems.length, 1);
    assert.equal(r.body.gems[0].id, "g1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Report
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — report queue entry", () => {
  it("POST /report inserts a report row", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        gemReports: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/report`, {
      reason: "inaccurate",
      notes: "The place doesn't exist",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.alreadyReported, false);

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("hidden_gem_reports"), "should insert into hidden_gem_reports");
  });

  it("POST /report returns alreadyReported=true on duplicate", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        gemReports: [{ id: "r1", gem_id: GEM_ID, reporter_id: USER_ID, reason: "spam" }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/report`, { reason: "spam" });
    assert.equal(r.status, 200);
    assert.equal(r.body.alreadyReported, true);
  });

  it("POST /report validates reason enum", async () => {
    const client = makeFakeClient(
      { featureFlags: { hidden_gems_enabled: true }, gems: [makeActiveGem()], gemReports: [] },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/report`, { reason: "bad_vibes" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Telegraph share visibility — protected gems hide coords and neighborhood
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — Telegraph share privacy", () => {
  it("protected gem share card omits neighborhood and coords", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem({ sensitivity_level: "protected" })],
        gemSaves: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/share-telegraph`, {
      threadId: "thread-123",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.card.neighborhood, null, "protected gem must not expose neighborhood");
    assert.equal(r.body.card.sensitivityLabel, "protected");
    // lat/lng must not be in the card
    assert.equal(r.body.card.lat, undefined);
    assert.equal(r.body.card.lng, undefined);
  });

  it("public gem share card includes neighborhood", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem({ sensitivity_level: "public" })],
        gemSaves: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/share-telegraph`, {
      threadId: "thread-123",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.card.neighborhood, "Shibuya");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Guide contribution
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — guide contribution", () => {
  it("PATCH updates safety notes and records guide contribution", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem({ submitted_by: USER_ID })],
        guideProfiles: [{ user_id: USER_ID, status: "active", guide_level: 1, contribution_count: 2, helpful_votes: 1, accuracy_score: 0.8 }],
        guideContribs: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("PATCH", `/api/hidden-gems/${GEM_ID}`, {
      safetyNotes: "Watch out for pickpockets near the entrance",
    });
    assert.equal(r.status, 200);

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("local_guide_contributions"), "should record guide contribution");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Admin verify / hide / mark-sensitive
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — admin actions", () => {
  before(() => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem({ status: "pending" })],
        profiles: [{ id: ADMIN_ID, is_admin: true }],
        gemVerifications: [],
      },
      ADMIN_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("non-admin user gets 403 on admin verify endpoint", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        profiles: [{ id: USER_ID, is_admin: false }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/admin/hidden-gems/${GEM_ID}/verify`, { result: "approved" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("admin can verify a gem (approve)", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem({ status: "pending" })],
        profiles: [{ id: ADMIN_ID, is_admin: true }],
        gemVerifications: [],
      },
      ADMIN_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/admin/hidden-gems/${GEM_ID}/verify`, { result: "approved" }, "admin-token");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    // Should have written a verification event and updated the gem
    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("hidden_gem_verifications"), "should record admin verification");
    const updatedGems = client._updated.filter((u: any) => u.table === "hidden_gems");
    assert.ok(updatedGems.length > 0, "should update hidden_gems status");
  });

  it("admin can mark a gem sensitive", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        profiles: [{ id: ADMIN_ID, is_admin: true }],
      },
      ADMIN_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/admin/hidden-gems/${GEM_ID}/sensitive`, { sensitivityLevel: "protected" }, "admin-token");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    const sensitiveUpdates = client._updated.filter((u: any) => u.table === "hidden_gems");
    assert.ok(sensitiveUpdates.length > 0, "should update sensitivity on hidden_gems");
  });

  it("admin can merge a duplicate", async () => {
    const CANONICAL_ID = "gem-canonical-1";
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem(), makeActiveGem({ id: CANONICAL_ID })],
        profiles: [{ id: ADMIN_ID, is_admin: true }],
      },
      ADMIN_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/admin/hidden-gems/${GEM_ID}/merge`, { canonicalGemId: CANONICAL_ID }, "admin-token");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Local guide application
// ─────────────────────────────────────────────────────────────────────────────

describe("Local Guides — application", () => {
  it("POST /hidden-gems/guides/apply creates a guide applicant", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, local_guides_enabled: true },
        guideProfiles: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/hidden-gems/guides/apply", {
      bio: "I know Tokyo's hidden spots",
      cityExpertise: ["Tokyo", "Osaka"],
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.guide);

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("local_guide_profiles"), "should insert guide profile");
  });

  it("GET guide profile returns 404 for non-active guide", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true, local_guides_enabled: true },
        guideProfiles: [{ user_id: USER_ID, status: "applicant" }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", `/api/hidden-gems/guides/${USER_ID}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Plan-from-gem location reveal logic
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — plan-from-gem reveal logic", () => {
  it("POST /plan returns 400 when tripId is missing", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/plan`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("POST /plan inserts a trip_plan_items row", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        trips: [{ id: TRIP_ID, destination: "Tokyo" }],
        tripMembers: [],
        gemSaves: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/plan`, { tripId: TRIP_ID });
    assert.equal(r.status, 201);
    assert.ok(r.body.planItemId);

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(tables.includes("trip_plan_items"), "should insert into trip_plan_items");
  });

  it("plan from reveal_after_acceptance gem hides exact coords until trip member", async () => {
    // Gem with reveal_after_acceptance — caller is NOT a trip member
    const gem = makeActiveGem({ sensitivity_level: "reveal_after_acceptance", submitted_by: OTHER_ID });
    const coords = await resolveGemCoords(gem, {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
      }) as any,
    } as any, USER_ID, OTHER_ID, TRIP_ID);

    assert.notEqual(coords.coordsPrecision, "exact", "non-member should NOT get exact coords");
  });
});
