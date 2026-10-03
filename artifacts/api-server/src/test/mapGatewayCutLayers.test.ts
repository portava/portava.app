/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B7 and B8): the NOW gateway never names
 * a layer in `sources` over a read that was cut at its cap, or whose own flag could not be read.
 *
 * `sources` is how every client tells "nothing here" from "not read" (useMapEntities' unread-layers banner, the Media
 * Map's partial state). Four layers were named over a cut or an unread flag, so the client drew a cut layer as whole:
 *
 *   GC1  places: 1001 active places at a CITY-band zoom (the read takes MAX_PLACE_ROWS = 1000) aggregate to one
 *        activity_zone with no `nextCursor`; `places` was named. Now: not named, `places.truncated` stays reported.
 *   GC2  saved: 501 saves, the oldest in view (each save table is read newest-first, 500 rows) — the in-view save is
 *        dropped; `saved` was named. Now: not named, `producers.saved_place.refusal` is `saves_capped`.
 *   GC3  memories: 301 remembered places, the in-view one past MAX_MEMORY_SUBJECTS (300); `memories` was named. Now: not
 *        named, `producers.memory.refusal` is `subjects_capped`.
 *   GC4  buddies: the `rent_buddy_enabled` read FAILS; readBuddyMapPins answered `{ ok: true, pins: [] }` and `buddies`
 *        was named. Now: the reader answers `ok: false` and the layer is not named.
 *   GC5  (sweep) buddies: the bbox scan returns BUDDY_SCAN_LIMIT rows (500), so buddies past the scan were never read —
 *        not named.
 *   GC0a/b/c/d CONTROLS: the same layers one under the cap (or the flag read on) → named and drawn, the healthy body
 *        unchanged (no refusal on the producers).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, { _clearProtectedZoneCache, _clearFlowZoneCache } from "../routes/mapProjection.js";
import { makeFakeMapDb, mountRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { MAX_PLACE_ROWS } from "../lib/mapProjectPlace.js";
import { MAX_MEMORY_SUBJECTS } from "../lib/mapProducers/memoryProducer.js";
import { MAX_SAVED_PLACE_ROWS } from "../lib/mapProducers/savedPlaceProducer.js";
import { BUDDY_SCAN_LIMIT, readBuddyMapPins } from "../lib/buddyMapRead.js";
import { _clearPlaceIdBridgeCache } from "../lib/placeIdBridge.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "77777777-1111-4111-8111-7777777777b8";
const TOKEN = "r18-gc-token";
const RAW = { lat: 16.054412, lng: 108.202233 };
const FAR = { lat: 10.7769, lng: 106.7009 };
const CITY = "bbox=108.0,16.0,108.5,16.2&zoom=9";
const DISTRICT = "bbox=108.15,16.00,108.25,16.10&zoom=13";
const iso = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

function placeCluster(n: number) {
  const side = Math.ceil(Math.sqrt(n));
  return Array.from({ length: n }, (_v, i) => ({
    id: `dddddddd-0000-0000-0000-${String(i + 1).padStart(12, "0")}`, name: `Place ${i + 1}`, primary_category: "night_market",
    city: "Da Nang", neighborhood: "Hai Chau", country_code: "VN",
    latitude: RAW.lat + (i % side) * 0.0001, longitude: RAW.lng + Math.floor(i / side) * 0.0001, status: "active", merged_into_place_id: null,
  }));
}
function dpVenue(id: string, at: { lat: number; lng: number }) {
  return { id, name: `Venue ${id}`, city: "Da Nang", neighborhood: "x", primary_category: "cafe", lat: at.lat, lng: at.lng, canonical_location_id: null };
}
/** `n` saves: the newest n-1 elsewhere, the OLDEST one in view (so a read that takes the newest cap drops it). */
function savesWithOldestInView(n: number) {
  const saves = Array.from({ length: n }, (_v, i) => ({ user_id: VIEWER, place_id: i === n - 1 ? "dp-in-view" : `dp-far-${i}`, saved_at: iso(-(i + 1)) }));
  const venues = [...Array.from({ length: n - 1 }, (_v, i) => dpVenue(`dp-far-${i}`, FAR)), dpVenue("dp-in-view", RAW)];
  return { discovery_place_saves: saves, discovery_places: venues };
}
function derivedRow(i: number, subject: string) {
  return {
    id: `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, "0")}`, memory_type: "place", subject_type: "place", subject_id: subject,
    content: `Remembered ${subject}`, confidence: 0.8, is_inferred: false, observation_count: 0, sensitivity: "normal", visibility: "private",
    state: "active", retention_class: "durable_fact", valid_from: iso(-60 * 24 * 30), valid_to: null, last_supported_at: iso(-60 * 24),
    derivation: "saved_places", source_event_ids: [],
  };
}
/** `n` remembered places, the in-view one LAST (past the subject cap when n > MAX_MEMORY_SUBJECTS). */
function memoriesWithLastInView(n: number) {
  const rows = Array.from({ length: n }, (_v, i) => derivedRow(i, i === n - 1 ? "dp-mem-in-view" : `dp-mem-far-${i}`));
  const venues = [...Array.from({ length: n - 1 }, (_v, i) => ({ id: `dp-mem-far-${i}`, name: `Far ${i}`, city: "HCMC", lat: FAR.lat, lng: FAR.lng })), { id: "dp-mem-in-view", name: "In view", city: "Da Nang", lat: RAW.lat, lng: RAW.lng }];
  return { rows, venues };
}
function buddy(i: number) {
  return {
    id: `bb-${i}`, user_id: `buddy-user-${i}`, display_name: `Buddy ${i}`, city: "Da Nang", country: "VN", status: "active", admin_status: "active",
    verified: true, languages: ["en"], categories: ["food"], hourly_rate_usd: "20", review_count: 1000 - i, average_rating: "4.8",
    meetup_base_lat: RAW.lat, meetup_base_lng: RAW.lng, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
    profiles: { verification_level: "id_verified" },
  };
}

const FLAGS = [
  { flag: "map_projection_enabled", enabled: true },
  { flag: "memory_projection", enabled: true },
  { flag: "rent_buddy_enabled", enabled: true },
];
function world(over: FakeState = {}): FakeState {
  return {
    feature_flags: FLAGS, blocks: [], protected_zones: [], places: [], intel_live_promoted_scopes: [], intel_state_snapshots: [],
    saved_places: [], discovery_place_saves: [], wishlist_places: [], discovery_places: [], memory_feedback: [], rent_buddy_profiles: [],
    ...over,
  };
}

let app: ProjectionApp | null = null;
beforeEach(() => { _clearProtectedZoneCache(); _clearFlowZoneCache(); _clearPlaceIdBridgeCache(); _clearPromotedScopeCache(); _resetRateLimit(); });
afterEach(async () => { if (app) await app.close(); app = null; });

/** A client whose read of ONE flag row fails (a statement timeout), every other read healthy. */
function failingFlag(client: any, failFlag: string): any {
  const from = client.from;
  client.from = (t: string) => {
    const q = from(t);
    if (t !== "feature_flags") return q;
    const eq = q.eq;
    q.eq = (col: string, val: unknown) => {
      if (col === "flag" && val === failFlag) {
        const fail: any = {
          select: () => fail, eq: () => fail, limit: () => fail,
          maybeSingle: () => Promise.resolve({ data: null, error: { code: "57014", message: "statement timeout" } }),
          single: () => fail.maybeSingle(), then: (r: any, j: any) => fail.maybeSingle().then(r, j),
        };
        return fail;
      }
      return eq(col, val);
    };
    return q;
  };
  return client;
}

async function serve(state: FakeState, query: string, opts: { memories?: any[]; failFlag?: string } = {}) {
  let client: any = makeFakeMapDb(state, { token: TOKEN, userId: VIEWER, rpc: { memory_remembers_for_user: () => ({ data: opts.memories ?? [], error: null }) } });
  if (opts.failFlag) client = failingFlag(client, opts.failFlag);
  app = await mountRouterApp(mapProjectionRouter, client, { token: TOKEN, userId: VIEWER });
  const r = await app.projection(query);
  return { ...r, seen: JSON.stringify({ status: r.status, sources: r.body.sources, nextCursor: r.body.nextCursor, total: r.body.total, kinds: (r.body.objects ?? []).map((o: any) => `${o.kind}${o.count != null ? `(${o.count})` : ""}`).slice(0, 5), places: r.body.places, producers: r.body.producers }) };
}
/** The client's rule (useMapEntities.unreadOnGateway / mediaMapGatewayPartial): named and not paged ⇒ whole. */
const saidWhole = (body: any, source: string) => body.sources.includes(source) && body.nextCursor == null;

describe("census-discovery §115 (B7, B8): the NOW gateway names no cut or flag-unread layer", () => {
  it("GC0a CONTROL: 999 places at a city zoom → named, not truncated", async () => {
    const r = await serve(world({ places: placeCluster(MAX_PLACE_ROWS - 1) }), `${CITY}&kinds=place`);
    assert.equal(r.status, 200, r.seen);
    assert.ok(saidWhole(r.body, "places"), r.seen);
    assert.equal(r.body.places.truncated, false, r.seen);
  });
  it("GC1 1001 places at a city zoom (the read takes 1000) → `places` not named; the cut is reported", async () => {
    const r = await serve(world({ places: placeCluster(MAX_PLACE_ROWS + 1) }), `${CITY}&kinds=place`);
    assert.equal(r.status, 200, r.seen);
    assert.equal(r.body.places?.truncated, true, r.seen);
    assert.ok(!r.body.sources.includes("places"), `a cut places read named whole: ${r.seen}`);
  });
  it("GC0b CONTROL: 499 saves, the oldest in view → drawn, named, no refusal", async () => {
    const r = await serve(world(savesWithOldestInView(MAX_SAVED_PLACE_ROWS - 1)), `${DISTRICT}&kinds=saved_place`);
    assert.equal(r.body.objects.filter((o: any) => o.kind === "saved_place").length, 1, r.seen);
    assert.ok(saidWhole(r.body, "saved"), r.seen);
    assert.equal(r.body.producers.saved_place.refusal, null, r.seen);
  });
  it("GC2 501 saves, the oldest in view (the read takes 500) → `saved` not named; refusal saves_capped", async () => {
    const r = await serve(world(savesWithOldestInView(MAX_SAVED_PLACE_ROWS + 1)), `${DISTRICT}&kinds=saved_place`);
    assert.equal(r.body.objects.filter((o: any) => o.kind === "saved_place").length, 0, r.seen);
    assert.ok(!r.body.sources.includes("saved"), `a cut saved read named whole: ${r.seen}`);
    assert.equal(r.body.producers.saved_place.refusal, "saves_capped", r.seen);
  });
  it("GC0c CONTROL: 300 remembered places, the in-view one last → drawn, named, no refusal", async () => {
    const m = memoriesWithLastInView(MAX_MEMORY_SUBJECTS);
    const r = await serve(world({ discovery_places: m.venues }), `${DISTRICT}&kinds=memory`, { memories: m.rows });
    assert.equal(r.body.objects.filter((o: any) => o.kind === "memory").length, 1, r.seen);
    assert.ok(saidWhole(r.body, "memories"), r.seen);
    assert.equal(r.body.producers.memory.refusal, null, r.seen);
  });
  it("GC3 301 remembered places, the in-view one past the cap → `memories` not named; refusal subjects_capped", async () => {
    const m = memoriesWithLastInView(MAX_MEMORY_SUBJECTS + 1);
    const r = await serve(world({ discovery_places: m.venues }), `${DISTRICT}&kinds=memory`, { memories: m.rows });
    assert.equal(r.body.objects.filter((o: any) => o.kind === "memory").length, 0, r.seen);
    assert.ok(!r.body.sources.includes("memories"), `a cut memory read named whole: ${r.seen}`);
    assert.equal(r.body.producers.memory.refusal, "subjects_capped", r.seen);
  });
  it("GC0d CONTROL: the buddy flag read (on), no buddies → named (a whole empty read)", async () => {
    const r = await serve(world(), `${DISTRICT}&kinds=buddy_zone`);
    assert.ok(saidWhole(r.body, "buddies"), r.seen);
  });
  it("GC4 the rent_buddy_enabled read FAILS → `buddies` not named", async () => {
    const r = await serve(world(), `${DISTRICT}&kinds=buddy_zone`, { failFlag: "rent_buddy_enabled" });
    assert.equal(r.status, 200, r.seen);
    assert.ok(!r.body.sources.includes("buddies"), `an unread flag named as a whole empty layer: ${r.seen}`);
  });
  it("GC4b the reader: an unread rent_buddy_enabled is ok:false (stage flag); a flag read off is a whole empty read", async () => {
    const unread = await readBuddyMapPins(failingFlag(makeFakeMapDb(world(), { token: TOKEN, userId: VIEWER }), "rent_buddy_enabled"), VIEWER, { lat: RAW.lat, lng: RAW.lng, radiusKm: 5, blockedSet: new Set() });
    assert.equal(unread.ok, false, JSON.stringify(unread));
    assert.equal(!unread.ok && unread.stage, "flag");
    const off = await readBuddyMapPins(makeFakeMapDb(world({ feature_flags: [{ flag: "rent_buddy_enabled", enabled: false }] }), { token: TOKEN, userId: VIEWER }), VIEWER, { lat: RAW.lat, lng: RAW.lng, radiusKm: 5, blockedSet: new Set() });
    assert.deepEqual(off, { ok: true, pins: [] });
    const noBlocks = await readBuddyMapPins(makeFakeMapDb(world(), { token: TOKEN, userId: VIEWER }), VIEWER, { lat: RAW.lat, lng: RAW.lng, radiusKm: 5, blockedSet: null });
    assert.equal(noBlocks.ok, false, `an unknown block set is not an empty marketplace: ${JSON.stringify(noBlocks)}`);
  });
  it("GC5 (sweep) the buddy scan returns BUDDY_SCAN_LIMIT rows → the read is cut: `buddies` not named", async () => {
    const r = await serve(world({ rent_buddy_profiles: Array.from({ length: BUDDY_SCAN_LIMIT + 1 }, (_v, i) => buddy(i)) }), `${DISTRICT}&kinds=buddy_zone`);
    assert.equal(r.status, 200, r.seen);
    assert.ok(!r.body.sources.includes("buddies"), `a cut buddy scan named whole: ${r.seen}`);
  });
  it("GC5a (sweep) the reader: a bbox scan that fills BUDDY_SCAN_LIMIT is capped, even when every pin fits", async () => {
    const db = makeFakeMapDb(world({ rent_buddy_profiles: Array.from({ length: BUDDY_SCAN_LIMIT + 1 }, (_v, i) => buddy(i)) }), { token: TOKEN, userId: VIEWER });
    const read = await readBuddyMapPins(db, VIEWER, { lat: RAW.lat, lng: RAW.lng, radiusKm: 5, blockedSet: new Set(), maxPins: 10_000 });
    assert.ok(read.ok && read.pins.length === BUDDY_SCAN_LIMIT, JSON.stringify({ ok: read.ok }));
    assert.equal(read.ok && read.capped, true);
  });
  it("GC5b (sweep) the reader: rows past the pin cap are never read — capped, though the scan was not", async () => {
    const db = makeFakeMapDb(world({ rent_buddy_profiles: [buddy(1), buddy(2), buddy(3)] }), { token: TOKEN, userId: VIEWER });
    const read = await readBuddyMapPins(db, VIEWER, { lat: RAW.lat, lng: RAW.lng, radiusKm: 5, blockedSet: new Set(), maxPins: 2 });
    assert.ok(read.ok && read.pins.length === 2);
    assert.equal(read.ok && read.capped, true);
    const whole = await readBuddyMapPins(db, VIEWER, { lat: RAW.lat, lng: RAW.lng, radiusKm: 5, blockedSet: new Set(), maxPins: 3 });
    assert.deepEqual(whole.ok && Object.keys(whole).sort(), ["ok", "pins"], "a whole read carries no cut mark");
  });
  it("GC5c CONTROL: fewer buddies than the scan cap → named and drawn", async () => {
    const r = await serve(world({ rent_buddy_profiles: [buddy(1), buddy(2)] }), `${DISTRICT}&kinds=buddy_zone`);
    assert.ok(saidWhole(r.body, "buddies"), r.seen);
    assert.ok(r.body.objects.length > 0, r.seen);
  });
});
