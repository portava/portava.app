/**
 * census-discovery §109 (DV-83 round 12, lane W11-X2, D-W11X2-89): the round-12 sweep of the Compass
 * tools' "nothing found" sentences. Each is stated to the model as a fact; over a failed read it
 * was a false one.
 *
 *   TT1   eight trip tools resolve "the current trip" through `toolGetCurrentTrip`, which says
 *         "Trip context unavailable: …" over an unread trips read — and each dropped that and told
 *         the model "No active or upcoming trip." (get_freedom_windows, get_route_chain,
 *         get_today_state, get_crew_state, get_live_conditions, get_commitments, get_saved_ideas,
 *         get_opportunities). Each now passes the unread on.
 *   TT2   search_places' priority-switch reading said "No active or upcoming trip" over the same.
 *   TTc   CONTROL: a user with no trip, every read healthy → "No active or upcoming trip." unchanged.
 *   GR1   get_group_recommendation, a named circle, the circles read fails → never "not a member of a circle by that name"
 *   GR2   the named circle is found, its members read fails → no recommendation over a partial group (fail closed), said
 *   GR3   no circle named, the current trip unread → never "no active or upcoming trip group"
 *   GR4   no circle named, the trip found, its members read fails → no recommendation over a partial group, said
 *   GR5   a named circle the user only JOINED, the joined-circles read fails → never "not a member of a circle by that name"
 *   GR6   a named circle the user only JOINED, the viewer's memberships read fails → never "not a member of a circle by that name"
 *   GRc   CONTROL: a named circle the user is not in, every read healthy → "not a member of a circle by that name"
 *   PD1   get_place_details, the discovery_places read fails → never "Place not found."
 *   PDc   CONTROL: no such place, the read healthy → "Place not found."
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER, DB_ERR, type Call } from "./helpers/compassReadWorld.js";

const profile = { userId: VIEWER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
const TRIP = "a1000000-0000-4000-a000-0000000000aa";
const NO_TRIP = "No active or upcoming trip.";
const run = async (w: ReturnType<typeof compassWorld>, tool: string, args: Record<string, unknown> = {}) =>
  (await executeCompassTool(w.client as any, VIEWER, profile, tool, args)) as Record<string, any>;
const eqCall = (calls: Call[], column: string) => calls.some(([k, a]) => k === "eq" && a[0] === column);
const inCall = (calls: Call[], column: string) => calls.some(([k, a]) => k === "in" && a[0] === column);
const failed = { data: null, error: DB_ERR };

const TRIP_TOOLS = ["get_freedom_windows", "get_route_chain", "get_today_state", "get_crew_state", "get_live_conditions", "get_commitments", "get_saved_ideas", "get_opportunities"];

describe("Compass trip tools over an unread current trip (§109, D-W11X2-89)", () => {
  it("TT1 each trip tool passes the unread on — never 'No active or upcoming trip.'", async () => {
    for (const tool of TRIP_TOOLS) {
      const r = await run(compassWorld({ failTables: ["trip_members"] }), tool);
      assert.notEqual(r.info, NO_TRIP, `${tool} stated a failed read as "no trip": ${JSON.stringify(r)}`);
      assert.match(String(r.info), /could not be read/i, `${tool}: ${JSON.stringify(r)}`);
    }
  });

  it("TT2 search_places: the priority switch over an unread current trip is not 'no trip'", async () => {
    const r = await run(compassWorld({ failTables: ["trip_members"] }), "search_places", { query: "coffee" });
    const info = String(r.attention?.info ?? "");
    assert.doesNotMatch(info, /No active or upcoming trip/, JSON.stringify(r.attention));
    assert.match(info, /could not be read/i, JSON.stringify(r.attention));
  });

  it("TTc CONTROL: no trip, every read healthy → 'No active or upcoming trip.' unchanged", async () => {
    for (const tool of TRIP_TOOLS) {
      const r = await run(compassWorld(), tool);
      assert.equal(r.info, NO_TRIP, `${tool}: ${JSON.stringify(r)}`);
    }
    const s = await run(compassWorld(), "search_places", { query: "coffee" });
    assert.equal(s.attention?.info, "No active or upcoming trip; the priority switch was not consulted.");
  });
});

describe("get_group_recommendation over failed group reads (§109, D-W11X2-89)", () => {
  const circleWorld = (fail: { owned?: boolean; members?: boolean } = {}) => compassWorld({
    answer: (t, calls) => {
      if (t === "circles" && eqCall(calls, "owner_id")) return fail.owned ? failed : { data: [{ id: "c1", name: "Porto crew", owner_id: VIEWER }], error: null };
      if (t === "circle_memberships" && eqCall(calls, "user_id")) return fail.members ? failed : { data: [], error: null };
      return undefined;
    },
  });

  it("GR1 the circles read fails → never 'not a member of a circle by that name'", async () => {
    const r = await run(circleWorld({ owned: true }), "get_group_recommendation", { circleName: "Porto crew" });
    assert.deepEqual(r.candidates, []);
    assert.doesNotMatch(String(r.info), /not a member of a circle by that name/, JSON.stringify(r));
    assert.match(String(r.info), /could not be (read|checked)/i, JSON.stringify(r));
  });

  it("GR2 the circle is found, its members read fails → no recommendation over a partial group", async () => {
    const r = await run(circleWorld({ members: true }), "get_group_recommendation", { circleName: "Porto crew" });
    assert.deepEqual(r.candidates, [], JSON.stringify(r));
    assert.match(String(r.info), /members could not be read/i, JSON.stringify(r));
  });

  it("GR3 no circle named, the current trip unread → never 'no active or upcoming trip group'", async () => {
    const r = await run(compassWorld({ failTables: ["trip_members"] }), "get_group_recommendation", {});
    assert.deepEqual(r.candidates, []);
    assert.doesNotMatch(String(r.info), /no active or upcoming trip group/, JSON.stringify(r));
    assert.match(String(r.info), /could not be read/i, JSON.stringify(r));
  });

  it("GR4 no circle named, the trip found, its members read fails → no recommendation over a partial group", async () => {
    const w = compassWorld({
      answer: (t, calls, single) => {
        const row = { id: TRIP, title: "Porto", destination_city: "Porto", destination_country: "PT", start_date: "2026-10-01", end_date: "2026-10-05", status: "active", owner_id: VIEWER, version: 1 };
        if (t === "trips") return { data: single ? row : [row], error: null };
        if (t === "trip_members" && eqCall(calls, "trip_id") && inCall(calls, "role")) return failed;
        return undefined;
      },
    });
    const r = await run(w, "get_group_recommendation", {});
    assert.deepEqual(r.candidates, [], JSON.stringify(r));
    assert.match(String(r.info), /members could not be read/i, JSON.stringify(r));
  });

  it("GR5 the joined-circles read fails and the circle is not an owned one → never 'not a member of a circle by that name'", async () => {
    const w = compassWorld({
      answer: (t, calls) => {
        if (t === "circles" && eqCall(calls, "owner_id")) return { data: [], error: null };
        if (t === "circle_memberships" && eqCall(calls, "other_id")) return { data: [{ user_id: "a7000000-0000-4000-a000-000000000007", status: "accepted" }], error: null };
        if (t === "circles" && inCall(calls, "owner_id")) return failed;
        return undefined;
      },
    });
    const r = await run(w, "get_group_recommendation", { circleName: "Joined crew" });
    assert.deepEqual(r.candidates, []);
    assert.doesNotMatch(String(r.info), /not a member of a circle by that name/, JSON.stringify(r));
    assert.match(String(r.info), /could not be (read|checked)/i, JSON.stringify(r));
  });

  it("GR6 the viewer's circle_memberships read fails (the circle is a joined one) → never 'not a member of a circle by that name'", async () => {
    const w = compassWorld({
      answer: (t, calls) => {
        if (t === "circles" && eqCall(calls, "owner_id")) return { data: [], error: null };
        if (t === "circle_memberships" && eqCall(calls, "other_id")) return failed;
        return undefined;
      },
    });
    const r = await run(w, "get_group_recommendation", { circleName: "Joined crew" });
    assert.deepEqual(r.candidates, []);
    assert.doesNotMatch(String(r.info), /not a member of a circle by that name/, JSON.stringify(r));
    assert.match(String(r.info), /could not be (read|checked)/i, JSON.stringify(r));
  });

  it("GRc CONTROL: a named circle the user is not in → 'not a member of a circle by that name'", async () => {
    const r = await run(circleWorld(), "get_group_recommendation", { circleName: "Lisbon crew" });
    assert.equal(r.info, "The user is not a member of a circle by that name.");
  });
});

describe("get_place_details over a failed read (§109, D-W11X2-89)", () => {
  it("PD1 the discovery_places read fails → never 'Place not found.'", async () => {
    const r = await run(compassWorld({ failTables: ["discovery_places"] }), "get_place_details", { placeId: "11111111-1111-4111-a111-111111111111" });
    assert.equal(r.place, null);
    assert.notEqual(r.info, "Place not found.", JSON.stringify(r));
    assert.match(String(r.info), /could not be read/i);
  });

  it("PDc CONTROL: no such place → 'Place not found.'", async () => {
    const r = await run(compassWorld({ answer: (t) => (t === "discovery_places" ? { data: null, error: null } : undefined) }), "get_place_details", { placeId: "11111111-1111-4111-a111-111111111111" });
    assert.equal(r.info, "Place not found.");
  });
});
