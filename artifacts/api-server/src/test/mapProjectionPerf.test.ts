/**
 * M256 (a) — the SERVER half of "viewport intelligence first results within
 * ~500-800 ms when cached or server-ready".
 *
 * The census's criterion, for this half:
 *
 *   "(a) SERVER: p50 and p95 of request-receipt to response-flush for
 *    `GET /api/map/projection` over 50 warm-cache requests on a seeded
 *    `portava-ci` … (b) additionally requires the gateway to be serving, so it
 *    is blocked behind M133; (a) is not."
 *
 * So this file measures ONE thing: how long the gateway takes to produce a
 * response, over 50 warm-cache requests, and it emits p50 AND p95 rather than a
 * single number, because a median alone hides the tail that the 800 ms budget
 * is actually about.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PART THAT MATTERS MORE THAN THE NUMBER: ANTI-VACUITY
 * ═══════════════════════════════════════════════════════════════════════════
 * §42.7's C4 mutation is the reason this section exists and is longer than the
 * measurement itself. A perf harness is the easiest kind of test to make
 * vacuous, because SPEED IS WHAT A BROKEN ROUTE IS BEST AT. Replace the handler
 * with one that answers `{ objects: [] }` without touching the database and
 * every timing assertion here gets *better*: p50 drops to a fraction of a
 * millisecond, p95 follows it down, and a green harness certifies a route that
 * measures nothing.
 *
 * The census also rules out the obvious defence. "Zero reads on the second
 * poll" cannot be the check, because on a WARM cache that is the correct
 * behaviour — the §24 zone list and the flow-zone list are both cached for 30 s
 * on purpose, and a route that re-read them every poll would be the defect.
 *
 * So the anti-vacuity guards below are about WHAT CAME BACK, not about how the
 * route spent its time, and each measured request is checked, not just the
 * first:
 *
 *   V1  every measured response is `enabled: true` with no refusal — a route
 *       that fell back to the disabled envelope is fast and serves nothing;
 *   V2  every measured response carries the full seeded object set, so a route
 *       that truncated, paged early or stopped reading is caught by count;
 *   V3  every measured response carries a `protection` report whose `evaluated`
 *       matches that set — the §24 gate ran on every one of the 50, so the
 *       thing being timed is the whole pipeline and not a prefix of it;
 *   V4  the run as a whole issued table reads — a handler that never touched
 *       the client at all is caught even if it somehow fabricated V1–V3.
 *
 * `mapProjectionPerf.test.ts` was checked against the C4 mutation shape before
 * being committed: the route's collection step was replaced with one returning
 * `[]` without reading, the harness went RED on V2/V3 while its timings
 * IMPROVED, and the source was restored. The log is in the lane report.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS NUMBER IS, AND WHAT IT IS NOT — SAID PLAINLY
 * ═══════════════════════════════════════════════════════════════════════════
 * This measures the handler in-process, over the repository's PostgREST-shaped
 * Supabase double, on the machine running the test. It is a REGRESSION gate on
 * the work the route does per request: an N+1, an unbounded scan, a
 * synchronous pass over the whole viewport will move it. It is NOT the census's
 * production latency, because it contains no network, no TLS, no real
 * PostgreSQL planner and no cold start.
 *
 * THE LIVE ARM IS REAL NOW, AND IT WAS NOT BEFORE. This paragraph used to say
 * that pointing the harness at a real database was "a one-variable change and
 * the harness supports it". It did not: PORTAVA_PERF_SUPABASE_URL and
 * PORTAVA_PERF_SERVICE_ROLE_KEY were read in exactly one place, to compute the
 * arm LABEL, while `startRouterApp` went on building the in-process double. So
 * setting them printed `arm=live-supabase` over the fake's numbers. A harness
 * that mislabels its own arm is worse than one with no live arm, because the
 * number then looks like evidence.
 *
 * Today the live arm mounts the same router over a real client
 * (`mountRouterApp`), seeds the SAME 120-place lattice through the real schema,
 * and turns the gateway on through a real `feature_flags` row. Everything below
 * the client is byte-identical between the arms, so a difference in the numbers
 * is a difference in the database. Measured against a loopback PostgREST over a
 * disposable PostgreSQL 16, five runs on a quiet box:
 *
 *   p50  33.2 / 33.5 / 33.7 / 33.7 / 33.8 ms   median 33.7 ms
 *   p95  40.8 / 42.2 / 42.7 / 43.1 / 48.0 ms   median 42.7 ms
 *
 * against the in-process double's p50 ~3 ms / p95 ~7 ms on the same box. Call
 * it an order of magnitude — which is exactly the gap the old label was hiding,
 * and the reason a "live" number that was really the fake's would have been
 * worse than no number at all. The median of five is the figure to quote; the
 * first run taken here read p50 38.1 / p95 51.9 ms and was measured while the
 * box was busy, so it is not.
 *
 * Because it WRITES (120 fixture places and a flag), it carries the same target
 * decision as the other live harnesses: PORTAVA_PERF_LOCAL_DB_URL selects the
 * one disposable local database, anything else takes the unweakened front door
 * and exits 2 before a client exists. Without any of them the in-process arm
 * runs and SAYS SO in its output, so a reader can never mistake one for the
 * other.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/mapProjectionPerf.test.ts
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
  _clearCityZoneCache,
} from "../routes/mapProjection.js";
import {
  mountRouterApp,
  startRouterApp,
  type FakeState,
  type ProjectionApp,
} from "./helpers/fakeMapDb.js";
import {
  approvedDisposableTarget,
  assertDisposableLocalBenchmarkTarget,
  DisposableTargetError,
} from "./helpers/liveWallCorpus.js";
import {
  readFlag,
  seedPerfCorpus,
  setExistingFlag,
  teardownPerfCorpus,
} from "./helpers/liveMapCorpus.js";
import { benchmark, formatBenchmark, percentile } from "./helpers/benchmark.js";

// ── The budget ───────────────────────────────────────────────────────────────
//
// §33 / the census name "~500-800 ms" for the CACHED case. The gate is on p95
// at the top of that band, because the promise is about what a user usually
// experiences, and a p50 gate would let a route with a bad tail pass.
const P95_BUDGET_MS = 800;
const ITERATIONS = 50;
/** Unmeasured. Warms the JIT AND the route's 30 s zone caches — this is the
 *  "warm-cache" in the criterion, made literal. */
const WARMUP = 5;

const VIEWER = "7f000001-0000-4000-8000-000000000256";
const TOKEN = "m256-perf-token";
/** Da Nang, the fixture city every map suite here uses. */
const BBOX = { west: 108.0, south: 15.9, east: 108.4, north: 16.2 };
const BBOX_STR = `${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}`;
/** Street band: individuals are not collapsed, so the timed pipeline is the full
 *  one (project → enrich → §24 gate → aggregate → rank → paginate). */
const ZOOM = 16;
/** The gateway caps `limit` at 200; the seeded set stays under it so every
 *  measured response is the WHOLE set and V2 can assert an exact count. */
const SEEDED_PLACES = 120;

/**
 * A deterministic viewport of places. Deterministic because a benchmark whose
 * corpus changes between runs produces numbers that cannot be compared and a
 * failure that cannot be reproduced.
 */
function seededPlaces(n: number) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    // A fixed lattice across the bbox interior — no RNG, no clock.
    const fx = ((i * 7) % 20) / 20;
    const fy = ((i * 11) % 20) / 20;
    rows.push({
      id: `perf-place-${i}`,
      name: `Perf Place ${i}`,
      primary_category: i % 2 === 0 ? "cafe" : "night_market",
      city: "Da Nang",
      neighborhood: null,
      country_code: "VN",
      latitude: BBOX.south + 0.02 + fy * (BBOX.north - BBOX.south - 0.04),
      longitude: BBOX.west + 0.02 + fx * (BBOX.east - BBOX.west - 0.04),
      status: "active",
      merged_into_place_id: null,
    });
  }
  return rows;
}

/**
 * Two curated §24 zones, placed OUTSIDE the seeded lattice on purpose.
 *
 * The gate must RUN on all 120 objects (V3 asserts `evaluated === 120`) without
 * removing any of them (V2 asserts all 120 arrive). Zones that suppressed part
 * of the set would make V2's count depend on the protection policy, and then a
 * protection bug and a truncation bug would be indistinguishable here — two
 * different failures collapsing into one assertion is how a guard stops being
 * able to name what broke.
 */
const PERF_ZONES = [
  {
    id: "perf-zone-medical", category: "medical_facility", action: null, privacy_floor: null,
    shape: "circle", center_lat: 10.0, center_lng: 100.0, radius_meters: 200,
    ring: null, jurisdiction: "VN", policy_ref: "portava/map-spec-24-perf", active: true,
  },
  {
    id: "perf-zone-residence", category: "private_residence", action: null, privacy_floor: null,
    shape: "circle", center_lat: 10.1, center_lng: 100.1, radius_meters: 200,
    ring: null, jurisdiction: "VN", policy_ref: "portava/map-spec-24-perf", active: true,
  },
];

function perfWorld(): FakeState {
  return {
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    blocks: [],
    geo_zones: [],
    event_roles: [],
    protected_zones: PERF_ZONES,
    places: seededPlaces(SEEDED_PLACES),
  };
}

// ── WHICH ARM, AND THE TARGET DECISION THAT GOES WITH IT ────────────────────
//
// FIXED 2026-09-21, and the defect is worth recording because it is the exact
// failure mode this harness's own header warns about. These two variables used
// to be read HERE AND NOWHERE ELSE — solely to compute the label below.
// `startRouterApp` always built the in-process double, so setting them printed
// `arm=live-supabase` over numbers produced entirely by the fake, and the
// header's claim that "pointing it at a real seeded portava-ci is a
// one-variable change and the harness supports it" was false. A measurement
// harness that mislabels its own arm is worse than one that has no live arm at
// all, because the number looks like evidence.
//
// The live arm is now real: `mountRouterApp` takes a caller-built client, so
// everything below the client is byte-identical between the arms and a
// difference in the numbers is a difference in the DATABASE.
//
// It carries the same target decision as the other live harnesses, for the same
// reason — this one WRITES (120 fixture places and a feature flag):
//   LOCAL   PORTAVA_PERF_LOCAL_DB_URL names the one disposable local database,
//           and assertDisposableLocalBenchmarkTarget refuses anything else,
//           opening the corpus write latch only on success.
//   REMOTE  any other named live target takes the unweakened front door and
//           exits 2 before a client is constructed.
const LIVE_URL = process.env["PORTAVA_PERF_SUPABASE_URL"] ?? "";
const LIVE_KEY = process.env["PORTAVA_PERF_SERVICE_ROLE_KEY"] ?? "";
const CONFIGURED_LOCAL_DB = process.env["PORTAVA_PERF_LOCAL_DB_URL"] ?? "";
const LIVE_REQUESTED = LIVE_URL.trim() !== "" && LIVE_KEY.trim() !== "";
const LOCAL_MODE_SELECTED = LIVE_REQUESTED && CONFIGURED_LOCAL_DB.trim() !== "";
const REMOTE_TARGET_NAMED = LIVE_REQUESTED && !LOCAL_MODE_SELECTED;

if (LOCAL_MODE_SELECTED) {
  assertDisposableLocalBenchmarkTarget(LIVE_URL, CONFIGURED_LOCAL_DB);
} else if (REMOTE_TARGET_NAMED) {
  await import("../lib/ciSupabaseGuard.mjs");
}

const ARM = LIVE_REQUESTED ? "live-supabase" : "in-process-double";

// The label is now BOUND to the thing it labels. If the live arm is asked for
// and the latch is shut, this module refuses rather than quietly measuring the
// double under a live label — which is the defect above, reintroduced.
//
// UNREACHABLE TODAY, and kept deliberately: every live request is either
// LOCAL_MODE_SELECTED (where assertDisposableLocalBenchmarkTarget either opens
// the latch or throws) or REMOTE_TARGET_NAMED (where the front door exits 2),
// so no mutation of the three branches above reaches this throw. It is here
// because the thing it refuses is the exact defect this file just had, and the
// cheapest way for that defect to come back is a fourth branch nobody thought
// about. Stated rather than dressed up as an armed guard.
if (ARM === "live-supabase" && approvedDisposableTarget() === null && !REMOTE_TARGET_NAMED) {
  throw new Error(
    "M256(a): the live arm was requested but no disposable target was approved. Refusing to " +
      "print live-supabase numbers that the in-process double produced.",
  );
}

describe("M256(a) — GET /api/map/projection, 50 warm-cache requests", () => {
  let app: ProjectionApp | null = null;
  /** Set only on the live arm; the fixtures it wrote are removed in after(). */
  let liveClient: any = null;
  /** The projection flag as the live arm FOUND it, so after() can put it back. */
  let liveFlagWasEnabled: boolean | null = null;
  /**
   * Table reads issued across the whole run, COUNTED PER TABLE (V4).
   *
   * Per-table, and not as one total, because a bare total does not mean what it
   * looks like. The first version of V4 asserted `reads > 0` and `reads >=
   * one per request`, and BOTH passed against a handler that returned before
   * touching the client at all (mutation C4b in the lane report) — because
   * `requireUser` reads the caller's account rows on every request before the
   * handler is entered, so the counter was never zero and never could be. The
   * guard was measuring the auth middleware.
   *
   * Naming the tables the PROJECTION needs is what fixes it: nothing in the
   * auth path reads `places` or `protected_zones`, so those two counts are
   * about this route's own work and nothing else.
   */
  const reads = new Map<string, number>();
  const readsOf = (t: string) => reads.get(t) ?? 0;
  const totalReads = () => [...reads.values()].reduce((a, b) => a + b, 0);
  /** Every measured response, for V1–V3. */
  const seen: any[] = [];

  before(async () => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
    _clearCityZoneCache();
    if (ARM === "live-supabase") {
      // Real client, real schema, real planner. Seed the SAME lattice the
      // double uses, and turn the gateway on through the real flag row — which
      // must already exist; setExistingFlag refuses to invent one.
      const { createClient } = await import("@supabase/supabase-js");
      liveClient = createClient(LIVE_URL, LIVE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { "X-Fixture-Viewer": VIEWER } },
      });
      liveFlagWasEnabled = await readFlag(liveClient, "map_projection_enabled");
      await seedPerfCorpus(liveClient, SEEDED_PLACES, BBOX);
      await setExistingFlag(liveClient, "map_projection_enabled", true);
      app = await mountRouterApp(mapProjectionRouter, liveClient, { token: TOKEN, userId: VIEWER });
    } else {
      app = await startRouterApp(mapProjectionRouter, perfWorld(), { token: TOKEN, userId: VIEWER });
    }

    // Instrument the installed client in place. `getServiceClient()` hands the
    // route this exact object, so every `from(...)` the handler issues passes
    // through here. Counting is all this does — it must not change what the
    // route sees, or the harness would be measuring the instrument.
    const client = app.client;
    const realFrom = client.from.bind(client);
    client.from = (table: string) => {
      reads.set(table, (reads.get(table) ?? 0) + 1);
      return realFrom(table);
    };
  });

  after(async () => {
    if (liveClient) {
      // Hand the database back as found. A perf run that leaves 120 places and
      // a Map flag ON is how the NEXT suite passes for the wrong reason.
      await teardownPerfCorpus(liveClient).catch(() => {});
      // RESTORED, not forced false. Forcing it would be the safe direction on a
      // disposable database and the wrong habit anywhere else: a harness that
      // decides what a flag should be is a harness that can silently turn a
      // feature off for whatever runs next. setExistingFlag refuses an absent
      // row, so a null here means the read failed and there is nothing to put
      // back.
      if (liveFlagWasEnabled !== null) {
        await setExistingFlag(liveClient, "map_projection_enabled", liveFlagWasEnabled).catch(() => {});
      }
      liveClient = null;
    }
    if (app) await app.close();
    app = null;
  });

  test(`p50 and p95 over ${ITERATIONS} warm-cache requests; p95 must be under ${P95_BUDGET_MS} ms`, async () => {
    assert.ok(app, "the harness never started");

    const result = await benchmark(
      `GET /api/map/projection [${ARM}] bbox=${BBOX_STR} zoom=${ZOOM} places=${SEEDED_PLACES}`,
      async () => {
        const r = await app!.projection(`bbox=${BBOX_STR}&zoom=${ZOOM}&kinds=place&limit=200`);
        seen.push(r.body);
        return r;
      },
      { warmup: WARMUP, iterations: ITERATIONS },
    );

    // BOTH numbers are emitted, as the criterion asks — not just the one being
    // gated. A p50 that has doubled while p95 still clears the budget is a real
    // regression, and it is only visible if p50 is printed.
    console.log(formatBenchmark(result));
    console.log(
      `[bench] M256(a) arm=${ARM} p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms ` +
        `budget(p95)=${P95_BUDGET_MS}ms` +
        (ARM === "in-process-double"
          ? "  NOTE: in-process over the test double — a regression gate on route work, NOT production latency"
          : "  arm: live Supabase"),
    );

    assert.equal(result.samples.length, ITERATIONS, "the harness must measure every iteration");
    assert.equal(
      percentile(result.samples, 0.95), result.p95,
      "p95 must be the nearest-rank percentile of the samples actually taken",
    );

    assert.ok(
      result.p95 <= P95_BUDGET_MS,
      `p95 ${result.p95.toFixed(1)}ms exceeds the ${P95_BUDGET_MS}ms budget ` +
        `(p50 ${result.p50.toFixed(1)}ms, max ${result.max.toFixed(1)}ms, arm ${ARM})`,
    );
  });

  // ── The anti-vacuity block ─────────────────────────────────────────────────
  //
  // These run AFTER the measurement and inspect the responses it produced, so
  // they are assertions about the very requests that were timed — not about a
  // fresh request that might behave differently.

  test("V1: every measured response was a SERVING one", () => {
    // Warm-up requests are captured too and are held to the same standard: they
    // are what populates the caches the measured requests then hit, so a
    // warm-up that refused would mean the "warm cache" was never warm.
    assert.equal(
      seen.length, WARMUP + ITERATIONS,
      "the harness did not capture every request it issued",
    );
    seen.forEach((body, i) => {
      assert.equal(body.enabled, true, `request ${i} did not serve (enabled=${body.enabled})`);
      assert.equal("refusal" in body, false, `request ${i} carried a refusal: ${body.refusal}`);
    });
  });

  test("V2: every measured response carried the WHOLE seeded set — a truncating route is not fast, it is broken", () => {
    seen.forEach((body, i) => {
      assert.equal(
        body.objects.length, SEEDED_PLACES,
        `request ${i} returned ${body.objects.length} of ${SEEDED_PLACES} objects. A route that ` +
          `returns [] without reading, or pages early, gets FASTER while getting wronger — which ` +
          `is the whole reason this assertion is here.`,
      );
      assert.equal(body.total, SEEDED_PLACES, `request ${i} reported total=${body.total}`);
    });
  });

  test("V3: the §24 gate ran on every measured request, over the whole set", () => {
    seen.forEach((body, i) => {
      assert.notEqual(body.protection, null, `request ${i} reported no protection pass`);
      assert.equal(
        body.protection.evaluated, SEEDED_PLACES,
        `request ${i} evaluated ${body.protection.evaluated} objects against the §24 policy, ` +
          `not ${SEEDED_PLACES} — the timed pipeline is a prefix of the real one`,
      );
      // The zones are deliberately far away, so nothing should be removed.
      assert.equal(body.protection.suppressed, 0, `request ${i} suppressed an object it should not have`);
      assert.equal(body.protection.coarsened, 0, `request ${i} coarsened an object it should not have`);
      assert.equal(body.protection.allowed, SEEDED_PLACES);
    });
  });

  test("V4: the PROJECTION's own tables were read — not merely the auth path's", () => {
    console.log(`[bench] M256(a) reads by table: ${JSON.stringify(Object.fromEntries(reads))}`);

    // `places` is the route's per-request source and is NOT cached, so a
    // handler doing the work reads it once per request. Nothing in
    // `requireUser` touches it, which is exactly why it is the table named
    // here: this assertion cannot be satisfied by the auth middleware.
    assert.ok(
      readsOf("places") >= WARMUP + ITERATIONS,
      `places was read ${readsOf("places")} times across ${WARMUP + ITERATIONS} requests. Fewer ` +
        `than one per request means requests were answered without loading the viewport — the ` +
        `C4 shape, which gets FASTER as it gets wronger.`,
    );

    // `protected_zones` is deliberately a LOWER BOUND of one over the whole
    // run, not one per request. Its 30 s cache means later requests correctly
    // re-read nothing, and the census is explicit that "zero reads on the
    // second poll" is the wrong question to ask of a warm cache. What must be
    // impossible is the §24 policy never being consulted at all.
    assert.ok(
      readsOf("protected_zones") >= 1,
      "the §24 policy table was never read across the whole run — the gate is not loading a policy",
    );

    assert.ok(totalReads() > 0, "no table was read at all");
  });
});

// ── The live arm's target decision, proven WITHOUT a database ────────────────
//
// These run in every mode, including the ordinary `npm test` pass where no live
// variable is set. They exist because the defect this file just carried was a
// LABEL that outran its target, and the fix is only worth what its refusals are
// worth. Every case below drives the real assertion with the real strings; none
// of them opens the latch, because every one is a refusal.
/**
 * The latch as it stood once the module's own target decision had run: null on
 * the in-process arm, the approved URL on the live one. The refusal cases below
 * assert they leave it exactly here.
 */
const LATCH_AT_LOAD = approvedDisposableTarget();

describe("M256(a) — the live arm refuses every target but the configured one", () => {
  /** Each case: what an operator set, and the refusal reason it must produce. */
  const REFUSALS: Array<{ why: string; runtime: string; configured: string; reason: string }> = [
    {
      why: "no disposable database configured — a bare live URL is not consent",
      runtime: "http://127.0.0.1:4002",
      configured: "",
      reason: "missing_configured_target",
    },
    {
      why: "the configured target is remote",
      runtime: "http://127.0.0.1:4002",
      configured: "https://ajrurzioarfkagpuxfnb.supabase.co",
      reason: "configured_target_not_loopback",
    },
    {
      why: "the runtime target is production while a local one is configured",
      runtime: "https://ajrurzioarfkagpuxfnb.supabase.co",
      configured: "http://127.0.0.1:4002",
      reason: "runtime_target_not_loopback",
    },
    {
      why: "two different loopback targets is ambiguous, so it is refused rather than guessed",
      runtime: "http://127.0.0.1:4002",
      configured: "http://127.0.0.1:4000",
      reason: "target_mismatch",
    },
  ];

  for (const c of REFUSALS) {
    test(`refused: ${c.why}`, () => {
      assert.throws(
        () => assertDisposableLocalBenchmarkTarget(c.runtime, c.configured),
        (err: unknown) => {
          // The TYPE and the REASON CODE, not the wording: a message-only check
          // would pass on a plain Error carrying the same sentence, and a
          // reason-less refusal cannot be told apart from a different refusal.
          assert.ok(err instanceof DisposableTargetError, "the refusal is a DisposableTargetError");
          assert.equal((err as DisposableTargetError).reason, c.reason);
          return true;
        },
      );
      // And the refusal did not OPEN the latch, which is the property that
      // actually matters: a refusal that opened it would be worse than none.
      // Compared against the state at module load rather than against null,
      // because on the live arm the latch is legitimately already open — the
      // claim is that these calls do not change it, not that it is shut.
      assert.equal(approvedDisposableTarget(), LATCH_AT_LOAD);
    });
  }
});
