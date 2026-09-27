/**
 * DSV2-12 — the coverage leg (census-discovery §55): served recommendation →
 * exposure → permitted outcome, with versions and coverage.
 *
 * The corpus is written by the REAL writers and routes (test/helpers/
 * discoveryOutcomeCorpus.ts); the only hand-planted rows are copies of real
 * rows with one field changed, each named where it is planted.
 *
 * Pinned:
 *   T1  per serve point: served items WITH and WITHOUT an exposure row, from the
 *       per-request rows — a full chain, a PDE page whose unscored item has no
 *       exposure (production's own partial chain), and a lost insert
 *   T2  outcomes: on the exposure row (bound by construction) and as events —
 *       bound, unbound for want of an id, unbound because the exposure was not read
 *   T3  anonymous serves are counted apart and never bind; an empty serve is a request
 *   T4  versions: per group and overall; an unknown schema_version and an
 *       unknown modelVersion are NAMED, and a missing servePoint is its own group
 *   T5  without the per-request table everything that needs it is UNOBSERVED
 *       (null), never 0 — and the exposures' own denominator still reports
 *   T6  attention rows are counted by kind, bound or not, and never as outcomes
 *   T7  rows outside the trace are counted, not dropped
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildTraceCoverageReport, renderTraceCoverageReport, type TraceCoverageReport, type TraceGroup } from "../lib/discoveryTraceCoverage.js";
import { DISCOVERY_MODEL_VERSION, DISCOVERY_PDE_MODEL_VERSION } from "../lib/discoveryRankProvenance.js";
import { startCorpus, quiesce, ALICE, BOB, SP, type CorpusHarness } from "./helpers/discoveryOutcomeCorpus.js";

let h: CorpusHarness;
let rows: any[];
let requests: any[];
let report: TraceCoverageReport;
const ids: Record<string, string> = {};

const group = (r: TraceCoverageReport, sp: number | "unmarked" | "unrecognised"): TraceGroup =>
  r.surfaces.find((s) => s.surface === "discovery")!.groups.find((g) => g.servePoint === sp)!;

before(async () => {
  h = await startCorpus();
  // Alice, legacy arm, cache A L1: a full chain of three.
  [ids.a, ids.b, ids.c] = await h.serveLegacy(ALICE, SP.CACHE_A_L1, ["db/a", "db/b", "node/c"]);
  // Alice, PDE arm, cache A L2: three served, two scored — db/f has NO exposure row by construction.
  [ids.d, ids.e, ids.f] = await h.servePde(ALICE, SP.CACHE_A_L2_FRESH, ["db/d", "db/e", "db/f"], ["db/d", "db/e"]);
  // Bob, search: two served; one insert is then LOST (removed from the table).
  [ids.g, ids.h] = await h.serveLegacy(BOB, SP.SEARCH, ["db/g", "db/h"]);
  const lost = h.db.rankEvents().findIndex((r) => r.item_id === "db/h" && r.user_id === BOB);
  h.db.rankEvents().splice(lost, 1);
  // An anonymous cold fetch of four, and a signed-in serve of nothing.
  await h.serveLegacy("", SP.COLD_FETCH_LEGACY_RANK, ["node/1", "node/2", "node/3", "node/4"]);
  await h.serveLegacy(ALICE, SP.FEED, []);

  // Outcomes through the real route.
  assert.equal(await h.outcome("alice-token", "db/a", "tap", ids.a), 200);        // claimed id
  assert.equal(await h.outcome("alice-token", "db/b", "save"), 200);              // item lookup
  assert.equal(await h.outcome("alice-token", "node/c", "dismiss", ids.c), 200);
  assert.equal(await h.outcome("alice-token", "db/d", "trip_add", ids.d), 200);   // no analytics event: trip_add has none
  assert.equal(await h.outcome("bob-token", "db/g", "tap", ids.g), 200);
  // Attention through the real route (flag on in this harness).
  assert.equal(await h.dwell("alice-token", "db/a", ids.a!, "0f0f0f0f-1111-4222-8333-444444444444", [{ kind: "active", ms: 3000 }, { kind: "idle", ms: 90000 }]), 200);
  assert.equal(await h.dwell("alice-token", "db/e", ids.e!, "0f0f0f0f-1111-4222-8333-555555555555", [{ kind: "passive_foreground", ms: 7000 }]), 200);
  await quiesce();

  const all = h.db.rankEvents();
  const real = (pred: (r: any) => boolean) => all.find(pred)!;
  // Planted: an outcome event from before 2891 (no id) — a copy of a real analytics row.
  const tapEvent = real((r) => r.outcome === "analytics" && r.event_type === "ranking_item_opened" && r.item_id === "db/a");
  all.push({ ...tapEvent, id: "planted-no-id", recommendation_id: null });
  // Planted: a ranker's per-candidate analytics row (not part of the trace).
  all.push({ ...tapEvent, id: "planted-ranker", event_type: "ranking_item_scored", recommendation_id: null });
  // Planted: an exposure written by a FUTURE writer (unknown versions) and one older than the servePoint marker.
  const exposureE = real((r) => r.item_id === "db/e" && r.event_type === undefined);
  all.push({ ...exposureE, id: "planted-future", recommendation_id: null, schema_version: 2,
    features: { ...exposureE.features, recommendationId: undefined, serveId: undefined, modelVersion: "future-model-2027" } });
  const exposureB = real((r) => r.item_id === "db/b" && r.event_type === undefined);
  const { servePoint: _sp, ...noMarker } = exposureB.features;
  all.push({ ...exposureB, id: "planted-unmarked", recommendation_id: null, features: { ...noMarker, recommendationId: undefined, serveId: undefined } });

  // The corpus the report reads EXCLUDES Bob's db/g exposure: its outcome event
  // and outcome row become "exposure not read" (e.g. it predates the window).
  rows = all.filter((r) => !(r.item_id === "db/g" && r.event_type === undefined));
  requests = h.db.serveRequests();
  report = buildTraceCoverageReport(rows, requests);
});
after(async () => { await h.close(); });

describe("DSV2-12 — trace coverage over a controlled corpus", () => {
  it("T1. served items with and without an exposure row, per serve point, from the per-request rows", () => {
    const l1 = group(report, SP.CACHE_A_L1);
    assert.deepEqual(l1.servedItems, { observed: true, value: { requests: 1, emptyRequests: 0, items: 3, withExposure: 3, withoutExposure: 0 } });
    const pde = group(report, SP.CACHE_A_L2_FRESH);
    assert.deepEqual(pde.servedItems, { observed: true, value: { requests: 1, emptyRequests: 0, items: 3, withExposure: 2, withoutExposure: 1 } },
      "the PDE page's unscored item was served and has no exposure row");
    const search = group(report, SP.SEARCH);
    assert.deepEqual(search.servedItems, { observed: true, value: { requests: 1, emptyRequests: 0, items: 2, withExposure: 0, withoutExposure: 2 } },
      "one insert lost, one exposure not read: neither is coverage");
    assert.equal(l1.exposures.withId, 3);
    assert.equal(l1.exposures.withServeId, 3);
    assert.deepEqual(l1.claimedByExposures, { requests: 1, items: 3, exposures: 3 });
    assert.deepEqual(pde.claimedByExposures, { requests: 1, items: 3, exposures: 2 });
    assert.deepEqual(l1.exposuresWithoutRequestRow, { observed: true, value: 0 });
  });

  it("T2. outcomes: on the exposure (bound by construction) and as events — bound, no id, exposure not read", () => {
    const l1 = group(report, SP.CACHE_A_L1);
    assert.deepEqual(l1.outcomes.onExposure, { tap: 1, save: 1, dismiss: 1 });
    assert.deepEqual(l1.outcomes.boundEvents, { ranking_item_opened: 1, ranking_item_saved: 1, ranking_item_hidden: 1 },
      "the claimed-id tap AND the item-lookup save both bind: the route stamps the exposure's id either way");
    const pde = group(report, SP.CACHE_A_L2_FRESH);
    assert.deepEqual(pde.outcomes.onExposure, { trip_add: 1 });
    assert.deepEqual(pde.outcomes.boundEvents, {}, "trip_add writes no analytics event — the on-row outcome is the record");
    const s = report.surfaces.find((x) => x.surface === "discovery")!;
    assert.equal(s.unbound.outcomeEventsNoId, 1, "the pre-2891 event");
    assert.equal(s.unbound.outcomeEventsExposureNotRead, 1, "Bob's tap, whose exposure is outside the rows read");
  });

  it("T3. anonymous serves are counted apart and never bind; a signed-in serve of nothing is still a request", () => {
    const s = report.surfaces.find((x) => x.surface === "discovery")!;
    assert.deepEqual(s.anonymous, { observed: true, value: { requests: 1, items: 4, byServePoint: { [String(SP.COLD_FETCH_LEGACY_RANK)]: { requests: 1, items: 4 } }, bindable: "never" } });
    assert.equal(group(report, SP.COLD_FETCH_LEGACY_RANK), undefined, "no signed-in group invented for an anonymous-only serve point");
    const feed = group(report, SP.FEED);
    assert.deepEqual(feed.servedItems, { observed: true, value: { requests: 1, emptyRequests: 1, items: 0, withExposure: 0, withoutExposure: 0 } });
    assert.equal(feed.exposures.total, 0);
  });

  it("T4. versions per group and overall; unknown versions and a missing servePoint are NAMED", () => {
    const l1 = group(report, SP.CACHE_A_L1);
    assert.deepEqual(l1.versions.schema, { "1": 3 });
    assert.deepEqual(l1.versions.model, { [DISCOVERY_MODEL_VERSION]: 3 });
    const pde = group(report, SP.CACHE_A_L2_FRESH);
    assert.deepEqual(pde.versions.model, { [DISCOVERY_PDE_MODEL_VERSION]: 2, "future-model-2027": 1 });
    assert.deepEqual(pde.versions.schema, { "1": 2, "2": 1 });
    assert.equal(pde.exposures.withoutId, 1, "the future row carries no served id");
    assert.deepEqual(report.versions.unknownSchemaVersions, ["2"]);
    assert.deepEqual(report.versions.unknownModelVersions, ["future-model-2027"]);
    const unmarked = group(report, "unmarked");
    assert.equal(unmarked.exposures.total, 1);
    assert.equal(unmarked.label, "no servePoint marker");
    assert.deepEqual(report.versions.requestRowModel, { observed: true, value: { [DISCOVERY_MODEL_VERSION]: 5 } },
      "3376's model_version is the serve log's constant on EVERY request row, the PDE page's included (§55 finding)");
  });

  it("T5. without the per-request table: UNOBSERVED (null), never 0; the exposures' own denominator still reports", () => {
    const r = buildTraceCoverageReport(rows, null);
    assert.equal(r.serveRequestsObserved, false);
    const l1 = group(r, SP.CACHE_A_L1);
    assert.equal(l1.servedItems.observed, false);
    assert.equal(l1.servedItems.value, null);
    assert.equal(l1.exposuresWithoutRequestRow.value, null);
    assert.deepEqual(l1.claimedByExposures, { requests: 1, items: 3, exposures: 3 });
    const s = r.surfaces.find((x) => x.surface === "discovery")!;
    assert.equal(s.anonymous.observed, false);
    assert.equal(s.anonymous.value, null);
    assert.equal(r.versions.requestRowModel.value, null);
    assert.equal(group(r, SP.FEED), undefined, "an empty serve is visible ONLY through the per-request table");
    const text = renderTraceCoverageReport(r);
    assert.match(text, /NOT READ/);
    assert.match(text, /anonymous serves: unobserved/);
    // An empty window is an absence of evidence, never "0% coverage".
    const empty = renderTraceCoverageReport(buildTraceCoverageReport([], []));
    assert.match(empty, /NOTHING OBSERVED/);
    assert.doesNotMatch(empty, /0\.0%/);
  });

  it("T6. attention rows are counted by kind, bound or not — never as outcomes", () => {
    assert.deepEqual(group(report, SP.CACHE_A_L1).attention, { active: 1, idle: 1 });
    assert.deepEqual(group(report, SP.CACHE_A_L2_FRESH).attention, { passive_foreground: 1 });
    const withOrphan = [...rows, { ...rows.find((r) => r.event_type === "place_dwell"), id: "orphan-dwell", features: { recommendationId: "ZZZZZZZZZZZZZZZZZZZZZZ" } }];
    const s = buildTraceCoverageReport(withOrphan, requests).surfaces.find((x) => x.surface === "discovery")!;
    assert.equal(s.unbound.attentionExposureNotRead, 1);
    assert.equal(s.unbound.outcomeEventsNoId + s.unbound.outcomeEventsExposureNotRead, 2, "attention never enters the outcome counts");
  });

  it("T7. rows outside the trace are counted by event_type, not dropped", () => {
    const s = report.surfaces.find((x) => x.surface === "discovery")!;
    assert.deepEqual(s.notTraceRows, { ranking_item_scored: 1 });
  });
});
