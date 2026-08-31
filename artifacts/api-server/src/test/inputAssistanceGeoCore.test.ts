/**
 * Phase 2 — Geographic Core (Global Input Intelligence).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceGeoCore.test.ts
 *
 * Proves the strengthened geographic resolution behind POST /input-assistance/suggest:
 *   §10  diacritic/stroke fold — "da nang"/"danang" resolve to stored "Đà Nẵng".
 *   §11  abbreviations resolve to a CITY entity/id — "hcmc"/"saigon" → the Ho Chi
 *        Minh City row, not merely a country.
 *   §10  misspelling tolerance — "phu qouc" → Phu Quoc.
 *   §17  selection returns the canonical binding (city_id + country + timezone).
 *   §14  zero-character defaults (current city + upcoming Trip).
 *   §19  ambiguity/airport input yields disambiguation CHOICES, not a silent pick.
 *   Regression: non-geographic paths (username search, global_search cities)
 *        keep their existing shape.
 *
 * MUTATION-PROOFS (documented inline):
 *   - Remove the stroke fold from `searchKey()` (lib/canonicalLocations): the
 *     Đà Nẵng fixture's search_key becomes "a nang", so "da nang" no longer
 *     matches → the §10 tests go RED. (The fixture computes search_key with the
 *     SAME `searchKey()` the DB generated column mirrors, so the fold is what is
 *     under test.)
 *   - Remove the "hcmc" entry from CITY_GEO_ALIASES → "hcmc" no longer resolves
 *     to the city id → that test goes RED.
 *   - Force `ambiguous=false` / drop the airport branch in geoResolver → the
 *     disambiguation tests go RED (a silent single pick returns instead).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import {
  searchKey,
  strokeFold,
  normalizeLocationName,
  resolveGeoAlias,
} from "../lib/canonicalLocations.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────
const ME = "aa000000-0000-4000-a000-000000000001";
const ALICE = "bb000000-0000-4000-a000-000000000002";
const ME_TOK = "tok-me";

// ── Fake Supabase client (same harness shape as inputAssistanceGateway.test.ts) ─
interface FakeState { [key: string]: any[] | undefined; }

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
  const errorBuilder: any = {};
  const errorFns = ["select","eq","neq","in","not","is","ilike","or","gte","lt","order","limit","range","maybeSingle"];
  for (const fn of errorFns) errorBuilder[fn] = () => errorBuilder;
  errorBuilder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, onR);

  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;
      let profileCols: string[] | null = null;
      function project(rowsIn: any[]): any[] {
        if (table !== "profiles" || !profileCols) return rowsIn;
        return rowsIn.map((r) => Object.fromEntries(profileCols!.filter((c) => c in r).map((c) => [c, r[c]])));
      }
      const builder: any = {
        select(cols?: string) {
          if (table === "profiles" && typeof cols === "string" && cols !== "*") {
            profileCols = cols.split(",").map((c) => c.trim());
          }
          return builder;
        },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val && r[col] != null);
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        ilike(col: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[col] ?? "")));
          return builder;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.([\w]+)\.(.+)$/);
            if (!m) return null;
            return { col: m[1]!, op: m[2]!.toLowerCase(), val: m[3]! };
          }).filter(Boolean) as { col: string; op: string; val: string }[];
          filters.push((r) =>
            parts.some(({ col, op, val }) => {
              const cellStr = String(r[col] ?? "");
              if (op === "ilike") {
                const re = new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
                return re.test(cellStr);
              }
              if (op === "eq") return cellStr === val;
              return false;
            }),
          );
          return builder;
        },
        gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return builder; },
        lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
        order() { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = project(sourceRows.filter((r) => filters.every((f) => f(r))));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = project(sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined));
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────────

/**
 * A canonical_locations row EXACTLY as prod stores it after migration 2220:
 *  - normalized_name = the LEGACY normalizer (which corrupts stroke letters:
 *    normalizeLocationName("Đà Nẵng") === "a nang"),
 *  - search_key      = the folded generated column, mirrored here by searchKey()
 *    (searchKey("Đà Nẵng") === "da nang").
 * The resolver matches via search_key, so the fold is the thing under test.
 */
function canonCity(
  name: string,
  opts: { country?: string; countryCode?: string; region?: string; lat?: number; lng?: number; id?: string } = {},
) {
  const key = searchKey(name);
  return {
    id: opts.id ?? `canon-${(key || "x").replace(/\s+/g, "-")}`,
    kind: "city",
    name,
    normalized_name: normalizeLocationName(name),
    search_key: key,
    display_name: opts.country ? `${name}, ${opts.country}` : name,
    city: null,
    region: opts.region ?? null,
    country: opts.country ?? null,
    country_code: opts.countryCode ?? null,
    postal_code: null,
    lat: opts.lat ?? null,
    lng: opts.lng ?? null,
    provider_ids: {},
    aliases: [],
  };
}

const DA_NANG = canonCity("Đà Nẵng", { country: "Vietnam", countryCode: "VN", lat: 16.0678, lng: 108.2208 });
const HCMC = canonCity("Ho Chi Minh City", { country: "Vietnam", countryCode: "VN", lat: 10.8231, lng: 106.6297 });
const PHU_QUOC = canonCity("Phu Quoc", { country: "Vietnam", countryCode: "VN", lat: 10.2899, lng: 103.984 });
const PARIS_FR = canonCity("Paris", { country: "France", countryCode: "FR", lat: 48.8566, lng: 2.3522, id: "canon-paris-fr" });
const PARIS_TX = canonCity("Paris", { country: "United States", countryCode: "US", region: "Texas", lat: 33.6609, lng: -95.5555, id: "canon-paris-tx" });

const GEO_STATE: FakeState = {
  canonical_locations: [DA_NANG, HCMC, PHU_QUOC],
  blocks: [],
  user_privacy_settings: [],
  profiles: [],
  profile_privacy_settings: [],
};

// ── Server ───────────────────────────────────────────────────────────────────────
let base: string;
let server: Server;

function setup(state: FakeState, tableErrors: string[] = []) {
  _setTestClient(makeFakeClient(state, new Set(tableErrors)) as any, true);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());
beforeEach(() => { _resetRateLimit(); setup(GEO_STATE); });

function post(body: any, tok: string | null = ME_TOK) {
  return fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
}

// ── 1. Normalizer primitives (pure) — the Đ/đ stroke fold (§10) ─────────────────

describe("query normalizer (§10) — stroke/diacritic fold", () => {
  it("folds Đ/đ (which NFD does NOT decompose) so 'da nang' === 'Đà Nẵng'", () => {
    // MUTATION-PROOF: removing the stroke fold makes searchKey('Đà Nẵng') === 'a nang'.
    assert.equal(searchKey("Đà Nẵng"), "da nang");
    assert.equal(searchKey("da nang"), "da nang");
    assert.equal(searchKey("Đà Nẵng"), searchKey("da nang"));
    assert.equal(strokeFold("Đà Nẵng"), "dà Nẵng"); // only the stroke letter changes
  });

  it("strips the generic 'City' suffix so an abbreviation lands on the city key", () => {
    // Mirrors the migration 2220 postcondition (input_normalize_city_key parity).
    assert.equal(searchKey("Ho Chi Minh City"), "ho chi minh");
    assert.equal(searchKey("Cebu City"), "cebu");
  });

  it("alias dictionary resolves abbreviations + misspellings to canonical keys", () => {
    assert.equal(resolveGeoAlias("hcmc"), "ho chi minh");
    assert.equal(resolveGeoAlias("saigon"), "ho chi minh");
    assert.equal(resolveGeoAlias("danang"), "da nang");
    assert.equal(resolveGeoAlias("phu qouc"), "phu quoc"); // misspelling tolerance
  });

  it("does not fold ordinary ASCII input (no destructive normalization)", () => {
    assert.equal(strokeFold("Bangkok"), "Bangkok");
    assert.equal(searchKey("Bangkok"), "bangkok");
  });
});

// ── 2. Diacritic resolution end-to-end (§10) ────────────────────────────────────

describe("POST /suggest — diacritic/stroke resolution to Đà Nẵng (§10)", () => {
  for (const text of ["da nang", "danang", "Da Nang", "DA NANG"]) {
    it(`"${text}" resolves to the stored canonical Đà Nẵng city`, async () => {
      const r = await post({ context: "city_picker", text });
      const body = (await r.json()) as any;
      const city = body.suggestions.find((s: any) => s.entityId === DA_NANG.id);
      assert.ok(city, `expected Đà Nẵng among: ${JSON.stringify(body.suggestions.map((s: any) => s.label))}`);
      assert.equal(city.entityType, "city");
      assert.equal(city.label, "Đà Nẵng"); // display spelling preserved (§10)
    });
  }
});

// ── 3. Abbreviations resolve to a CITY entity/id, not a country (§11) ───────────

describe("POST /suggest — abbreviation → city entity/id (§11)", () => {
  for (const text of ["hcmc", "saigon", "Saigon"]) {
    it(`"${text}" resolves to the Ho Chi Minh City entity (not just a country)`, async () => {
      // MUTATION-PROOF: dropping "hcmc"/"saigon" from CITY_GEO_ALIASES makes this RED.
      const r = await post({ context: "city_picker", text });
      const body = (await r.json()) as any;
      const hit = body.suggestions.find((s: any) => s.entityId === HCMC.id);
      assert.ok(hit, `expected HCMC city entity among: ${JSON.stringify(body.suggestions.map((s: any) => s.label))}`);
      assert.equal(hit.entityType, "city");
      assert.equal(hit.structuredValue?.city, "Ho Chi Minh City");
      // The gap the audit named: it must NOT come back merely as a country.
      assert.ok(!body.suggestions.some((s: any) => s.entityType === "country"));
    });
  }
});

// ── 4. Misspelling tolerance (§10) ──────────────────────────────────────────────

describe("POST /suggest — misspelling tolerance (§10)", () => {
  it('"phu qouc" resolves to Phu Quoc', async () => {
    const r = await post({ context: "city_picker", text: "phu qouc" });
    const body = (await r.json()) as any;
    const hit = body.suggestions.find((s: any) => s.entityId === PHU_QUOC.id);
    assert.ok(hit, `expected Phu Quoc among: ${JSON.stringify(body.suggestions.map((s: any) => s.label))}`);
    assert.equal(hit.label, "Phu Quoc");
  });
});

// ── 5. Canonical binding on selection (§17/§53) ─────────────────────────────────

describe("POST /suggest — canonical binding on selection (§17/§53)", () => {
  it("selecting Đà Nẵng returns city_id + country + coordinates + timezone", async () => {
    const r = await post({ context: "trip_destination", text: "da nang" });
    const body = (await r.json()) as any;
    const city = body.suggestions.find((s: any) => s.entityId === DA_NANG.id);
    assert.ok(city);
    // The selection action BINDS the field to the canonical structured value.
    assert.equal(city.action.type, "set_structured_value");
    const b = city.structuredValue;
    assert.ok(b, "binding must be present");
    assert.equal(b.entityType, "city");
    assert.equal(b.cityId, DA_NANG.id);
    assert.equal(b.country, "Vietnam");
    assert.equal(b.timezone, "Asia/Ho_Chi_Minh"); // derived from the canonical centroid
    assert.equal(typeof b.lat, "number");
    assert.equal(typeof b.lng, "number");
  });
});

// ── 6. Zero-character defaults (§14/§53) ────────────────────────────────────────

describe("POST /suggest — zero-character defaults (§14)", () => {
  it("empty trip_destination returns current city + upcoming Trip", async () => {
    setup({
      ...GEO_STATE,
      trip_members: [{ user_id: ME, role: "member", trip_id: "trip-1" }],
      trips: [{
        id: "trip-1", destination_city: "Bangkok", destination_country: "Thailand",
        destination_lat: 13.7563, destination_lng: 100.5018, status: "upcoming", start_date: "2026-12-01",
      }],
    });
    const r = await post({ context: "trip_destination", text: "", city: "Da Nang" });
    const body = (await r.json()) as any;
    assert.ok(body.suggestions.length > 0, "zero-char must return defaults");
    const labels = body.suggestions.map((s: any) => s.label);
    assert.ok(labels.includes("Bangkok"), `expected upcoming Trip city; got ${JSON.stringify(labels)}`);
    const trip = body.suggestions.find((s: any) => s.label === "Bangkok");
    assert.equal(trip.reason, "Upcoming Trip");
    assert.equal(trip.type, "recent");
    // Current-location default resolves the supplied city to the canonical row.
    const current = body.suggestions.find((s: any) => s.reason === "Current location");
    assert.ok(current, "current-location default expected");
  });

  it("empty field with no trips/city returns no defaults (nothing fabricated)", async () => {
    const r = await post({ context: "trip_destination", text: "" });
    const body = (await r.json()) as any;
    assert.equal(body.suggestions.length, 0);
  });
});

// ── 7. Disambiguation, not a silent guess (§19) ─────────────────────────────────

describe("POST /suggest — progressive disambiguation (§19)", () => {
  it("an airport code (DAD) offers the city as a disambiguation choice, not a silent pick", async () => {
    // MUTATION-PROOF: removing the airport branch in geoResolver returns []/nothing here.
    const r = await post({ context: "city_picker", text: "DAD" });
    const body = (await r.json()) as any;
    const dis = body.suggestions.filter((s: any) => s.type === "disambiguation");
    assert.ok(dis.length >= 1, `expected a disambiguation choice for an airport code; got ${JSON.stringify(body.suggestions)}`);
    assert.ok(dis.some((s: any) => s.label === "Da Nang" && /DAD/.test(s.reason ?? "")));
    // Never an auto-replaceable high-confidence single entity.
    assert.ok(!body.suggestions.some((s: any) => s.type === "entity" && (s.confidence ?? 0) >= 0.9));
  });

  it("an ambiguous city (Paris FR vs Paris TX) returns ranked CHOICES, not one silent pick", async () => {
    // MUTATION-PROOF: forcing ambiguous=false makes these entity rows at conf 0.99.
    setup({ ...GEO_STATE, canonical_locations: [PARIS_FR, PARIS_TX] });
    const r = await post({ context: "city_picker", text: "paris" });
    const body = (await r.json()) as any;
    const dis = body.suggestions.filter((s: any) => s.type === "disambiguation");
    assert.ok(dis.length >= 2, `expected >=2 disambiguation choices; got ${JSON.stringify(body.suggestions.map((s: any) => [s.label, s.type]))}`);
    for (const s of dis) assert.ok((s.confidence ?? 1) <= 0.6, "disambiguation must stay in the MEDIUM band (no auto-replace)");
  });
});

// ── 8. Non-geographic paths unchanged (regression) ─────────────────────────────

describe("POST /suggest — non-geographic paths unchanged", () => {
  it("username search still returns a plain user entity (open_entity, not a binding)", async () => {
    setup({
      ...GEO_STATE,
      profiles: [{
        id: ALICE, handle: "wanderer", username: "wanderer", name: "Wanderer",
        avatar_url: null, is_private: false, home_city: null, home_country: null,
        account_status: "active", verified: false, is_official: false, show_profile_picture_publicly: true,
      }],
      profile_privacy_settings: [{ user_id: ALICE, show_real_name: true, allow_profile_discovery: true }],
      user_follows: [], friend_requests: [], user_friendships: [],
    });
    const r = await post({ context: "username", text: "wanderer" });
    const body = (await r.json()) as any;
    const user = body.suggestions.find((s: any) => s.entityType === "user");
    assert.ok(user, "username search must still surface the user");
    assert.equal(user.type, "entity");
    assert.equal(user.action.type, "open_entity"); // NOT set_structured_value
  });

  it("global_search cities keep the open_entity shape (no forced binding)", async () => {
    const r = await post({ context: "global_search", text: "da nang" });
    const body = (await r.json()) as any;
    const city = body.suggestions.find((s: any) => s.entityType === "city");
    assert.ok(city, "global_search should still surface the canonical city");
    assert.equal(city.action.type, "open_entity");
    assert.equal(city.structuredValue, undefined);
  });
});
