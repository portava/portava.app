/**
 * §10 material conflict — the readers that go STRAIGHT to intel_state_snapshots.
 *
 * THE DEFECT (audit 2026-09-05). lib/liveClaimRead selects `conflict_state` and
 * caps the served band through lib/intelConflict.capForConflict, so a materially
 * conflicted claim can never carry a Live label on the place path. TWO other
 * readers query the same table directly and did neither:
 *
 *   (a) lib/mapProducers/safetyNoticeProducer — the safety_notice layer. It
 *       selected no conflict_state and derived the band from the RAW confidence,
 *       so a `crowd.level = unsafe_density` claim that independent parties
 *       materially DISAGREE about projected onto the map at FULL band, at the top
 *       of the §31 rendering ladder. Safety data is exactly where a disputed
 *       claim must not read as certain.
 *   (b) routes/intelReadModels — GET /v1/neighborhoods/:id/pulse. It selected no
 *       conflict_state either, so a conflicted subject's PLURALITY value was
 *       folded into the neighborhood distribution as though uncontested — the
 *       silent averaging invariant §1 forbids, in an aggregate that has no way to
 *       say "reports differ".
 *
 * WHAT IS PINNED HERE
 *   one policy      both readers go through lib/intelConflict, not a second
 *                   local rule: the safety band equals capForConflict's answer
 *                   exactly, and both use normalizeConflictState's fail-closed
 *                   reading (unrecognised marker ⇒ material)
 *   never live      a materially conflicted safety claim never projects at the
 *                   live/strong band, at any confidence
 *   never removed   it is still projected (§5: a safety notice is not silently
 *                   dropped) — capped, and labelled with its conflict state
 *   never averaged  a conflicted subject contributes nothing to the pulse
 *   unchanged       'none' / 'minor' / a pre-2275 row (no column) are untouched
 *   the column IS read — the fakes ignore PostgREST projection, so the select
 *                   lists are pinned in source too
 *
 * Run:
 *   node --import tsx/esm --test src/test/intelConflictReaders.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { _setTestClient, _clearTestClient } from "../lib/http.js";
import intelReadModelsRouter from "../routes/intelReadModels.js";
import {
  SAFETY_CLAIM_LEVEL,
  SAFETY_CLAIM_TYPE,
  projectSafetyNotice,
  readSafetyNotices,
  type SafetyPlaceLike,
  type SafetySnapshotLike,
} from "../lib/mapProducers/safetyNoticeProducer.js";
import {
  capForConflict,
  MATERIAL_CONFLICT_BAND_CEILING,
  normalizeConflictState,
} from "../lib/intelConflict.js";
import { confidenceBand, CONFIDENCE_BAND_FLOOR } from "../lib/intelContracts.js";
import { computeNeighborhoodPulse, MIN_PULSE_SUBJECTS, type PulseSnapshotInput } from "../lib/intelPulse.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";
import { parseBbox } from "../lib/mapProjection.js";
import type { BBox } from "../lib/mapAggregation.js";
import type { MapObject } from "../lib/mapObjects.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const VIEWER = "55555555-eeee-4eee-8eee-555555555555";
const TOKEN = "conflict-token";
const PLACE_ID = "66666666-ffff-4fff-8fff-666666666666";
const SPOT = { lat: 16.0678, lng: 108.2208 };
const BBOX_STR = "108.0,15.9,108.4,16.2";
const BBOX: BBox = parseBbox(BBOX_STR) as BBox;
const NOW = Date.now();
/** High enough that, uncapped, the band is unambiguously the live one. */
const STRONG = 0.95;

const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

function snapshot(over: Partial<SafetySnapshotLike> = {}): SafetySnapshotLike {
  return {
    id: "snap-1",
    subject_id: PLACE_ID,
    zone_id: null,
    claim_type: SAFETY_CLAIM_TYPE,
    value: { level: SAFETY_CLAIM_LEVEL },
    confidence: STRONG,
    observed_at: iso(-3),
    expires_at: iso(27),
    privacy_eligible: true,
    conflict_state: null,
    ...over,
  };
}

function place(over: Partial<SafetyPlaceLike> = {}): SafetyPlaceLike {
  return {
    id: PLACE_ID,
    name: "Han Market",
    city: "Da Nang",
    latitude: SPOT.lat,
    longitude: SPOT.lng,
    status: "active",
    merged_into_place_id: null,
    ...over,
  };
}

function project(conflictState: unknown): MapObject {
  const o = projectSafetyNotice(snapshot({ conflict_state: conflictState }), place(), { now: NOW });
  assert.ok(o, "a current safety claim must still project");
  return o as MapObject;
}

// ── (a) the map safety layer ─────────────────────────────────────────────────

describe("safety_notice honours §10 conflict_state", () => {
  it("a MATERIAL conflict never projects at the live/strong band, however confident the row", () => {
    for (const confidence of [1, STRONG, 0.9, 0.8]) {
      const o = projectSafetyNotice(
        snapshot({ confidence, conflict_state: "material" }),
        place(),
        { now: NOW },
      );
      assert.ok(o, "the notice is capped, never dropped");
      assert.ok(
        !["live", "strong"].includes(String(o!.confidence)),
        `confidence ${confidence} projected as ${String(o!.confidence)}`,
      );
      assert.equal(o!.provenance?.confidence, o!.confidence, "provenance carries the SAME capped band");
      assert.equal((o!.payload as any).band, o!.confidence);
    }
  });

  it("the cap is lib/intelConflict's own answer — one policy, not a second local rule", () => {
    const expected = capForConflict("material", STRONG, confidenceBand(STRONG)).band;
    assert.equal(expected, MATERIAL_CONFLICT_BAND_CEILING);
    assert.equal(project("material").confidence, expected);
    // And it is a real cap: uncapped this row would band strictly higher.
    assert.ok(
      CONFIDENCE_BAND_FLOOR[confidenceBand(STRONG)] > CONFIDENCE_BAND_FLOOR[expected],
      "fixture must be strong enough that the cap actually lowers the band",
    );
  });

  it("is still PROJECTED (§5: never silently removed) and says why it is capped", () => {
    const o = project("material");
    assert.equal(o.kind, "safety_notice");
    assert.equal((o.payload as any).conflictState, "material");
    assert.equal((o.payload as any).level, SAFETY_CLAIM_LEVEL);
    // Counts-only: no cohort, no side sizes, no identities travel with the state.
    for (const forbidden of ["sides", "sidesCount", "actors", "clusters", "distinct_actors"]) {
      assert.ok(!(forbidden in (o.payload as any)), `${forbidden} must not travel with a conflict state`);
    }
  });

  it("'none', 'minor' and a pre-2275 row (absent column) are untouched", () => {
    const uncapped = confidenceBand(STRONG);
    assert.equal(project(null).confidence, uncapped);
    assert.equal(project("none").confidence, uncapped);
    assert.equal(project("minor").confidence, uncapped);
    assert.equal(project("contextualized").confidence, uncapped, "the spec's middle-state spelling is 'minor'");
    const noColumn = projectSafetyNotice(
      { ...snapshot(), conflict_state: undefined },
      place(),
      { now: NOW },
    );
    assert.equal(noColumn?.confidence, uncapped);
    assert.equal((noColumn?.payload as any).conflictState, "none");
  });

  it("an UNRECOGNISED conflict marker reads as material (fail-closed), like every other reader", () => {
    for (const marker of ["reports_differ", "MATERIAL", 7, { state: "material" }]) {
      assert.equal(normalizeConflictState(marker), "material", `${String(marker)} must fail closed`);
      const o = project(marker);
      assert.equal(o.confidence, MATERIAL_CONFLICT_BAND_CEILING);
      assert.equal((o.payload as any).conflictState, "material");
    }
  });
});

// ── (a) through the real read ────────────────────────────────────────────────

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

describe("readSafetyNotices carries the conflict state through", () => {
  it("serves a conflicted claim capped, and an agreed one at its full band", async () => {
    const state: FakeState = {
      feature_flags: LIVE_GATES_OPEN,
      intel_state_snapshots: [
        snapshot({ id: "agreed", conflict_state: "none" }),
        snapshot({ id: "disputed", conflict_state: "material" }),
      ],
      places: [place()],
      intel_live_promoted_scopes: [],
    };
    const r = await readSafetyNotices(makeFakeMapDb(state, { token: TOKEN, userId: VIEWER }), { bbox: BBOX, now: NOW });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.notices.length, 2, "both are served — a disputed crush is still a safety notice");
    const byId = new Map(r.notices.map((n: MapObject) => [n.id, n]));
    assert.equal(byId.get("safety:agreed")!.confidence, confidenceBand(STRONG));
    assert.equal(byId.get("safety:disputed")!.confidence, MATERIAL_CONFLICT_BAND_CEILING);
  });

  it("SELECTS conflict_state — the fake ignores PostgREST projection, so the column list is pinned in source", () => {
    const src = readFileSync(join(HERE, "../lib/mapProducers/safetyNoticeProducer.ts"), "utf8");
    const select = src.match(/\.select\("id, subject_id[^"]*"\)/)?.[0] ?? "";
    assert.ok(select.includes("conflict_state"), `the snapshot select must read conflict_state: ${select}`);
  });
});

// ── (b) neighborhood pulse ───────────────────────────────────────────────────

const pulseRow = (subjectId: string, level: string, over: Partial<PulseSnapshotInput> = {}): PulseSnapshotInput => ({
  subjectId,
  claimType: "crowd.level",
  value: { level },
  observedAt: iso(-5),
  ...over,
});

describe("neighborhood pulse never folds in a materially conflicted subject", () => {
  it("a conflicted subject contributes neither its value nor its head to the aggregate", () => {
    const pulse = computeNeighborhoodPulse([
      pulseRow("s1", "quiet"),
      pulseRow("s2", "quiet"),
      pulseRow("s3", "busy"),
      pulseRow("s4", "packed", { conflictState: "material" }),
    ]);
    assert.equal(pulse.exposable, true);
    assert.equal(pulse.subjectCount, 3, "the disputed subject is not counted");
    assert.deepEqual(pulse.levels, { quiet: 2, busy: 1 });
    assert.ok(!("packed" in pulse.levels), "its plurality value never enters the distribution");
  });

  it("dropping a conflicted subject can only make the k-threshold STRICTER, never looser", () => {
    const rows = [
      pulseRow("s1", "quiet"),
      pulseRow("s2", "busy"),
      pulseRow("s3", "packed", { conflictState: "material" }),
    ];
    assert.equal(MIN_PULSE_SUBJECTS, 3);
    const pulse = computeNeighborhoodPulse(rows);
    assert.equal(pulse.exposable, false);
    assert.equal(pulse.reason, "below_threshold");
    assert.deepEqual(pulse.levels, {});
  });

  it("'none' / 'minor' / an absent state still count (pre-2275 behaviour unchanged)", () => {
    const pulse = computeNeighborhoodPulse([
      pulseRow("s1", "quiet"),
      pulseRow("s2", "busy", { conflictState: "none" }),
      pulseRow("s3", "busy", { conflictState: "minor" }),
      pulseRow("s4", "packed", { conflictState: null }),
    ]);
    assert.equal(pulse.subjectCount, 4);
    assert.deepEqual(pulse.levels, { quiet: 1, busy: 2, packed: 1 });
  });

  it("an unrecognised marker is dropped too (fail-closed)", () => {
    const pulse = computeNeighborhoodPulse([
      pulseRow("s1", "quiet"),
      pulseRow("s2", "quiet"),
      pulseRow("s3", "busy"),
      pulseRow("s4", "packed", { conflictState: "who knows" }),
    ]);
    assert.equal(pulse.subjectCount, 3);
    assert.ok(!("packed" in pulse.levels));
  });
});

// ── (b) through the real HTTP route ──────────────────────────────────────────

const NEIGHBORHOOD = "An Thuong";

function pulseWorld(snapshots: Array<Record<string, unknown>>): FakeState {
  return {
    feature_flags: LIVE_GATES_OPEN,
    places: [
      { id: "p1", neighborhood: NEIGHBORHOOD },
      { id: "p2", neighborhood: NEIGHBORHOOD },
      { id: "p3", neighborhood: NEIGHBORHOOD },
      { id: "p4", neighborhood: NEIGHBORHOOD },
    ],
    intel_state_snapshots: snapshots,
  };
}

const snapRow = (subject: string, level: string, conflict: unknown = null) => ({
  subject_id: subject,
  claim_type: "crowd.level",
  value: { level },
  observed_at: iso(-5),
  privacy_eligible: true,
  expires_at: iso(30),
  conflict_state: conflict,
});

let server: http.Server | null = null;

async function getPulse(state: FakeState): Promise<{ status: number; body: any }> {
  const client = makeFakeMapDb(state, { token: TOKEN, userId: VIEWER });
  _setTestClient(client, true);
  const app = express();
  app.use(express.json());
  app.use(intelReadModelsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/neighborhoods/${encodeURIComponent(NEIGHBORHOOD)}/pulse`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
}

after(() => { _clearTestClient(); });

describe("GET /v1/neighborhoods/:id/pulse — the route reads the state, not just the aggregator", () => {
  it("excludes the conflicted subject from the served distribution", async () => {
    const r = await getPulse(pulseWorld([
      snapRow("p1", "quiet"),
      snapRow("p2", "quiet"),
      snapRow("p3", "busy"),
      snapRow("p4", "packed", "material"),
    ]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.pulse.exposable, true);
    assert.equal(r.body.pulse.subjectCount, 3);
    assert.deepEqual(r.body.pulse.levels, { quiet: 2, busy: 1 });
  });

  it("serves every agreed subject exactly as before", async () => {
    const r = await getPulse(pulseWorld([
      snapRow("p1", "quiet"),
      snapRow("p2", "quiet"),
      snapRow("p3", "busy"),
      snapRow("p4", "packed"),
    ]));
    assert.equal(r.status, 200);
    assert.equal(r.body.pulse.subjectCount, 4);
    assert.deepEqual(r.body.pulse.levels, { quiet: 2, busy: 1, packed: 1 });
  });

  it("SELECTS conflict_state — pinned in source, since the fake ignores projection", () => {
    const src = readFileSync(join(HERE, "../routes/intelReadModels.ts"), "utf8");
    const select = src.match(/\.select\("subject_id, claim_type[^"]*"\)/)?.[0] ?? "";
    assert.ok(select.includes("conflict_state"), `the pulse select must read conflict_state: ${select}`);
  });
});
