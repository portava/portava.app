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
 *     canonical systems (disclosure policy, k-anonymity floor, the RAB flag).
 *
 * event_state and trip_signal have no existing canonical live reader, so they are
 * not produced here (see the unit's notDone).
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
  type LiveForYouCandidate,
} from "../services/wall/LiveForYouService.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const PAST = new Date(NOW.getTime() - 3600_000).toISOString();
const FUTURE = new Date(NOW.getTime() + 3600_000).toISOString();

/** A client whose every read throws — proves the resolved path takes no read. */
const THROWS = { from() { throw new Error("no intel read expected"); } };

/** A generic table-routed fake: returns the configured rows for a table (unknown
 *  tables ⇒ []), and honours maybeSingle by returning the first row. */
function tableClient(tables: Record<string, any[]>) {
  function builder(table: string) {
    const b: any = {
      select: () => b, eq: () => b, in: () => b, gte: () => b, lte: () => b, gt: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (onF: any, onR: any) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(onF, onR),
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
  const postsClient = (rows: any[]) => tableClient({ posts: rows });

  it("≥ 2 distinct followed authors at the place ⇒ one social_presence candidate", async () => {
    const sc = postsClient([
      { author_id: "a1", canonical_place_id: "p1", created_at: PAST },
      { author_id: "a2", canonical_place_id: "p1", created_at: PAST },
    ]);
    const cands = await buildSocialPresenceLiveCandidates(sc, "viewer", new Set(["a1", "a2"]), PLACES, { now: NOW });
    assert.equal(cands.length, 1);
    assert.equal(cands[0].liveObjectType, "social_presence");
    assert.match(cands[0].resolved!.label, /2 people you follow were here/);
  });

  it("a single followed person is suppressed (never one person's movement)", async () => {
    const sc = postsClient([{ author_id: "a1", canonical_place_id: "p1", created_at: PAST }]);
    assert.deepEqual(await buildSocialPresenceLiveCandidates(sc, "viewer", new Set(["a1"]), PLACES, { now: NOW }), []);
  });

  it("no candidate when the viewer follows nobody", async () => {
    const sc = postsClient([{ author_id: "a1", canonical_place_id: "p1", created_at: PAST }]);
    assert.deepEqual(await buildSocialPresenceLiveCandidates(sc, "viewer", new Set(), PLACES, { now: NOW }), []);
  });
});

describe("buddy producer — behind the RAB flag, city-area only (spec §19)", () => {
  const PLACES = [{ placeId: "p1", name: "Rooftop", city: "Bangkok" }];
  const buddyClient = (rows: any[]) => tableClient({ rent_buddy_profiles: rows });

  it("returns nothing when the RAB flag is off", async () => {
    const sc = buddyClient([{ id: "b1", city: "Bangkok", categories: ["nightlife"] }]);
    assert.deepEqual(await buildBuddyLiveCandidates(sc, PLACES, { rabEnabled: false, now: NOW }), []);
  });

  it("surfaces an available Buddy in the place's city when the flag is on", async () => {
    const sc = buddyClient([{ id: "b1", city: "Bangkok", categories: ["nightlife"] }]);
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
