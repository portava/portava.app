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
  /**
   * message_thread_members — read by the share-telegraph membership check.
   * Absent means "not a member", which is the correct default: the check exists
   * precisely so an arbitrary thread id in the body cannot be posted into.
   */
  threadMembers?:   Record<string, any>[];
  locationTrust?:   Record<string, any>[];
  passportVizPrefs?: Record<string, any>[];
  /** Canonical places — used by the dedicated Add a Gem flow validation. */
  places?:          Record<string, any>[];
  /** Existing plan rows — used by the POST /:id/plan duplicate guard. */
  tripPlanItems?:   Record<string, any>[];
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
      or(expr: string) {
        // Parses PostgREST or()-expressions including the nested and()-of-range
        // form the proximity bounding box uses:
        //   and(latitude.gte.X,latitude.lte.Y,longitude.gte.A,longitude.lte.B),and(approx_...)
        const splitTop = (s: string): string[] => {
          const out: string[] = [];
          let depth = 0, cur = "";
          for (const ch of s) {
            if (ch === "(") { depth++; cur += ch; }
            else if (ch === ")") { depth--; cur += ch; }
            else if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
            else cur += ch;
          }
          if (cur) out.push(cur);
          return out;
        };
        const matchTerm = (r: any, term: string): boolean => {
          const m = term.trim().match(/^(\w+)\.(\w+)\.(.*)$/);
          if (!m) return false;
          const [, col, op, raw] = m;
          const rv = r[col];
          if (op === "is") return raw === "null" ? rv == null : String(rv) === raw;
          if (rv == null) return false;
          const a = Number(rv), b = Number(raw);
          switch (op) {
            case "eq":  return String(rv) === raw;
            case "gte": return a >= b;
            case "lte": return a <= b;
            case "gt":  return a > b;
            case "lt":  return a < b;
            default:    return false;
          }
        };
        const matchGroup = (r: any, g: string): boolean => {
          const t = g.trim();
          if (t.startsWith("and(") && t.endsWith(")")) {
            return splitTop(t.slice(4, -1)).every((term) => matchTerm(r, term));
          }
          return matchTerm(r, t);
        };
        const groups = splitTop(expr);
        filters.push((r) => groups.some((g) => matchGroup(r, g)));
        return builder;
      },
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
        feature_flags:           Object.entries(state.featureFlags ?? {}).map(([key, enabled]) => ({ flag: key, enabled })),
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
        message_thread_members:  state.threadMembers ?? [],
        location_trust_events:   state.locationTrust ?? [],
        passport_visibility_preferences: state.passportVizPrefs ?? [],
        places:                  state.places ?? [],
        trip_plan_items:         state.tripPlanItems ?? [],
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

  // ── Canonical place validation (dedicated Add a Gem flow) ─────────────────

  const CANONICAL_PLACE_ID = "a1b2c3d4-0000-0000-0000-000000000001";
  const BASE_GEM_PAYLOAD = {
    name: "Hidden Waterfall",
    category: "nature",
    city: "Bali",
    country: "Indonesia",
  };

  it("POST /hidden-gems with sourceConfirmation=true and valid canonicalPlaceId creates gem and persists canonical fields", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [],
        places: [{ id: CANONICAL_PLACE_ID, status: "active" }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/hidden-gems", {
      ...BASE_GEM_PAYLOAD,
      canonicalPlaceId: CANONICAL_PLACE_ID,
      sourceConfirmation: true,
      visibility: "public",
      accessibility: "Steep path — good mobility required.",
      crowdLevel: "quiet",
    });

    assert.equal(r.status, 201, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.gem?.id, "should return gem id");

    // Verify the insert row actually carried the new fields through
    const hiddenGemInsert = client._inserted.find((i: any) => i.table === "hidden_gems");
    assert.ok(hiddenGemInsert, "should have inserted into hidden_gems");
    assert.equal(hiddenGemInsert.row.canonical_place_id, CANONICAL_PLACE_ID, "canonical_place_id must be persisted");
    assert.equal(hiddenGemInsert.row.source_confirmation, true, "source_confirmation must be persisted");
    assert.equal(hiddenGemInsert.row.visibility, "public", "visibility must be persisted");
    assert.equal(hiddenGemInsert.row.accessibility, "Steep path — good mobility required.", "accessibility must be persisted");
    assert.equal(hiddenGemInsert.row.crowd_level, "quiet", "crowd_level must be persisted");
  });

  it("POST /hidden-gems rejects sourceConfirmation=false with 422", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [],
        places: [{ id: CANONICAL_PLACE_ID, status: "active" }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/hidden-gems", {
      ...BASE_GEM_PAYLOAD,
      canonicalPlaceId: CANONICAL_PLACE_ID,
      sourceConfirmation: false, // must be true
    });

    assert.equal(r.status, 422, `expected 422 but got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
    assert.ok(
      r.body.message?.includes("confirm"),
      `message should mention confirmation; got: ${r.body.message}`,
    );
    // Nothing should have been inserted
    const insertedTables = client._inserted.map((i: any) => i.table);
    assert.ok(!insertedTables.includes("hidden_gems"), "should not insert gem when confirmation is false");
  });

  it("POST /hidden-gems rejects canonicalPlaceId present but sourceConfirmation omitted with 422 — no bypass via omission", async () => {
    // Attestation bypass attempt: caller sends canonicalPlaceId without
    // sourceConfirmation, hoping to skip the confirmation gate.
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [],
        places: [{ id: CANONICAL_PLACE_ID, status: "active" }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/hidden-gems", {
      ...BASE_GEM_PAYLOAD,
      canonicalPlaceId: CANONICAL_PLACE_ID,
      // sourceConfirmation intentionally omitted — must still be rejected
    });

    assert.equal(r.status, 422, `expected 422 (bypass should be blocked) but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_payload");
    assert.ok(
      r.body.message?.includes("confirm"),
      `message should mention confirmation; got: ${r.body.message}`,
    );
    // Nothing should have been inserted
    const insertedTables = client._inserted.map((i: any) => i.table);
    assert.ok(!insertedTables.includes("hidden_gems"), "should not insert gem when confirmation is bypassed");
  });

  it("POST /hidden-gems with sourceConfirmation=true and no canonicalPlaceId creates a freehand gem (201)", async () => {
    // canonicalPlaceId is now optional — freehand gems without a linked place
    // should be accepted as long as sourceConfirmation is true.
    const client = makeFakeClient(
      { featureFlags: { hidden_gems_enabled: true }, gems: [] },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/hidden-gems", {
      ...BASE_GEM_PAYLOAD,
      sourceConfirmation: true,
      // canonicalPlaceId intentionally omitted — freehand gem
    });

    assert.equal(r.status, 201, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });

  it("POST /hidden-gems rejects canonicalPlaceId that does not exist in places table with 422", async () => {
    const NONEXISTENT_PLACE_ID = "deadbeef-0000-0000-0000-000000000099";
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [],
        places: [], // empty — place lookup will return null
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/hidden-gems", {
      ...BASE_GEM_PAYLOAD,
      canonicalPlaceId: NONEXISTENT_PLACE_ID,
      sourceConfirmation: true,
    });

    assert.equal(r.status, 422, `expected 422 but got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
    assert.ok(
      r.body.message?.toLowerCase().includes("verified") || r.body.message?.toLowerCase().includes("could not be"),
      `message should mention place verification; got: ${r.body.message}`,
    );
  });

  it("POST /hidden-gems without sourceConfirmation uses legacy path and creates gem without canonical fields", async () => {
    // The legacy submission path (no sourceConfirmation) must still work
    const client = makeFakeClient(
      { featureFlags: { hidden_gems_enabled: true }, gems: [] },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/hidden-gems", {
      name: "Local Market",
      category: "market",
      city: "Marrakech",
      country: "Morocco",
    });

    assert.equal(r.status, 201, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.gem?.id, "should return gem id for legacy path");
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
// 8. Nearby — route reachability (regression: must not be shadowed by /:id)
// ─────────────────────────────────────────────────────────────────────────────

describe("Hidden Gems — nearby endpoint", () => {
  it("GET /nearby is reachable and returns gems array (not caught by /:id)", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [
          makeActiveGem({ id: "g1", sensitivity_level: "public", latitude: 35.6762, longitude: 139.6503 }),
          makeActiveGem({ id: "g2", sensitivity_level: "public", latitude: 35.6800, longitude: 139.6600 }),
        ],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", `/api/hidden-gems/nearby?lat=35.68&lng=139.65&radiusKm=5`);
    // Must return 200 (not 404 from /:id shadow or feature_disabled)
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.gems), "should return gems array");
  });

  it("GET /nearby returns 400 when lat/lng are missing", async () => {
    const client = makeFakeClient({ featureFlags: { hidden_gems_enabled: true }, gems: [] }, USER_ID);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/hidden-gems/nearby");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("GET /nearby bounds the fetch: a gem far outside the radius is not returned", async () => {
    // near = Tokyo (in the 5km box of 35.68,139.65); far = London (thousands of km).
    // Before the bounding box, London would be fetched and only dropped in JS;
    // now it never leaves the DB (the .or() box excludes it).
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [
          makeActiveGem({ id: "near", sensitivity_level: "public", latitude: 35.6762, longitude: 139.6503 }),
          makeActiveGem({ id: "far",  sensitivity_level: "public", latitude: 51.5074, longitude: -0.1278,
                          city: "London", approx_latitude: 51.51, approx_longitude: -0.12 }),
        ],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", `/api/hidden-gems/nearby?lat=35.68&lng=139.65&radiusKm=5`);
    assert.equal(r.status, 200);
    const ids = r.body.gems.map((g: any) => g.id);
    assert.ok(ids.includes("near"), "the in-radius gem should be returned");
    assert.ok(!ids.includes("far"), "a gem far outside the radius must not be returned");
  });

  it("GET /nearby matches an approximate gem via its approx coords (exact null)", async () => {
    // Approximate-sensitivity gem: no exact coords, only approx inside the box.
    // The second box of the .or() must still catch it.
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [
          makeActiveGem({
            id: "approx", sensitivity_level: "approximate",
            latitude: null, longitude: null,
            approx_latitude: 35.68, approx_longitude: 139.65,
          }),
          makeActiveGem({
            id: "protected", sensitivity_level: "protected",
            latitude: null, longitude: null, approx_latitude: null, approx_longitude: null,
          }),
        ],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", `/api/hidden-gems/nearby?lat=35.68&lng=139.65&radiusKm=5`);
    assert.equal(r.status, 200);
    const ids = r.body.gems.map((g: any) => g.id);
    assert.ok(ids.includes("approx"),     "approx-only gem inside the box should be returned");
    assert.ok(!ids.includes("protected"), "a gem with no coordinates must not appear in proximity results");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Report
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
        // CONTRACT CHANGE, not a weakened fixture. 744a10d86 added a
        // message_thread_members check to share-telegraph, because threadId came
        // straight from the request body and the insert runs on the service-role
        // client — so any authenticated user could post a gem card into any
        // thread id they could guess, with RLS not acting as a backstop. These
        // two cases are about what the CARD contains, so the sender is made a
        // real member of the thread they post into; they were never intended to
        // assert anything about thread access. The membership check itself is
        // covered separately by the two non-member cases at the end of this
        // describe block, which are what fail if the check is removed.
        threadMembers: [{ thread_id: "thread-123", user_id: USER_ID, left_at: null }],
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
        // Member of the thread — see the note on the protected case above.
        threadMembers: [{ thread_id: "thread-123", user_id: USER_ID, left_at: null }],
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

  // These two cases are NEW, and they are the reason the two cases above were
  // allowed to seed membership rather than have the check relaxed. Before this,
  // nothing in the suite exercised the membership check at all: both existing
  // cases posted into "thread-123" with no membership rows, so once they were
  // given membership, deleting the check from the route entirely would have
  // left the whole suite green. A guard with no failing case is not covered.
  it("refuses to share into a thread the sender does not belong to", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem({ sensitivity_level: "public" })],
        gemSaves: [],
        // Someone ELSE is in the thread. The sender is not — which is the
        // guessed-thread-id case: threadId comes from the request body and the
        // insert runs on the service-role client, so RLS is not a backstop.
        threadMembers: [{ thread_id: "thread-123", user_id: "someone-else", left_at: null }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/share-telegraph`, {
      threadId: "thread-123",
    });

    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(
      client._inserted.filter((i: any) => i.table === "messages").length,
      0,
      "a non-member must not get a message written into the thread",
    );
  });

  it("refuses to share into a thread the sender has left", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem({ sensitivity_level: "public" })],
        gemSaves: [],
        // A row exists, but left_at is set. The route requires left_at === null;
        // a membership row alone is not membership, and a check that only tested
        // for row existence would pass this and still be wrong.
        threadMembers: [{ thread_id: "thread-123", user_id: USER_ID, left_at: "2026-01-01T00:00:00.000Z" }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/share-telegraph`, {
      threadId: "thread-123",
    });

    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(
      client._inserted.filter((i: any) => i.table === "messages").length,
      0,
      "a departed member must not get a message written into the thread",
    );
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
        profiles: [{ id: ADMIN_ID, role: "admin" }],
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
        profiles: [{ id: USER_ID, role: "user" }],
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
        profiles: [{ id: ADMIN_ID, role: "admin" }],
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
        profiles: [{ id: ADMIN_ID, role: "admin" }],
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
        profiles: [{ id: ADMIN_ID, role: "admin" }],
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
    // owner_id added to the fixture: this endpoint now runs canEditPlan, and the
    // trip was previously seeded with no owner and no members, so the caller was
    // neither. It asserted 201 for a write it was never entitled to make — which
    // was defect (a), not a property worth preserving. The assertions below are
    // unchanged; only the caller's right to make the write is now established.
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        trips: [{ id: TRIP_ID, destination: "Tokyo", owner_id: USER_ID }],
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

  it("POST /plan sets creator_id on the inserted row (NOT NULL, required by the Insert type)", async () => {
    // trip_plan_items.creator_id is `creator_id: string` in the generated Insert
    // type — required — while added_by is `added_by?: string | null`. This
    // handler set only added_by, so every insert violated NOT NULL and the
    // endpoint had never once added a gem to a plan. The fake client does not
    // enforce constraints, which is why the test above reported success for a
    // write that always failed live; this one checks the column directly.
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        trips: [{ id: TRIP_ID, destination: "Tokyo", owner_id: USER_ID }],
        tripMembers: [],
        gemSaves: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/plan`, { tripId: TRIP_ID });
    assert.equal(r.status, 201);

    const planInsert = client._inserted.find((i: any) => i.table === "trip_plan_items");
    assert.ok(planInsert, "expected a trip_plan_items insert");
    assert.equal(planInsert.row.creator_id, USER_ID,
      `creator_id is NOT NULL and must be set, got: ${JSON.stringify(planInsert.row.creator_id)}`);
  });

  it("POST /plan returns 403 when the caller is not a member of the trip", async () => {
    // tripId comes straight from the request body and was written with no
    // membership or plan-edit check at all, so any authenticated user could add
    // an item to any trip id they could guess.
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        trips: [{ id: TRIP_ID, destination: "Tokyo", owner_id: OTHER_ID }],
        tripMembers: [],
        gemSaves: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/plan`, { tripId: TRIP_ID });
    assert.equal(r.status, 403, `a non-member must not write to someone else's trip plan, got ${r.status}`);
    assert.equal(r.body.error, "forbidden");

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(!tables.includes("trip_plan_items"), "no plan row may be written for a non-member");
  });

  it("POST /plan returns 404 when the trip does not exist", async () => {
    // canEditPlan distinguishes null (no such trip) from false (exists, not
    // permitted), matching routes/compassAutopilot.ts.
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        trips: [],
        tripMembers: [],
        gemSaves: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/plan`, { tripId: TRIP_ID });
    assert.equal(r.status, 404, `unknown trip must be 404, got ${r.status}`);
    assert.equal(r.body.error, "not_found");
  });

  it("POST /plan returns 409 duplicate on a second tap instead of a sanitized db_error", async () => {
    // trip_plan_items_source_uniq (trip_id, source_type, source_id) makes the
    // second tap raise 23505, which became a db_error and was then SANITIZED to
    // "A database error occurred" — leaving the client unable to tell a
    // duplicate from a real failure.
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem()],
        trips: [{ id: TRIP_ID, destination: "Tokyo", owner_id: USER_ID }],
        tripMembers: [],
        gemSaves: [],
        tripPlanItems: [
          { id: "existing-plan-item-1", trip_id: TRIP_ID, source_type: "hidden_gem", source_id: GEM_ID, removed_at: null },
        ],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", `/api/hidden-gems/${GEM_ID}/plan`, { tripId: TRIP_ID });
    assert.equal(r.status, 409, `second tap must be 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "duplicate");

    const tables = client._inserted.map((i: any) => i.table);
    assert.ok(!tables.includes("trip_plan_items"), "duplicate must not insert a second row");
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

// ─────────────────────────────────────────────────────────────────────────────
// 14. Detail endpoint — coordinate safety (HTTP-level)
//
// These tests hit GET /api/hidden-gems/:id and assert that:
//   • public gems  → exact lat/lng present, coordsPrecision = 'exact'
//   • approximate  → approx lat/lng, coordsPrecision = 'approximate'
//   • protected    → null lat/lng, coordsPrecision = 'hidden'
//
// All three also assert that raw DB fields (latitude, longitude,
// approx_latitude, approx_longitude, rawLocation, exactLocation) are ABSENT
// from the response body — preventing any accidental coordinate leak.
// ─────────────────────────────────────────────────────────────────────────────

describe("Detail endpoint — coordinate safety", () => {
  it("public gem: exact coords present, no raw fields in response", async () => {
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

    const r = await req("GET", `/api/hidden-gems/${GEM_ID}`);
    assert.equal(r.status, 200, `expected 200, got: ${JSON.stringify(r.body)}`);

    const gem = r.body.gem;
    assert.equal(gem.lat,            35.6762,  "public gem must expose exact lat");
    assert.equal(gem.lng,            139.6503, "public gem must expose exact lng");
    assert.equal(gem.coordsPrecision, "exact");

    // Raw DB coordinate fields must never appear on the response
    assert.equal(gem.latitude,          undefined, "raw latitude must be absent");
    assert.equal(gem.longitude,         undefined, "raw longitude must be absent");
    assert.equal(gem.approx_latitude,   undefined, "raw approx_latitude must be absent");
    assert.equal(gem.approx_longitude,  undefined, "raw approx_longitude must be absent");
    assert.equal(gem.rawLocation,       undefined, "rawLocation must be absent");
    assert.equal(gem.exactLocation,     undefined, "exactLocation must be absent");
  });

  it("approximate gem: approx coords present, exact coords absent, no raw fields", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem({ sensitivity_level: "approximate", submitted_by: OTHER_ID })],
        gemSaves: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", `/api/hidden-gems/${GEM_ID}`);
    assert.equal(r.status, 200, `expected 200, got: ${JSON.stringify(r.body)}`);

    const gem = r.body.gem;
    assert.equal(gem.lat,            35.68,   "approximate gem must expose approx lat");
    assert.equal(gem.lng,            139.65,  "approximate gem must expose approx lng");
    assert.equal(gem.coordsPrecision, "approximate");

    // Exact raw coordinates must be absent
    assert.equal(gem.latitude,         undefined, "raw latitude must be absent");
    assert.equal(gem.longitude,        undefined, "raw longitude must be absent");
    assert.equal(gem.approx_latitude,  undefined, "raw approx_latitude must be absent");
    assert.equal(gem.approx_longitude, undefined, "raw approx_longitude must be absent");
    assert.equal(gem.rawLocation,      undefined, "rawLocation must be absent");
    assert.equal(gem.exactLocation,    undefined, "exactLocation must be absent");
  });

  it("protected gem: null coords, coordsPrecision=hidden, no raw coord fields in response", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { hidden_gems_enabled: true },
        gems: [makeActiveGem({ sensitivity_level: "protected", submitted_by: OTHER_ID })],
        gemSaves: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", `/api/hidden-gems/${GEM_ID}`);
    assert.equal(r.status, 200, `expected 200, got: ${JSON.stringify(r.body)}`);

    const gem = r.body.gem;
    assert.equal(gem.lat,             null,     "protected gem must have null lat");
    assert.equal(gem.lng,             null,     "protected gem must have null lng");
    assert.equal(gem.coordsPrecision, "hidden", "protected gem must have coordsPrecision=hidden");

    // None of the raw or alternative coordinate keys may appear
    assert.equal(gem.latitude,         undefined, "raw latitude must be absent");
    assert.equal(gem.longitude,        undefined, "raw longitude must be absent");
    assert.equal(gem.approx_latitude,  undefined, "raw approx_latitude must be absent");
    assert.equal(gem.approx_longitude, undefined, "raw approx_longitude must be absent");
    assert.equal(gem.rawLocation,      undefined, "rawLocation must be absent");
    assert.equal(gem.exactLocation,    undefined, "exactLocation must be absent");
  });
});
