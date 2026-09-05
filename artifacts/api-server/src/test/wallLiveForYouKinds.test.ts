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
 *  tables ⇒ []), and honours maybeSingle by returning the first row.
 *
 *  It also APPLIES `.eq(col, val)` — as a row filter, but only against rows that
 *  actually carry that column, so fixtures that omit an unrelated column are
 *  unaffected. That matters: the fake used to swallow every predicate
 *  (`eq: () => b`) and no fixture carried `post_status`, so deleting
 *  buildSocialPresenceLiveCandidates' `.eq("post_status", "published")` — the
 *  gate that stops a pending delayed-geotag post from revealing that a followed
 *  person was at a place — left all 11 tests green. `captured` records the
 *  predicates too, so a test can assert a query CARRIES one rather than
 *  inferring it from the response. */
function tableClient(tables: Record<string, any[]>, captured?: Array<{ table: string; eqs: Record<string, any> }>) {
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const rows = () => {
      const src = tables[table] ?? [];
      return src.filter((r) =>
        Object.entries(eqs).every(([c, v]) => !(c in r) || r[c] === v),
      );
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: () => b, gte: () => b, lte: () => b, gt: () => b, order: () => b, limit: () => b,
      maybeSingle: () => { captured?.push({ table, eqs: { ...eqs } }); return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then: (onF: any, onR: any) => {
        captured?.push({ table, eqs: { ...eqs } });
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
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
