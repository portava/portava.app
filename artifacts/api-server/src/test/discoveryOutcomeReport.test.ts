/**
 * DV-19 — the outcome INSTRUMENT (census-discovery §55): `01` §12's success
 * items, per arm and serve point, numbers and sample sizes only.
 *
 * The corpus is written by the REAL writers and routes (test/helpers/
 * discoveryOutcomeCorpus.ts): the legacy arm through the serve log, the PDE arm
 * through rankLog, outcomes through POST /rank-events/outcome, attention through
 * POST /rank-events/dwell. Hand-planted rows are copies of real rows with one
 * field changed, named where planted.
 *
 * Pinned:
 *   O1  the arm is read from the row's own modelVersion; unrecorded and unknown
 *       versions are never folded into an arm
 *   O2  every measured metric: the funnel's lower and upper bounds, with n
 *   O3  an arm with ZERO sample is "insufficient_sample" with null figures —
 *       never 0 % — in the totals and at every serve point either arm reached
 *   O4  every `01` §12 item with no input is listed UNMEASURED with its missing
 *       input, never as a number; dismiss is "dismiss rate", never regret
 *   O5  a stray outcome for an unmeasured item is reported as a finding
 *   O6  anonymous serves: counted when observed, "unobserved" (not 0) when not
 *   O7  NO READER ADDED HERE COUNTS DWELL — idle, passive or active — AS AN
 *       OUTCOME OR INTEREST: adding attention rows changes no figure but the
 *       coverage report's attention counts
 *   O8  the rendering states no verdict and no threshold
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildOutcomeReport, renderOutcomeReport, armOf, OUTCOME_METRICS, type OutcomeCell } from "../lib/discoveryOutcomeReport.js";
import { buildTraceCoverageReport } from "../lib/discoveryTraceCoverage.js";
import { DISCOVERY_DWELL_EVENT_TYPE } from "../lib/discoveryDwellVocabulary.js";
import { startCorpus, quiesce, ALICE, BOB, SP, type CorpusHarness } from "./helpers/discoveryOutcomeCorpus.js";

let h: CorpusHarness;
let rows: any[];
let requests: any[];
const ids: Record<string, string> = {};

const cell = (cells: OutcomeCell[], arm: string, sp: number | "all") => cells.find((c) => c.arm === arm && c.servePoint === sp)!;

before(async () => {
  h = await startCorpus();
  [ids.a, ids.b, ids.c] = await h.serveLegacy(ALICE, SP.CACHE_A_L1, ["db/a", "db/b", "node/c"]);
  [ids.d, ids.e] = await h.servePde(ALICE, SP.CACHE_A_L2_FRESH, ["db/d", "db/e"], ["db/d", "db/e"]);
  [ids.g] = await h.serveLegacy(BOB, SP.SEARCH, ["db/g"]);
  await h.serveLegacy("", SP.COLD_FETCH_LEGACY_RANK, ["node/1", "node/2", "node/3", "node/4"]);
  assert.equal(await h.outcome("alice-token", "db/a", "tap", ids.a), 200);
  assert.equal(await h.outcome("alice-token", "db/b", "tap", ids.b), 200);
  assert.equal(await h.outcome("alice-token", "db/b", "save", ids.b), 200);        // tap then save: the row reads save
  assert.equal(await h.outcome("alice-token", "node/c", "dismiss", ids.c), 200);
  assert.equal(await h.outcome("alice-token", "db/d", "trip_add", ids.d), 200);
  assert.equal(await h.outcome("bob-token", "db/g", "tap", ids.g), 200);
  await quiesce();
  rows = [...h.db.rankEvents()];
  requests = h.db.serveRequests();
});
after(async () => { await h.close(); });

describe("DV-19 — outcomes by arm over a controlled corpus", () => {
  it("O1. the arm is the row's own modelVersion; unrecorded and unknown versions stay OUT of both arms", () => {
    const exposureA = rows.find((r) => r.item_id === "db/a" && r.event_type === undefined);
    const exposureD = rows.find((r) => r.item_id === "db/d" && r.event_type === undefined);
    assert.equal(armOf(exposureA), "legacy");
    assert.equal(armOf(exposureD), "pde");
    const planted = [
      ...rows,
      { ...exposureA, id: "future", features: { ...exposureA.features, modelVersion: "future-model-2027" } },
      { ...exposureA, id: "old", features: { ...exposureA.features, modelVersion: undefined } },
    ];
    const r = buildOutcomeReport(planted, requests);
    assert.equal(cell(r.arms, "legacy", "all").n, 4, "neither planted row joined the legacy arm");
    assert.equal(cell(r.arms, "pde", "all").n, 2);
    assert.deepEqual(r.outsideArms.map((c) => [c.arm, c.servePoint, c.n]), [["unknown", SP.CACHE_A_L1, 1], ["unrecorded", SP.CACHE_A_L1, 1]]);
    assert.deepEqual(r.unknownModelVersions, ["future-model-2027"]);
  });

  it("O2. measured metrics are the funnel's lower and upper bounds over n exposures", () => {
    const r = buildOutcomeReport(rows, requests);
    const legacy = cell(r.arms, "legacy", "all");
    assert.equal(legacy.n, 4);
    assert.deepEqual(legacy.terminal, { tap: 2, save: 1, dismiss: 1 });
    assert.deepEqual(legacy.metrics["place_opens"], { status: "measured", n: 4, lower: { count: 2, share: 0.5 }, upper: { count: 3, share: 0.75 } });
    assert.deepEqual(legacy.metrics["useful_saves"], { status: "measured", n: 4, lower: { count: 1, share: 0.25 }, upper: { count: 1, share: 0.25 } });
    assert.deepEqual(legacy.metrics["dismiss_rate"], { status: "measured", n: 4, lower: { count: 1, share: 0.25 }, upper: { count: 1, share: 0.25 } });
    assert.deepEqual(legacy.metrics["itinerary_additions"], { status: "measured", n: 4, lower: { count: 0, share: 0 }, upper: { count: 0, share: 0 } },
      "a MEASURED zero over a real sample is a number");
    const pde = cell(r.arms, "pde", "all");
    assert.deepEqual(pde.terminal, { trip_add: 1, impression: 1 });
    assert.deepEqual(pde.metrics["itinerary_additions"], { status: "measured", n: 2, lower: { count: 1, share: 0.5 }, upper: { count: 1, share: 0.5 } });
    assert.deepEqual(pde.metrics["useful_saves"], { status: "measured", n: 2, lower: { count: 0, share: 0 }, upper: { count: 1, share: 0.5 } },
      "a trip_add may have consumed a save: the upper bound counts it, the lower does not");
    assert.deepEqual(pde.rankedInRequest, { ranked: 2, unranked: 0, unrecorded: 0 });
    assert.deepEqual(legacy.rankedInRequest, { ranked: 0, unranked: 4, unrecorded: 0 });
  });

  it("O3. an arm with ZERO sample is insufficient — null, never 0 % — in the totals and at every serve point", () => {
    const legacyOnly = rows.filter((r) => armOf(r) !== "pde");
    const r = buildOutcomeReport(legacyOnly, requests);
    const pde = cell(r.arms, "pde", "all");
    assert.equal(pde.n, 0);
    for (const m of OUTCOME_METRICS.filter((x) => x.status === "measured")) {
      assert.deepEqual(pde.metrics[m.id], { status: "insufficient_sample", n: 0, lower: null, upper: null }, m.id);
    }
    for (const sp of [SP.CACHE_A_L1, SP.SEARCH]) {
      const c = cell(r.byServePoint, "pde", sp);
      assert.ok(c, `the pde arm is SHOWN at serve point ${sp}`);
      assert.equal(c.metrics["place_opens"]!.status, "insufficient_sample");
    }
    const full = buildOutcomeReport(rows, requests);
    assert.equal(cell(full.byServePoint, "legacy", SP.CACHE_A_L2_FRESH).metrics["place_opens"]!.status, "insufficient_sample",
      "and the legacy arm where only PDE served");
    const text = renderOutcomeReport(r);
    assert.match(text, /\[pde\] all serve points — n = 0/);
    assert.match(text, /place_opens: insufficient sample \(n = 0\) — not 0%/);
    assert.doesNotMatch(text, /\[pde\][^\n]*\n[^\n]*\n[^\n]*0\.0%/, "no 0.0% under an empty arm");
  });

  it("O4. every §12 item with no input is UNMEASURED with its missing input; dismiss is never called regret", () => {
    const r = buildOutcomeReport(rows, requests);
    assert.deepEqual(r.unmeasured.map((u) => u.id), [
      "completed_visits", "event_attendance", "successful_trip_actions", "low_regret",
      "creator_diversity", "new_creator_discovery", "trail_freshness", "repeat_traveler_satisfaction",
    ]);
    for (const u of r.unmeasured) {
      assert.ok(u.missingInput.length > 20, `${u.id} names what is missing`);
      assert.equal("strayRows" in u, false, `${u.id}: no number at all`);
      for (const c of [...r.arms, ...r.byServePoint]) assert.equal(c.metrics[u.id], undefined, `${u.id} never carries a figure`);
    }
    // All eleven `01` §12 items are accounted for, measured or not.
    assert.equal(OUTCOME_METRICS.length, 12, "eleven §12 items, with low regret/hide/report split into dismiss_rate and low_regret");
    const dismiss = OUTCOME_METRICS.find((m) => m.id === "dismiss_rate")!;
    assert.match(dismiss.spec, /ONLY the dismiss rate/);
    assert.doesNotMatch(dismiss.id, /regret/);
  });

  it("O5. a stray outcome for an unmeasured item is reported as a finding, not absorbed", () => {
    const exposureA = rows.find((r) => r.item_id === "db/a" && r.event_type === undefined);
    const r = buildOutcomeReport([...rows, { ...exposureA, id: "stray", outcome: "rsvp" }], requests);
    const ea = r.unmeasured.find((u) => u.id === "event_attendance")!;
    assert.equal(ea.strayRows, 1);
    assert.match(renderOutcomeReport(r), /the registry is stale/);
  });

  it("O6. anonymous serves: counted when observed, UNOBSERVED (not 0) when the per-request table was not read", () => {
    const seen = buildOutcomeReport(rows, requests);
    assert.deepEqual(seen.anonymous, { observed: true, requests: 1, items: 4, outcomes: "unobservable by design — an anonymous serve has no exposure row and binds no outcome" });
    const unseen = buildOutcomeReport(rows, null);
    assert.equal(unseen.anonymous.observed, false);
    assert.equal("requests" in unseen.anonymous, false);
  });

  it("O7. NO reader added here counts dwell — idle, passive or active — as an outcome or as interest", async () => {
    const without = rows.filter((r) => r.event_type !== DISCOVERY_DWELL_EVENT_TYPE);
    assert.equal(await h.dwell("alice-token", "db/a", ids.a!, "0f0f0f0f-1111-4222-8333-000000000001", [{ kind: "idle", ms: 3_600_000 }]), 200);
    assert.equal(await h.dwell("alice-token", "db/e", ids.e!, "0f0f0f0f-1111-4222-8333-000000000002", [{ kind: "idle", ms: 120_000 }, { kind: "passive_foreground", ms: 50_000 }, { kind: "active", ms: 4_000 }]), 200);
    assert.equal(await h.dwell("bob-token", "db/g", ids.g!, "0f0f0f0f-1111-4222-8333-000000000003", [{ kind: "idle", ms: 1 }]), 200);
    const withDwell = [...h.db.rankEvents()];
    assert.equal(withDwell.filter((r) => r.event_type === DISCOVERY_DWELL_EVENT_TYPE).length, 5);

    assert.deepEqual(buildOutcomeReport(withDwell, requests), buildOutcomeReport(without, requests),
      "the outcome report is byte-for-byte unchanged by any dwell");

    const strip = (r: ReturnType<typeof buildTraceCoverageReport>) => JSON.parse(JSON.stringify(r, (k, v) =>
      k === "attention" || k === "attentionNoId" || k === "attentionExposureNotRead" ? undefined : v));
    const a = buildTraceCoverageReport(withDwell, requests), b = buildTraceCoverageReport(without, requests);
    assert.deepEqual(strip(a), strip(b), "coverage changes ONLY in its attention counts");
    const l1 = a.surfaces[0]!.groups.find((g) => g.servePoint === SP.CACHE_A_L1)!;
    assert.deepEqual(l1.attention, { idle: 1 });
    assert.deepEqual(l1.outcomes.onExposure, { tap: 1, save: 1, dismiss: 1 }, "an hour of idle dwell is not an outcome");
  });

  it("O8. the rendering states numbers and sample sizes, and no verdict or threshold", () => {
    const text = renderOutcomeReport(buildOutcomeReport(rows, requests));
    assert.match(text, /verdict: none — numbers and sample sizes only/);
    assert.match(text, /place_opens: between 2 \(50\.0%\) and 3 \(75\.0%\) of 4/);
    assert.match(text, /dismiss_rate: 1 \(25\.0%\) of 4/);
    assert.doesNotMatch(text, /\b(better|worse|improv|regress|significan|winner|threshold)/i);
  });
});
