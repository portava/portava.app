/**
 * `11` §4 trend explanation (census-discovery §58: DC-21, DV-33) — the route
 * over loopback HTTP, the pure disclosure rules, and the SQL/TypeScript
 * explanation parity of migration 3410.
 *
 * What is pinned, and why each matters:
 *   A  auth, the flag (fail-closed, revocable both ways), input bounds
 *   B  the served shape is CLOSED: a state and a reason, never a rate, a weight,
 *      a traveller count or a score (`11` §4)
 *   C  cross-viewer denial: another viewer's exposure token reads exactly like
 *      a token that does not exist; a dwell row or another surface's row with
 *      the same token binds nothing
 *   D  the disclosure floor: below k travellers is indistinguishable from no
 *      evidence; a pre-3410 row (no traveller counts) is never disclosed
 *   E  freshness: stale, future-dated, absent and 2892-written snapshots each
 *      degrade with their stated reason, never as a claim
 *   F  failures: store absent, column absent, transient, a failure on the
 *      SECOND read, and an exposure-read failure are 503 with a closed reason —
 *      never a 200 with empty explanations
 *   G  retries answer byte-identically
 *   H  no serve path reads the store or imports this API (the default serving
 *      order cannot move)
 *   I  3410's stored sentence for every state IS lib/discoveryTrendState's
 *
 * Run: node --import tsx/esm --test src/test/discoveryTrendingApi.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trendingRouter from "../routes/discoveryTrending.js";
import {
  explainExposures, isCurrentRun, mayDiscloseTrend, parseRecommendationIds,
  TREND_DISCLOSURE_MIN_TRAVELERS, TREND_SNAPSHOT_MAX_AGE_MS, TREND_EXPLANATIONS_MAX_IDS,
  TREND_UNAVAILABLE_REASONS, TREND_API_FLAG,
} from "../lib/discoveryTrendExplanation.js";
import {
  TREND_STATES, TREND_REASON_CODES, trendReasonFor, explainTrendState,
  TREND_EVENT_WEIGHTS, TREND_RECENT_MS, TREND_MID_MS, TREND_PRIOR_MS, TREND_FEATURE_VERSION,
} from "../lib/discoveryTrendState.js";
import { MOMENTUM_CACHE_TTL_MS } from "../lib/discoveryLocalMomentum.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, "..");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";
const P1 = "33333333-3333-4333-8333-333333333301";
const rid = (s: string) => s.padEnd(22, "x");
const R = {
  trending: rid("r1"), emerging: rid("r2"), belowFloor: rid("r3"), unknown: rid("r4"),
  noRow: rid("r5"), legacy: rid("r6"), dwell: rid("r7"), livingPage: rid("r8"),
  others: rid("r9"), missing: rid("rX"), preThreeFourTen: rid("rA"),
};

type Row = Record<string, any>;
let seedNow = Date.now(); const iso = (msAgo: number) => new Date(seedNow - msAgo).toISOString();  // one clock reading per SEED(): rows of one run share computed_at exactly (the route selects the run by .eq(computed_at))

/** A momentum row as 3410's rebuild writes it — rates, weights and all. */
const pm = (place: string, state: string, recent: number | null, window: number | null, over: Row = {}): Row => ({
  place_id: place, computed_at: iso(60_000), trend_state: state,
  recent_rate: 12, mid_rate: 4, prior_rate: 2, total_weight: 99,
  recent_unique_travelers: recent, window_unique_travelers: window,
  model_version: "discovery-trend-state-v1", feature_version: TREND_FEATURE_VERSION,  // §75: as 3435 writes it
  window_ms: { recent_ms: TREND_RECENT_MS, mid_ms: TREND_MID_MS, prior_ms: TREND_PRIOR_MS },
  source_surface: "discovery", ...over,
});

const exposure = (user: string, rec: string, item: string, over: Row = {}): Row => ({
  user_id: user, item_id: item, surface: "discovery", outcome: "impression", event_type: null,
  recommendation_id: rec, features: { recommendationId: rec }, served_at: iso(3_600_000), ...over,
});

const K = TREND_DISCLOSURE_MIN_TRAVELERS;

const SEED = (): Record<string, Row[]> => (seedNow = Date.now(), {
  feature_flags: [{ flag: TREND_API_FLAG, enabled: true }],
  rank_events: [
    exposure(USER, R.trending, `db/${P1}`),
    exposure(USER, R.emerging, "node/2"),
    exposure(USER, R.belowFloor, "node/3"),
    exposure(USER, R.unknown, "node/4"),
    exposure(USER, R.noRow, "node/5"),
    // A §13.3 row: the id only in `features`, the column empty.
    exposure(USER, R.legacy, "node/6", { recommendation_id: null }),
    exposure(USER, R.preThreeFourTen, "node/10"),
    // An attention row carrying a token: never an exposure.
    exposure(USER, R.dwell, "node/7", { outcome: "analytics", event_type: "place_dwell" }),
    // Another surface's exposure token: not a Discovery exposure.
    exposure(USER, R.livingPage, "node/8", { surface: "living_page" }),
    // Another viewer's exposure.
    exposure(OTHER, R.others, "node/9"),
  ],
  place_momentum: [
    pm(`db/${P1}`, "trending", K, K),
    pm("node/2", "emerging", K + 5, K + 15),
    pm("node/3", "established", K - 1, K + 25),
    pm("node/4", "unknown", K + 15, K + 15),
    pm("node/6", "cooling", K, K),
    pm("node/9", "trending", K + 15, K + 15),
    pm("node/10", "trending", null, null),
    // An OLDER run with other answers: the newest run is the one read.
    pm("node/2", "cooling", 99, 99, { computed_at: iso(2 * 3_600_000) }),
    // A NEWER row written by 2892's function (no source_surface): not the product's corpus.
    pm("node/5", "trending", 99, 99, { computed_at: iso(30_000), source_surface: null }),
  ],
});

/**
 * PostgREST-shaped fake. Supports exactly the calls the route makes; anything
 * else throws, so a new filter fails here loudly instead of matching everything.
 */
function makeDb(
  seed: Record<string, Row[]>,
  faults: { missing?: string[]; missingColumn?: string[]; erroring?: string[]; failFromCall?: Record<string, number>; missingSelect?: string[] } = {},  // §75: `missingSelect` — a SELECT naming one of these columns answers 42703
) {
  const tables: Record<string, Row[]> = {
    profiles: [USER, OTHER].map((id) => ({ id, account_status: "active" })),
    ...seed,
  };
  const reads: string[] = [];
  const calls: Record<string, number> = {};
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let orders: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null; let selected: string[] = [];
    const fault = (): { code: string; message: string } | null => {
      if (faults.missing?.includes(table)) return { code: "42P01", message: `relation "public.${table}" does not exist` };
      if (faults.missingColumn?.includes(table)) return { code: "42703", message: `column ${table}.source_surface does not exist` }; const absent = selected.find((c) => faults.missingSelect?.includes(c)); if (absent) return { code: "42703", message: `column ${table}.${absent} does not exist` };
      if (faults.erroring?.includes(table)) return { code: "57014", message: "canceling statement due to statement timeout" };
      // Fail every read of `table` after the first n succeeded.
      const n = faults.failFromCall?.[table];
      if (n !== undefined && (calls[table] ?? 0) >= n) return { code: "57014", message: "canceling statement due to statement timeout" };
      return null;
    };
    const result = () => {
      reads.push(table);
      const err = fault();
      calls[table] = (calls[table] ?? 0) + 1;
      if (err) return { data: null, error: err };
      let out = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      for (const o of [...orders].reverse()) {
        out = [...out].sort((a, b) => (String(a[o.col] ?? "") < String(b[o.col] ?? "") ? -1 : String(a[o.col] ?? "") > String(b[o.col] ?? "") ? 1 : 0) * (o.asc ? 1 : -1));
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return { data: out.map((r) => (selected.length > 0 ? Object.fromEntries(selected.filter((c) => c in r).map((c) => [c, r[c]])) : { ...r })), error: null };  // §75: project to the SELECTED columns, as PostgREST does, so a column the read did not name cannot reach the code
    };
    const b: any = {
      select(cols?: string) { selected = String(cols ?? "").split(",").map((c) => c.trim()).filter(Boolean); return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      or(expr: string) {
        const m = /^recommendation_id\.in\.\(([^)]*)\),features->>recommendationId\.in\.\(([^)]*)\)$/.exec(expr);
        if (!m) throw new Error(`fake: unsupported or() ${expr}`);
        const col = m[1]!.split(","), feat = m[2]!.split(",");
        filters.push((r) => col.includes(r["recommendation_id"]) || feat.includes(r["features"]?.["recommendationId"]));
        return b;
      },
      order(c: string, o?: { ascending?: boolean }) { orders = [...orders, { col: c, asc: o?.ascending !== false }]; return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { const r = result(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      then(res: (r: any) => any, rej?: (e: any) => any) { return Promise.resolve(result()).then(res, rej); },
    };
    return b;
  }
  const auth = {
    async getUser(token: string) {
      return tables["profiles"]!.some((p) => p["id"] === token)
        ? { data: { user: { id: token } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  return { from, auth, tables, reads };
}

const app = express();
app.use(trendingRouter);
const server = http.createServer(app);
let base = "";
before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });

async function get(ids: string | null, as: string | null): Promise<{ status: number; body: any; text: string; cache: string | null }> {
  const headers: Record<string, string> = {};
  if (as) headers["authorization"] = `Bearer ${as}`;
  const q = ids === null ? "" : `?recommendationIds=${encodeURIComponent(ids)}`;
  const res = await fetch(`${base}/v1/discovery/trending/explanations${q}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text, cache: res.headers.get("cache-control") };
}

const withDb = (seed = SEED(), faults: Parameters<typeof makeDb>[1] = {}) => {
  const db = makeDb(seed, faults);
  _setTestClient(db, true);
  return db;
};

const byRid = (body: any) => new Map<string, any>(body.explanations.map((e: any) => [e.recommendationId, e]));
const ALL = [R.trending, R.emerging, R.belowFloor, R.unknown, R.noRow, R.legacy, R.dwell, R.livingPage, R.others, R.missing, R.preThreeFourTen].join(",");

// ── A. auth, flag, bounds ────────────────────────────────────────────────────

describe("A — signed-in only, behind a fail-closed flag, bounded input", () => {
  it("A1. no bearer ⇒ 401, nothing read", async () => {
    const db = withDb();
    const r = await get(R.trending, null);
    assert.equal(r.status, 401);
    assert.deepEqual(db.reads.filter((t) => t === "rank_events" || t === "place_momentum"), []);
  });

  it("A2. flag absent ⇒ 404 feature_disabled, and neither the exposures nor the store is read", async () => {
    const db = withDb({ ...SEED(), feature_flags: [] });
    const r = await get(R.trending, USER);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
    assert.deepEqual(db.reads.filter((t) => t === "rank_events" || t === "place_momentum"), []);
  });

  it("A3. an unreadable flag reads OFF (fail-closed)", async () => {
    withDb(SEED(), { erroring: ["feature_flags"] });
    const r = await get(R.trending, USER);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("A4. revocation, both directions: ON answers, OFF refuses on the very next request, ON again answers identically", async () => {
    const db = withDb();
    const on1 = await get(R.trending, USER);
    assert.equal(on1.status, 200);
    db.tables["feature_flags"]![0]!["enabled"] = false;
    const off = await get(R.trending, USER);
    assert.equal(off.status, 404);
    db.tables["feature_flags"]![0]!["enabled"] = true;
    const on2 = await get(R.trending, USER);
    assert.equal(on2.status, 200);
    assert.equal(on2.text, on1.text);
  });

  it("A5. missing, malformed, delimiter-carrying or over-bound ids ⇒ 400, nothing read", async () => {
    const db = withDb();
    const over = Array.from({ length: TREND_EXPLANATIONS_MAX_IDS + 1 }, (_, i) => rid(`o${i}`)).join(",");
    for (const bad of [null, "", "short", `${R.trending})`, `${R.trending},recommendation_id.eq.x`, over]) {
      const r = await get(bad, USER);
      assert.equal(r.status, 400, `ids ${bad}`);
      assert.equal(r.body.error, "invalid_payload");
    }
    assert.deepEqual(db.reads.filter((t) => t === "rank_events" || t === "place_momentum"), []);
  });
});

// ── B. the served shape ──────────────────────────────────────────────────────

describe("B — `11` §4: a state and a reason, never a raw score", () => {
  it("B1. a served, disclosable item gets its state, a closed code and the product's sentence", async () => {
    withDb();
    const r = await get(ALL, USER);
    assert.equal(r.status, 200);
    const e = byRid(r.body);
    assert.deepEqual(e.get(R.trending), {
      recommendationId: R.trending, itemId: `db/${P1}`,
      trend: { state: "trending", reason: { code: "trend_accelerating", text: explainTrendState("trending") } },
      unavailable: null,
    });
    assert.equal(e.get(R.emerging).trend.state, "emerging", "the NEWEST run is read, not the older one that said cooling");
    assert.equal(e.get(R.emerging).trend.reason.code, "trend_new_activity");
    assert.equal(e.get(R.legacy).trend.state, "cooling", "an id held only in features binds, as lib/discoveryDwell reads it");
    assert.deepEqual(r.body.explanations.map((x: any) => x.recommendationId), ALL.split(","), "one answer per requested id, in request order");
    assert.equal(r.cache, "private, no-store");
  });

  it("B2. the body is a CLOSED shape: no rate, weight, total, traveller count or score, at any depth", async () => {
    withDb();
    const r = await get(ALL, USER);
    const allowed = new Set(["explanations", "readingProvenance", "recommendationId", "itemId", "trend", "unavailable",
      "state", "reason", "code", "text", "computedAt", "window", "start", "end", "modelVersion", "featureVersion"]);  // §75 H-P21-1
    // No number anywhere: the only values are ids, codes, sentences and instants.
    const walk = (v: unknown): void => {
      assert.notEqual(typeof v, "number", "a numeric value reached the client");
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) { assert.ok(allowed.has(k), `unexpected key ${k}`); walk(x); }
      }
    };
    walk(r.body);
    for (const leak of ["momentum", "score", "travel", "weight", "_rate", "Rate", "total"]) {
      assert.ok(!r.text.includes(leak), `the body carries "${leak}"`);  // §84 (W10-R1): full strictness restored — the feature version was renamed so no exemption is needed; B3 still pins it
    }
  });

  it("B3. the reading's provenance names the one run every answer came from", async () => {
    withDb();
    const r = await get(R.trending, USER);
    const p = r.body.readingProvenance;
    assert.equal(p.modelVersion, "discovery-trend-state-v1"); assert.equal(p.featureVersion, TREND_FEATURE_VERSION, "§75 H-P21-1: the run's feature version, as 3435 stored it");
    assert.equal(Date.parse(p.window.end), Date.parse(p.computedAt));
    assert.equal(Date.parse(p.window.end) - Date.parse(p.window.start), TREND_PRIOR_MS);
  });
});

// ── C. cross-viewer denial ───────────────────────────────────────────────────

describe("C — only the viewer's own Discovery exposures bind", () => {
  it("C1. another viewer's token reads exactly like a token that does not exist, and their item's state never appears", async () => {
    withDb();
    const r = await get(ALL, USER);
    const e = byRid(r.body);
    const strip = (x: any) => ({ ...x, recommendationId: "·" });
    assert.deepEqual(strip(e.get(R.others)), strip(e.get(R.missing)));
    assert.deepEqual(e.get(R.others), { recommendationId: R.others, itemId: null, trend: null, unavailable: "unknown_recommendation" });
    assert.ok(!r.text.includes("node/9"), "the other viewer's item leaked");
  });

  it("C2. the OWNER of that token does get it — the denial is about who asks, not the data", async () => {
    withDb();
    const r = await get(R.others, OTHER);
    assert.equal(byRid(r.body).get(R.others).trend.state, "trending");
  });

  it("C3. an attention row or another surface's row carrying the token is not a Discovery exposure", async () => {
    withDb();
    const e = byRid((await get(`${R.dwell},${R.livingPage}`, USER)).body);
    assert.equal(e.get(R.dwell).unavailable, "unknown_recommendation");
    assert.equal(e.get(R.livingPage).unavailable, "unknown_recommendation");
  });
});

// ── D. the disclosure floor ──────────────────────────────────────────────────

describe("D — below k travellers is indistinguishable from no evidence", () => {
  it("D1. below the floor, `unknown`, and absent from the run all answer the same way", async () => {
    withDb();
    const e = byRid((await get(ALL, USER)).body);
    const strip = (x: any) => ({ ...x, recommendationId: "·", itemId: "·" });
    const below = strip(e.get(R.belowFloor));
    assert.deepEqual(below, { recommendationId: "·", itemId: "·", trend: null, unavailable: "insufficient_evidence" });
    assert.deepEqual(strip(e.get(R.unknown)), below);
    assert.deepEqual(strip(e.get(R.noRow)), below);
  });

  it("D2. a row written before 3410 carries no traveller counts and is never disclosed", async () => {
    withDb();
    assert.equal(byRid((await get(R.preThreeFourTen, USER)).body).get(R.preThreeFourTen).unavailable, "insufficient_evidence");
  });

  it("D3. the floor is the live-claim path's k, reused — not a number minted here — and applies to BOTH windows", () => {
    assert.equal(TREND_DISCLOSURE_MIN_TRAVELERS, PRIVACY_THRESHOLD_V1.minUniqueActors);
    const row = { place_id: "p", trend_state: "trending", recent_unique_travelers: K, window_unique_travelers: K };
    assert.equal(mayDiscloseTrend(row), true);
    assert.equal(mayDiscloseTrend({ ...row, recent_unique_travelers: K - 1 }), false);
    assert.equal(mayDiscloseTrend({ ...row, window_unique_travelers: K - 1 }), false);
    assert.equal(mayDiscloseTrend({ ...row, trend_state: "unknown" }), false);
    assert.equal(mayDiscloseTrend({ ...row, trend_state: "viral" }), false, "a stored value outside `03` §9 is not a state");
  });
});

// ── E. freshness ─────────────────────────────────────────────────────────────

describe("E — a snapshot that is not current is never served as a claim", () => {
  it("E1. stale: every bound item says stale_snapshot, and the provenance still says which run", async () => {
    const seed = SEED();
    for (const r of seed["place_momentum"]!) r["computed_at"] = iso(TREND_SNAPSHOT_MAX_AGE_MS + 60_000);
    withDb(seed);
    const r = await get(ALL, USER);
    const e = byRid(r.body);
    for (const id of [R.trending, R.emerging, R.belowFloor, R.legacy]) assert.equal(e.get(id).unavailable, "stale_snapshot", id);
    assert.equal(e.get(R.others).unavailable, "unknown_recommendation", "binding is decided before freshness");
    assert.ok(r.body.readingProvenance.computedAt);
  });

  it("E2. the freshness bound is the in-process reading's own lifetime, and it is inclusive", () => {
    assert.equal(TREND_SNAPSHOT_MAX_AGE_MS, MOMENTUM_CACHE_TTL_MS);
    const now = Date.parse("2031-04-01T00:10:00.000Z");
    const run = (msAgo: number) => ({ computedAt: new Date(now - msAgo).toISOString(), modelVersion: "m", featureVersion: null, priorMs: TREND_PRIOR_MS });
    assert.equal(isCurrentRun(run(TREND_SNAPSHOT_MAX_AGE_MS), now), true);
    assert.equal(isCurrentRun(run(TREND_SNAPSHOT_MAX_AGE_MS + 1), now), false);
    assert.equal(isCurrentRun(run(-1), now), false, "a future-dated run is not current");
    assert.equal(isCurrentRun({ ...run(0), computedAt: "not a time" }, now), false);
  });

  it("E3. no run at all: no_snapshot, and no provenance for a computation that never ran", async () => {
    withDb({ ...SEED(), place_momentum: [] });
    const r = await get(`${R.trending},${R.missing}`, USER);
    assert.equal(r.status, 200);
    assert.equal(byRid(r.body).get(R.trending).unavailable, "no_snapshot");
    assert.equal(byRid(r.body).get(R.missing).unavailable, "unknown_recommendation");
    assert.equal(r.body.readingProvenance, null);
  });

  it("E4. rows written by 2892's all-surfaces function are not read, however new", async () => {
    const seed = SEED();
    seed["place_momentum"] = seed["place_momentum"]!.map((r) => ({ ...r, source_surface: null }));
    withDb(seed);
    const r = await get(R.trending, USER);
    assert.equal(byRid(r.body).get(R.trending).unavailable, "no_snapshot");
  });
});

// ── F. failures ──────────────────────────────────────────────────────────────

describe("F — a failed read is a stated 503, never a 200", () => {
  const cases: Array<[string, Parameters<typeof makeDb>[1], string]> = [
    ["2892 unapplied (no table)", { missing: ["place_momentum"] }, "trend_store_absent"],
    ["3410 unapplied (no column)", { missingColumn: ["place_momentum"] }, "trend_store_absent"],
    ["the store times out", { erroring: ["place_momentum"] }, "trend_read_failed"],
    ["the store fails on the SECOND read, after the run was found", { failFromCall: { place_momentum: 1 } }, "trend_read_failed"],
    ["the exposures cannot be read", { erroring: ["rank_events"] }, "exposure_read_failed"],
  ];
  for (const [name, faults, reason] of cases) {
    it(`F. ${name} ⇒ 503 degraded_unavailable, reason ${reason}`, async () => {
      withDb(SEED(), faults);
      const r = await get(ALL, USER);
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.reason, reason);
      assert.equal(r.body.explanations, undefined, "no partial answer");
    });
  }
});

// ── G. retries ───────────────────────────────────────────────────────────────

describe("G — a retry is safe to repeat", () => {
  it("G1. the same request twice answers byte-identically, and writes nothing", async () => {
    const db = withDb();
    const before = JSON.stringify(db.tables);
    const a = await get(ALL, USER);
    const b = await get(ALL, USER);
    assert.equal(a.status, 200);
    assert.equal(a.text, b.text);
    assert.equal(JSON.stringify(db.tables), before);
  });

  it("G2. a duplicated id is answered once, in first-seen order", () => {
    assert.deepEqual(parseRecommendationIds(`${R.emerging},${R.trending},${R.emerging}`), [R.emerging, R.trending]);
  });
});

// ── H. the default serving order cannot move ─────────────────────────────────

describe("H — nothing that serves or ranks reads the store or imports this API", () => {
  const files = (dir: string): string[] => readdirSync(join(SRC, dir)).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`);
  const scan = [...files("lib"), ...files("routes"), ...files("services/trails"), ...files("services/ranking")];
  it("H1. place_momentum is read only by the trend-explanation module", () => {
    const readers = scan.filter((f) => /\.from\(\s*["']place_momentum["']\s*\)|rebuild_place_momentum["']\s*[,)]/.test(readFileSync(join(SRC, f), "utf8")));
    assert.deepEqual(readers, ["lib/discoveryTrendExplanation.ts", "lib/discoveryTrendRebuildScheduler.ts"]); assert.deepEqual(scan.filter((f) => /discoveryTrendRebuildScheduler\.js/.test(readFileSync(join(SRC, f), "utf8"))), [], "no lib, route, Trails or ranking module imports the scheduler");  // §84 (D-W10-R1-11): the rebuild scheduler CALLS the rebuild and prunes old runs; it is a writer, started once by src/index.ts, and no serve path imports it
  });
  it("H2. the explanation module is imported only by its route, and the route only by the router index", () => {
    const importers = (name: string) => scan.filter((f) => new RegExp(`from "\\.\\.?/(lib/|routes/)?${name}\\.js"`).test(readFileSync(join(SRC, f), "utf8")));
    assert.deepEqual(importers("discoveryTrendExplanation"), ["routes/discoveryTrending.ts"]);
    assert.deepEqual(importers("discoveryTrending"), ["routes/index.ts"]);
  });
});

// ── I. the vocabulary, and 3410's copy of it ─────────────────────────────────

describe("I — one closed reason vocabulary, stored and served identically", () => {
  it("I1. one code per state that is a claim, none for unknown, all distinct", () => {
    const codes = TREND_STATES.map((s) => trendReasonFor(s)?.code ?? null);
    assert.equal(codes[0], null, "unknown carries no reason");
    assert.deepEqual([...codes.slice(1)].sort(), [...TREND_REASON_CODES].sort());
    assert.equal(new Set(codes.slice(1)).size, TREND_REASON_CODES.length);
    for (const s of TREND_STATES.slice(1)) assert.equal(trendReasonFor(s)!.text, explainTrendState(s));
  });

  it("I2. the unavailable vocabulary is closed and every answer uses it", () => {
    const out = explainExposures([R.trending, R.missing], [{ recommendationId: R.trending, itemId: "p" }], null, [], Date.now());
    for (const e of out.explanations) assert.ok(TREND_UNAVAILABLE_REASONS.includes(e.unavailable!));
  });

  const SQL = readFileSync(join(SRC, "migrations", "3410_discovery_trend_snapshot_parity.sql"), "utf8");
  const BODY = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION public.rebuild_place_momentum"), SQL.indexOf("$fn$;"));

  it("I3. 3410 stores lib/discoveryTrendState's sentence for every claim, and nothing for unknown", () => {
    for (const s of TREND_STATES.slice(1)) {
      const text = explainTrendState(s)!;
      assert.ok(BODY.includes(`WHEN '${s}'`) && BODY.includes(`THEN '${text.replace(/'/g, "''")}'`),
        `3410's sentence for ${s} is not the product's: ${text}`);
    }
    assert.match(BODY, /ELSE NULL\s+END/, "unknown must store NULL, not a sentence");
  });

  it("I4. 3410's windows and weights are the TypeScript constants", () => {
    const num = (name: string) => Number(new RegExp(`${name}\\s+CONSTANT[^:]*:=\\s*([0-9.]+)`).exec(BODY)?.[1]);
    assert.equal(num("c_w_impression"), TREND_EVENT_WEIGHTS.impression);
    assert.equal(num("c_w_save"), TREND_EVENT_WEIGHTS.save);
    assert.equal(num("c_w_outcome"), TREND_EVENT_WEIGHTS.outcome);
    const hours = (name: string) => Number(new RegExp(`${name}\\s+CONSTANT bigint := (\\d+)::bigint\\s*\\*\\s*3600000`).exec(BODY)?.[1]) * 3_600_000;
    assert.equal(hours("c_recent_ms"), TREND_RECENT_MS);
    assert.equal(hours("c_mid_ms"), TREND_MID_MS);
    assert.equal(hours("c_prior_ms"), TREND_PRIOR_MS);
    assert.match(BODY, /c_surface\s+CONSTANT text := 'discovery'/, "the corpus is the loader's surface");
  });
});

// ── §75 (lane P33, DC-17 H-P21-1): the feature version, and a deployment without it ─

describe("§75 H-P21-1 — the wire record names its feature version; a database without 3435 still answers", () => {
  it("P1. with 3435: the run's feature_version is served on readingProvenance, and a pre-3435 run's NULL is served as null", async () => {
    withDb();
    const withIt = await get(ALL, USER);
    assert.equal(withIt.status, 200);
    assert.equal(withIt.body.readingProvenance.featureVersion, TREND_FEATURE_VERSION);
    const seed = SEED();
    seed["place_momentum"] = seed["place_momentum"]!.map((r) => ({ ...r, feature_version: null }));
    withDb(seed);
    const legacy = await get(ALL, USER);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.readingProvenance.featureVersion, null, "a row 3435 did not write is 'not recorded'");
    assert.deepEqual(legacy.body.explanations, withIt.body.explanations, "the answers do not depend on the provenance column");
  });

  it("P2. WITHOUT 3435 (feature_version answers 42703): a 200, featureVersion null, and every other byte the with-column answer", async () => {
    const seed = SEED();  // ONE seed, so both answers are over the same instants
    withDb(seed);
    const withIt = await get(ALL, USER);
    const db = withDb(seed, { missingSelect: ["feature_version"] });
    const without = await get(ALL, USER);
    assert.equal(without.status, 200, JSON.stringify(without.body));
    assert.equal(without.body.readingProvenance.featureVersion, null);
    const { featureVersion: _a, ...restWith } = withIt.body.readingProvenance;
    const { featureVersion: _b, ...restWithout } = without.body.readingProvenance;
    assert.deepEqual(restWithout, restWith, "computedAt, window and modelVersion are served as before");
    assert.deepEqual(without.body.explanations, withIt.body.explanations, "every explanation is served as before");
    assert.ok(db.reads.filter((t) => t === "place_momentum").length >= 3, "the head read was retried once without the column, then the rows were read");
  });

  it("P3. the retry is classified exactly as before: 3410 absent too ⇒ trend_store_absent; a timeout on the retry ⇒ trend_read_failed", async () => {
    withDb(SEED(), { missingSelect: ["feature_version"], missingColumn: ["place_momentum"] });
    const absent = await get(ALL, USER);
    assert.equal(absent.status, 503);
    assert.equal(absent.body.reason, "trend_store_absent");
    withDb(SEED(), { missingSelect: ["feature_version"], failFromCall: { place_momentum: 1 } });
    const failed = await get(ALL, USER);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.reason, "trend_read_failed", "a timeout is never relabelled as a missing column");
  });

  it("P4. only a MISSING COLUMN is retried: a timeout on the first head read is still trend_read_failed, with one read", async () => {
    const db = withDb(SEED(), { erroring: ["place_momentum"] });
    const r = await get(ALL, USER);
    assert.equal(r.body.reason, "trend_read_failed");
    assert.equal(db.reads.filter((t) => t === "place_momentum").length, 1, "no retry on an unknown answer");
  });
});
