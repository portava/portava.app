/**
 * Live For You — the multi-kind strip (spec §4 / TABLE 0).
 *
 * The strip used to build EVERY candidate as place_state, so LiveForYouService's
 * per-kind action mapping (actionFor) never bound for the other kinds. These
 * tests prove:
 *   • buildLiveForYou emits a RESOLVED (non-intel) candidate directly, with the
 *     right per-kind action, and drops it when its horizon has passed;
 *   • a resolved fact wins the per-subject slot over a bare place_state one;
 *   • the hidden_gem / social_presence / buddy producers read + gate their own
 *     canonical systems (disclosure policy, k-anonymity floor, the RAB flag);
 *   • the event_state producer reads the ONE privacy-complete events reader
 *     (loadNearbyEvents) and the Map's own timing derivation, drops an event
 *     that is not AT the place / not time-valid / has no usable coordinate, and
 *     fails closed when the block set cannot be read;
 *   • the trip_signal producer is trip-scoped, anchors on a saved stop, drops
 *     private-location and cancelled-meetup milestones, and fails closed when
 *     the meetup cross-check cannot be read.
 *
 * Run: node --import tsx/esm --test src/test/wallLiveForYouKinds.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLiveForYou,
  buildGemLiveCandidates,
  buildSocialPresenceLiveCandidates,
  buildBuddyLiveCandidates,
  buildEventStateLiveCandidates,
  buildTripSignalLiveCandidates,
  EVENT_AT_PLACE_METERS,
  TRIP_SIGNAL_NEAR_METERS,
  type LiveForYouCandidate,
} from "../services/wall/LiveForYouService.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const PAST = new Date(NOW.getTime() - 3600_000).toISOString();
const FUTURE = new Date(NOW.getTime() + 3600_000).toISOString();

/** A client whose every read throws — proves the resolved path takes no read. */
const THROWS = { from() { throw new Error("no intel read expected"); } };

/** A generic table-routed fake: returns the configured rows for a table (unknown
 *  tables ⇒ []), and honours maybeSingle by returning the first row. A table may
 *  also be given as `{ error }` to simulate a read FAILURE.
 *
 *  It also APPLIES `.eq(col, val)` — as a row filter, but only against rows that
 *  actually carry that column, so fixtures that omit an unrelated column are
 *  unaffected. That matters: the fake used to swallow every predicate
 *  (`eq: () => b`) and no fixture carried `post_status`, so deleting
 *  buildSocialPresenceLiveCandidates' `.eq("post_status", "published")` — the
 *  gate that stops a pending delayed-geotag post from revealing that a followed
 *  person was at a place — left all 11 tests green. `captured` records the
 *  predicates too, so a test can assert a query CARRIES one rather than
 *  inferring it from the response; `calls` records every table a builder is
 *  opened on, so a test can assert a table is never read AT ALL. */
function tableClient(
  tables: Record<string, any[] | { error: unknown }>,
  captured?: Array<{ table: string; eqs: Record<string, any> }>,
  calls?: string[],
) {
  function builder(table: string) {
    calls?.push(table);
    const entry = tables[table];
    const failure = entry && !Array.isArray(entry) ? (entry as { error: unknown }).error : null;
    const eqs: Record<string, any> = {};
    const rows = () => {
      const src = (Array.isArray(entry) ? entry : []) as any[];
      return src.filter((r) =>
        Object.entries(eqs).every(([c, v]) => !(c in r) || r[c] === v),
      );
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      neq: () => b, in: () => b, not: () => b, is: () => b, or: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b, order: () => b, limit: () => b,
      maybeSingle: () => {
        captured?.push({ table, eqs: { ...eqs } });
        return Promise.resolve(
          failure ? { data: null, error: failure } : { data: rows()[0] ?? null, error: null },
        );
      },
      then: (onF: any, onR: any) => {
        captured?.push({ table, eqs: { ...eqs } });
        return Promise.resolve(
          failure ? { data: null, error: failure } : { data: rows(), error: null },
        ).then(onF, onR);
      },
    };
    return b;
  }
  return { from: builder };
}

describe("buildLiveForYou — resolved (non-intel) kinds bind to actionFor", () => {
  it("emits a resolved social_presence item with the see_who action", async () => {
    const cand: LiveForYouCandidate = {
      subjectId: "p1", liveObjectType: "social_presence", subject: { placeId: "p1", name: "An Thuong" },
      resolved: { id: "sp-p1", label: "3 people you follow were here recently", state: "emerging", confidence: 0.8, observedAt: PAST, validUntil: FUTURE },
    };
    const out = await buildLiveForYou(THROWS, [cand], { now: NOW });
    assert.equal(out.length, 1);
    assert.equal(out[0].liveObjectType, "social_presence");
    assert.equal(out[0].action?.type, "see_who");
    assert.equal(out[0].label, "3 people you follow were here recently");
    assert.equal(out[0].state, "emerging");
  });

  it("maps each resolved kind to its action", async () => {
    const mk = (kind: LiveForYouCandidate["liveObjectType"], id: string): LiveForYouCandidate => ({
      subjectId: id, liveObjectType: kind, subject: { placeId: id, name: id },
      resolved: { id: `r-${id}`, label: kind, state: "emerging", observedAt: PAST, validUntil: FUTURE },
    });
    const out = await buildLiveForYou(THROWS, [mk("hidden_gem", "g"), mk("buddy", "b")], { now: NOW, limit: 4 });
    const byKind = new Map(out.map((o) => [o.liveObjectType, o.action?.type]));
    assert.equal(byKind.get("hidden_gem"), "explore");
    assert.equal(byKind.get("buddy"), "book_buddy");
  });

  it("drops a resolved fact whose validUntil has passed (no stale live labels)", async () => {
    const cand: LiveForYouCandidate = {
      subjectId: "p1", liveObjectType: "hidden_gem", subject: { placeId: "p1", name: "X" },
      resolved: { id: "g", label: "Hidden Gem", state: "emerging", observedAt: PAST, validUntil: PAST },
    };
    assert.deepEqual(await buildLiveForYou(THROWS, [cand], { now: NOW }), []);
  });

  it("prefers a resolved fact over a bare place_state candidate for the same subject", async () => {
    const placeState: LiveForYouCandidate = { subjectId: "p1", liveObjectType: "place_state", subject: { placeId: "p1", name: "X" } };
    const gem: LiveForYouCandidate = {
      subjectId: "p1", liveObjectType: "hidden_gem", subject: { placeId: "p1", name: "X" },
      resolved: { id: "g-p1", label: "Hidden Gem · recently confirmed", state: "emerging", observedAt: PAST, validUntil: FUTURE },
    };
    // THROWS would blow up an intel read; the resolved gem must win the slot with
    // no read at all.
    const out = await buildLiveForYou(THROWS, [placeState, gem], { now: NOW });
    assert.equal(out.length, 1);
    assert.equal(out[0].liveObjectType, "hidden_gem");
  });
});

describe("social_presence producer — k-anonymity floor, viewer-relevant (spec §23)", () => {
  const PLACES = [{ placeId: "p1", name: "An Thuong" }];
  const postsClient = (rows: any[], captured?: Array<{ table: string; eqs: Record<string, any> }>) =>
    tableClient({ posts: rows }, captured);
  // posts.post_status is NOT NULL DEFAULT 'published', so a real row always
  // carries one. Fixtures that omit it cannot tell a published post from a
  // pending delayed-geotag one.
  const at = (author: string, post_status = "published") =>
    ({ author_id: author, canonical_place_id: "p1", created_at: PAST, visibility: "public", status: "active", post_status });

  it("≥ 2 distinct followed authors at the place ⇒ one social_presence candidate", async () => {
    const sc = postsClient([at("a1"), at("a2")]);
    const cands = await buildSocialPresenceLiveCandidates(sc, "viewer", new Set(["a1", "a2"]), PLACES, { now: NOW });
    assert.equal(cands.length, 1);
    assert.equal(cands[0].liveObjectType, "social_presence");
    assert.match(cands[0].resolved!.label, /2 people you follow were here/);
  });

  it("a single followed person is suppressed (never one person's movement)", async () => {
    const sc = postsClient([at("a1")]);
    assert.deepEqual(await buildSocialPresenceLiveCandidates(sc, "viewer", new Set(["a1"]), PLACES, { now: NOW }), []);
  });

  it("no candidate when the viewer follows nobody", async () => {
    const sc = postsClient([at("a1")]);
    assert.deepEqual(await buildSocialPresenceLiveCandidates(sc, "viewer", new Set(), PLACES, { now: NOW }), []);
  });

  // A pending delayed-geotag post is exactly the case this producer must not
  // read: "2 people you follow were here recently" IS the disclosure its author
  // asked to withhold until they had left (spec §23 / §37). The producer carries
  // `.eq("post_status", "published")`; nothing pinned it, so a revert was free.
  for (const pending of ["pending_location_exit", "pending_delay", "pending_safety_review"]) {
    it(`a '${pending}' post does not count toward the k-anonymity floor`, async () => {
      const sc = postsClient([at("a1"), at("a2", pending)]);
      const cands = await buildSocialPresenceLiveCandidates(sc, "viewer", new Set(["a1", "a2"]), PLACES, { now: NOW });
      assert.deepEqual(cands, [], `one published author is below the floor once the ${pending} post is excluded`);
    });
  }

  it("the producer's query CARRIES post_status='published' (the DB-layer predicate)", async () => {
    const captured: Array<{ table: string; eqs: Record<string, any> }> = [];
    const sc = postsClient([at("a1"), at("a2")], captured);
    await buildSocialPresenceLiveCandidates(sc, "viewer", new Set(["a1", "a2"]), PLACES, { now: NOW });
    const reads = captured.filter((c) => c.table === "posts");
    assert.ok(reads.length >= 1, "the producer read posts");
    for (const q of reads) {
      assert.equal(q.eqs.status, "active");
      assert.equal(q.eqs.visibility, "public");
      assert.equal(q.eqs.post_status, "published", "the producer must carry the canonical predicate");
    }
  });
});

describe("buddy producer — behind BOTH RAB flags, city-area only (spec §19)", () => {
  const PLACES = [{ placeId: "p1", name: "Rooftop", city: "Bangkok" }];

  /**
   * Flag-AWARE fake: `feature_flags` resolves per requested flag name, so the
   * Wall flag and the RAB master can be set independently. `tableClient` above
   * cannot express that — its maybeSingle returns the same row for every flag.
   */
  function buddyClient(rows: any[], flags: Record<string, boolean>) {
    return {
      from(table: string) {
        const eqs: Record<string, unknown> = {};
        const b: any = {
          select: () => b, in: () => b, limit: () => b,
          eq: (col: string, val: unknown) => { eqs[col] = val; return b; },
          maybeSingle: () => Promise.resolve(
            table === "feature_flags"
              ? { data: { enabled: flags[String(eqs["flag"])] === true }, error: null }
              : { data: null, error: null },
          ),
          then: (onF: any, onR: any) =>
            Promise.resolve({ data: table === "rent_buddy_profiles" ? rows : [], error: null }).then(onF, onR),
        };
        return b;
      },
    };
  }

  const BUDDY = [{ id: "b1", city: "Bangkok", categories: ["nightlife"] }];

  it("returns nothing when the Wall RAB flag is off", async () => {
    const sc = buddyClient(BUDDY, { wall_rab_integration_enabled: false, rent_buddy_enabled: true });
    assert.deepEqual(await buildBuddyLiveCandidates(sc, PLACES, { rabEnabled: false, now: NOW }), []);
  });

  /**
   * REGRESSION — a producer must not advertise a globally disabled product.
   *
   * `rabEnabled` is the Wall's own flag, handed down by the route. This producer
   * used to treat it as sufficient, so pressing `wall_rab_integration_enabled`
   * would have surfaced "Buddy around" strip items while the RAB master
   * `rent_buddy_enabled` was false — as it is in production — offering a booking
   * nobody could complete. The master is now re-read HERE, not trusted from the
   * caller, so no caller can reintroduce the misfire.
   */
  it("returns nothing when the RAB MASTER is off, even with the Wall flag on", async () => {
    const sc = buddyClient(BUDDY, { wall_rab_integration_enabled: true, rent_buddy_enabled: false });
    assert.deepEqual(await buildBuddyLiveCandidates(sc, PLACES, { rabEnabled: true, now: NOW }), []);
  });

  it("returns nothing when the flag table is unreadable (fail-closed)", async () => {
    const sc = { from: () => { throw new Error("flag table down"); } };
    assert.deepEqual(await buildBuddyLiveCandidates(sc, PLACES, { rabEnabled: true, now: NOW }), []);
  });

  it("surfaces an available Buddy in the place's city when BOTH flags are on", async () => {
    const sc = buddyClient(BUDDY, { wall_rab_integration_enabled: true, rent_buddy_enabled: true });
    const cands = await buildBuddyLiveCandidates(sc, PLACES, { rabEnabled: true, now: NOW });
    assert.equal(cands.length, 1);
    assert.equal(cands[0].liveObjectType, "buddy");
    assert.equal(cands[0].subjectId, "p1");
    assert.equal(cands[0].resolved!.label, "Nightlife Buddy around");
  });
});

describe("hidden_gem producer — disclosure policy (spec §20)", () => {
  const PLACES = [{ placeId: "p1", name: "Secret Cove" }];

  it("never surfaces a protected gem", async () => {
    const sc = tableClient({ hidden_gems: [{ id: "g1", canonical_place_id: "p1", sensitivity_level: "protected", status: "active", updated_at: PAST }] });
    assert.deepEqual(await buildGemLiveCandidates(sc, PLACES, { now: NOW }), []);
  });

  it("does not surface a public gem with no confirmed evidence (fresh+qualified only)", async () => {
    // deriveGemProjection over empty aggregates ⇒ 'still_hidden' ⇒ no surfaceable state.
    const sc = tableClient({ hidden_gems: [{ id: "g1", canonical_place_id: "p1", sensitivity_level: "public", status: "active", updated_at: PAST }] });
    assert.deepEqual(await buildGemLiveCandidates(sc, PLACES, { now: NOW }), []);
  });
});

// ── event_state (spec §4 / TABLE 0) ─────────────────────────────────────────

describe("event_state producer — time-valid, at the place, privacy-complete", () => {
  const VIEWER = "viewer-1";
  /** The Wall's place ref carries NO coordinate (routes/wall.ts, §23) — the
   *  producer resolves the venue coordinate from `places` itself. */
  const PLACE = { placeId: "p1", name: "An Thuong", city: "Da Nang" };
  const PLACES = [PLACE];
  const LAT = 16.041;
  const LNG = 108.246;
  const PLACE_ROWS = [{ id: "p1", latitude: LAT, longitude: LNG, status: "active", merged_into_place_id: null }];

  /** An events row shaped as loadNearbyEvents returns it (public, current). */
  function eventRow(over: Record<string, unknown> = {}) {
    return {
      id: "ev-1",
      host_id: "host-1",
      title: "Beach Festival",
      location_name: "An Thuong beach",
      location_lat: LAT,
      location_lng: LNG,
      show_exact_location: true,
      starts_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(), // started 30m ago
      ends_at: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
      cover_url: null,
      visibility: "public",
      state: "published",
      age_min: null, age_max: null, trust_score_min: null, verified_only: false,
      ...over,
    };
  }

  const eventClient = (events: any[], over: Record<string, any> = {}) =>
    tableClient({ events, places: PLACE_ROWS, blocks: [], event_roles: [], feature_flags: [], ...over });

  it("an event on now at the place becomes one event_state candidate", async () => {
    const cands = await buildEventStateLiveCandidates(eventClient([eventRow()]), VIEWER, PLACES, { now: NOW });
    assert.equal(cands.length, 1);
    assert.equal(cands[0].liveObjectType, "event_state");
    assert.equal(cands[0].subjectId, "p1");
    assert.equal(cands[0].resolved!.label, "Beach Festival · happening now");
    assert.equal(cands[0].resolved!.id, "event-ev-1");
    // §37: a schedule is not an observation — never a Live badge, never a
    // fabricated confidence, and never a crowd/capacity phrase.
    assert.equal(cands[0].resolved!.state, "emerging");
    assert.equal(cands[0].resolved!.confidence, null);
    assert.ok(!/peak|busy|crowd|going/i.test(cands[0].resolved!.label));
    // It ages out on the event's own clock (its end).
    assert.equal(cands[0].resolved!.validUntil, new Date(NOW.getTime() + 90 * 60_000).toISOString());
  });

  it("an event starting soon is labelled as a start window, not as happening", async () => {
    const starts = new Date(NOW.getTime() + 20 * 60_000).toISOString();
    const cands = await buildEventStateLiveCandidates(
      eventClient([eventRow({ starts_at: starts, ends_at: null })]), VIEWER, PLACES, { now: NOW },
    );
    assert.equal(cands.length, 1);
    assert.equal(cands[0].resolved!.label, "Beach Festival · starts in 20 min");
    // The "starts in N min" claim stops being true the moment it starts.
    assert.equal(cands[0].resolved!.validUntil, starts);
  });

  it("an event that already ended is not a live state", async () => {
    const cands = await buildEventStateLiveCandidates(
      eventClient([
        eventRow({
          starts_at: new Date(NOW.getTime() - 6 * 3600_000).toISOString(),
          ends_at: new Date(NOW.getTime() - 5 * 3600_000).toISOString(),
        }),
      ]),
      VIEWER, PLACES, { now: NOW },
    );
    assert.deepEqual(cands, []);
  });

  it("an event too far away is not AT the place", async () => {
    // ~0.05 degrees of latitude ≈ 5.5 km, far past EVENT_AT_PLACE_METERS.
    assert.ok(EVENT_AT_PLACE_METERS < 5_000);
    const cands = await buildEventStateLiveCandidates(
      eventClient([eventRow({ location_lat: LAT + 0.05 })]), VIEWER, PLACES, { now: NOW },
    );
    assert.deepEqual(cands, []);
  });

  it("an event whose exact location the host hid is skipped, never approximated", async () => {
    // loadNearbyEvents NULLs the coordinates of such an event for other viewers.
    const cands = await buildEventStateLiveCandidates(
      eventClient([eventRow({ show_exact_location: false })]), VIEWER, PLACES, { now: NOW },
    );
    assert.deepEqual(cands, []);
  });

  it("an unreadable block set yields no event items, and nothing else is read", async () => {
    const calls: string[] = [];
    const sc = tableClient(
      {
        events: [eventRow()], places: PLACE_ROWS,
        blocks: { error: { message: "down" } }, event_roles: [], feature_flags: [],
      },
      undefined,
      calls,
    );
    assert.deepEqual(await buildEventStateLiveCandidates(sc, VIEWER, PLACES, { now: NOW }), []);
    // Fail-CLOSED, not fail-by-accident: the producer stops at the unreadable
    // block set rather than reading events and filtering them against nothing.
    assert.ok(calls.includes("blocks"), "the block set is read first");
    assert.ok(!calls.includes("events"), `events must not be read; calls were ${calls.join(",")}`);
    assert.ok(!calls.includes("places"), `places must not be read; calls were ${calls.join(",")}`);
  });

  it("an unreadable events table says nothing rather than 'nothing is on'", async () => {
    const sc = tableClient({
      events: { error: { message: "down" } }, places: PLACE_ROWS,
      blocks: [], event_roles: [], feature_flags: [],
    });
    assert.deepEqual(await buildEventStateLiveCandidates(sc, VIEWER, PLACES, { now: NOW }), []);
  });

  it("a place with no canonical public coordinate is never probed", async () => {
    // The Wall's place ref never carries a coordinate; when `places` has none
    // either (or the row is merged/inactive), the place cannot be probed — and
    // is never approximated from its city.
    const calls: string[] = [];
    const sc = tableClient(
      { events: [eventRow()], places: [], blocks: [], event_roles: [], feature_flags: [] },
      undefined,
      calls,
    );
    assert.deepEqual(await buildEventStateLiveCandidates(sc, VIEWER, PLACES, { now: NOW }), []);
    assert.ok(!calls.includes("events"), `events must not be read; calls were ${calls.join(",")}`);
  });

  it("prefers the ongoing event over one starting later at the same place", async () => {
    const cands = await buildEventStateLiveCandidates(
      eventClient([
        eventRow({ id: "ev-later", title: "Night Market", starts_at: new Date(NOW.getTime() + 45 * 60_000).toISOString(), ends_at: null }),
        eventRow({ id: "ev-now", title: "Beach Festival" }),
      ]),
      VIEWER, PLACES, { now: NOW },
    );
    assert.equal(cands.length, 1);
    assert.equal(cands[0].resolved!.id, "event-ev-now");
  });
});

// ── trip_signal (spec §4 / TABLE 0) ─────────────────────────────────────────

describe("trip_signal producer — trip-scoped, anchored on a saved stop", () => {
  const VIEWER = "viewer-1";
  const PLACE = { placeId: "p1", name: "Riverside", city: "Bangkok" };
  const PLACES = [PLACE];
  const LAT = 13.7275;
  const LNG = 100.5241;
  const TRIPS = new Set(["trip-1"]);
  const SAVED = [{ trip_id: "trip-1", place_id: "p1", lat: LAT, lng: LNG }];
  const PLACE_ROWS = [{ id: "p1", latitude: LAT, longitude: LNG, status: "active", merged_into_place_id: null }];

  function planItem(over: Record<string, unknown> = {}) {
    return {
      id: "pi-1",
      trip_id: "trip-1",
      title: "Meet at the pier",
      category: "meeting_point",
      status: "confirmed",
      source_type: "manual",
      source_id: null,
      starts_at: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
      ends_at: new Date(NOW.getTime() + 80 * 60_000).toISOString(),
      lat: LAT,
      lng: LNG,
      location_is_private: false,
      removed_at: null,
      visibility: "members",
      ...over,
    };
  }

  const tripClient = (items: any[], over: Record<string, any> = {}) =>
    tableClient({ trip_saved_places: SAVED, places: PLACE_ROWS, trip_plan_items: items, meetups: [], ...over });

  it("a crew gathering near a saved stop becomes one trip_signal candidate", async () => {
    const cands = await buildTripSignalLiveCandidates(tripClient([planItem()]), VIEWER, TRIPS, PLACES, { now: NOW });
    assert.equal(cands.length, 1);
    assert.equal(cands[0].liveObjectType, "trip_signal");
    assert.equal(cands[0].subjectId, "p1");
    assert.equal(cands[0].resolved!.label, "Crew gathering in 20 min nearby · Meet at the pier");
    assert.equal(cands[0].resolved!.id, "trip-pi-1");
    // §37: a plan is not an observation.
    assert.equal(cands[0].resolved!.state, "emerging");
    assert.equal(cands[0].resolved!.confidence, null);
  });

  it("claims proximity only when both coordinates were known and checked", async () => {
    const cands = await buildTripSignalLiveCandidates(
      tripClient([planItem({ lat: null, lng: null })]), VIEWER, TRIPS, PLACES, { now: NOW },
    );
    assert.equal(cands.length, 1);
    assert.ok(cands[0].resolved!.label.includes("on your trip"));
    assert.ok(!cands[0].resolved!.label.includes("nearby"));
  });

  it("falls back to the saved stop's own coordinate when the canonical place has none", async () => {
    const sc = tableClient({
      trip_saved_places: SAVED, places: [], trip_plan_items: [planItem()], meetups: [],
    });
    const cands = await buildTripSignalLiveCandidates(sc, VIEWER, TRIPS, PLACES, { now: NOW });
    assert.equal(cands.length, 1);
    assert.ok(cands[0].resolved!.label.includes("nearby"));
  });

  it("a milestone with a known coordinate far from the stop is not 'near' it", async () => {
    assert.ok(TRIP_SIGNAL_NEAR_METERS < 20_000);
    const cands = await buildTripSignalLiveCandidates(
      tripClient([planItem({ lat: LAT + 0.5 })]), VIEWER, TRIPS, PLACES, { now: NOW },
    );
    assert.deepEqual(cands, []);
  });

  it("never surfaces a milestone the owner marked private-location", async () => {
    const cands = await buildTripSignalLiveCandidates(
      tripClient([planItem({ location_is_private: true })]), VIEWER, TRIPS, PLACES, { now: NOW },
    );
    assert.deepEqual(cands, []);
  });

  it("never surfaces a removed or cancelled milestone", async () => {
    const removed = await buildTripSignalLiveCandidates(
      tripClient([planItem({ removed_at: PAST })]), VIEWER, TRIPS, PLACES, { now: NOW },
    );
    assert.deepEqual(removed, []);
    const cancelled = await buildTripSignalLiveCandidates(
      tripClient([planItem({ status: "cancelled" })]), VIEWER, TRIPS, PLACES, { now: NOW },
    );
    assert.deepEqual(cancelled, []);
  });

  it("withholds a milestone whose visibility is not member-visible (fail-closed)", async () => {
    const cands = await buildTripSignalLiveCandidates(
      tripClient([planItem({ visibility: "owner_only" })]), VIEWER, TRIPS, PLACES, { now: NOW },
    );
    assert.deepEqual(cands, []);
  });

  it("surfaces a meetup-sourced milestone whose meetup is still live", async () => {
    const sc = tripClient([planItem({ source_type: "meetup", source_id: "m1" })], {
      meetups: [{ id: "m1", status: "active" }],
    });
    const cands = await buildTripSignalLiveCandidates(sc, VIEWER, TRIPS, PLACES, { now: NOW });
    assert.equal(cands.length, 1);
    assert.equal(cands[0].resolved!.id, "trip-pi-1");
  });

  it("drops a meetup-sourced milestone whose meetup was cancelled", async () => {
    const sc = tripClient([planItem({ source_type: "meetup", source_id: "m1" })], {
      meetups: [{ id: "m1", status: "cancelled" }],
    });
    assert.deepEqual(await buildTripSignalLiveCandidates(sc, VIEWER, TRIPS, PLACES, { now: NOW }), []);
  });

  it("withholds ONLY the meetup-sourced milestones when the cross-check cannot be read", async () => {
    // Two saved stops on the same trip, far enough apart that each milestone can
    // only pair with its own stop. The meetup-sourced one is withheld because the
    // cancellation check is unreadable; the manual one is unaffected — the
    // withholding is targeted, not the whole producer collapsing.
    const FAR = { placeId: "p2", name: "Old Town", city: "Bangkok" };
    const FAR_LAT = LAT + 0.5;
    const sc = tableClient({
      trip_saved_places: [...SAVED, { trip_id: "trip-1", place_id: "p2", lat: FAR_LAT, lng: LNG }],
      places: [...PLACE_ROWS, { id: "p2", latitude: FAR_LAT, longitude: LNG, status: "active", merged_into_place_id: null }],
      trip_plan_items: [
        planItem({ id: "pi-manual", title: "Breakfast", category: "activity" }),
        planItem({ id: "pi-meetup", source_type: "meetup", source_id: "m1", lat: FAR_LAT, lng: LNG }),
      ],
      meetups: { error: { message: "down" } },
    });
    const cands = await buildTripSignalLiveCandidates(sc, VIEWER, TRIPS, [PLACE, FAR], { now: NOW });
    assert.deepEqual(cands.map((c) => c.resolved!.id), ["trip-pi-manual"]);
    assert.deepEqual(cands.map((c) => c.subjectId), ["p1"]);
  });

  it("a trip the viewer does not belong to is never read", async () => {
    // The saved stop belongs to trip-1; the viewer's membership set has none of it.
    const cands = await buildTripSignalLiveCandidates(
      tripClient([planItem()]), VIEWER, new Set<string>(), PLACES, { now: NOW },
    );
    assert.deepEqual(cands, []);
  });

  it("a feed place that is not a saved stop yields nothing", async () => {
    const sc = tableClient({ trip_saved_places: [], places: PLACE_ROWS, trip_plan_items: [planItem()], meetups: [] });
    assert.deepEqual(await buildTripSignalLiveCandidates(sc, VIEWER, TRIPS, PLACES, { now: NOW }), []);
  });

  it("a milestone that has already finished is dropped", async () => {
    const cands = await buildTripSignalLiveCandidates(
      tripClient([
        planItem({
          starts_at: new Date(NOW.getTime() - 150 * 60_000).toISOString(),
          ends_at: new Date(NOW.getTime() - 90 * 60_000).toISOString(),
        }),
      ]),
      VIEWER, TRIPS, PLACES, { now: NOW },
    );
    assert.deepEqual(cands, []);
  });

  it("an ongoing non-meeting_point milestone reads as a trip milestone, not a gathering", async () => {
    const cands = await buildTripSignalLiveCandidates(
      tripClient([
        planItem({
          category: "activity",
          title: "Sunset cruise",
          starts_at: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
          ends_at: new Date(NOW.getTime() + 50 * 60_000).toISOString(),
        }),
      ]),
      VIEWER, TRIPS, PLACES, { now: NOW },
    );
    assert.equal(cands.length, 1);
    assert.equal(cands[0].resolved!.label, "Sunset cruise now · nearby");
  });
});

describe("both new kinds bind to actionFor and honour the strip bound", () => {
  it("event_state maps to see_place and trip_signal to open_map", async () => {
    const mk = (kind: LiveForYouCandidate["liveObjectType"], id: string): LiveForYouCandidate => ({
      subjectId: id, liveObjectType: kind, subject: { placeId: id, name: id },
      resolved: { id: `r-${id}`, label: kind, state: "emerging", confidence: null, observedAt: PAST, validUntil: FUTURE },
    });
    const out = await buildLiveForYou(THROWS, [mk("event_state", "e"), mk("trip_signal", "t")], { now: NOW, limit: 4 });
    const byKind = new Map(out.map((o) => [o.liveObjectType, o.action?.type]));
    assert.equal(byKind.get("event_state"), "see_place");
    assert.equal(byKind.get("trip_signal"), "open_map");
  });
});
