/**
 * mapProjectionLiveDb.test.ts — the Map gateway, against a REAL PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ESTABLISHES THAT NO EXISTING MAP TEST CAN
 * ═══════════════════════════════════════════════════════════════════════════
 * Every other Map suite drives `GET /api/map/projection` against a double. A
 * double answers whatever its fixture says, so it can show the handler is
 * self-consistent and it can show nothing about whether the route's reads are
 * ones a real schema would accept, or whether the gateway actually SERVES when
 * its flag row is genuinely true. W146 is the reason that distinction is not
 * theoretical: against a fake, all 151 Wall analytics writes "succeeded";
 * against a real schema every one was refused `23514`.
 *
 * So this file asserts four things a double cannot reach:
 *
 *   1. the flag gate runs against a REAL `feature_flags` ROW. `isFlagEnabled`
 *      reads an absent row as false, so "false" and "no row" are the same to
 *      the route and different to an operator — and the whole Map deployment
 *      question is which of the two production is in. The helper REFUSES to
 *      create a missing flag row for exactly this reason.
 *   2. with the row true, the gateway answers `enabled: true` and names its
 *      sources — i.e. the dark-gateway state that blocks ~30 census rows is a
 *      deployment fact, not a code fact.
 *   3. a seeded place inside the viewport reaches `objects` through the real
 *      `places` read, with its real columns; one outside does not. Without the
 *      outside row, "the seeded places came back" is also satisfied by a route
 *      that returns the whole table.
 *   4. §24 ran on what was served: `protection.evaluated` accounts for the
 *      objects, so the thing under test is the whole pipeline rather than a
 *      prefix of it.
 *
 * And it settles M223's gate by measurement rather than argument. The row's
 * criterion, read literally, wants `enabled: true` PLUS a non-null forecast —
 * which would close Time Machine for every PAST offset, because a past offset
 * answers `forecast: null` with a `history` block. That was argued in
 * docs/ops/map-completion-checkpoint.md from the source. Here it is OBSERVED:
 * the same route, same seed, one future offset and one past offset, both
 * `enabled: true`, and the past one `forecast: null`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 * It is not production, and it is not `portava-ci`. It is a loopback PostgREST
 * over a disposable local PostgreSQL carrying the replayed migration chain.
 * That makes it a REAL-SCHEMA gate on the gateway's reads and on the flag
 * contract; it is not evidence about any deployed database, and no census row
 * may be closed on it that names one. The environment is printed in the run's
 * own output so a reader cannot mistake one for the other.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TARGET DECISION — the first thing this module does
 * ═══════════════════════════════════════════════════════════════════════════
 * Three mutually exclusive modes, decided at module scope, before any Supabase
 * code is loaded, and identical in shape to wallFirstPageLiveDb.test.ts:
 *
 *   LOCAL      MAP_LIVE_LOCAL_DB_URL names the ONE disposable local database.
 *              The host is loopback, so it cannot be a Supabase project: there
 *              is no project ref for the CI allowlist to bind to and no packet
 *              leaves the machine. `assertDisposableLocalBenchmarkTarget`
 *              refuses missing / remote / production / mismatched targets here,
 *              and it is the ONLY thing that opens the corpus write latch.
 *              A bare loopback SUPABASE_URL nobody configured is NOT local mode.
 *   REMOTE     MAP_LIVE_LOCAL_DB_URL is unset and SUPABASE_URL names something.
 *              The full production guard runs, unchanged and unweakened, and
 *              exits 2 right here. A malformed or non-http URL fails CLOSED
 *              into this branch, because the loopback predicate does.
 *   NO TARGET  SUPABASE_URL names nothing. Nothing is connected to, the suite
 *              skips, and the write latch stays shut so seedMapCorpus and
 *              teardownMapCorpus throw. That inertness is ASSERTED below
 *              rather than assumed, because it is the one branch with no guard.
 *
 * Run it:
 *   SUPABASE_URL=http://127.0.0.1:4002 \
 *   MAP_LIVE_LOCAL_DB_URL=http://127.0.0.1:4002 \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role jwt> \
 *     node --import tsx/esm --test src/test/mapProjectionLiveDb.test.ts
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { AddressInfo } from "node:net";

import {
  approvedDisposableTarget,
  assertDisposableLocalBenchmarkTarget,
  DisposableTargetError,
  missingLiveDbReason,
} from "./helpers/liveWallCorpus.js";
import {
  MAP_BBOX,
  MAP_ZOOM,
  MAP_EXPECTED_OBJECT_IDS,
  MAP_OUTSIDE_OBJECT_ID,
  readFlag,
  seedMapCorpus,
  setExistingFlag,
  teardownMapCorpus,
} from "./helpers/liveMapCorpus.js";

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
const CONFIGURED_LOCAL_DB = process.env["MAP_LIVE_LOCAL_DB_URL"] ?? "";

const A_TARGET_IS_NAMED = SUPABASE_URL.trim() !== "";
const LOCAL_MODE_SELECTED = A_TARGET_IS_NAMED && CONFIGURED_LOCAL_DB.trim() !== "";
const REMOTE_TARGET_NAMED = A_TARGET_IS_NAMED && !LOCAL_MODE_SELECTED;

if (LOCAL_MODE_SELECTED) {
  assertDisposableLocalBenchmarkTarget(SUPABASE_URL, CONFIGURED_LOCAL_DB);
} else if (REMOTE_TARGET_NAMED) {
  await import("../lib/ciSupabaseGuard.mjs");
}

const SKIP_REASON = missingLiveDbReason(SUPABASE_URL, SERVICE_ROLE_KEY);
const LIVE = SKIP_REASON === null && LOCAL_MODE_SELECTED;

// NO_TARGET_IS_INERT. The one branch above that runs no guard is the branch
// with no target. That is only safe while it also reaches no database, so the
// claim is asserted rather than asserted-about.
if (!A_TARGET_IS_NAMED) {
  if (LIVE || approvedDisposableTarget() !== null) {
    throw new Error(
      "mapProjectionLiveDb: no target is configured, yet this file believes it can reach a " +
        `database (live=${LIVE}, approvedTarget=${String(approvedDisposableTarget())}). ` +
        "The unguarded no-target branch is only sound while it is inert.",
    );
  }
}

/** The viewer the local shim names from its header; any bearer token will do. */
const VIEWER_ID = "aa11aa11-0000-4000-8000-000000000001";
const PROJECTION_FLAG = "map_projection_enabled";

const bboxParam = `${MAP_BBOX.west},${MAP_BBOX.south},${MAP_BBOX.east},${MAP_BBOX.north}`;

let server: http.Server | null = null;
let base = "";
let pub: any = null;
let flagWasEnabled: boolean | null = null;

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: "Bearer map-live-fixture-token" },
  });
  return { status: res.status, body: await res.json() };
}

describe("the Map gateway against a real PostgreSQL", { skip: !LIVE ? (SKIP_REASON ?? "MAP_LIVE_LOCAL_DB_URL is not set") : false }, () => {
  before(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { _setTestClient } = await import("../lib/http.js");
    const { _setTestServiceClient } = await import("../lib/supabase.js");
    const mapProjection = (await import("../routes/mapProjection.js")).default;
    const mapTemporal = (await import("../routes/mapProjectionTemporal.js")).default;

    pub = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "X-Fixture-Viewer": VIEWER_ID } },
    });
    _setTestClient(pub, true);
    _setTestServiceClient(pub);

    // Remember the flag's real value so the database is handed back as found.
    // A harness that leaves a Map flag ON is how another suite passes for the
    // wrong reason.
    flagWasEnabled = await readFlag(pub, PROJECTION_FLAG);
    assert.notEqual(
      flagWasEnabled,
      null,
      `${PROJECTION_FLAG} has NO ROW in this database — that is the deployment finding, and ` +
        "this harness refuses to invent the row",
    );

    await seedMapCorpus(pub);

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
      next();
    });
    app.use(mapProjection);
    app.use(mapTemporal);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server!.once("listening", () => r()));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    console.log(
      `# [map-live] gateway driven against ${SUPABASE_URL} — a LOOPBACK PostgREST over a ` +
        "disposable PostgreSQL. Real schema, real planner, real feature_flags row. " +
        "NOT production and NOT portava-ci.",
    );
  });

  after(async () => {
    if (pub) {
      await teardownMapCorpus(pub).catch(() => {});
      if (flagWasEnabled !== null) {
        await setExistingFlag(pub, PROJECTION_FLAG, flagWasEnabled).catch(() => {});
      }
    }
    if (server) await new Promise<void>((r) => server!.close(() => r()));
  });

  // ── the flag gate, against a real row ─────────────────────────────────────

  test("a FALSE flag row yields the disabled envelope, and serves nothing", async () => {
    await setExistingFlag(pub, PROJECTION_FLAG, false);
    const { status, body } = await get(`/map/projection?bbox=${bboxParam}&zoom=${MAP_ZOOM}`);
    assert.equal(status, 200, "the gateway is fail-soft: a dark flag is not an error");
    assert.equal(body.enabled, false);
    assert.deepEqual(body.objects, []);
    assert.deepEqual(body.sources, [], "a disabled gateway must not claim sources it did not read");
    assert.equal(body.protection, null);
    // Anti-vacuity for the whole file: the rows ARE there, and the empty answer
    // is the flag's doing rather than an empty table.
    const { count, error } = await pub
      .from("places")
      .select("id", { count: "exact", head: true })
      .like("normalized_name", "mlive-%");
    assert.equal(error, null);
    assert.equal(count, 3, "the seeded rows exist while the disabled envelope says nothing");
  });

  test("a TRUE flag row turns the gateway on", async () => {
    await setExistingFlag(pub, PROJECTION_FLAG, true);
    const { status, body } = await get(`/map/projection?bbox=${bboxParam}&zoom=${MAP_ZOOM}`);
    assert.equal(status, 200);
    assert.equal(body.enabled, true, "this is the state ~30 census rows are waiting on");
    assert.ok(Array.isArray(body.sources) && body.sources.length > 0, "an enabled gateway names what it read");
    assert.ok(body.sources.includes("places"), "the places layer is among them");
    assert.ok(body.viewport && body.viewport.bbox, "an enabled gateway reports the viewport it served");
  });

  // ── the real read ─────────────────────────────────────────────────────────

  test("seeded places INSIDE the viewport are served, and the one outside is not", async () => {
    await setExistingFlag(pub, PROJECTION_FLAG, true);
    const { body } = await get(`/map/projection?bbox=${bboxParam}&zoom=${MAP_ZOOM}`);
    const ids = (body.objects as Array<{ id: string }>).map((o) => o.id);
    for (const id of MAP_EXPECTED_OBJECT_IDS) {
      assert.ok(ids.includes(id), `expected ${id} in objects; got ${JSON.stringify(ids)}`);
    }
    assert.equal(
      ids.includes(MAP_OUTSIDE_OBJECT_ID),
      false,
      "a place far outside the bbox must not be served — otherwise this suite would pass " +
        "against a route that returned the whole table",
    );

    // ── AND THE READ ITSELF, not only the outcome ─────────────────────────
    // Found by arming this case rather than by reading the code. The viewport
    // is enforced TWICE — `loadViewportPlaceRows` filters in SQL, and
    // `aggregateForViewport` separately drops any object whose centroid is not
    // bboxContains(request.bbox, …) — and the assertion above only sees the
    // composition of the two. The first version of this case had NO line here,
    // and deleting the SQL filter outright left the suite GREEN: the aggregator
    // caught the extra row on the way out. Defence in depth doing its job, and
    // a hole in the measurement.
    //
    // WHAT IS AND IS NOT ARMED, measured rather than claimed:
    //   SQL filter removed  ................ RED, on this line (places.rows 3 ≠ 2)
    //   aggregator drop removed ............ GREEN — and that is CORRECT, not a
    //       gap: the SQL filter already excluded the row, so the aggregator
    //       never saw it. No single-gate mutation can change what is served
    //       while the other gate stands, which is the point of having two.
    //   BOTH removed ....................... RED, on the assertion above
    // So this line pins the read and the line above pins the composition, and
    // between them every reachable single- and double-gate failure is covered.
    assert.equal(
      body.places?.rows,
      2,
      "the places READ must return the two inside the bbox — if it returns three, the SQL " +
        "filter is gone and only the aggregator is standing between the table and the client",
    );
  });

  test("a served object carries the shape the client renders, from real columns", async () => {
    await setExistingFlag(pub, PROJECTION_FLAG, true);
    const { body } = await get(`/map/projection?bbox=${bboxParam}&zoom=${MAP_ZOOM}`);
    const obj = (body.objects as any[]).find((o) => o.id === MAP_EXPECTED_OBJECT_IDS[0]);
    assert.ok(obj, "the first seeded place was served");
    assert.equal(obj.kind, "place");
    assert.equal(obj.geometry.type, "Point");
    // [lng, lat] — GeoJSON order, and the seeded values, so a transposed
    // projection is caught rather than merely "a number was present".
    assert.deepEqual(obj.geometry.coordinates, [108.2, 16.05]);
    assert.equal(obj.title, "Mlive Inside A");
    assert.equal(obj.privacyClass, "place_level");
    assert.ok(Array.isArray(obj.interaction?.actions) && obj.interaction.actions.includes("view"));
    assert.equal(obj.payload?.canonicalPlaceId, MAP_EXPECTED_OBJECT_IDS[0].slice("place:".length));
  });

  test("§24 ran on what was served — protection accounts for the objects", async () => {
    await setExistingFlag(pub, PROJECTION_FLAG, true);
    const { body } = await get(`/map/projection?bbox=${bboxParam}&zoom=${MAP_ZOOM}`);
    assert.ok(body.protection, "an enabled gateway reports its protection pass");
    const { evaluated, allowed, coarsened, suppressed } = body.protection;
    assert.equal(
      allowed + coarsened + suppressed,
      evaluated,
      "every evaluated object has an outcome — a protection report that does not add up " +
        "means the gate ran on a prefix",
    );
    assert.ok(
      evaluated >= (body.objects as any[]).length,
      `protection evaluated ${evaluated} but ${(body.objects as any[]).length} objects were served; ` +
        "an object served without being evaluated is the §24 bypass this report exists to expose",
    );
  });

  // ── M223: the Time Machine gate, measured rather than argued ──────────────

  describe("M223 — the temporal producer's own answer", () => {
    test("a FUTURE offset answers enabled:true in forecast mode", async () => {
      await setExistingFlag(pub, PROJECTION_FLAG, true);
      const { status, body } = await get(
        `/map/projection/temporal?bbox=${bboxParam}&zoom=${MAP_ZOOM}&offsetMinutes=30`,
      );
      assert.equal(status, 200);
      assert.equal(body.enabled, true);
      assert.equal(body.target?.mode, "forecast");
      assert.ok(body.forecast, "a forecast request carries a forecast block");
    });

    test("a PAST offset answers enabled:true with forecast NULL — so the gate is `enabled`, not the forecast", async () => {
      // This is the correction. M223's criterion read literally wants
      // `enabled: true` PLUS a non-null forecast, and a gate written that way
      // closes Time Machine for every past offset — which is most of what Time
      // Machine is for. The checkpoint argued this from the source; this case
      // observes it.
      await setExistingFlag(pub, PROJECTION_FLAG, true);
      const { status, body } = await get(
        `/map/projection/temporal?bbox=${bboxParam}&zoom=${MAP_ZOOM}&offsetMinutes=-120`,
      );
      assert.equal(status, 200);
      assert.equal(body.enabled, true, "the producer IS reachable for a past offset");
      assert.equal(body.forecast, null, "and it answers no forecast — as a past window must");
      assert.notEqual(body.target, null, "it still reports the window it resolved");
    });

    test("the temporal route is dark when the gateway is", async () => {
      // Anti-vacuity for the two cases above: they must be reading the real
      // flag row, not a route that answers enabled:true unconditionally.
      await setExistingFlag(pub, PROJECTION_FLAG, false);
      const { body } = await get(
        `/map/projection/temporal?bbox=${bboxParam}&zoom=${MAP_ZOOM}&offsetMinutes=30`,
      );
      assert.equal(body.enabled, false);
    });
  });
});

// ── The write gate, always run, with no database anywhere ────────────────────
//
// These cases exist in EVERY mode, including the ordinary `npm test` run where
// nothing is configured. They are the reason the no-target branch needs no
// guard: they prove the write paths refuse while the latch is shut, and they
// do it without constructing a client at all.
describe("liveMapCorpus refuses to write while the latch is shut", () => {
  const throwsIfReached: any = new Proxy(
    {},
    {
      get() {
        throw new Error("liveMapCorpus reached a client before checking the write latch");
      },
    },
  );

  test("seedMapCorpus throws before touching the client", async (t) => {
    if (approvedDisposableTarget() !== null) {
      t.skip("the latch is open in this run — see the live suite above");
      return;
    }
    await assert.rejects(
      () => seedMapCorpus(throwsIfReached),
      (err: unknown) => {
        // The TYPE, not only the wording: a plain Error carrying the same
        // sentence would pass a message-only check while meaning something else.
        assert.ok(err instanceof DisposableTargetError, "the refusal is a DisposableTargetError");
        assert.match(String((err as Error).message), /without an approved disposable target/);
        return true;
      },
    );
  });

  test("teardownMapCorpus throws before touching the client", async (t) => {
    if (approvedDisposableTarget() !== null) {
      t.skip("the latch is open in this run — see the live suite above");
      return;
    }
    await assert.rejects(
      () => teardownMapCorpus(throwsIfReached),
      (err: unknown) => {
        // The TYPE, not only the wording: a plain Error carrying the same
        // sentence would pass a message-only check while meaning something else.
        assert.ok(err instanceof DisposableTargetError, "the refusal is a DisposableTargetError");
        assert.match(String((err as Error).message), /without an approved disposable target/);
        return true;
      },
    );
  });

  test("setExistingFlag throws before touching the client", async (t) => {
    // The flag write is the one that could change a DEPLOYED system's
    // behaviour, so it is latched like the fixtures rather than trusted to its
    // caller.
    if (approvedDisposableTarget() !== null) {
      t.skip("the latch is open in this run — see the live suite above");
      return;
    }
    await assert.rejects(
      () => setExistingFlag(throwsIfReached, "map_projection_enabled", true),
      (err: unknown) => {
        assert.ok(err instanceof DisposableTargetError, "the refusal is a DisposableTargetError");
        assert.match(String((err as Error).message), /without an approved disposable target/);
        return true;
      },
    );
  });
});
