/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B34): Compass's candidate pool over a
 * FAILED live going read never offers a capped event as open.
 *
 * Round 21 (D-W11X2-167) made CompassItemHydrator state `currentAttendees` as the live count of the going RSVPs, or
 * `undefined` when that read fails ("the pool states no attendee count"). The eligibility engine every hydrated item
 * runs through read `item.currentAttendees ?? 0`, so an unread count was taken as nobody going: a FULL event (10 of 10)
 * passed the `event_at_capacity` gate it fails when the count is read, and the failed read was named nowhere. The group
 * tool's ruling for the same read is the opposite (`capacity_could_not_be_checked`, D-W11X2-167).
 *
 *   CE0 CONTROL: a full event (max 10), 10 going read → ineligible `event_at_capacity`, nothing named
 *   CE1 the same event, the live going read FAILS → ineligible `capacity_could_not_be_checked`, and the pool names
 *       `event_rsvps` (a capped event was withheld over a read that failed)
 *   CE2 (the verifier's V26 fixture) the live read is whole and EMPTY, the cached counter 10 → currentAttendees 0, never 10
 *   CE3 an event with no capacity, the live going read FAILS → still eligible (there is no room to check), nothing named
 *   CE4 the engine alone: capacity 10 with 9, 10 and no count read → eligible, `event_at_capacity`,
 *       `capacity_could_not_be_checked`
 *
 * Harness: the verifier's (staleGoingCounterReads CH1/CH2's compassWorld) and the pipeline's own runEligibilityCheck.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hydrateCompassItems, compassHydrationFailedSources } from "../compass/CompassItemHydrator.js";
import { runEligibilityCheck } from "../compass/CompassEligibilityEngine.js";
import type { CompassItem, CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER as CVIEWER, DB_ERR } from "./helpers/compassReadWorld.js";

const EV = "ee000000-0000-4000-a000-000000000001";
const profile = { userId: CVIEWER, currentCity: "Paris", blockedUserIds: [], blockerUserIds: [], mutedUserIds: [], interests: ["music"] } as unknown as CompassProfile;
const going = (n: number) => Array.from({ length: n }, (_, i) => ({ event_id: EV, user_id: `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`, status: "going" }));

async function pool(live: number | "fail", maxAttendees: number | null = 10) {
  const rsvps = live === "fail" ? [] : going(live);
  const w = compassWorld({ answer: (t) => {
    if (t === "events") return { data: [{ id: EV, host_id: "ff000000-0000-4000-a000-000000000001", title: "Jazz night", category: "music", starts_at: new Date(Date.now() + 86_400_000).toISOString(), ends_at: null, city: "Paris", max_attendees: maxAttendees, going_count: 10, visibility: "public", state: "open", location_lat: 48.85, location_lng: 2.35, location_name: "Club", cover_url: null, show_exact_location: true }], error: null };
    if (t === "event_rsvps") return live === "fail" ? { data: null, error: DB_ERR } : ({ data: rsvps, error: null, count: rsvps.length } as any);
    return undefined;
  } });
  const items = await hydrateCompassItems(w.client as any, { ...profile, currentCity: null } as any);
  const ev = items.find((i) => i.type === "event");
  const verdict = ev ? runEligibilityCheck(ev, profile, {} as any, null, {}) : null;
  return { currentAttendees: ev?.currentAttendees ?? null, capacity: ev?.capacity ?? null, verdict, named: [...compassHydrationFailedSources(items)] };
}

describe("census-discovery §119 (B34): Compass's pool never offers a capped event as open over an unread going count", () => {
  it("CE0 CONTROL: 10 of 10 going, read → event_at_capacity, nothing named", async () => {
    const seen = await pool(10);
    assert.deepEqual(seen, { currentAttendees: 10, capacity: 10, verdict: { eligible: false, reason: "event_at_capacity" }, named: [] });
  });
  it("CE1 the live going read FAILS → capacity_could_not_be_checked, and event_rsvps named", async () => {
    const seen = await pool("fail");
    assert.equal(seen.currentAttendees, null, "the pool states no attendee count");
    assert.deepEqual(seen.verdict, { eligible: false, reason: "capacity_could_not_be_checked" }, JSON.stringify(seen));
    assert.deepEqual(seen.named, ["event_rsvps"], JSON.stringify(seen));
  });
  it("CE2 (V26) a whole, empty live read, cached 10 → currentAttendees 0, never the cached counter", async () => {
    const seen = await pool(0);
    assert.equal(seen.currentAttendees, 0);
    assert.deepEqual(seen.verdict, { eligible: true });
    assert.deepEqual(seen.named, []);
  });
  it("CE3 no capacity, the live going read FAILS → eligible, nothing named (no room to check, nothing withheld)", async () => {
    const seen = await pool("fail", null);
    assert.deepEqual({ verdict: seen.verdict, named: seen.named }, { verdict: { eligible: true }, named: [] });
  });
  it("CE4 the engine alone: 9, 10 and no count of 10", () => {
    const item = (currentAttendees?: number): CompassItem => ({ id: EV, type: "event", title: "Jazz night", category: "music", capacity: 10, currentAttendees, visibilityScope: "public", qualityScore: 6, createdAt: new Date().toISOString(), data: {} } as unknown as CompassItem);
    assert.deepEqual(runEligibilityCheck(item(9), profile, {} as any, null, {}), { eligible: true });
    assert.deepEqual(runEligibilityCheck(item(10), profile, {} as any, null, {}), { eligible: false, reason: "event_at_capacity" });
    assert.deepEqual(runEligibilityCheck(item(undefined), profile, {} as any, null, {}), { eligible: false, reason: "capacity_could_not_be_checked" });
  });
});
