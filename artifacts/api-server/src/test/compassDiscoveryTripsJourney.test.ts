/**
 * ONE USER JOURNEY, end to end through the real dispatcher:
 * Compass asks → Discovery answers → Trips holds a proposal.
 *
 * ── WHY A JOURNEY TEST AND NOT THREE UNIT TESTS ─────────────────────────────
 * Each leg of this path is already covered where it lives. What no existing
 * suite asserts is that the legs AGREE — specifically that the identifier
 * `search_places` hands the model is the identifier `add_to_trip` will accept.
 * Those two tools read the same table through different code, and a divergence
 * (one returning a bridge id, the other expecting a catalog id) breaks the
 * whole journey while every unit test stays green, because no unit test ever
 * feeds one tool's output into the other's input. This one does.
 *
 * THE JOURNEY, as a person experiences it:
 *   1. "Somewhere with a view in Cebu?"   -> search_places
 *   2. the model names one of the answers -> add_to_trip { placeId }
 *   3. the app shows a proposal           -> nothing has been added
 *
 * WHAT IS ASSERTED, and why each is separate:
 *  (1) The journey COMPLETES: the id from step 1 is accepted at step 2 and the
 *      proposal names that same place. This is the seam nothing else covers.
 *  (2) The catalog owns the title and category, not the model. A model that
 *      invented a nicer name must not be able to write it onto a real place.
 *  (3) NOTHING IS WRITTEN. `add_to_trip` proposes; the person confirms.
 *  (4) A non-member is refused even though the place is real — the model
 *      cannot route around authorization by having the right id.
 *  (5) An id that is not in the catalog is refused.
 *  (6) No coordinates reach the model at EITHER step.
 *  (7) An UNREADABLE catalog must not be reported as "this place does not
 *      exist". See below — this one was RED.
 *
 * ── (7), THE DEFECT THIS FILE FOUND ─────────────────────────────────────────
 * `toolAddToTrip` looked the place up with
 *
 *     const { data: place } = await sc.from("discovery_places")…maybeSingle();
 *     if (!place) return { error: "Place not found — only real catalog places…" };
 *
 * The `error` is DISCARDED. supabase-js RESOLVES on a database failure, so an
 * unreadable `discovery_places` produces `data: null` — byte-identical to "no
 * such row" — and the person is told the place they are looking at does not
 * exist. That is a SETTLED answer to a RETRYABLE failure, the same defect class
 * as the Map search sheet reporting a refused search as "Nothing matched", and
 * it is worse here because the model will faithfully relay the denial as fact.
 *
 * Note the asymmetry that made it easy to miss: `toolSearchPlaces`, ten lines
 * of the same file away, BINDS its error and answers "Place search unavailable
 * right now." Step 1 of this journey was honest and step 2 was not.
 *
 * ── ONE MUTATION SURVIVES, AND IT IS NOT AN OVERSIGHT ───────────────────────
 * Deleting the `tripErr` branch in `toolAddToTrip` leaves all eight cases
 * green. That branch is UNREACHABLE on this path: `canEditPlan`, called three
 * lines earlier, reads the same `trips` row and THROWS
 * TripAccessUnavailableError on an unreadable one, so nothing survives to
 * reach it. Case (8) therefore measures the DISPATCHER's handling of that
 * throw — which is where the honest answer actually comes from — and mutating
 * the dispatcher's `instanceof` branch to `false` does turn (8) red.
 *
 * The branch is kept anyway (the read would otherwise be a discarded read, and
 * the call ordering is a fact about today\'s code rather than a contract), and
 * the survivor is written down here instead of being killed with a contrived
 * fixture that fails `trips` only on its second read.
 *
 * Run: node --import tsx/esm --test src/test/compassDiscoveryTripsJourney.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const CAROL = "c3c3c3c3-cccc-cccc-cccc-000000000003";
const TRIP  = "eeee0000-eeee-eeee-eeee-000000000001";
const PLACE = "f0f0f0f0-ffff-ffff-ffff-000000000001";

const profile = (): CompassProfile =>
  ({ userId: ALICE, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile);

type Db = Record<string, any[]>;

function db(overrides: Db = {}): Db {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    profiles: [{ id: ALICE }, { id: CAROL }],
    // `role` matters: requireTripMember's accepted set is
    // ["owner","co_host","member","viewer"], and my first fixture used
    // "organizer" — which is not in it. Cases (4) and (5) then PASSED for the
    // wrong reason: every add_to_trip was being refused at the membership gate
    // before it ever reached the catalog, so "a non-member is refused" and "an
    // invented id is refused" were both just the same refusal wearing two
    // labels. Recorded rather than quietly corrected, because a green
    // authorization case that fires for an unrelated reason is worse than a
    // red one.
    trips: [{ id: TRIP, title: "Cebu, March", owner_id: ALICE }],
    trip_members: [{ trip_id: TRIP, user_id: ALICE, status: "accepted", role: "owner" }],
    trip_plan_items: [],
    discovery_places: [{
      id: PLACE,
      name: "Lantaw Floating Native Restaurant",
      category: "restaurant",
      primary_category: "restaurant",
      city: "Cebu",
      neighborhood: "Cordova",
      rating: 4.6,
      saved_count: 812,
      verified: true,
      blurb: "Over the water, sunset side.",
      // These must never reach the model, at either step.
      lat: 10.2543,
      lng: 123.9482,
    }],
    compass_profiles: [], compass_user_preferences: [], user_hashtag_follows: [],
    user_location_state: [], events: [], circles: [], circle_memberships: [],
    blocks: [], user_follows: [], user_interactions: [],
    ...overrides,
  };
}

/**
 * The fake client, with ONE addition over the shape compass-tools.test.ts uses:
 * `failTables` makes a named table answer every read the way PostgREST answers
 * a real failure — RESOLVED, with `error` set and `data` null. That is the only
 * way to tell a discarded error from a handled one, and nothing in the existing
 * Compass fakes could express it.
 */
function client(data: Db, opts: { failTables?: string[] } = {}) {
  const writes: Array<{ table: string; payload: unknown }> = [];
  const fail = new Set(opts.failTables ?? []);
  const DB_DOWN = { code: "57P01", message: "terminating connection due to administrator command", details: null, hint: null };

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];
    const like = (col: string, pat: string) => {
      const re = new RegExp("^" + String(pat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
      filtered = filtered.filter((r) => re.test(String(r[col] ?? "")));
    };
    const answer = (single: boolean) =>
      fail.has(table)
        ? { data: null, error: DB_DOWN }
        : { data: single ? (filtered[0] ?? null) : filtered, error: null };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] === v); return b; },
      neq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] !== v); return b; },
      in: (c: string, v: any[]) => { filtered = filtered.filter((r) => v.includes(r[c])); return b; },
      is: (c: string, v: any) => { filtered = filtered.filter((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      gte: () => b, lte: () => b, not: () => b, order: () => b, or: () => b,
      ilike: (c: string, p: string) => { like(c, p); return b; },
      like: (c: string, p: string) => { like(c, p); return b; },
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve(answer(true)),
      single: () => Promise.resolve(answer(true)),
      then: (res: any) => res(answer(false)),
      update: () => b,
      upsert: (payload: any) => { writes.push({ table, payload }); return b; },
      insert: (payload: any) => { writes.push({ table, payload }); return b; },
      delete: () => { writes.push({ table, payload: "DELETE" }); return b; },
    };
    return b;
  }
  return { sc: { from: (t: string) => builder(t, data[t] ?? []) } as any, writes };
}

const search = (sc: any, who = ALICE) =>
  executeCompassTool(sc, who, profile(), "search_places", { city: "Cebu", query: "view" }) as Promise<any>;
const addToTrip = (sc: any, args: Record<string, unknown>, who = ALICE) =>
  executeCompassTool(sc, who, profile(), "add_to_trip", { tripId: TRIP, ...args }, ) as Promise<any>;

describe("journey — Compass asks, Discovery answers, Trips holds a proposal", () => {
  it("(1) the id Discovery returns is the id Trips accepts", async () => {
    const { sc } = client(db());

    const found = await search(sc);
    assert.ok(Array.isArray(found.candidates) && found.candidates.length === 1,
      `step 1 returned no candidate: ${JSON.stringify(found)}`);
    const chosen = found.candidates[0];

    // THE SEAM. Whatever step 1 called the place, step 2 is handed exactly that.
    const proposed = await addToTrip(sc, { placeId: chosen.id });
    assert.ok(!proposed.error, `step 2 refused step 1's own id: ${proposed.error}`);
    assert.equal(proposed.proposal.placeId, chosen.id,
      "the proposal names a different place from the one the person chose");
    assert.equal(proposed.proposal.tripId, TRIP);
    assert.equal(proposed.proposal.status, "pending_confirmation");
  });

  it("(2) the CATALOG owns the title and category, not the model", async () => {
    const { sc } = client(db());
    const proposed = await addToTrip(sc, {
      placeId: PLACE,
      title: "The Best Restaurant In The World",
      category: "unmissable",
    });
    assert.match(proposed.proposal.title, /Lantaw/,
      "a model-supplied title overwrote a real catalog place's name");
    assert.equal(proposed.proposal.category, "restaurant");
  });

  it("(3) the journey changes NO TRIP STATE — the person confirms, not the model", async () => {
    const { sc, writes } = client(db());
    const found = await search(sc);
    await addToTrip(sc, { placeId: found.candidates[0].id });

    // NOT `writes` being empty, and the first version of this case asserted
    // exactly that and was red for the wrong reason. Step 1 writes a RANKING
    // TELEMETRY row through `rankToolCandidates` — the exposure funnel's record
    // that it served this candidate — and forbidding that would be asserting
    // the opposite of what D11 requires. What must not happen is a change to
    // the TRIP.
    const tripState = writes.filter((w) =>
      ["trip_plan_items", "trips", "trip_members", "trip_plans"].includes(w.table));
    assert.deepEqual(tripState, [],
      "the journey changed trip state; add_to_trip PROPOSES and the app executes on confirmation");
  });

  it("(4) a non-member is refused even holding a real place id", async () => {
    const { sc, writes } = client(db());
    const proposed = await addToTrip(sc, { placeId: PLACE }, CAROL);
    assert.ok(proposed.error, "a non-member was allowed to propose onto someone else's trip");
    assert.deepEqual(writes, []);
  });

  it("(5) an id that is not in the catalog is refused", async () => {
    const { sc } = client(db());
    const proposed = await addToTrip(sc, { placeId: "00000000-0000-0000-0000-00000000dead" });
    assert.ok(proposed.error, "an invented place id produced a proposal");
    assert.match(String(proposed.error), /not found/i);
  });

  it("(6) no coordinates reach the model at EITHER step", async () => {
    const { sc } = client(db());
    const found = await search(sc);
    const proposed = await addToTrip(sc, { placeId: found.candidates[0].id });
    for (const [label, obj] of [["search_places", found], ["add_to_trip", proposed]] as const) {
      const json = JSON.stringify(obj);
      assert.ok(!/10\.2543|123\.9482/.test(json), `${label} leaked a coordinate`);
      assert.ok(!/"lat"|"lng"|"latitude"|"longitude"/.test(json), `${label} leaked a coordinate KEY`);
    }
  });

  it("(7) an UNREADABLE catalog is not reported as 'this place does not exist'", async () => {
    const { sc } = client(db(), { failTables: ["discovery_places"] });

    // Step 1 is already honest and is asserted here as the CONTROL: it proves
    // the fake's failure mode is reaching the code, so (7)'s red cannot be a
    // fixture that quietly does nothing.
    const found = await search(sc);
    assert.deepEqual(found.candidates, []);
    assert.match(String(found.info ?? ""), /unavailable/i,
      "step 1 stopped declaring the outage — the fixture may not be failing the table at all");

    // Step 2 must not turn the same outage into a fact about the world.
    const proposed = await addToTrip(sc, { placeId: PLACE });
    assert.ok(proposed.error, "an unreadable catalog produced a proposal");

    // COMPARED, not grepped. The first version of this assertion was
    // `doesNotMatch(/not found|does not exist|only real catalog/i)` and stayed
    // RED against the correct fix, because the honest message explains itself
    // — "not a statement that the place does not exist" contains the very
    // phrase the regex forbade. A guard whose red can be caused by the fix's
    // own prose is measuring vocabulary, not behaviour, and this is the second
    // time that trap has been sprung in this session.
    //
    // What actually matters is that the two refusals are DIFFERENT: the
    // absent-place answer and the unreadable-catalog answer must not be the
    // same sentence, because a person and a model can only tell them apart if
    // they differ.
    const { sc: healthy } = client(db());
    const absent = await addToTrip(healthy, { placeId: "00000000-0000-0000-0000-00000000dead" });
    assert.notEqual(
      String(proposed.error), String(absent.error),
      "an unreadable catalog produced the SAME sentence as a place that genuinely does not " +
        "exist — a settled answer to a retryable failure, which the model relays as fact",
    );
    assert.match(
      String(proposed.error), /temporar|unreadable|try again/i,
      "the refusal does not say the failure is retryable, so nobody downstream can know to retry",
    );
  });

  it("(8) an unreadable TRIPS table is not answered with a nameless proposal", async () => {
    // (8) EXISTS BECAUSE A MUTATION SURVIVED. `toolAddToTrip` discarded the
    // error on TWO reads, and the fix bound both — but case (7) only pins the
    // catalog one. Deleting the `trips` binding left all seven cases GREEN:
    // the proposal simply came back with `tripTitle: null`, which is exactly
    // what a trip with no title looks like. A person is then shown a proposal
    // for "your trip" while the database that holds it cannot be read.
    //
    // Two reads fixed, one pinned, is one fixed.
    const { sc } = client(db(), { failTables: ["trips"] });
    const proposed = await addToTrip(sc, { placeId: PLACE });
    assert.ok(
      proposed.error,
      `an unreadable trips table produced a proposal instead of a refusal: ${JSON.stringify(proposed)}`,
    );
    assert.match(
      String(proposed.error), /temporar|unreadable|try again/i,
      "the refusal does not say the failure is retryable",
    );
  });
});
