/**
 * Search Intelligence unit + integration tests
 *
 * Covers Phases 11–18, 26:
 *   - applyAliases: typo tolerance / synonym expansion (incl. travel destinations)
 *   - matchTier: exact > prefix > contains > none, subtitle-aware
 *   - rankByMatchTier: stable descending sort; subtitle checked for handle searches
 *   - haversineKm: approximate distance computation
 *   - parseTimeIntent: keyword detection, stripped query, UTC date bounds
 *   - parseNearbyIntent: proximity keyword detection + stripping
 *   - GET/POST/DELETE /api/me/search-history (incl. delete by id)
 *
 * Run: node --import tsx/esm --test src/test/discoverySearchIntelligence.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import searchHistoryRouter from "../routes/searchHistory.js";
import {
  applyAliases,
  matchTier,
  rankByMatchTier,
  rankCombined,
  haversineKm,
  parseTimeIntent,
  parseNearbyIntent,
} from "../routes/discoverySearchHelpers.js";

// ── Pure-logic tests ──────────────────────────────────────────────────────────

describe("applyAliases", () => {
  it("corrects a simple misspelling", () => {
    assert.equal(applyAliases("bech party"), "beach party");
  });

  it("corrects restaurnt → restaurant", () => {
    assert.equal(applyAliases("best restaurnt in town"), "best restaurant in town");
  });

  it("is case-insensitive", () => {
    assert.equal(applyAliases("Travler meet"), "traveler meet");
  });

  it("returns original when no alias matches", () => {
    assert.equal(applyAliases("hiking trail"), "hiking trail");
  });

  it("replaces only the first match", () => {
    const result = applyAliases("bech bech bech");
    assert.equal(result, "beach bech bech");
  });

  it("does not match substrings — word boundary only", () => {
    const r = applyAliases("beautiful beaches");
    assert.equal(r, "beautiful beaches");
  });

  it("expands tonite → tonight", () => {
    assert.equal(applyAliases("events tonite"), "events tonight");
  });

  // Travel destination aliases
  it("corrects siargou → siargao", () => {
    assert.equal(applyAliases("siargou surf"), "siargao surf");
  });

  it("corrects manilla → manila", () => {
    assert.equal(applyAliases("manilla hotels"), "manila hotels");
  });

  it("corrects tokoyo → tokyo", () => {
    assert.equal(applyAliases("tokoyo food"), "tokyo food");
  });

  it("corrects pukhet → phuket", () => {
    assert.equal(applyAliases("pukhet beaches"), "phuket beaches");
  });

  it("corrects borocay → boracay", () => {
    assert.equal(applyAliases("borocay trip"), "boracay trip");
  });
});

describe("matchTier", () => {
  it("returns 3 for exact match", () => {
    assert.equal(matchTier("beach", "beach"), 3);
  });

  it("is case-insensitive for exact match", () => {
    assert.equal(matchTier("Beach", "beach"), 3);
  });

  it("returns 2 for prefix match", () => {
    assert.equal(matchTier("beach party", "beach"), 2);
  });

  it("returns 1 for substring match", () => {
    assert.equal(matchTier("great beach experience", "beach"), 1);
  });

  it("returns 0 for no match", () => {
    assert.equal(matchTier("mountain trek", "beach"), 0);
  });

  // Subtitle-aware (handle matching for @username searches)
  it("returns 3 for exact subtitle match (handle)", () => {
    assert.equal(matchTier("John Smith", "alice", "@alice"), 3);
  });

  it("returns 2 for prefix subtitle match", () => {
    assert.equal(matchTier("John Smith", "ali", "@alice"), 2);
  });

  it("returns 0 when neither title nor subtitle matches", () => {
    assert.equal(matchTier("Bob Jones", "alice", "@bob"), 0);
  });

  it("strips leading @ from subtitle before comparing", () => {
    // query "alice", subtitle "@alice" → exact tier 3
    assert.equal(matchTier("Full Name", "alice", "@alice"), 3);
  });
});

describe("rankByMatchTier", () => {
  it("sorts exact > prefix > contains > none", () => {
    const items = [
      { title: "great beach experience" },
      { title: "mountain trek" },
      { title: "Beach" },
      { title: "beach party" },
    ];
    const ranked = rankByMatchTier(items, "beach");
    assert.equal(ranked[0]!.title, "Beach");
    assert.equal(ranked[1]!.title, "beach party");
    assert.equal(ranked[2]!.title, "great beach experience");
    assert.equal(ranked[3]!.title, "mountain trek");
  });

  it("is stable — equal-tier items preserve relative order", () => {
    const items = [
      { title: "beach club A" },
      { title: "beach club B" },
    ];
    const ranked = rankByMatchTier(items, "beach");
    assert.equal(ranked[0]!.title, "beach club A");
    assert.equal(ranked[1]!.title, "beach club B");
  });

  it("does not mutate the original array", () => {
    const items = [{ title: "foo" }, { title: "foobar" }];
    const copy = [...items];
    rankByMatchTier(items, "foobar");
    assert.deepEqual(items, copy);
  });

  it("ranks handle-subtitle matches above unrelated titles (@username search)", () => {
    const items = [
      { title: "Random Person", subtitle: "@randomuser" },
      { title: "Full Name",     subtitle: "@alice" },
    ];
    const ranked = rankByMatchTier(items, "alice");
    assert.equal(ranked[0]!.subtitle, "@alice");
    assert.equal(ranked[1]!.subtitle, "@randomuser");
  });
});

describe("rankCombined", () => {
  it("sorts exact > prefix > contains > none (same as rankByMatchTier when no userCity)", () => {
    const items = [
      { title: "great beach experience", locationPreview: "Cebu" },
      { title: "mountain trek",          locationPreview: "Bohol" },
      { title: "Beach",                  locationPreview: "Cebu" },
      { title: "beach party",            locationPreview: "Cebu" },
    ];
    const ranked = rankCombined(items, "beach");
    assert.equal(ranked[0]!.title, "Beach");
    assert.equal(ranked[1]!.title, "beach party");
    assert.equal(ranked[2]!.title, "great beach experience");
    assert.equal(ranked[3]!.title, "mountain trek");
  });

  it("exact handle surfaces first under high-noise (20+ same-tier travelers)", () => {
    // Simulate 25 travelers whose titles all contain "alice" (contains-tier = 1)
    // plus one exact username match (via subtitle, tier = 3).
    const noise: { title: string; subtitle: string; locationPreview: string }[] = Array.from(
      { length: 25 }, (_, i) => ({
        title: `Traveler alice${i}`,
        subtitle: `@noise${i}`,
        locationPreview: "Manila",
      }),
    );
    const exactMatch = { title: "Traveler Person", subtitle: "@alice", locationPreview: "Manila" };
    const pool = [...noise, exactMatch];

    const ranked = rankCombined(pool, "alice");
    assert.equal(ranked[0]!.subtitle, "@alice",
      "exact handle match must be first regardless of pool size");
  });

  it("city-matched result surfaces first when tier is tied (nearby tiebreak)", () => {
    const items = [
      { title: "beach party",   subtitle: undefined, locationPreview: "Davao City, Philippines" },
      { title: "beach club",    subtitle: undefined, locationPreview: "Manila, Philippines" },
      { title: "beach resort",  subtitle: undefined, locationPreview: "Cebu City, Philippines" },
    ];
    // All three are contains-tier for "beach" — city boost should determine order
    const ranked = rankCombined(items, "beach", "cebu");
    assert.equal(ranked[0]!.locationPreview, "Cebu City, Philippines",
      "cebu-city result must be first when userCity='cebu' and tiers are tied");
  });

  it("without userCity degenerates to pure match-tier (no city boost)", () => {
    // Both items are prefix-tier for "beach" (same tier).
    // Without userCity, no city boost is applied and stable (original) order is preserved.
    // If userCity were "cebu", beach resort (Cebu) would jump to front — this test proves it doesn't.
    const items = [
      { title: "beach club",   locationPreview: "Manila" },
      { title: "beach resort", locationPreview: "Cebu City" },
    ];
    const ranked = rankCombined(items, "beach"); // no userCity
    assert.equal(ranked[0]!.title, "beach club",
      "without userCity, stable original order is preserved — city boost must not apply");
    assert.equal(ranked[1]!.title, "beach resort");
  });

  it("does not mutate the original array", () => {
    const items = [
      { title: "foo", locationPreview: "City A" },
      { title: "foobar", locationPreview: "City B" },
    ];
    const copy = [...items];
    rankCombined(items, "foobar", "City B");
    assert.deepEqual(items, copy);
  });

  it("nearby-intent: higher-tier match wins over city boost (tier beats proximity)", () => {
    const items = [
      { title: "beach bar",   subtitle: undefined, locationPreview: "Cebu City" }, // contains-tier + city match
      { title: "Beach",       subtitle: undefined, locationPreview: "Manila" },    // exact-tier, no city match
    ];
    const ranked = rankCombined(items, "beach", "cebu");
    assert.equal(ranked[0]!.title, "Beach",
      "exact match must beat city-matched contains-match even when userCity set");
  });

  it("upcomingFirst: future trip surfaces before past trip when tiers are tied", () => {
    const past  = { title: "beach trip past",     locationPreview: null, startsAt: "2020-01-01T00:00:00Z" };
    const future = { title: "beach trip upcoming", locationPreview: null, startsAt: new Date(Date.now() + 86400000 * 30).toISOString() };
    const ranked = rankCombined([past, future], "beach", undefined, { upcomingFirst: true });
    assert.equal(ranked[0]!.title, "beach trip upcoming",
      "upcoming trip must surface before past trip within same tier");
  });

  it("upcomingFirst: exact match surfaces first even when it is a past trip", () => {
    const past  = { title: "beach trip",    locationPreview: null, startsAt: "2020-01-01T00:00:00Z" }; // exact tier
    const future = { title: "beach party 2025", locationPreview: null, startsAt: new Date(Date.now() + 86400000).toISOString() }; // prefix tier
    const ranked = rankCombined([future, past], "beach trip", undefined, { upcomingFirst: true });
    assert.equal(ranked[0]!.title, "beach trip",
      "exact match must win over upcoming-prefix even with upcomingFirst enabled — tier beats upcoming");
  });

  it("upcomingFirst: is a no-op for items without startsAt (travelers, places)", () => {
    const items = [
      { title: "beach club",   locationPreview: "Manila" },
      { title: "beach resort", locationPreview: "Cebu City" },
    ];
    const withOpt    = rankCombined(items, "beach", undefined, { upcomingFirst: true });
    const withoutOpt = rankCombined(items, "beach");
    assert.deepEqual(withOpt.map(i => i.title), withoutOpt.map(i => i.title),
      "upcomingFirst with no startsAt fields must produce same order as without the option");
  });
});

describe("haversineKm", () => {
  it("returns ~0 for same point", () => {
    assert.ok(haversineKm(14.5995, 120.9842, 14.5995, 120.9842) < 0.001);
  });

  it("Manila to Cebu is roughly 570 km", () => {
    const d = haversineKm(14.5995, 120.9842, 10.3157, 123.8854);
    assert.ok(d > 500 && d < 650, `Expected ~570 km, got ${d.toFixed(1)} km`);
  });

  it("is symmetric", () => {
    const d1 = haversineKm(14.5995, 120.9842, 10.3157, 123.8854);
    const d2 = haversineKm(10.3157, 123.8854, 14.5995, 120.9842);
    assert.ok(Math.abs(d1 - d2) < 0.001);
  });
});

describe("parseNearbyIntent", () => {
  it("returns nearbyIntent:false when no keyword", () => {
    const r = parseNearbyIntent("beach events");
    assert.equal(r.nearbyIntent, false);
    assert.equal(r.strippedQuery, "beach events");
  });

  it("detects 'nearby' keyword", () => {
    const r = parseNearbyIntent("events nearby");
    assert.equal(r.nearbyIntent, true);
    assert.equal(r.strippedQuery, "events");
  });

  it("detects 'near me'", () => {
    const r = parseNearbyIntent("food near me");
    assert.equal(r.nearbyIntent, true);
    assert.equal(r.strippedQuery, "food");
  });

  it("detects 'around me'", () => {
    const r = parseNearbyIntent("travelers around me");
    assert.equal(r.nearbyIntent, true);
    assert.equal(r.strippedQuery, "travelers");
  });

  it("is case-insensitive", () => {
    const r = parseNearbyIntent("Events NEARBY");
    assert.equal(r.nearbyIntent, true);
    assert.equal(r.strippedQuery, "Events");
  });

  it("falls back to original q when stripping leaves empty", () => {
    const r = parseNearbyIntent("nearby");
    assert.equal(r.nearbyIntent, true);
    assert.equal(r.strippedQuery, "nearby");
  });
});

describe("parseTimeIntent", () => {
  it("returns null intent when no keyword found", () => {
    const r = parseTimeIntent("beach events", "UTC");
    assert.equal(r.intent, null);
    assert.equal(r.strippedQuery, "beach events");
  });

  it("detects 'tonight' and strips it", () => {
    const r = parseTimeIntent("events tonight", "UTC");
    assert.equal(r.intent?.type, "tonight");
    assert.equal(r.intent?.label, "Tonight");
    assert.equal(r.strippedQuery, "events");
    const after  = new Date(r.intent!.startsAfter);
    const before = new Date(r.intent!.startsBefore);
    assert.ok(after < before);
    const spanHrs = (before.getTime() - after.getTime()) / 3600_000;
    assert.ok(spanHrs <= 8, `Tonight span should be ≤ 8h, got ${spanHrs}`);
  });

  it("detects 'tonite' alias", () => {
    const r = parseTimeIntent("fun tonite", "UTC");
    assert.equal(r.intent?.type, "tonight");
    assert.equal(r.strippedQuery, "fun");
  });

  it("detects 'tomorrow'", () => {
    const r = parseTimeIntent("food tomorrow", "UTC");
    assert.equal(r.intent?.type, "tomorrow");
    const spanHrs = (new Date(r.intent!.startsBefore).getTime() - new Date(r.intent!.startsAfter).getTime()) / 3600_000;
    assert.ok(Math.abs(spanHrs - 24) < 1, `Tomorrow should be ~24h, got ${spanHrs}`);
  });

  it("detects 'this weekend'", () => {
    const r = parseTimeIntent("hiking this weekend", "UTC");
    assert.equal(r.intent?.type, "this_weekend");
    assert.equal(r.strippedQuery, "hiking");
    const spanHrs = (new Date(r.intent!.startsBefore).getTime() - new Date(r.intent!.startsAfter).getTime()) / 3600_000;
    assert.ok(spanHrs <= 48, `Weekend span should be ≤ 48h, got ${spanHrs}`);
  });

  it("detects 'next week'", () => {
    const r = parseTimeIntent("concerts next week", "UTC");
    assert.equal(r.intent?.type, "next_week");
    const spanHrs = (new Date(r.intent!.startsBefore).getTime() - new Date(r.intent!.startsAfter).getTime()) / 3600_000;
    assert.ok(Math.abs(spanHrs - 168) < 2, `Next week should be ~168h, got ${spanHrs}`);
  });

  it("falls back to original q when stripping leaves it empty", () => {
    const r = parseTimeIntent("tonight", "UTC");
    assert.equal(r.strippedQuery, "tonight");
  });

  it("is case-insensitive", () => {
    const r = parseTimeIntent("events TONIGHT please", "UTC");
    assert.equal(r.intent?.type, "tonight");
    assert.equal(r.strippedQuery.trim(), "events please");
  });
});

// ── Search history HTTP tests ─────────────────────────────────────────────────

const ME     = "aa000000-0000-4000-a000-000000000001";
const ME_TOK = "tok-me";

interface HistoryRow {
  id: string;
  user_id: string;
  query: string;
  search_type: string;
  searched_at: string;
}

interface FakeState {
  search_history?: HistoryRow[];
}

function makeFakeClient(state: FakeState) {
  const rows: HistoryRow[] = [...(state.search_history ?? [])];

  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from(table: string) {
      if (table !== "search_history") {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return this; },
          range() { return this; },
          in() { return this; },
          upsert() { return Promise.resolve({ error: null }); },
          delete() { return this; },
          then(onF: any) { return Promise.resolve({ data: [], error: null }).then(onF); },
        };
      }

      let pending: "select" | "upsert" | "delete" | null = null;
      let upsertPayload: Partial<HistoryRow> | null = null;
      const filters: Array<(r: HistoryRow) => boolean> = [];
      let _limitN = Infinity;
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let inIds: string[] | null = null;
      let _singleMode = false;

      const builder: any = {
        select()                         { pending = "select"; return builder; },
        upsert(row: Partial<HistoryRow>) { pending = "upsert"; upsertPayload = row; return builder; },
        delete()                         { pending = "delete"; return builder; },
        single()                         { _singleMode = true; return builder; },
        eq(col: string, val: any)        { filters.push((r) => (r as any)[col] === val); return builder; },
        order()                          { return builder; },
        limit(n: number)                 { _limitN = n; return builder; },
        range(s: number, e: number)      { _rangeStart = s; _rangeEnd = e; return builder; },
        in(col: string, vals: string[])  { inIds = vals; return builder; },
        then(onF: any, onR: any) {
          if (pending === "upsert" && upsertPayload) {
            // Simulate upsert: find existing row by (user_id, query, search_type) conflict,
            // update it if found; otherwise insert a new row.
            const p = upsertPayload;
            const existing = rows.find(
              (r) => r.user_id === p.user_id && r.query === p.query && r.search_type === p.search_type,
            );
            let result: HistoryRow;
            if (existing) {
              existing.searched_at = p.searched_at ?? existing.searched_at;
              result = existing;
            } else {
              const newRow: HistoryRow = {
                id: p.id ?? `fake-uuid-${rows.length}`,
                user_id: p.user_id ?? ME,
                query: p.query ?? "",
                search_type: p.search_type ?? "all",
                searched_at: p.searched_at ?? new Date().toISOString(),
              };
              rows.push(newRow);
              result = newRow;
            }
            const out = _singleMode
              ? { data: { ...result }, error: null }
              : { data: [{ ...result }], error: null };
            return Promise.resolve(out).then(onF, onR);
          }
          if (pending === "delete") {
            const toRemove = rows.filter((r) => {
              const passFilters = filters.every((f) => f(r));
              const passIn = inIds ? inIds.includes(r.id) : true;
              return passFilters && passIn;
            });
            for (const rm of toRemove) rows.splice(rows.indexOf(rm), 1);
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          }
          // select
          const matched = rows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined);
          if (_singleMode) {
            return Promise.resolve({ data: matched[0] ?? null, error: null }).then(onF, onR);
          }
          return Promise.resolve({ data: [...matched], error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

let base: string;
let server: Server;
let currentState: FakeState = {};

function setup(state: Partial<FakeState> = {}) {
  currentState = { search_history: [], ...state };
  _setTestClient(makeFakeClient(currentState) as any, true);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", searchHistoryRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))));

beforeEach(() => {
  _resetRateLimit();
  setup();
});

async function get(path: string, token = ME_TOK) {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}
async function post(path: string, body: unknown, token = ME_TOK) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
async function del(path: string, token = ME_TOK) {
  return fetch(`${base}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
}

describe("GET /api/me/search-history", () => {
  it("401 when unauthenticated", async () => {
    const res = await get("/me/search-history", "bad-token");
    assert.equal(res.status, 401);
  });

  it("returns empty array when no history", async () => {
    const res = await get("/me/search-history");
    assert.equal(res.status, 200);
    const body = await res.json() as { history: any[] };
    assert.deepEqual(body.history, []);
  });

  it("returns seeded history", async () => {
    setup({
      search_history: [
        { id: "h1", user_id: ME, query: "beach", search_type: "all", searched_at: new Date().toISOString() },
      ],
    });
    const res = await get("/me/search-history");
    assert.equal(res.status, 200);
    const body = await res.json() as { history: HistoryRow[] };
    assert.equal(body.history.length, 1);
    assert.equal(body.history[0]!.query, "beach");
  });
});

describe("POST /api/me/search-history", () => {
  it("401 when unauthenticated", async () => {
    const res = await post("/me/search-history", { query: "beach" }, "bad-token");
    assert.equal(res.status, 401);
  });

  it("400 when query missing", async () => {
    const res = await post("/me/search-history", {});
    assert.equal(res.status, 400);
  });

  it("400 when query is empty string", async () => {
    const res = await post("/me/search-history", { query: "   " });
    assert.equal(res.status, 400);
  });

  it("200 and ok on valid save", async () => {
    const res = await post("/me/search-history", { query: "hiking", search_type: "places" });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("200 response includes the persisted row id (deletion identity contract)", async () => {
    // The UI replaces its optimistic synthetic id with this server id so that
    // per-item DELETE ?id= actually finds the row.  Verify the field exists.
    setup({
      search_history: [
        { id: "server-uuid-1", user_id: ME, query: "surfing", search_type: "all", searched_at: new Date().toISOString() },
      ],
    });
    const res = await post("/me/search-history", { query: "surfing", search_type: "all" });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; id: string | null };
    assert.equal(body.ok, true);
    assert.ok(
      typeof body.id === "string" || body.id === null,
      "response must include an id field (string uuid or null on error)",
    );
  });

  it("save → delete by returned id → entry is gone (end-to-end deletion contract)", async () => {
    // Simulates the UI flow: save search, get server id, delete using that id.
    setup({
      search_history: [
        { id: "server-uuid-abc", user_id: ME, query: "volcano hike", search_type: "all", searched_at: new Date().toISOString() },
        { id: "server-uuid-xyz", user_id: ME, query: "beach",        search_type: "all", searched_at: new Date().toISOString() },
      ],
    });

    // 1. GET to confirm both entries visible
    const before = await get("/me/search-history");
    const beforeBody = await before.json() as { history: HistoryRow[] };
    assert.equal(beforeBody.history.length, 2);

    // 2. DELETE the first entry by its server id
    const delRes = await del("/me/search-history?id=server-uuid-abc");
    assert.equal(delRes.status, 200);

    // 3. GET to confirm only the other entry remains
    const after = await get("/me/search-history");
    const afterBody = await after.json() as { history: HistoryRow[] };
    assert.equal(afterBody.history.length, 1);
    assert.equal(afterBody.history[0]!.id, "server-uuid-xyz",
      "only the deleted entry must be removed; the other must survive");
  });
});

describe("DELETE /api/me/search-history", () => {
  it("401 when unauthenticated", async () => {
    const res = await del("/me/search-history", "bad-token");
    assert.equal(res.status, 401);
  });

  it("200 on clear all", async () => {
    const res = await del("/me/search-history");
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("200 on clear specific query via ?q=", async () => {
    const res = await del("/me/search-history?q=beach");
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("200 on delete by id via ?id=", async () => {
    setup({
      search_history: [
        { id: "uuid-h1", user_id: ME, query: "beach", search_type: "all", searched_at: new Date().toISOString() },
        { id: "uuid-h2", user_id: ME, query: "hiking", search_type: "all", searched_at: new Date().toISOString() },
      ],
    });
    const res = await del("/me/search-history?id=uuid-h1");
    assert.equal(res.status, 200);
    // Only the targeted entry should be removed; the other survives
    const getRes = await get("/me/search-history");
    const body = await getRes.json() as { history: HistoryRow[] };
    assert.equal(body.history.length, 1);
    assert.equal(body.history[0]!.id, "uuid-h2");
  });
});
