/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-102): the round-13 sweep of bounded reads
 * whose emptiness a Compass tool states as a fact.
 *
 * `search_events` reads `limit * 2` events, drops hidden hosts, then ranks; `get_group_recommendation`
 * reads `limit * 3` events and drops those that fail a member's constraint. When the read reached its
 * cap and nothing survived, the tools said "No matching upcoming public events found." / "No candidates
 * satisfy the whole group's constraints right now." — but more rows existed past the cap, unread. Under
 * the cap the sentence is a fact and is unchanged; at the cap the tool says only the first N were
 * checked.
 *
 *   CR1  search_events: 16 events (the cap at limit 8), every host hidden → never "No matching upcoming public events found."
 *   CR2  get_group_recommendation: 18 events (the cap at limit 6), none fits the group → never "No candidates satisfy …"
 *   CRc  CONTROL: under the cap the same fates keep their sentences
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER, type Call } from "./helpers/compassReadWorld.js";

const HIDDEN = "ff000000-0000-4000-a000-0000000000aa";
const profile = { userId: VIEWER, currentCity: "Paris", blockedUserIds: [HIDDEN], blockerUserIds: [], mutedUserIds: [], interests: ["music"] } as unknown as CompassProfile;
const limitOf = (calls: Call[]) => { const c = calls.find(([k]) => k === "limit"); return c ? Number(c[1][0]) : Infinity; };
const eqCall = (calls: Call[], col: string) => calls.some(([k, a]) => k === "eq" && a[0] === col);
const inCall = (calls: Call[], col: string) => calls.some(([k, a]) => k === "in" && a[0] === col);
const ev = (i: number, over: Record<string, unknown> = {}) => ({ id: `ee000000-0000-4000-a000-${String(i).padStart(12, "0")}`, title: `Event ${i}`, description: null, city: "Paris", country: "FR", starts_at: new Date(Date.now() + 86_400_000 + i * 60_000).toISOString(), category: "music", host_id: HIDDEN, state: "open", visibility: "public", max_attendees: null, going_count: 0, age_min: null, verified_only: false, ...over });
const world = (events: any[]) => compassWorld({
  answer: (t, calls) => {
    if (t === "events") return { data: events.slice(0, limitOf(calls)), error: null };
    if (t === "blocks" && eqCall(calls, "blocker_id")) return { data: [{ blocked_id: HIDDEN }], error: null };  // the tools re-read the hidden set per call
    if (t === "circles" && eqCall(calls, "owner_id")) return { data: [{ id: "c1", name: "Porto crew", owner_id: VIEWER }], error: null };
    if (t === "circle_memberships") return { data: [], error: null };
    if (t === "profiles" && inCall(calls, "id")) return { data: [{ id: VIEWER, interests: ["music"] }], error: null };
    return undefined;
  },
});
const run = async (w: ReturnType<typeof compassWorld>, tool: string, args: Record<string, unknown>) => (await executeCompassTool(w.client as any, VIEWER, profile, tool, args)) as Record<string, any>;
const NO_EVENTS = "No matching upcoming public events found.";
const NO_GROUP = "No candidates satisfy the whole group's constraints right now.";

describe("Compass tools over a capped read that nothing survived (§110, D-W11X2-102)", () => {
  it("CR1 search_events: 16 events at the cap, every host hidden → never 'No matching upcoming public events found.'", async () => {
    const r = await run(world(Array.from({ length: 30 }, (_, i) => ev(i))), "search_events", { city: "Paris" });
    assert.deepEqual(r.candidates, []);
    assert.notEqual(r.info, NO_EVENTS, JSON.stringify(r));
    assert.match(String(r.info), /first \d+/i, JSON.stringify(r));
  });
  it("CR2 get_group_recommendation: 18 events at the cap, none fits the group → never 'No candidates satisfy …'", async () => {
    const r = await run(world(Array.from({ length: 30 }, (_, i) => ev(i, { host_id: `h-${i}`, age_min: 21 }))), "get_group_recommendation", { circleName: "Porto crew", kind: "events", city: "Paris" });
    assert.deepEqual(r.candidates, [], JSON.stringify(r));
    assert.notEqual(r.info, NO_GROUP, JSON.stringify(r));
    assert.match(String(r.info), /first \d+/i, JSON.stringify(r));
  });
  it("CRc CONTROL: under the cap the same fates keep their sentences", async () => {
    const e = await run(world(Array.from({ length: 3 }, (_, i) => ev(i))), "search_events", { city: "Paris" });
    assert.equal(e.info, NO_EVENTS, JSON.stringify(e));
    const g = await run(world(Array.from({ length: 3 }, (_, i) => ev(i, { host_id: `h-${i}`, age_min: 21 }))), "get_group_recommendation", { circleName: "Porto crew", kind: "events", city: "Paris" });
    assert.equal(g.info, NO_GROUP, JSON.stringify(g));
  });
});
