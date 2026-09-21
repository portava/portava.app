/**
 * The Map gateway consumes Discovery's candidate projection — Map §20,
 * census-discovery A25 / decision D10.
 *
 * WHAT WAS WRONG
 * ==============
 * Discovery built `lib/discoveryCandidate.readDiscoveryCandidatesForViewer`,
 * the privacy-complete, write-free, does-not-retrieve reader Map §20 says each
 * owner must expose — and the only callers in the tree were its own definition
 * and its own unit test. census-discovery graded A25 "reader exists, consumer
 * absent" and filed the missing call site as D10 against the Map lane, because
 * the call site belongs to GET /api/map/projection.
 *
 * WHAT THESE TESTS PIN
 * ====================
 *  1. THE READER IS ACTUALLY CALLED — not a lookalike re-derived inside the
 *     Map. Two independent witnesses, because either alone is weak: the
 *     gateway's source names it (a call site cannot be faked away), and the
 *     served projection carries `freshness.servedFrom: "map_read"`, the
 *     reader's OWN default serve label, which nothing else in the Map produces.
 *  2. A SUCCESSFUL PROJECTION IS SERVED, on the place object, additively.
 *  3. AN UNREADABLE READ IS NOT AN EMPTY ANSWER. `11` §9 via
 *     lib/discoveryRefusal: a failure must not masquerade as success. A page
 *     where the reader threw must not be byte-indistinguishable from a page
 *     where it ran and had nothing to add.
 *  4. THE CONTROL. With `discovery_candidate_projection_enabled` off or absent
 *     — production's state, and the state migration 2361 seeds — the gateway
 *     serves EXACTLY what it served before this existed, proven by comparing
 *     the two responses field by field rather than by asserting an absence.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx --test src/test/mapDiscoveryCandidateConsumer.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
  _clearCityZoneCache,
} from "../routes/mapProjection.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { type MapObject } from "../lib/mapObjects.js";
import { PLACE_PRIVACY_CLASS, discoveryServedIdFor } from "../lib/mapProjectPlace.js";
import {
  DISCOVERY_CANDIDATE_PROJECTION_FLAG,
  invalidateCandidateProjectionFlagCache,
  type CandidateReadOutcome,
  type DiscoveryCandidate,
} from "../lib/discoveryCandidate.js";
import {
  ELIGIBLE_PRIVACY_CLASS,
  foldDiscoveryCandidates,
  refusedDiscoveryCandidates,
  selectDiscoveryCandidateRows,
  type MapDiscoveryPlaceRow,
} from "../lib/mapDiscoveryCandidates.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const VIEWER = "4c4c4c4c-1111-4111-8111-4c4c4c4c4c4c";
const TOKEN = "map-discovery-candidate-token";
const SPOT = { lat: 16.0678, lng: 108.2208 };
const BBOX_STR = "108.0,15.9,108.4,16.2";
const PLACE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PLACE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function placeRow(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    primary_category: "night_market",
    city: "Da Nang",
    neighborhood: "Hai Chau",
    country_code: "VN",
    latitude: SPOT.lat,
    longitude: SPOT.lng,
    status: "active",
    merged_into_place_id: null,
    ...over,
  };
}

const ON = (flag: string) => ({ flag, enabled: true });
const OFF = (flag: string) => ({ flag, enabled: false });

/** A gateway world serving canonical places and nothing else. */
function world(flags: { flag: string; enabled: boolean }[] = [], over: FakeState = {}): FakeState {
  return {
    feature_flags: [ON("map_projection_enabled"), ...flags],
    blocks: [],
    protected_zones: [],
    geo_zones: [],
    places: [placeRow(PLACE_A, "Han Market"), placeRow(PLACE_B, "Con Market")],
    intel_live_promoted_scopes: [],
    intel_state_snapshots: [],
    ...over,
  };
}

/** A synthetic served place object, shaped exactly as lib/mapProjectPlace emits one. */
function placeObject(id: string, over: Partial<MapObject> = {}): MapObject {
  return {
    id: `place:${id}`,
    kind: "place",
    geometry: { type: "Point", coordinates: [SPOT.lng, SPOT.lat] },
    title: "Han Market",
    privacyClass: PLACE_PRIVACY_CLASS,
    renderingPriority: 50,
    distanceKm: 1.5,
    payload: {
      category: "night_market",
      city: "Da Nang",
      neighborhood: "Hai Chau",
      countryCode: "VN",
      canonicalPlaceId: id,
      discoveryId: discoveryServedIdFor(id),
    },
    ...over,
  } as MapObject;
}

function candidateFor(id: string): DiscoveryCandidate {
  return {
    id: discoveryServedIdFor(id),
    whyNow: null,
    whyForUser: ["categoryAffinity"],
    rankedBy: "pde",
    confidence: 0.8,
    freshness: { state: "unknown", ageMs: null, servedFrom: "map_read" },
    truthClass: "corroborated",
    provenance: null,
    reasons: [],
  };
}

function outcomeFor(ids: string[], over: Partial<CandidateReadOutcome<MapDiscoveryPlaceRow>> = {}) {
  return {
    candidates: ids.map((id) => ({
      place: { id: discoveryServedIdFor(id) } as MapDiscoveryPlaceRow,
      candidate: candidateFor(id),
    })),
    rankedBy: "pde" as const,
    suppressedWrites: 3,
    ...over,
  } satisfies CandidateReadOutcome<MapDiscoveryPlaceRow>;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The call site — D10, in the gateway's own file
// ─────────────────────────────────────────────────────────────────────────────

describe("A. the gateway names Discovery's reader", () => {
  const gateway = readFileSync(
    fileURLToPath(new URL("../routes/mapProjection.ts", import.meta.url)),
    "utf8",
  );

  it("routes/mapProjection.ts imports readDiscoveryCandidatesForViewer from lib/discoveryCandidate", () => {
    assert.match(
      gateway,
      /readDiscoveryCandidatesForViewer[\s\S]{0,200}from "\.\.\/lib\/discoveryCandidate\.js"/,
      "D10: the Map gateway must import Discovery's owner reader, not re-derive candidate relevance",
    );
  });

  it("routes/mapProjection.ts CALLS it — an import alone is not a consumer", () => {
    assert.match(
      gateway,
      /await readDiscoveryCandidatesForViewer\(/,
      "A25 is closed by a call site, not by a reference",
    );
  });

  it("the call is guarded, so a throwing reader cannot take the whole gateway down", () => {
    const at = gateway.indexOf("await readDiscoveryCandidatesForViewer(");
    assert.ok(at > 0);
    const around = gateway.slice(Math.max(0, at - 400), at);
    assert.match(around, /try\s*\{/, "the reader call must sit inside a try, per the fail-closed report");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Through the real route
// ─────────────────────────────────────────────────────────────────────────────

describe("B. GET /api/map/projection serves Discovery's candidate projection", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
    _clearCityZoneCache();
    _clearPromotedScopeCache();
    invalidateCandidateProjectionFlagCache();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = null;
    invalidateCandidateProjectionFlagCache();
  });

  async function serve(state: FakeState, query: string) {
    app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId: VIEWER });
    return app.projection(query);
  }

  const places = (body: any): MapObject[] =>
    (body.objects as MapObject[]).filter((o) => o.kind === "place");

  it("flag ON: every served place carries an additive payload.candidate, and the report says the layer was complete", async () => {
    const r = await serve(
      world([ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]),
      `bbox=${BBOX_STR}&zoom=14&kinds=place`,
    );
    assert.equal(r.status, 200);
    const served = places(r.body);
    assert.equal(served.length, 2, "the fixture's places must actually flow");

    for (const p of served) {
      const c = (p.payload as any).candidate as DiscoveryCandidate;
      assert.ok(c, `${p.id} must carry a candidate projection`);
      assert.equal(c.id, (p.payload as any).discoveryId, "the projection keys on the Discovery served id");
      assert.equal(
        c.freshness.servedFrom,
        "map_read",
        "the reader's OWN serve label — proof readDiscoveryCandidatesForViewer produced this",
      );
      assert.equal(c.truthClass, "corroborated", "a canonical places row carries canonicalPlaceId");
      assert.equal(c.confidence, 0.8, "the corroborated class prior, unchanged by the Map");
      assert.equal(c.whyNow, null, "no live producer ran on this read — absent, never an empty endorsement");
      assert.equal(c.rankedBy, "pde", "an authenticated viewer is ranked per-user");
      assert.equal(c.provenance, null);
    }

    const report = r.body.discoveryCandidates;
    assert.equal(report.refusal, null);
    assert.equal(report.coverage, null, "no refusal ⇒ nothing whose completeness is in doubt");
    assert.equal(report.servedPlaces, 2);
    assert.equal(report.eligible, 2);
    assert.equal(report.projected, 2);
    assert.equal(report.rankedBy, "pde");
    assert.ok(report.suppressedWrites >= 0, "the no-write interception count is reported");
  });

  it("the Map keeps its own §31 order and its own payload — the projection is ADDITIVE", async () => {
    const r = await serve(
      world([ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]),
      `bbox=${BBOX_STR}&zoom=14&kinds=place`,
    );
    const p = places(r.body)[0];
    assert.deepEqual(
      Object.keys(p.payload as object).sort(),
      ["candidate", "canonicalPlaceId", "category", "city", "countryCode", "discoveryId", "neighborhood"],
      "exactly one key is added, and no place field is replaced",
    );
    assert.equal("truthClass" in p, false, "the top-level Sensing §5.1 stamp stays behind its own flag");
    assert.equal("confidence" in p, false);
    assert.equal(p.privacyClass, PLACE_PRIVACY_CLASS);
  });

  it("flag OFF (migration 2361's seed): a NAMED refusal, not a silently empty layer", async () => {
    const r = await serve(
      world([OFF(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]),
      `bbox=${BBOX_STR}&zoom=14&kinds=place`,
    );
    const served = places(r.body);
    assert.equal(served.length, 2);
    for (const p of served) {
      assert.equal("candidate" in (p.payload as object), false, "nothing is attached with the gate shut");
    }
    const report = r.body.discoveryCandidates;
    assert.equal(report.refusal, "flag_off", "Discovery's gate is respected, not routed around");
    assert.equal(report.coverage, "nothing", "the empty candidate set is a consequence of the refusal, not a result");
    assert.equal(report.servedPlaces, 2);
    assert.equal(report.eligible, 2, "the places WERE eligible — only the gate stopped the read");
    assert.equal(report.projected, 0);
  });

  it("CONTROL — flag ABSENT (production) is identical to flag FALSE, and both are the pre-existing response", async () => {
    const absent = await serve(world(), `bbox=${BBOX_STR}&zoom=14&kinds=place`);
    await app!.close(); app = null;
    invalidateCandidateProjectionFlagCache();
    const off = await serve(
      world([OFF(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]),
      `bbox=${BBOX_STR}&zoom=14&kinds=place`,
    );
    const strip = (body: any) => ({ ...body, generatedAt: null });
    assert.deepEqual(strip(off.body), strip(absent.body), "absent and FALSE must be the same answer");

    // And that answer is the one the gateway gave before this layer existed:
    // the whole response minus the new report key.
    const { discoveryCandidates, ...legacy } = strip(absent.body) as Record<string, unknown>;
    assert.ok(discoveryCandidates, "the report itself is always present so its absence is never the signal");
    assert.equal(
      JSON.stringify(legacy).includes('"candidate"'),
      false,
      "with the gate shut not one byte of candidate projection reaches the wire",
    );
  });

  it("the layer reports null when no place was requested — not a zeroed report that claims it looked", async () => {
    const r = await serve(
      world([ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]),
      `bbox=${BBOX_STR}&zoom=14&kinds=event`,
    );
    assert.equal(r.body.discoveryCandidates, null);
  });

  it("the gateway's own flag still governs: map_projection_enabled off ⇒ no report at all", async () => {
    const r = await serve(
      world([OFF("map_projection_enabled"), ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]),
      `bbox=${BBOX_STR}&zoom=14&kinds=place`,
    );
    assert.equal(r.body.enabled, false);
    assert.deepEqual(r.body.objects, []);
    assert.equal(r.body.discoveryCandidates ?? null, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The fold — what the response says when the answer does not arrive
// ─────────────────────────────────────────────────────────────────────────────

describe("C. an unreadable read must not render as a complete empty answer", () => {
  const page = [placeObject(PLACE_A), placeObject(PLACE_B)];

  it("the read threw: the page is returned UNTOUCHED and the report names the failure", () => {
    const selection = selectDiscoveryCandidateRows(page);
    const out = foldDiscoveryCandidates(page, selection, null);

    assert.equal(out.objects, page, "no copy, no partial attachment — the page is exactly what it was");
    for (const o of out.objects) assert.equal("candidate" in (o.payload as object), false);
    assert.equal(out.report.refusal, "read_threw");
    assert.equal(out.report.coverage, "nothing");
    assert.equal(out.report.eligible, 2);
    assert.equal(out.report.projected, 0);
    assert.equal(out.report.rankedBy, "none");
  });

  it("a page with a failed read is DISTINGUISHABLE from a page the reader completed with nothing to add", () => {
    const selection = selectDiscoveryCandidateRows(page);
    const threw = foldDiscoveryCandidates(page, selection, null).report;
    const ranAndEmpty = foldDiscoveryCandidates(
      page,
      selection,
      { candidates: [], rankedBy: "none", suppressedWrites: 0 },
    ).report;
    assert.notDeepEqual(
      threw,
      ranAndEmpty,
      "`11` §9: a failure must not be byte-identical to a successful empty result",
    );
    assert.equal(threw.refusal, "read_threw");
    assert.equal(ranAndEmpty.refusal, "incomplete_projection");
  });

  it("a SHORT answer is partial, not complete: what came back is real, what is missing is not evidence of absence", () => {
    const selection = selectDiscoveryCandidateRows(page);
    const out = foldDiscoveryCandidates(page, selection, outcomeFor([PLACE_A]));

    assert.equal(out.report.refusal, "incomplete_projection");
    assert.equal(out.report.coverage, "partial");
    assert.equal(out.report.eligible, 2);
    assert.equal(out.report.projected, 1);
    const a = out.objects.find((o) => o.id === `place:${PLACE_A}`)!;
    const b = out.objects.find((o) => o.id === `place:${PLACE_B}`)!;
    assert.ok("candidate" in (a.payload as object), "the row that came back IS a result");
    assert.equal("candidate" in (b.payload as object), false, "the row that did not is left alone");
  });

  it("a complete answer carries no refusal and no coverage, and copies rather than mutates", () => {
    const selection = selectDiscoveryCandidateRows(page);
    const out = foldDiscoveryCandidates(page, selection, outcomeFor([PLACE_A, PLACE_B]));

    assert.equal(out.report.refusal, null);
    assert.equal(out.report.coverage, null);
    assert.equal(out.report.projected, 2);
    assert.equal(out.report.suppressedWrites, 3, "the reader's no-write count is carried, not recomputed");
    for (const o of page) {
      assert.equal("candidate" in (o.payload as object), false, "the caller's objects must not be mutated");
    }
  });

  it("a projection for a row the Map never sent is not folded in, and cannot hide a shortfall", () => {
    const selection = selectDiscoveryCandidateRows(page);
    const out = foldDiscoveryCandidates(
      page,
      selection,
      outcomeFor(["cccccccc-3333-4333-8333-cccccccccccc"]),
    );
    assert.equal(out.report.projected, 0);
    assert.equal(out.report.coverage, "nothing");
    assert.equal(out.objects, page);
  });

  it("refusedDiscoveryCandidates reports the counts it DID establish, and zero for the rest", () => {
    const selection = selectDiscoveryCandidateRows(page);
    const report = refusedDiscoveryCandidates("flag_off", selection);
    assert.deepEqual(report, {
      refusal: "flag_off",
      coverage: "nothing",
      servedPlaces: 2,
      eligible: 2,
      projected: 0,
      rankedBy: "none",
      suppressedWrites: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Eligibility — §24 is upstream of this layer and stays that way
// ─────────────────────────────────────────────────────────────────────────────

describe("D. which served objects may be asked about", () => {
  it("a §24-COARSENED place is not eligible: the projection would restate the fields the gate deleted", () => {
    const coarsened = placeObject(PLACE_A, { privacyClass: "approximate" as MapObject["privacyClass"] });
    const selection = selectDiscoveryCandidateRows([coarsened, placeObject(PLACE_B)]);
    assert.equal(selection.servedPlaces, 2, "it is COUNTED, never silently dropped");
    assert.equal(selection.rows.length, 1);
    assert.equal(selection.rows[0].id, discoveryServedIdFor(PLACE_B));
    assert.equal(ELIGIBLE_PRIVACY_CLASS, PLACE_PRIVACY_CLASS);
  });

  it("non-place kinds and aggregated cells are left alone entirely", () => {
    const zone = { ...placeObject(PLACE_A), id: "zone:1", kind: "activity_zone" } as MapObject;
    const selection = selectDiscoveryCandidateRows([zone, placeObject(PLACE_B)]);
    assert.equal(selection.servedPlaces, 1);
    assert.equal(selection.rows.length, 1);
  });

  it("a place with no Discovery served id is not eligible — the reader keys on that id space", () => {
    const noId = placeObject(PLACE_A, { payload: { canonicalPlaceId: PLACE_A } as unknown } as Partial<MapObject>);
    const selection = selectDiscoveryCandidateRows([noId]);
    assert.equal(selection.servedPlaces, 1);
    assert.equal(selection.rows.length, 0);
  });

  it("the reader row carries the DISCOVERY served id, the canonical id and the ranker's distance", () => {
    const selection = selectDiscoveryCandidateRows([placeObject(PLACE_A)]);
    const row = selection.rows[0];
    assert.equal(row.id, `db/${PLACE_A}`, "db/<places.id>, not the Map object id and not a bare uuid");
    assert.equal(row.canonicalPlaceId, PLACE_A);
    assert.equal(row.category, "night_market");
    assert.equal(row.distanceKm, 1.5);
    assert.equal(row.lat, SPOT.lat);
    assert.equal(row.lng, SPOT.lng);
    assert.equal(row.savedCount, undefined, "a feature nobody measured is absent, never defaulted to 0");
  });

  it("one city when every eligible place agrees; null when the viewport straddles two", () => {
    assert.equal(selectDiscoveryCandidateRows([placeObject(PLACE_A)]).city, "da nang");
    const straddle = [
      placeObject(PLACE_A),
      placeObject(PLACE_B, { payload: { ...(placeObject(PLACE_B).payload as object), city: "Hoi An" } as unknown } as Partial<MapObject>),
    ];
    assert.equal(selectDiscoveryCandidateRows(straddle).city, null);
  });

  it("an empty page asks nothing", () => {
    const selection = selectDiscoveryCandidateRows([]);
    assert.deepEqual(selection.rows, []);
    assert.equal(selection.servedPlaces, 0);
    assert.equal(selection.city, null);
  });
});
