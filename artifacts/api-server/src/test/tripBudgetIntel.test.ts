/**
 * Budget intelligence tests — lib math + routes.
 *
 * Covers:
 *  - HONESTY: no baseline rows → { available:false, reason:'no_baseline_data' }
 *  - Lookup priority: city → country → global
 *  - Tier fallback to nearest tier is noted in assumptions
 *  - Sandbox: protected categories are never suggested for trimming
 *  - fitsBudget arithmetic vs trip_budget + budgetDelta
 *  - Flag + membership gates on member routes
 *  - Admin auth on /admin/price-baselines CRUD (+ upsert-by-combo)
 *
 * Runtime: node:test + node:assert/strict. No network / no real DB.
 * Run: node --import tsx/esm --test src/test/tripBudgetIntel.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import {
  resolveTier,
  estimateTripCost,
  sandboxBudget,
} from "../lib/tripBudgetIntel.js";

// ── Test IDs ──────────────────────────────────────────────────────────────────
const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const ADMIN_ID  = "44444444-4444-4444-4444-444444444444";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// ── Fake supabase client (hand-built, per-file) ───────────────────────────────
type Row = Record<string, any>;
interface FakeTable { rows: Row[]; }

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    feature_flags:   tables.feature_flags   ?? { rows: [] },
    profiles:        tables.profiles        ?? { rows: [] },
    trips:           tables.trips           ?? { rows: [] },
    trip_members:    tables.trip_members    ?? { rows: [] },
    trip_budget:     tables.trip_budget     ?? { rows: [] },
    price_baselines: tables.price_baselines ?? { rows: [] },
    ...tables,
  };

  const insertCalls: Array<{ table: string; payload: any }> = [];
  let idCtr = 0;
  const newId = () => `${String(++idCtr).padStart(8, "0")}-0000-0000-0000-000000000000`;

  function ilikeToRegex(pattern: string): RegExp {
    const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("^" + escaped.replace(/%/g, ".*") + "$", "i");
  }

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _single = false;
    let _maybeSingle = false;

    const obj: any = {
      select: () => obj,
      insert(data: Row | Row[]) { _insert = data; insertCalls.push({ table: tableName, payload: data }); return obj; },
      update(patch: Row) { _update = patch; return obj; },
      delete() { _delete = true; return obj; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return obj; },
      is(col: string, val: any)    { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      ilike(col: string, pattern: string) {
        const re = ilikeToRegex(pattern);
        filters.push((r) => re.test(String(r[col] ?? "")));
        return obj;
      },
      order: () => obj,
      limit: () => obj,
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single = true;      return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function resolve(): Promise<{ data: any; error: any }> {
      return Promise.resolve().then(() => {
        if (!db[tableName]) db[tableName] = { rows: [] };
        const table = db[tableName];

        if (_insert !== null) {
          const rows = Array.isArray(_insert) ? _insert : [_insert];
          const inserted = rows.map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
          table.rows.push(...inserted);
          return { data: _single || _maybeSingle ? inserted[0] ?? null : inserted, error: null };
        }
        if (_update !== null) {
          const matched: Row[] = [];
          table.rows = table.rows.map((r) => {
            if (filters.every((f) => f(r))) {
              const updated = { ...r, ..._update };
              matched.push(updated);
              return updated;
            }
            return r;
          });
          return { data: _single || _maybeSingle ? matched[0] ?? null : matched, error: null };
        }
        if (_delete) {
          table.rows = table.rows.filter((r) => !filters.every((f) => f(r)));
          return { data: null, error: null };
        }
        const rows = table.rows.filter((r) => filters.every((f) => f(r)));
        if (_single || _maybeSingle) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      });
    }

    return obj;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        const map: Record<string, string> = {
          "owner-token":  OWNER_ID,
          "member-token": MEMBER_ID,
          "other-token":  OTHER_ID,
          "admin-token":  ADMIN_ID,
        };
        const id = map[token];
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: (tableName: string) => chain(tableName),
    _insertCalls: insertCalls,
  };

  return { client, db };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseTables(overrides: Record<string, FakeTable> = {}): Record<string, FakeTable> {
  return {
    feature_flags: { rows: [{ flag: "budget_intelligence_enabled", enabled: true }] },
    profiles: { rows: [
      { id: ADMIN_ID, role: "admin", account_status: "active" },
      { id: MEMBER_ID, budget_style: "mid-range", account_status: "active" },
    ]},
    trips: { rows: [
      { id: TRIP_ID, owner_id: OWNER_ID, destination_city: "Lisbon",
        destination_country: "Portugal", start_date: "2026-08-01", end_date: "2026-08-05" },
    ]},
    trip_members: { rows: [
      { trip_id: TRIP_ID, user_id: OWNER_ID,  role: "owner",   status: "accepted" },
      { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member",  status: "accepted" },
      { trip_id: TRIP_ID, user_id: OTHER_ID,  role: "invited", status: "invited"  },
    ]},
    ...overrides,
  };
}

const CITY_BASELINES: Row[] = [
  { id: "b1", country: "PT", city: "Lisbon", category: "lodging", tier: "comfortable",
    daily_amount: 100, currency: "USD", source_note: "city-lodging", last_verified_at: "2026-06-01T00:00:00Z" },
  { id: "b2", country: "PT", city: "Lisbon", category: "food", tier: "comfortable",
    daily_amount: 50, currency: "USD", source_note: "city-food", last_verified_at: "2026-05-01T00:00:00Z" },
  { id: "b3", country: "PT", city: "Lisbon", category: "activities", tier: "comfortable",
    daily_amount: 30, currency: "USD", source_note: "city-activities", last_verified_at: "2026-07-01T00:00:00Z" },
];

const COUNTRY_BASELINE: Row = {
  id: "b4", country: "PT", city: null, category: "lodging", tier: "comfortable",
  daily_amount: 80, currency: "USD", source_note: "country-lodging", last_verified_at: "2026-04-01T00:00:00Z",
};

const GLOBAL_BASELINE: Row = {
  id: "b5", country: null, city: null, category: "lodging", tier: "comfortable",
  daily_amount: 60, currency: "USD", source_note: "global-lodging", last_verified_at: "2026-03-01T00:00:00Z",
};

// ── Server setup (router mounted directly; index.ts is not edited) ────────────

let app: Express;
let server: Server;
let port: number;

async function startServer() {
  const { default: budgetIntelRouter } = await import("../routes/tripBudgetIntel.js");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", budgetIntelRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
}

async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = null;
  try { body = (r.headers.get("content-type") ?? "").includes("json") ? await r.json() : await r.text(); }
  catch { body = null; }
  return { status: r.status, body };
}

// ── Lib: resolveTier ──────────────────────────────────────────────────────────

describe("resolveTier", () => {
  it("normalizes profile budget_style values", () => {
    assert.equal(resolveTier("budget"), "budget");
    assert.equal(resolveTier("mid-range"), "comfortable");
    assert.equal(resolveTier("Mid Range"), "comfortable");
    assert.equal(resolveTier("flexible"), "comfortable");
    assert.equal(resolveTier("luxury"), "luxury");
    assert.equal(resolveTier("upscale"), "upscale");
  });
  it("defaults to comfortable for unknown/missing input", () => {
    assert.equal(resolveTier(undefined), "comfortable");
    assert.equal(resolveTier(null), "comfortable");
    assert.equal(resolveTier("yolo-spender"), "comfortable");
  });
});

// ── Lib: estimateTripCost ─────────────────────────────────────────────────────

describe("estimateTripCost", () => {
  const trip = {
    destination_city: "Lisbon",
    destination_country: "Portugal",
    start_date: "2026-08-01",
    end_date: "2026-08-05",
  };

  it("HONESTY: returns available:false with no_baseline_data when zero rows exist", async () => {
    const { client } = makeFakeClient({ price_baselines: { rows: [] } });
    const result = await estimateTripCost(client, trip, { tier: "comfortable" });
    assert.equal(result.available, false);
    assert.equal((result as any).reason, "no_baseline_data");
    assert.ok((result as any).disclaimer, "explains why no estimate is shown");
  });

  it("returns dates_not_set when dates are missing", async () => {
    const { client } = makeFakeClient({ price_baselines: { rows: [...CITY_BASELINES] } });
    const result = await estimateTripCost(client, { ...trip, end_date: null }, {});
    assert.equal(result.available, false);
    assert.equal((result as any).reason, "dates_not_set");
  });

  it("prefers city baselines over country and global (case-insensitive city match)", async () => {
    const { client } = makeFakeClient({
      price_baselines: { rows: [...CITY_BASELINES, COUNTRY_BASELINE, GLOBAL_BASELINE] },
    });
    const result = await estimateTripCost(
      client,
      { ...trip, destination_city: "lisbon" },
      { tier: "comfortable" },
    );
    assert.equal(result.available, true);
    const est = result as any;
    assert.equal(est.scope, "city");
    const lodging = est.breakdown.find((b: any) => b.category === "lodging");
    assert.equal(lodging.perDay, 100, "city lodging amount, not country (80) or global (60)");
  });

  it("falls back to country scope (name → ISO code), then global", async () => {
    const { client: countryClient } = makeFakeClient({
      price_baselines: { rows: [COUNTRY_BASELINE, GLOBAL_BASELINE] },
    });
    const viaCountry = await estimateTripCost(
      countryClient,
      { ...trip, destination_city: "Porto" }, // no city rows for Porto
      { tier: "comfortable" },
    );
    assert.equal(viaCountry.available, true);
    assert.equal((viaCountry as any).scope, "country");
    assert.equal((viaCountry as any).breakdown[0].perDay, 80);

    const { client: globalClient } = makeFakeClient({
      price_baselines: { rows: [GLOBAL_BASELINE] },
    });
    const viaGlobal = await estimateTripCost(
      globalClient,
      { destination_city: "Nowhere", destination_country: "Atlantis",
        start_date: "2026-08-01", end_date: "2026-08-05" },
      { tier: "comfortable" },
    );
    assert.equal(viaGlobal.available, true);
    assert.equal((viaGlobal as any).scope, "global");
    assert.equal((viaGlobal as any).breakdown[0].perDay, 60);
  });

  it("computes inclusive days, per-day sum, bands, totals, and oldest lastVerifiedAt", async () => {
    const { client } = makeFakeClient({ price_baselines: { rows: [...CITY_BASELINES] } });
    const result = await estimateTripCost(client, trip, { tier: "comfortable", partySize: 2 });
    assert.equal(result.available, true);
    const est = result as any;
    assert.equal(est.days, 5, "Aug 1..Aug 5 inclusive = 5 days");
    assert.equal(est.perDay.mid, 180, "100 + 50 + 30");
    assert.equal(est.perDay.low, 153, "0.85x");
    assert.equal(est.perDay.high, 216, "1.2x");
    assert.equal(est.total.mid, 900);
    assert.equal(est.confidence, "curated_baseline");
    assert.equal(est.lastVerifiedAt, "2026-05-01T00:00:00Z", "oldest last_verified_at of used rows");
    assert.ok(est.assumptions.some((a: string) => a.includes("PER PERSON")));
    assert.ok(est.assumptions.some((a: string) => a.includes("2 accepted members")));
    assert.ok(est.disclaimer.length > 0);
  });

  it("notes nearest-tier fallback in assumptions when the exact tier is missing", async () => {
    const { client } = makeFakeClient({
      price_baselines: { rows: [
        { id: "t1", country: "PT", city: "Lisbon", category: "lodging", tier: "budget",
          daily_amount: 40, currency: "USD", source_note: "budget-only", last_verified_at: "2026-06-01T00:00:00Z" },
      ]},
    });
    const result = await estimateTripCost(client, trip, { tier: "luxury" });
    assert.equal(result.available, true);
    const est = result as any;
    assert.equal(est.tier, "luxury");
    assert.equal(est.breakdown[0].perDay, 40, "uses the only row that exists");
    assert.ok(
      est.assumptions.some((a: string) => a.includes("nearest tier 'budget'")),
      "fallback must be stated, not silent",
    );
  });
});

// ── Lib: sandboxBudget ────────────────────────────────────────────────────────

describe("sandboxBudget", () => {
  async function makeEstimate() {
    const { client } = makeFakeClient({ price_baselines: { rows: [...CITY_BASELINES] } });
    return estimateTripCost(client, {
      destination_city: "Lisbon", destination_country: "Portugal",
      start_date: "2026-08-01", end_date: "2026-08-05",
    }, { tier: "comfortable" });
  }

  it("HONESTY: no estimate and no override → no_inputs", () => {
    const result = sandboxBudget(null, { total_budget: 1000 }, {});
    assert.equal(result.available, false);
    assert.equal((result as any).reason, "no_inputs");
  });

  it("fitsBudget math: over budget → false with positive gap; delta can flip it", async () => {
    const estimate = await makeEstimate(); // total mid 900 over 5 days
    const over = sandboxBudget(estimate, { total_budget: 500 }, {});
    assert.equal(over.available, true);
    const o = over as any;
    assert.equal(o.total.mid, 900);
    assert.equal(o.budget.effectiveBudget, 500);
    assert.equal(o.fitsBudget, false);
    assert.equal(o.gap, 400, "900 - 500");

    const fits = sandboxBudget(estimate, { total_budget: 500 }, { budgetDelta: 450 });
    const f = fits as any;
    assert.equal(f.budget.effectiveBudget, 950);
    assert.equal(f.fitsBudget, true);
    assert.equal(f.gap, -50);
  });

  it("never suggests trimming a protected category", async () => {
    const estimate = await makeEstimate(); // lodging 100 / food 50 / activities 30
    const result = sandboxBudget(estimate, { total_budget: 500 }, {
      protectedCategories: ["lodging"],
    });
    assert.equal(result.available, true);
    const r = result as any;
    assert.ok(r.suggestions.length > 0, "over budget should yield suggestions");
    for (const s of r.suggestions) {
      assert.notEqual(s.category, "lodging", "protected category must be untouched");
    }
    // Untouched categories may appear
    assert.ok(r.suggestions.some((s: any) => s.type === "reduce_category" && s.category !== "lodging"));
    assert.ok(r.notes.some((n: string) => n.includes("Protected categories left untouched")));
  });

  it("extraDays changes days and totals", async () => {
    const estimate = await makeEstimate();
    const result = sandboxBudget(estimate, null, { extraDays: 2 });
    const r = result as any;
    assert.equal(r.days, 7);
    assert.equal(r.total.mid, 1260, "180/day x 7");
    assert.equal(r.fitsBudget, null, "no budget row → honest null");
    assert.ok(r.notes.some((n: string) => n.includes("No trip budget is set")));
  });

  it("works off dailySpendOverride alone with an honest note", async () => {
    const result = sandboxBudget(null, { total_budget: 300 }, {
      dailySpendOverride: 100, extraDays: 4,
    });
    assert.equal(result.available, true);
    const r = result as any;
    assert.equal(r.days, 4);
    assert.equal(r.total.mid, 400);
    assert.equal(r.fitsBudget, false);
    assert.equal(r.gap, 100);
    assert.ok(r.notes.some((n: string) => n.includes("dailySpendOverride")));
    assert.ok(r.notes.some((n: string) => n.includes("No baseline estimate")));
    // No category data → no reduce_category suggestions (nothing invented)
    assert.ok(r.suggestions.every((s: any) => s.type !== "reduce_category"));
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────

describe("budget intelligence routes", () => {
  beforeEach(async () => {
    if (server) server.close();
    await startServer();
  });

  after(() => {
    if (server) server.close();
    _setTestClient(null as any, false);
  });

  it("GET /trips/:id/cost-estimate is gated by the feature flag", async () => {
    const { client } = makeFakeClient(baseTables({
      feature_flags: { rows: [{ flag: "budget_intelligence_enabled", enabled: false }] },
    }));
    _setTestClient(client, true);
    const r = await req("GET", `/trips/${TRIP_ID}/cost-estimate`, { token: "member-token" });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("GET /trips/:id/cost-estimate rejects non-members", async () => {
    const { client } = makeFakeClient(baseTables());
    _setTestClient(client, true);
    const r = await req("GET", `/trips/${TRIP_ID}/cost-estimate`, { token: "other-token" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });

  it("GET /trips/:id/cost-estimate returns the estimate with accepted-member partySize", async () => {
    const { client } = makeFakeClient(baseTables({
      price_baselines: { rows: [...CITY_BASELINES] },
    }));
    _setTestClient(client, true);
    const r = await req("GET", `/trips/${TRIP_ID}/cost-estimate?tier=comfortable`, { token: "member-token" });
    assert.equal(r.status, 200);
    assert.equal(r.body.partySize, 2, "invited row must not count");
    assert.equal(r.body.estimate.available, true);
    assert.equal(r.body.estimate.perDay.mid, 180);
  });

  it("GET /trips/:id/cost-estimate rejects an invalid tier", async () => {
    const { client } = makeFakeClient(baseTables());
    _setTestClient(client, true);
    const r = await req("GET", `/trips/${TRIP_ID}/cost-estimate?tier=platinum`, { token: "member-token" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("cost-estimate stays honest with zero baselines over HTTP", async () => {
    const { client } = makeFakeClient(baseTables());
    _setTestClient(client, true);
    const r = await req("GET", `/trips/${TRIP_ID}/cost-estimate`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.equal(r.body.estimate.available, false);
    assert.equal(r.body.estimate.reason, "no_baseline_data");
  });

  it("POST /trips/:id/budget/sandbox gives owners the budget comparison", async () => {
    const { client } = makeFakeClient(baseTables({
      price_baselines: { rows: [...CITY_BASELINES] },
      trip_budget: { rows: [{ trip_id: TRIP_ID, total_budget: 500, currency: "USD" }] },
    }));
    _setTestClient(client, true);
    const r = await req("POST", `/trips/${TRIP_ID}/budget/sandbox`, {
      token: "owner-token",
      body: { tier: "comfortable", protectedCategories: ["lodging"] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.sandbox.available, true);
    assert.equal(r.body.sandbox.fitsBudget, false);
    assert.equal(r.body.sandbox.gap, 400);
    for (const s of r.body.sandbox.suggestions) {
      assert.notEqual(s.category, "lodging");
    }
  });

  it("POST /trips/:id/budget/sandbox hides the budget comparison from plain members", async () => {
    const { client } = makeFakeClient(baseTables({
      price_baselines: { rows: [...CITY_BASELINES] },
      trip_budget: { rows: [{ trip_id: TRIP_ID, total_budget: 500, currency: "USD" }] },
    }));
    _setTestClient(client, true);
    const r = await req("POST", `/trips/${TRIP_ID}/budget/sandbox`, {
      token: "member-token",
      body: {},
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.sandbox.fitsBudget, null, "budget stays owner/co_host-only");
    assert.ok(r.body.sandbox.notes.some((n: string) => n.includes("owner and co-hosts")));
  });

  // ── Admin CRUD ──────────────────────────────────────────────────────────────

  it("admin baseline routes reject non-admins", async () => {
    const { client } = makeFakeClient(baseTables());
    _setTestClient(client, true);
    const list = await req("GET", "/admin/price-baselines", { token: "member-token" });
    assert.equal(list.status, 403);
    const create = await req("POST", "/admin/price-baselines", {
      token: "member-token",
      body: { category: "food", tier: "budget", dailyAmount: 10 },
    });
    assert.equal(create.status, 403);
    const del = await req("DELETE", "/admin/price-baselines/aaaaaaaa-0000-0000-0000-000000000000", { token: "member-token" });
    assert.equal(del.status, 403);
  });

  it("admin can create, upsert-in-place, list with filters, and delete baselines", async () => {
    const { client, db } = makeFakeClient(baseTables());
    _setTestClient(client, true);

    const created = await req("POST", "/admin/price-baselines", {
      token: "admin-token",
      body: { country: "pt", city: "Lisbon", category: "food", tier: "budget", dailyAmount: 20, sourceNote: "v1" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    assert.equal(created.body.baseline.country, "PT", "country upper-cased");
    assert.equal(created.body.baseline.verified_by, ADMIN_ID);
    assert.ok(created.body.baseline.last_verified_at);

    // Same (country, city, category, tier) combo → update, not a second row
    const upserted = await req("POST", "/admin/price-baselines", {
      token: "admin-token",
      body: { country: "PT", city: "Lisbon", category: "food", tier: "budget", dailyAmount: 25, sourceNote: "v2" },
    });
    assert.equal(upserted.status, 200);
    assert.equal(upserted.body.created, false);
    assert.equal(upserted.body.baseline.daily_amount, 25);
    assert.equal(db.price_baselines.rows.length, 1, "upsert must not duplicate the combo");

    const list = await req("GET", "/admin/price-baselines?country=PT&category=food", { token: "admin-token" });
    assert.equal(list.status, 200);
    assert.equal(list.body.baselines.length, 1);
    assert.equal(list.body.baselines[0].source_note, "v2");

    const id = list.body.baselines[0].id;
    const del = await req("DELETE", `/admin/price-baselines/${id}`, { token: "admin-token" });
    assert.equal(del.status, 204);
    assert.equal(db.price_baselines.rows.length, 0);
  });
});
