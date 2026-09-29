/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-92): the Compass search tools never
 * state a failed COMPASS_% flag read as an empty catalog.
 *
 * `rankToolCandidates` runs the one ranking pipeline. `runPipeline` reads the COMPASS_% flags
 * UNCACHED; a failed read answers the fail-safe map, which engages every
 * `COMPASS_<TYPE>_SAFETY_BLOCK`, so every candidate is blocked and the summary says
 * `flagsUnreadable: true` (§103, D-W11X2-49). The tools kept `results` alone and read "zero
 * survivors" as "every candidate intentionally gated out", so search_places, search_events and
 * get_group_recommendation told the model "No matching …" (§110.1 BK1). The ranking now carries the
 * unread state: nothing is offered (the safety gate is never skipped — no unranked fallback) and the
 * answer says the catalog could not be checked.
 *
 *   V12-SP0  CONTROL: flags readable → the catalog place is a candidate            (verifier probe)
 *   V12-SP1  search_places, the flag read fails → never "No matching places found in the catalog."
 *   V12-SE0  CONTROL: flags readable → the event is a candidate
 *   V12-SE1  search_events, the flag read fails → never "No matching upcoming public events found."
 *   FU1      search_places / search_events over an unread flag read: no candidate, the unread said
 *   FU2      get_group_recommendation over an unread flag read → never "No candidates satisfy …"
 *   FUc      CONTROL: a healthy read that matches nothing is still "No matching places found in the catalog."
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER, type Call } from "./helpers/compassReadWorld.js";

const profile = { userId: VIEWER, currentCity: "Paris", blockedUserIds: [], blockerUserIds: [], mutedUserIds: [], interests: ["food"] } as unknown as CompassProfile;
const EVENT = { id: "ee000000-0000-4000-a000-0000000000a1", title: "Jazz night", description: null, city: "Paris", country: "FR", starts_at: new Date(Date.now() + 86_400_000).toISOString(), category: "music", host_id: "ff000000-0000-4000-a000-000000000001", state: "open", visibility: "public" };
const eventsWorld = (flagsFail: boolean) => compassWorld({ flagsFail, answer: (t) => (t === "events" ? { data: [EVENT], error: null } : undefined) });
type Tool = { candidates: any[]; info?: string; ranked?: boolean };
const UNREAD = /could not check its safety settings/i;
const eqCall = (calls: Call[], column: string) => calls.some(([k, a]) => k === "eq" && a[0] === column);

beforeEach(() => invalidateFlagsCache());

describe("the Compass search tools over a failed COMPASS_% flag read (§110, D-W11X2-92)", () => {
  it("V12-SP0 CONTROL: flags readable → the catalog place is a candidate", async () => {
    const r = (await executeCompassTool(compassWorld().client as any, VIEWER, profile, "search_places", { query: "place", city: "Paris" })) as Tool;
    assert.equal(r.candidates.length, 1, JSON.stringify(r));
  });
  it("V12-SP1 search_places, the flag read fails → never 'No matching places found in the catalog.'", async () => {
    const r = (await executeCompassTool(compassWorld({ flagsFail: true }).client as any, VIEWER, profile, "search_places", { query: "place", city: "Paris" })) as Tool;
    assert.notEqual(r.info, "No matching places found in the catalog.", `a failed flag read was stated as an empty catalog: ${JSON.stringify(r)}`);
  });
  it("V12-SE0 CONTROL: flags readable → the event is a candidate", async () => {
    const r = (await executeCompassTool(eventsWorld(false).client as any, VIEWER, profile, "search_events", { city: "Paris" })) as Tool;
    assert.equal(r.candidates.length, 1, JSON.stringify(r));
  });
  it("V12-SE1 search_events, the flag read fails → never 'No matching upcoming public events found.'", async () => {
    const r = (await executeCompassTool(eventsWorld(true).client as any, VIEWER, profile, "search_events", { city: "Paris" })) as Tool;
    assert.notEqual(r.info, "No matching upcoming public events found.", `a failed flag read was stated as no events: ${JSON.stringify(r)}`);
  });

  it("FU1 over an unread flag read nothing is offered (no unranked fallback) and the unread is said", async () => {
    const p = (await executeCompassTool(compassWorld({ flagsFail: true }).client as any, VIEWER, profile, "search_places", { query: "place", city: "Paris" })) as Tool;
    assert.deepEqual(p.candidates, [], JSON.stringify(p));
    assert.match(String(p.info), UNREAD, JSON.stringify(p));
    const e = (await executeCompassTool(eventsWorld(true).client as any, VIEWER, profile, "search_events", { city: "Paris" })) as Tool;
    assert.deepEqual(e.candidates, [], JSON.stringify(e));
    assert.match(String(e.info), UNREAD, JSON.stringify(e));
  });

  it("FU2 get_group_recommendation over an unread flag read → never 'No candidates satisfy the whole group's constraints'", async () => {
    const world = (flagsFail: boolean) => compassWorld({
      flagsFail,
      answer: (t, calls) => {
        if (t === "circles" && eqCall(calls, "owner_id")) return { data: [{ id: "c1", name: "Porto crew", owner_id: VIEWER }], error: null };
        if (t === "circle_memberships") return { data: [], error: null };
        if (t === "profiles" && calls.some(([k, a]) => k === "in" && a[0] === "id")) return { data: [{ id: VIEWER, budget_style: "mid", interests: ["food"] }], error: null };
        return undefined;
      },
    });
    const healthy = (await executeCompassTool(world(false).client as any, VIEWER, profile, "get_group_recommendation", { circleName: "Porto crew", kind: "places", city: "Paris" })) as Tool;
    assert.ok(healthy.candidates.length > 0, `control: ${JSON.stringify(healthy)}`);
    const r = (await executeCompassTool(world(true).client as any, VIEWER, profile, "get_group_recommendation", { circleName: "Porto crew", kind: "places", city: "Paris" })) as Tool;
    assert.deepEqual(r.candidates, [], JSON.stringify(r));
    assert.notEqual(r.info, "No candidates satisfy the whole group's constraints right now.", `a failed flag read was stated as no candidates: ${JSON.stringify(r)}`);
    assert.match(String(r.info), UNREAD, JSON.stringify(r));
  });

  it("FUc CONTROL: a healthy read that matches nothing is still 'No matching places found in the catalog.'", async () => {
    const w = compassWorld({ answer: (t) => (t === "discovery_places" ? { data: [], error: null } : undefined) });
    const r = (await executeCompassTool(w.client as any, VIEWER, profile, "search_places", { query: "nothing", city: "Paris" })) as Tool;
    assert.equal(r.info, "No matching places found in the catalog.", JSON.stringify(r));
  });
});
