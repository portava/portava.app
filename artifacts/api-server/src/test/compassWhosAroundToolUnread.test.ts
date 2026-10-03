/**
 * census-discovery §107 sweep (DV-83 round 10, lane W11-X2, register D-W11X2-73): Compass's
 * `get_whos_around` tool never tells the model "nobody is around" or "no active trips" over a
 * presence read that failed.
 *
 * The tool read `getWhosAround`, whose reads were all "non-fatal": a failed trip-membership or RSVP
 * read gave `contextsChecked: 0`, which the tool phrased as "The user has no active trips or
 * upcoming events with a circle to check." — a claim about the user's trips made from a read that
 * did not answer — and a failed member or consent read gave "Nobody in the user's circles is
 * sharing their presence right now." `getWhosAround` now says `unread` (D-W11X2-67); the tool says
 * the check could not be completed instead.
 *
 *   WA1  the viewer's trip and RSVP reads fail → info says presence could not be checked
 *   WA2  a context's member read fails → the same, never "nobody is sharing"
 *   WAc  CONTROL: every read answered, no trips → the old "no active trips" info
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, eqValue, VIEWER, DB_ERR } from "./helpers/compassReadWorld.js";

const TRIP = "a1000000-0000-4000-a000-000000000001";
const profile = { userId: VIEWER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
const run = async (world: ReturnType<typeof compassWorld>) => (await executeCompassTool(world.client as any, VIEWER, profile, "get_whos_around", {})) as { people: unknown[]; info: string };

describe("census-discovery §107 sweep (D-W11X2-73): get_whos_around over a failed presence read", () => {
  it("WA1 the viewer's trip and RSVP reads fail → presence could not be checked, never 'no active trips'", async () => {
    const r = await run(compassWorld({ failTables: ["trip_members", "event_rsvps"] }));
    assert.deepEqual(r.people, []);
    assert.doesNotMatch(r.info, /no active trips/);
    assert.match(r.info, /could not be checked/);
  });

  it("WA2 a context's member read fails → could not be checked, never 'nobody is sharing'", async () => {
    const r = await run(compassWorld({ answer: (table, calls) => {
      if (table === "trip_members" && eqValue(calls, "trip_id")) return { data: null, error: DB_ERR };
      if (table === "trip_members" && eqValue(calls, "user_id") === VIEWER) return { data: [{ trip_id: TRIP, role: "owner", status: "accepted" }], error: null };
      if (table === "trips") return { data: [{ id: TRIP, title: "Paris trip", destination_city: "Paris", status: "active" }], error: null };
      return undefined;
    } }));
    assert.doesNotMatch(r.info, /Nobody in the user's circles/);
    assert.match(r.info, /could not be checked/);
  });

  it("WAc CONTROL: every read answered, no trips → the old 'no active trips' info", async () => {
    const r = await run(compassWorld({}));
    assert.match(r.info, /no active trips/);
  });
});
