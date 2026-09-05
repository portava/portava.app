/**
 * Wall §33 / TABLE 4 — the first-page performance guard.
 *
 * TABLE 4's backend row is "First server page: aim < 500 ms backend excluding
 * network". Until now nothing in the repo measured it, so the only way to learn
 * that a change had made the first page four times more expensive was to ship
 * it. This is the in-repo half of that target.
 *
 * WHAT THIS MEASURES
 * ==================
 * The REAL /wall router, over a real HTTP round-trip on loopback, against a
 * seeded fixture corpus served by a fake supabase client with no I/O latency.
 * So the number is the cost of OUR work on the first page: candidate loading,
 * the eligibility/block/visibility gate, projection, For You ranking, the
 * diversity controller, the multi-kind Live For You strip, context threads and
 * JSON serialization. It is NOT the production number: it excludes network,
 * real database latency and cold starts, and the runner is slower and noisier
 * than production. The ceiling below is therefore GENEROUS — a healthy tree
 * clears it by a wide margin, so a failure means somebody added real work.
 *
 * WHY THERE IS ALSO A READ BUDGET
 * ===============================
 * A wall-clock ceiling on a fake client is hardware-sensitive; a QUERY COUNT is
 * not. The read budget is the part of this guard that actually catches the
 * regression that matters — an N+1 introduced into a per-item loop, or an
 * unbounded fan-out — on any machine, at any speed. The timing number tells you
 * how bad it is; the read count tells you that it happened.
 *
 * WHAT STILL NEEDS A DEVICE
 * =========================
 * TABLE 4's other rows — 60 fps scroll, immediate first paint, mode-switch
 * reuse — are device measurements and cannot be made here. The client half of
 * this unit (WallFeed.renderCost.component.test.tsx) bounds RENDER COST, which
 * is the input to frame time, but frame time itself needs a real device.
 *
 * Run: node --import tsx/esm --test src/test/wallPerformance.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import wallRouter from "../routes/wall.js";
import { benchmark, formatBenchmark, seededRandom } from "./helpers/benchmark.js";

// ── The budget ───────────────────────────────────────────────────────────────

/**
 * Wall-clock ceiling for the p95 first page, in milliseconds — TABLE 4's own
 * production number.
 *
 * HOW MUCH HEADROOM THERE ACTUALLY IS. Measured on two developer Macs at the
 * commit that introduced this file: p50 3–8 ms, p95 4–38 ms. So the real margin
 * under this ceiling is roughly 13–100x depending on the machine, and the p95
 * spread is an order of magnitude wider than the p50 spread — a tail of a few
 * tens of milliseconds is ordinary here, because a single GC pause or a busy
 * runner lands in a 20-sample p95. Quote a range, never one machine's number:
 * an earlier draft of this comment claimed "two orders of magnitude" from the
 * fastest run alone and overstated the margin by about 10x on slower hardware.
 * The ceiling is sized for the SLOW end of that spread, so it does not fail
 * because a runner was busy, and does fail when the page gets an order of
 * magnitude more expensive. The read ratchets below are the hardware-independent
 * half and are what actually catch a regression.
 */
const FIRST_PAGE_P95_CEILING_MS = 500;
/** The same for the median, where noise has less room to hide (measured 3–8 ms,
 *  so ~40x under this line even on the slower machine). */
const FIRST_PAGE_P50_CEILING_MS = 300;

/**
 * Supabase calls issued while building ONE 20-item first page.
 *
 * THIS IS A SHRINK-ONLY RATCHET, NOT A CLEAN BUDGET. The tree currently issues
 * ~362, which is far more than a first page should cost, and this harness is
 * what made that visible. The three contributors, measured with WALL_BENCH_DIAG=1:
 *
 *   ~150  rank_events  — DiscoveryRankingService writes one fire-and-forget
 *                        analytics row per SCORED CANDIDATE. Deliberate, shared
 *                        by every ranked surface, and batchable.
 *   ~85   context      — ContextThreadService gathers its candidate facts
 *                        PER FEED ITEM: trips, hidden_gems, rent_buddy_profiles,
 *                        passport_memories and posts are each read once per
 *                        item rather than once per page. This is the per-item
 *                        read the slope test below pins.
 *   ~80   feature_flags — isFlagEnabled does an uncached read every call.
 *
 * None of those are this unit's to fix — each is a separate change with its own
 * correctness surface (batched analytics, a page-level context fact loader, a
 * flag cache whose staleness has kill-switch consequences). What this unit owes
 * them is a number that cannot drift upward unnoticed. Lower it when one is
 * fixed; raise it only with a reason, never to make a red build green.
 *
 * The recorded figures are DETERMINISTIC — they depend on the seeded corpus and
 * the code path, not on the machine — so the margins here are small on purpose.
 */
const FIRST_PAGE_READ_RATCHET = 375;
/**
 * Supabase calls added per EXTRA item on the page (the slope between a 5-item
 * and a 40-item page). Recorded at 8.3, and the margin is deliberately under one
 * call: adding a SINGLE read per item moves it to 9.3 and fails here. Removing
 * the context-thread fan-out drops it to ~0 and this can be ratcheted down.
 */
const READS_PER_EXTRA_ITEM_RATCHET = 9;

// ── Seeded fixture corpus ────────────────────────────────────────────────────

const TOKEN = "tok";
const VIEWER = "viewer-1";
const AUTHORS = 24;
const POSTS = 150; // CANDIDATE_FETCH — a full first-page candidate window
const PLACES = 30;
const CITIES = ["Da Nang", "Bangkok", "Tokyo", "Manila", "Miami"];
const CATEGORIES = ["food", "nightlife", "nature", "culture", "beach"];

/** The whole corpus, built once from a fixed seed so every run measures the
 *  same world and a failure is reproducible. */
function buildCorpus() {
  const rnd = seededRandom(20260905);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const places = Array.from({ length: PLACES }, (_, i) => ({
    id: `place-${i}`,
    name: `Place ${i}`,
    city: pick(CITIES),
    country_code: "VN",
    latitude: 16 + rnd(),
    longitude: 108 + rnd(),
    status: "active",
    merged_into_place_id: null,
  }));

  const profiles: Record<string, any> = {
    [VIEWER]: {
      id: VIEWER, display_name: "Viewer", username: "viewer", avatar_url: null,
      account_status: "active", current_city: "Da Nang", home_city: "Bangkok",
      interests: ["food", "nightlife"],
    },
  };
  for (let i = 0; i < AUTHORS; i++) {
    profiles[`author-${i}`] = {
      id: `author-${i}`, display_name: `Author ${i}`, username: `a${i}`,
      avatar_url: null, account_status: "active",
    };
  }

  const base = Date.parse("2026-09-01T12:00:00.000Z");
  const posts = Array.from({ length: POSTS }, (_, i) => {
    const place = places[Math.floor(rnd() * places.length)];
    const at = new Date(base - i * 60_000).toISOString();
    return {
      id: `post-${i}`,
      author_id: `author-${i % AUTHORS}`,
      trip_id: null,
      content: `Post ${i} about ${pick(CATEGORIES)} in ${place.city}`,
      visibility: "public",
      status: "active",
      post_status: "published",
      created_at: at,
      published_at: at,
      canonical_place_id: place.id,
      has_video: i % 7 === 0,
      media_count: i % 3 === 0 ? 0 : 2,
      category: pick(CATEGORIES),
      location_city: place.city,
      location_country: "VN",
      like_count: Math.floor(rnd() * 200),
      comment_count: Math.floor(rnd() * 40),
      save_count: Math.floor(rnd() * 60),
    };
  });

  const follows = Array.from({ length: AUTHORS }, (_, i) => ({ following_id: `author-${i}` }));

  return { places, profiles, posts, follows };
}

const CORPUS = buildCorpus();

const FLAGS: Record<string, boolean> = {
  // Everything the first page can do, ON — the guard must bound the WORST
  // realistic page, not the cheapest one.
  wall_enabled: true,
  wall_live_for_you_enabled: true,
  wall_input_intelligence_enabled: true,
  wall_discovery_insertions_enabled: true,
  wall_compass_handoff_enabled: true,
  wall_context_threads_enabled: true,
  wall_rab_integration_enabled: true,
  intel_live_label_crowd: true,
  intel_claim_projection_crowd: true,
  intel_limited_live: true,
  disable_intel_live_labels: false,
};

/** Supabase calls issued since the last reset — the hardware-independent half. */
let readCount = 0;
/** Which tables those calls hit. Printed only under WALL_BENCH_DIAG=1, so a
 *  failure can be attributed to a table without re-instrumenting anything. */
const readTables: string[] = [];

/**
 * A table-routed fake with no latency. Filters are accepted and ignored (the
 * point is to measure OUR work over a realistic row count, not to reimplement
 * PostgREST), but `.limit(n)` IS honoured so a bound the code applies actually
 * shrinks what it then has to process.
 */
function corpusClient() {
  function rowsFor(table: string): any[] {
    switch (table) {
      case "posts": return CORPUS.posts;
      case "places": return CORPUS.places;
      case "profiles": return Object.values(CORPUS.profiles);
      case "user_follows": return CORPUS.follows;
      default: return [];
    }
  }
  function builder(table: string) {
    readCount += 1;
    readTables.push(table);
    let cap = Number.POSITIVE_INFINITY;
    const filters: Record<string, any> = {};
    const b: any = {
      select: () => b, neq: () => b, in: () => b, not: () => b, is: () => b,
      or: () => b, gte: () => b, lte: () => b, gt: () => b, lt: () => b, order: () => b,
      eq(col: string, val: any) { filters[col] = val; return b; },
      limit(n: number) { if (Number.isFinite(n)) cap = n; return b; },
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      maybeSingle() {
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: !!FLAGS[String(filters["flag"])] }, error: null });
        }
        if (table === "profiles") {
          return Promise.resolve({ data: CORPUS.profiles[String(filters["id"])] ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        const rows = rowsFor(table);
        const data = rows.length > cap ? rows.slice(0, cap) : rows;
        return Promise.resolve({ data, error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

// ── HTTP harness ─────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl = "";

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        method: "GET", headers: { authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Wall first-page performance (spec §33 / TABLE 4)", () => {
  before(async () => {
    _setTestClient(corpusClient(), true);
    const app = express();
    app.use(express.json());
    app.use("/api", wallRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  it("the benchmark measures a REAL first page, not an error path", async () => {
    _clearPromotedScopeCache();
    const res = await get("/api/wall?mode=for_you");
    assert.equal(res.status, 200, "the fixture corpus must produce a servable page");
    assert.equal(res.json.mode, "for_you");
    assert.ok(Array.isArray(res.json.items), "items must be an array");
    // A benchmark over an empty feed would measure nothing. Pin a full page.
    assert.equal(res.json.items.length, 20, "the first page is a full DEFAULT_LIMIT page");
    assert.ok(typeof res.json.nextCursor === "string", "a full page carries a cursor");
    assert.ok(Array.isArray(res.json.liveForYou));
  });

  it("For You first page stays inside the p50/p95 ceiling", async () => {
    const result = await benchmark(
      "GET /wall?mode=for_you (first page, 150-post corpus)",
      async () => {
        const res = await get("/api/wall?mode=for_you");
        if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);
      },
      { warmup: 5, iterations: 20 },
    );
    console.log(formatBenchmark(result));
    // Print the margin THIS machine actually has, so the headroom is read off a
    // run rather than remembered from someone else's laptop.
    console.log(
      `[bench] headroom on this machine: p50 ${(FIRST_PAGE_P50_CEILING_MS / Math.max(result.p50, 0.001)).toFixed(0)}x, ` +
        `p95 ${(FIRST_PAGE_P95_CEILING_MS / Math.max(result.p95, 0.001)).toFixed(0)}x`,
    );
    assert.ok(
      result.p50 <= FIRST_PAGE_P50_CEILING_MS,
      `first-page p50 ${result.p50.toFixed(1)}ms exceeds ${FIRST_PAGE_P50_CEILING_MS}ms — ` +
        `something on the first page got materially more expensive`,
    );
    assert.ok(
      result.p95 <= FIRST_PAGE_P95_CEILING_MS,
      `first-page p95 ${result.p95.toFixed(1)}ms exceeds ${FIRST_PAGE_P95_CEILING_MS}ms`,
    );
  });

  it("Following first page stays inside the same ceiling", async () => {
    const result = await benchmark(
      "GET /wall?mode=following (first page, 150-post corpus)",
      async () => {
        const res = await get("/api/wall?mode=following");
        if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);
      },
      { warmup: 3, iterations: 12 },
    );
    console.log(formatBenchmark(result));
    assert.ok(
      result.p95 <= FIRST_PAGE_P95_CEILING_MS,
      `following first-page p95 ${result.p95.toFixed(1)}ms exceeds ${FIRST_PAGE_P95_CEILING_MS}ms`,
    );
  });

  it("one first page stays inside its recorded read ratchet", async () => {
    _clearPromotedScopeCache();
    await get("/api/wall?mode=for_you"); // warm any per-process cache first
    readCount = 0;
    readTables.length = 0;
    await get("/api/wall?mode=for_you");
    const used = readCount;
    if (process.env.WALL_BENCH_DIAG) {
      const counts = new Map<string, number>();
      for (const t of readTables) counts.set(t, (counts.get(t) ?? 0) + 1);
      console.log("[diag]", [...counts].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(" "));
    }
    console.log(`[bench] GET /wall?mode=for_you: ${used} supabase calls (ratchet ${FIRST_PAGE_READ_RATCHET})`);
    assert.ok(
      used <= FIRST_PAGE_READ_RATCHET,
      `one first page issued ${used} supabase calls, over the recorded ratchet of ` +
        `${FIRST_PAGE_READ_RATCHET}. Re-run with WALL_BENCH_DIAG=1 to see which table grew. ` +
        `Raise the ratchet only with a reason, never to make a red build green.`,
    );
    // And the guard must not be measuring nothing.
    assert.ok(used > 5, `only ${used} calls observed — the counter is not wired to the page`);
  });

  it("the per-item read slope stays at its recorded ratchet", async () => {
    _clearPromotedScopeCache();
    await get("/api/wall?mode=for_you&limit=5");
    readCount = 0;
    await get("/api/wall?mode=for_you&limit=5");
    const small = readCount;
    readCount = 0;
    await get("/api/wall?mode=for_you&limit=40");
    const large = readCount;
    const slope = (large - small) / 35;
    console.log(
      `[bench] supabase calls: limit=5 → ${small}, limit=40 → ${large} ` +
        `(${slope.toFixed(1)}/item, ratchet ${READS_PER_EXTRA_ITEM_RATCHET})`,
    );
    // Most of the page's reads are batched over the CANDIDATE window and do not
    // move with `limit`. What DOES move is the per-item context-thread fan-out.
    // Pinning the slope means a NEW per-item read fails here immediately, and
    // removing the existing one shows up as a number that can be ratcheted down.
    assert.ok(
      slope <= READS_PER_EXTRA_ITEM_RATCHET,
      `each extra feed item now costs ${slope.toFixed(1)} supabase calls, over the ` +
        `recorded ${READS_PER_EXTRA_ITEM_RATCHET}. Something reads per item.`,
    );
    assert.ok(
      large > small,
      "the two page sizes cost the same — the counter is not observing page-size work",
    );
  });
});
