/**
 * memory producer (Map spec §6 "Gold marker = Saved / Passport / Memory", §16
 * Memories layer, §20 Memory owns personal projection and history).
 *
 * The read is the owner's own §12 "What Portava Remembers" boundary
 * (memory_remembers_for_user + the TS defence-in-depth gate + user
 * suppressions), placed on the venue's public geography and COARSENED.
 *
 * WHAT IS PINNED HERE
 *   privacy class      approximate — the §6 ring, never the venue pin
 *   coarse geometry    the raw venue coordinate never survives the projector
 *   isServable         a projected pin clears the last gate before the wire
 *   protection gate    memory is AMBIENT PRESENCE: suppressed even in a
 *                      coarsen-class zone (the association is the disclosure)
 *   TTL                a memory past valid_to, a forgotten memory and a
 *                      sensitive one never leave the producer
 *   owner only         the RPC is called with the SESSION id, never a query
 *                      parameter; the flag off means no read at all
 *
 * Fixtures are derived rows exactly as memory_remembers_for_user returns them
 * (migration 2213's RETURNS TABLE), mapped by the production mapper.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapMemoryProducer.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
} from "../routes/mapProjection.js";
import { makeFakeMapDb, startRouterApp, type FakeState, type ProjectionApp, type RpcCall } from "./helpers/fakeMapDb.js";
import {
  MAX_MEMORY_SUBJECTS,
  MEMORY_COARSENING,
  MEMORY_PRIVACY_CLASS,
  projectMemoryPin,
  readMemoryPins,
  type MemoryPlaceLike,
} from "../lib/mapProducers/memoryProducer.js";
import { mapDerivedRow, type RememberItem } from "../compass/PassportRemembersService.js";
import { coarsenPosition } from "../lib/mapTravelers.js";
import {
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  isServable,
  precisionRank,
  type MapObject,
} from "../lib/mapObjects.js";
import { AMBIENT_PRESENCE_KINDS, applyProtection, type ProtectedZone } from "../lib/protectedLocations.js";
import { parseBbox } from "../lib/mapProjection.js";
import type { BBox } from "../lib/mapAggregation.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const OWNER = "33333333-cccc-4ccc-8ccc-333333333333";
const MALLORY = "44444444-dddd-4ddd-8ddd-444444444444";
const TOKEN = "memory-token";
// Anchored to the real clock: the canonical mapper (mapDerivedRow) and the
// gateway route (routes/mapProjection.ts nowMs = Date.now()) both age memories
// against the wall clock, not an injected instant, so a fixed NOW would make a
// fixture that is "current" only during the minute the file was written. This
// is the same convention the other gateway-integration suites use
// (mapCrowdFlowLayer, mapProjectionLayers). Offsets are minute-scale, so the
// sub-second skew between this capture and the route's own Date.now() is inert.
const NOW = Date.now();
const BBOX_STR = "108.0,15.9,108.4,16.2";
const BBOX: BBox = parseBbox(BBOX_STR) as BBox;
const PLACE_ID = "dp-banh-mi-phuong";
/** The venue's RAW coordinate. Sentinel digits: they must never reach a pin. */
const RAW = { lat: 16.0537913, lng: 108.2246821 };
const FAR = { lat: 10.7769, lng: 106.7009 };

function iso(offsetMinutes: number): string {
  return new Date(NOW + offsetMinutes * 60_000).toISOString();
}

/** A derived row as memory_remembers_for_user returns it (2213 RETURNS TABLE). */
function derivedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    memory_type: "place",
    subject_type: "place",
    subject_id: PLACE_ID,
    content: "Saved Bánh Mì Phượng",
    confidence: 0.8,
    is_inferred: false,
    observation_count: 0,
    sensitivity: "normal",
    visibility: "private",
    state: "active",
    retention_class: "durable_fact",
    valid_from: iso(-60 * 24 * 30),
    valid_to: null,
    last_supported_at: iso(-60 * 24),
    derivation: "saved_places",
    source_event_ids: [],
    ...over,
  };
}

function place(over: Partial<MemoryPlaceLike> = {}): MemoryPlaceLike {
  return { id: PLACE_ID, name: "Bánh Mì Phượng", city: "Da Nang", lat: RAW.lat, lng: RAW.lng, ...over };
}

function remembered(over: Record<string, unknown> = {}): RememberItem {
  const item = mapDerivedRow(derivedRow(over));
  assert.ok(item, "fixture row must pass the production deny gate");
  return item as RememberItem;
}

function pin(rowOver: Record<string, unknown> = {}, placeOver: Partial<MemoryPlaceLike> = {}): MapObject {
  const p = projectMemoryPin(remembered(rowOver), place(placeOver), OWNER);
  assert.ok(p, "expected a pin");
  return p as MapObject;
}

function zone(over: Partial<ProtectedZone> & { category: string }): ProtectedZone {
  const coarse = coarsenPosition(OWNER, RAW.lat, RAW.lng, MEMORY_COARSENING);
  return {
    id: "zone-1",
    shape: "circle",
    center: { lat: coarse.lat, lng: coarse.lng },
    radiusMeters: 400,
    ...over,
  } as ProtectedZone;
}

// ── projectMemoryPin ──────────────────────────────────────────────────────────

describe("projectMemoryPin — shape", () => {
  it("is a memory at the saved-place tier, approximate, and servable", () => {
    const o = pin();
    assert.equal(o.id, "memory:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    assert.equal(o.kind, "memory");
    assert.equal(o.privacyClass, "approximate");
    assert.equal(o.privacyClass, MEMORY_PRIVACY_CLASS);
    assert.equal(o.renderingPriority, KIND_DEFAULT_PRIORITY.memory);
    assert.equal(o.renderingPriority, RENDERING_PRIORITY.saved_place);
    assert.equal(isServable(o), true);
    assert.equal(o.title, "Bánh Mì Phượng");
    assert.equal(o.subtitle, "Saved Bánh Mì Phượng");
  });

  it("the rung is below place_level — the renderer draws a ring, not a venue pin", () => {
    assert.ok(precisionRank(MEMORY_PRIVACY_CLASS) < precisionRank("place_level"));
  });

  it("geometry is COARSE: the raw venue coordinate does not survive the projector", () => {
    const o = pin();
    const expected = coarsenPosition(OWNER, RAW.lat, RAW.lng, MEMORY_COARSENING);
    assert.deepEqual(o.geometry, { type: "Point", coordinates: [expected.lng, expected.lat] });
    assert.notDeepEqual(o.geometry, { type: "Point", coordinates: [RAW.lng, RAW.lat] });
    // Not in the payload either.
    const serialized = JSON.stringify(o);
    assert.ok(!serialized.includes(String(RAW.lat)), "raw latitude leaked");
    assert.ok(!serialized.includes(String(RAW.lng)), "raw longitude leaked");
    assert.equal((o.payload as { precision: string }).precision, "area");
  });

  it("is deterministic per owner and differs between owners (per-user jitter, no shared grid point)", () => {
    const a1 = projectMemoryPin(remembered(), place(), OWNER) as MapObject;
    const a2 = projectMemoryPin(remembered(), place(), OWNER) as MapObject;
    const b = projectMemoryPin(remembered(), place(), MALLORY) as MapObject;
    assert.deepEqual(a1.geometry, a2.geometry);
    assert.notDeepEqual(a1.geometry, b.geometry);
  });

  it("history, not an observation: no observedAt, freshness, confidence, activity or trend", () => {
    const o = pin();
    assert.equal(o.observedAt, undefined);
    assert.equal(o.freshness, undefined);
    assert.equal(o.confidence, undefined);
    assert.equal(o.activity, undefined);
    assert.equal(o.trend, undefined);
    assert.equal(o.expiresAt, undefined);
  });

  it("carries the owner's own controls (forget endpoint) and the inference flag", () => {
    const p = pin({ is_inferred: true, content: "Often here late", memory_type: "semantic" }).payload as {
      isInferred: boolean; forgetEndpoint: string; memoryType: string; subjectId: string;
    };
    assert.equal(p.isInferred, true);
    assert.equal(p.forgetEndpoint, "/compass/me/passport/remembers/forget");
    assert.equal(p.memoryType, "semantic");
    assert.equal(p.subjectId, PLACE_ID);
  });

  it("only a place subject is placeable", () => {
    assert.equal(projectMemoryPin(remembered({ subject_type: "city", subject_id: "Da Nang" }), place(), OWNER), null);
    assert.equal(projectMemoryPin(remembered(), place({ lat: null, lng: null }), OWNER), null);
    assert.equal(projectMemoryPin(remembered(), place({ lat: 95 }), OWNER), null);
  });
});

// ── TTL / deny boundary ───────────────────────────────────────────────────────

describe("memory — what the boundary never lets through", () => {
  it("a memory past valid_to is denied by the production mapper (TTL)", () => {
    assert.equal(mapDerivedRow(derivedRow({ valid_to: iso(-1) })), null);
    assert.ok(mapDerivedRow(derivedRow({ valid_to: iso(60) })));
  });

  it("a forgotten / non-active / sensitive memory is denied", () => {
    assert.equal(mapDerivedRow(derivedRow({ state: "forgotten" })), null);
    assert.equal(mapDerivedRow(derivedRow({ state: "hidden" })), null);
    assert.equal(mapDerivedRow(derivedRow({ sensitivity: "sensitive" })), null);
  });
});

// ── §24 protection gate ───────────────────────────────────────────────────────

describe("memory through the §24 gate", () => {
  it("is listed as ambient presence", () => {
    assert.ok(AMBIENT_PRESENCE_KINDS.includes("memory"));
  });

  it("is SUPPRESSED inside a coarsen-class zone (medical_facility) — the association is the disclosure", () => {
    const out = applyProtection([pin()], [zone({ category: "medical_facility" })]);
    assert.equal(out.objects.length, 0);
    assert.equal(out.report.suppressed, 1);
    assert.equal(out.report.coarsened, 0);
  });

  it("is suppressed inside a suppress-class zone (shelter)", () => {
    const out = applyProtection([pin()], [zone({ category: "shelter" })]);
    assert.equal(out.objects.length, 0);
    assert.equal(out.report.suppressed, 1);
  });

  it("passes when no zone covers its coarse point", () => {
    const out = applyProtection([pin()], [zone({ category: "shelter", center: FAR })]);
    assert.equal(out.objects.length, 1);
    assert.equal(out.report.allowed, 1);
  });
});

// ── readMemoryPins ────────────────────────────────────────────────────────────

function world(over: FakeState = {}): FakeState {
  return {
    feature_flags: [{ flag: "memory_projection", enabled: true }],
    memory_feedback: [],
    discovery_places: [place()],
    ...over,
  };
}

type RpcRows = Record<string, unknown>[];

function client(state: FakeState, derived: RpcRows | { error: string } = [derivedRow()]) {
  return makeFakeMapDb(state, {
    token: TOKEN,
    userId: OWNER,
    rpc: {
      memory_remembers_for_user: (_args: Record<string, unknown>) =>
        "error" in derived && !Array.isArray(derived)
          ? { data: null, error: { message: derived.error } }
          : { data: derived, error: null },
    },
  });
}

describe("readMemoryPins — owner-only, coarse, viewport-scoped", () => {
  it("reads the OWNER's memory through the §12 boundary, with the id it was given", async () => {
    const c = client(world());
    const r = await readMemoryPins(c, OWNER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pins.length, 1);
    assert.equal(r.report.derived, 1);
    assert.equal(r.report.placeSubjects, 1);
    const calls = c.__rpcCalls as RpcCall[];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, "memory_remembers_for_user");
    assert.deepEqual(calls[0].args, { p_user_id: OWNER });
  });

  it("flag off ⇒ refuses BEFORE reading (no RPC call)", async () => {
    const c = client(world({ feature_flags: [{ flag: "memory_projection", enabled: false }] }));
    const r = await readMemoryPins(c, OWNER, { bbox: BBOX });
    assert.deepEqual(r, { ok: false, reason: "flag_off" });
    assert.equal((c.__rpcCalls as RpcCall[]).length, 0);
  });

  it("a memory read error is a refusal, not an empty layer", async () => {
    const r = await readMemoryPins(client(world(), { error: "rpc down" }), OWNER, { bbox: BBOX });
    assert.deepEqual(r, { ok: false, reason: "memory_read_failed" });
  });

  it("a venue read error is a refusal", async () => {
    const r = await readMemoryPins(
      client(world({ discovery_places: { error: { message: "down" } } })),
      OWNER,
      { bbox: BBOX },
    );
    assert.deepEqual(r, { ok: false, reason: "places_read_failed" });
  });

  it("a forgotten memory (memory_feedback kind=forget) is denied by the TS gate even if the SQL read returned it", async () => {
    const c = client(
      world({ memory_feedback: [{ user_id: OWNER, kind: "forget", subject_type: "place", subject_id: PLACE_ID, projection_id: null }] }),
    );
    const r = await readMemoryPins(c, OWNER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pins.length, 0);
    assert.equal(r.report.denied, 1);
  });

  it("an expired or sensitive row that slipped through SQL is denied here (defence in depth)", async () => {
    const c = client(world(), [derivedRow({ valid_to: iso(-1) }), derivedRow({ id: "b", sensitivity: "sensitive" })]);
    const r = await readMemoryPins(c, OWNER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pins.length, 0);
    assert.equal(r.report.denied, 2);
  });

  it("non-place subjects are not looked up or placed", async () => {
    const c = client(world(), [derivedRow({ subject_type: "city", subject_id: "Da Nang", memory_type: "episodic" })]);
    const r = await readMemoryPins(c, OWNER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pins.length, 0);
    assert.equal(r.report.placeSubjects, 0);
  });

  it("filters on the COARSE point — a venue outside the viewport is reported, not served", async () => {
    const c = client(world({ discovery_places: [place({ lat: FAR.lat, lng: FAR.lng })] }));
    const r = await readMemoryPins(c, OWNER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pins.length, 0);
    assert.equal(r.report.outsideViewport, 1);
  });

  it("a subject with no venue row is unplaced, not invented", async () => {
    const c = client(world({ discovery_places: [] }));
    const r = await readMemoryPins(c, OWNER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pins.length, 0);
    assert.equal(r.report.unplaced, 1);
  });

  it("the subject lookup is bounded and the cap is reported", async () => {
    const rows: RpcRows = Array.from({ length: MAX_MEMORY_SUBJECTS + 5 }, (_v: unknown, i: number) =>
      derivedRow({ id: `row-${i}`, subject_id: `${PLACE_ID}-${i}` }),
    );
    const c = client(world({ discovery_places: [] }), rows);
    const r = await readMemoryPins(c, OWNER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.placeSubjects, MAX_MEMORY_SUBJECTS + 5);
    assert.equal(r.report.capped, 5);
  });
});

// ── through the gateway ───────────────────────────────────────────────────────

function gatewayWorld(over: FakeState = {}): FakeState {
  return world({
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: "memory_projection", enabled: true },
    ],
    blocks: [],
    protected_zones: [],
    ...over,
  });
}

describe("memory through GET /api/map/projection", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function serve(state: FakeState, query: string, derived: RpcRows = [derivedRow()]) {
    app = await startRouterApp(mapProjectionRouter, state, {
      token: TOKEN,
      userId: OWNER,
      rpc: { memory_remembers_for_user: (_args: Record<string, unknown>) => ({ data: derived, error: null }) },
    });
    return app.projection(query);
  }

  it("arrives for the owner as an approximate gold pin, and the layer is reported", async () => {
    const r = await serve(gatewayWorld(), `bbox=${BBOX_STR}&zoom=14&kinds=memory`);
    assert.equal(r.status, 200);
    const objs = r.body.objects as MapObject[];
    assert.equal(objs.length, 1);
    assert.equal(objs[0].kind, "memory");
    assert.equal(objs[0].privacyClass, "approximate");
    assert.ok(r.body.sources.includes("memories"));
    assert.deepEqual(r.body.producers.memory, { refusal: null, collected: 1 });
    assert.ok(!JSON.stringify(r.body).includes(String(RAW.lat)), "raw latitude reached the wire");
  });

  it("reads the SESSION owner's memory — a smuggled ?user_id / p_user_id is ignored", async () => {
    const r = await serve(gatewayWorld(), `bbox=${BBOX_STR}&zoom=14&kinds=memory&user_id=${MALLORY}&p_user_id=${MALLORY}`);
    assert.equal(r.status, 200);
    const calls = (app as ProjectionApp).client.__rpcCalls as RpcCall[];
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, { p_user_id: OWNER });
  });

  it("flag off ⇒ the layer refuses and says so; nothing is read", async () => {
    const r = await serve(
      gatewayWorld({
        feature_flags: [
          { flag: "map_projection_enabled", enabled: true },
          { flag: "memory_projection", enabled: false },
        ],
      }),
      `bbox=${BBOX_STR}&zoom=14&kinds=memory`,
    );
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.producers.memory, { refusal: "flag_off", collected: 0 });
    assert.ok(!r.body.sources.includes("memories"));
    assert.equal(((app as ProjectionApp).client.__rpcCalls as RpcCall[]).length, 0);
  });

  it("is not read when the kind is not requested", async () => {
    const r = await serve(gatewayWorld(), `bbox=${BBOX_STR}&zoom=14&kinds=hidden_gem`);
    assert.equal(r.body.producers.memory, null);
    assert.equal(((app as ProjectionApp).client.__rpcCalls as RpcCall[]).length, 0);
  });

  it("is suppressed by the §24 gate inside a coarsen-class zone (ambient presence)", async () => {
    const coarse = coarsenPosition(OWNER, RAW.lat, RAW.lng, MEMORY_COARSENING);
    const r = await serve(
      gatewayWorld({
        protected_zones: [
          {
            id: "pz-1", category: "medical_facility", action: null, privacy_floor: null, shape: "circle",
            center_lat: coarse.lat, center_lng: coarse.lng, radius_meters: 400, ring: null,
            jurisdiction: null, policy_ref: null, active: true,
          },
        ],
      }),
      `bbox=${BBOX_STR}&zoom=14&kinds=memory`,
    );
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.producers.memory, { refusal: null, collected: 1 });
    assert.equal(r.body.protection.suppressed, 1);
    assert.equal(r.body.protection.coarsened, 0);
  });
});
