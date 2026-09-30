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

// ── census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-106): the round-13 verifier's V13-SP1, SE1, GP1, GE1 ──
// D-W11X2-102 reached two of six sites. `search_places` and the group recommendation's places branch read
// `.limit(limit)` with no cap test; `search_events` and the group events branch test the SQL cap but keep
// `.slice(0, limit)` after it, so rows the slice dropped were never checked and "none" was stated over them.
// A per-city launch gate withholds every row the pipeline sees (rows 0..7 in the unlaunched Lyon).
const cityOf13 = (i: number) => (i < 8 ? "Lyon" : "Paris");
const place13 = (i: number) => ({ id: `11111111-1111-4111-a111-${String(i).padStart(12, "0")}`, name: `Place ${i}`, blurb: null, category: "food", primary_category: "food", city: cityOf13(i), rating: 4, saved_count: 0, verified: true, status: "active" });
const ev13 = (i: number, n: number) => ({ ...ev(i), city: i < n ? "Lyon" : "Paris", host_id: `ff000000-0000-4000-a000-${String(100 + i).padStart(12, "0")}` });
const LAUNCH13 = { COMPASS_ENABLED: true, COMPASS_V1_RULE_BASED_ENABLED: true, COMPASS_CITY_LAUNCH_REQUIRED: true, COMPASS_CITY_LYON_ENABLED: false, COMPASS_CITY_PARIS_ENABLED: true };
const OPEN13 = { COMPASS_ENABLED: true, COMPASS_V1_RULE_BASED_ENABLED: true };
function world13(flags: Record<string, boolean>, places: any[], events: any[]) {
  return compassWorld({
    flags,
    answer: (t, calls) => {
      if (t === "discovery_places") return { data: places.slice(0, limitOf(calls)), error: null };
      if (t === "events") return { data: events.slice(0, limitOf(calls)), error: null };
      if (t === "blocks" && eqCall(calls, "blocker_id")) return { data: [{ blocked_id: HIDDEN }], error: null };
      if (t === "circles" && eqCall(calls, "owner_id")) return { data: [{ id: "c1", name: "Porto crew", owner_id: VIEWER }], error: null };
      if (t === "circle_memberships") return { data: [], error: null };
      if (t === "profiles" && inCall(calls, "id")) return { data: [{ id: VIEWER, interests: ["music"] }], error: null };
      return undefined;
    },
  });
}
const NO_PLACES = "No matching places found in the catalog.";

describe("Compass tool reads cut by a cap or a slice, then emptied by the pipeline (§111, D-W11X2-106; the round-13 verifier's probes)", () => {
  it("V13-CT0 CONTROL: launch gate off → candidates offered from the same reads", async () => {
    const p = await run(world13(OPEN13, Array.from({ length: 12 }, (_, i) => place13(i)), []), "search_places", { query: "place" });
    assert.ok(p.candidates.length > 0, JSON.stringify(p));
    const e = await run(world13(OPEN13, [], Array.from({ length: 12 }, (_, i) => ev13(i, 8))), "search_events", {});
    assert.ok(e.candidates.length > 0, JSON.stringify(e));
  });
  it("V13-SP1 search_places at its cap, every read row withheld → never 'No matching places found in the catalog.'", async () => {
    const r = await run(world13(LAUNCH13, Array.from({ length: 12 }, (_, i) => place13(i)), []), "search_places", { query: "place" });
    assert.deepEqual(r.candidates, [], JSON.stringify(r));
    assert.notEqual(r.info, NO_PLACES, JSON.stringify(r));
    assert.match(String(r.info), /first 8 /i, JSON.stringify(r));
  });
  it("V13-SE1 search_events: 12 read, 8 kept by the slice and withheld → never 'No matching upcoming public events found.'", async () => {
    const r = await run(world13(LAUNCH13, [], Array.from({ length: 12 }, (_, i) => ev13(i, 8))), "search_events", {});
    assert.notEqual(r.info, NO_EVENTS, JSON.stringify(r));
    assert.match(String(r.info), /first 8 /i, JSON.stringify(r));
  });
  it("V13-GP1 get_group_recommendation (places) at its cap, every row withheld → never 'No candidates satisfy …'", async () => {
    const r = await run(world13(LAUNCH13, Array.from({ length: 12 }, (_, i) => place13(i)), []), "get_group_recommendation", { circleName: "Porto crew", kind: "places" });
    assert.notEqual(r.info, NO_GROUP, JSON.stringify(r));
    assert.match(String(r.info), /first 6 matching places/i, JSON.stringify(r));
  });
  it("V13-GE1 get_group_recommendation (events): 10 fit, 6 kept by the slice and withheld → never 'No candidates satisfy …'", async () => {
    const r = await run(world13(LAUNCH13, [], Array.from({ length: 10 }, (_, i) => ev13(i, 6))), "get_group_recommendation", { circleName: "Porto crew", kind: "events", limit: 6 });
    assert.notEqual(r.info, NO_GROUP, JSON.stringify(r));
    assert.match(String(r.info), /first 6 matching events/i, JSON.stringify(r));
  });
  it("CS1c CONTROL: under the cap and with nothing sliced away, every row withheld keeps the 'none' sentence", async () => {
    const p = await run(world13(LAUNCH13, Array.from({ length: 3 }, (_, i) => place13(i)), []), "search_places", { query: "place" });
    assert.equal(p.info, NO_PLACES, JSON.stringify(p));
    const e = await run(world13(LAUNCH13, [], Array.from({ length: 3 }, (_, i) => ev13(i, 8))), "search_events", {});
    assert.equal(e.info, NO_EVENTS, JSON.stringify(e));
    const g = await run(world13(LAUNCH13, Array.from({ length: 3 }, (_, i) => place13(i)), []), "get_group_recommendation", { circleName: "Porto crew", kind: "places" });
    assert.equal(g.info, NO_GROUP, JSON.stringify(g));
    const ge = await run(world13(LAUNCH13, [], Array.from({ length: 3 }, (_, i) => ev13(i, 8))), "get_group_recommendation", { circleName: "Porto crew", kind: "events", limit: 6 });
    assert.equal(ge.info, NO_GROUP, JSON.stringify(ge));
  });
  it("CS2c CONTROL: exactly `limit` rows kept and withheld, none sliced away and the read under its cap → 'none' stands", async () => {
    const e = await run(world13(LAUNCH13, [], Array.from({ length: 8 }, (_, i) => ev13(i, 8))), "search_events", {});
    assert.equal(e.info, NO_EVENTS, JSON.stringify(e));
    const ge = await run(world13(LAUNCH13, [], Array.from({ length: 6 }, (_, i) => ev13(i, 8))), "get_group_recommendation", { circleName: "Porto crew", kind: "events", limit: 6 });
    assert.equal(ge.info, NO_GROUP, JSON.stringify(ge));
  });
  it("CS3c CONTROL: more rows read than `limit`, but hidden hosts leave no more than `limit` → nothing was sliced away, 'none' stands", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => (i < 3 ? { ...ev13(i, 10), host_id: HIDDEN } : ev13(i, 10)));
    const e = await run(world13(LAUNCH13, [], rows), "search_events", {});
    assert.deepEqual(e.candidates, [], JSON.stringify(e));
    assert.equal(e.info, NO_EVENTS, JSON.stringify(e));
  });
});
