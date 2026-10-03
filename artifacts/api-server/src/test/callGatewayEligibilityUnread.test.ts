/**
 * census-discovery §113 (round 16, lane W11-X2, D-W11X2-134; outside DV-83, census-telegraph's call gateway): the call
 * gateway never states a failed eligibility read as a fact about the viewer.
 *
 * `eventRoomIneligibility` (lib/calls/callGatewayAdapter.ts) did not read `checkEventEligibility`'s `unread` marker: it
 * mapped the refusal MESSAGE by substring, and the age seam's unread message ("Your age could not be checked right now")
 * contains "age", so a failed age read became `age_ineligible` — "This event's voice room isn't available for your age
 * group" (the round-15 verifier's N1). Every other unread arm, and a failed events, staff-role or RSVP read, became
 * `not_event_eligible` — "This voice room is for event attendees". All fail closed; none is true.
 *
 *   V15-CG0  CONTROL (the verifier's): a readable profile aged 16 → age_ineligible
 *   V15-CG1  (the verifier's) the profiles (age) read FAILS → never age_ineligible
 *   CG1b     the same → `degraded_unavailable`, the gateway's retryable "could not check" outcome
 *   CG2      the block read fails (the eligibility check's own unread arm) → degraded_unavailable, not not_event_eligible
 *   CG3      the events read fails → degraded_unavailable, never "for attendees"
 *   CG4      the RSVP read fails → degraded_unavailable, never "for attendees"
 *   CG5      the staff-role read fails → degraded_unavailable
 *   CG5b     only the gateway's OWN staff-role read fails: with no RSVP → degraded_unavailable; with a going RSVP → admitted (an attendee is one either way)
 *   CG6      the engine: joining an event room over an unread age gate → denied `degraded_unavailable` (503, retryable)
 *   CGc      CONTROL: a readable adult with an RSVP → eligible; a readable adult with none → not_event_eligible
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeCallGateway } from "../lib/calls/callGatewayAdapter.js";
import { canUserJoinCall } from "../lib/calls/callPermissionEngine.js";

const EV = { id: "ev-1", host_id: "host-1", age_min: 18, age_max: null, trust_score_min: null, verified_only: false, state: "open", visibility: "public" };
const ERR = { message: "boom" };
let staffReads = 0; let failStaffRead = 0;
function q(rows: any[], error: any = null) {
  let r = [...rows];
  const o: any = {
    select() { return o; }, in(c: string) { if (c === "role" && ++staffReads === failStaffRead) error = ERR; return o; }, or() { return o; }, limit() { return o; }, order() { return o; }, is() { return o; }, not() { return o; },
    eq(c: string, v: any) { r = r.filter((x) => !(c in x) || x[c] === v); return o; },
    maybeSingle() { return Promise.resolve(error ? { data: null, error } : { data: r[0] ?? null, error: null }); },
    then(a: any, b: any) { return Promise.resolve(error ? { data: null, error } : { data: r, error: null }).then(a, b); },
  };
  return o;
}
const adultDob = new Date(Date.now() - 30 * 365.25 * 86400e3).toISOString().slice(0, 10);
function sc(over: { profiles?: { rows?: any[]; error?: any }; fail?: string[]; rsvp?: string | null } = {}) {
  const fail = new Set(over.fail ?? []);
  return {
    from(t: string) {
      if (fail.has(t)) return q([], ERR);
      if (t === "events") return q([EV]);
      if (t === "feature_flags") return q([{ flag: "events_trust_gates_enabled", enabled: true }]);
      if (t === "profiles") return q(over.profiles?.rows ?? [{ id: "viewer-1", date_of_birth: adultDob }], over.profiles?.error ?? null);
      if (t === "event_rsvps") return q(over.rsvp ? [{ event_id: "ev-1", user_id: "viewer-1", status: over.rsvp }] : []);
      return q([]);
    },
    rpc: async () => ({ data: null, error: null }),
  } as any;
}

describe("§113 (D-W11X2-134): the call gateway over an unread eligibility read", () => {
  it("V15-CG0 CONTROL: a readable profile aged 16 → age_ineligible", async () => {
    const dob = new Date(Date.now() - 16 * 365.25 * 86400e3).toISOString().slice(0, 10);
    const r = await makeCallGateway(sc({ profiles: { rows: [{ id: "viewer-1", date_of_birth: dob }] } })).eventRoomIneligibility("ev-1", "viewer-1");
    assert.equal(r, "age_ineligible");
  });
  it("V15-CG1 the profiles (age) read FAILS → never age_ineligible (a statement about the viewer's age)", async () => {
    const r = await makeCallGateway(sc({ profiles: { error: ERR } })).eventRoomIneligibility("ev-1", "viewer-1");
    assert.notEqual(r, "age_ineligible", "a failed age read is reported as the viewer's age group");
  });
  it("CG1b the same → degraded_unavailable", async () => {
    const r = await makeCallGateway(sc({ profiles: { error: ERR } })).eventRoomIneligibility("ev-1", "viewer-1");
    assert.equal(r, "degraded_unavailable");
  });
  it("CG2 the block read fails → degraded_unavailable, not not_event_eligible", async () => {
    const r = await makeCallGateway(sc({ fail: ["blocks"], rsvp: "going" })).eventRoomIneligibility("ev-1", "viewer-1");
    assert.equal(r, "degraded_unavailable");
  });
  it("CG3 the events read fails → degraded_unavailable, never 'for attendees'", async () => {
    const r = await makeCallGateway(sc({ fail: ["events"] })).eventRoomIneligibility("ev-1", "viewer-1");
    assert.equal(r, "degraded_unavailable");
  });
  it("CG4 the RSVP read fails → degraded_unavailable, never 'for attendees'", async () => {
    const r = await makeCallGateway(sc({ fail: ["event_rsvps"] })).eventRoomIneligibility("ev-1", "viewer-1");
    assert.equal(r, "degraded_unavailable");
  });
  it("CG5 the staff-role read fails → degraded_unavailable", async () => {
    const r = await makeCallGateway(sc({ fail: ["event_roles"], rsvp: "going" })).eventRoomIneligibility("ev-1", "viewer-1");
    assert.equal(r, "degraded_unavailable");
  });
  it("CG5b only the gateway's own staff-role read fails → no RSVP: degraded_unavailable; a going RSVP: admitted", async () => {
    staffReads = 0; failStaffRead = 2;
    try {
      const r = await makeCallGateway(sc({})).eventRoomIneligibility("ev-1", "viewer-1");
      assert.equal(staffReads, 2, "the eligibility check's staff read, then the gateway's own");
      assert.equal(r, "degraded_unavailable");
      staffReads = 0;
      assert.equal(await makeCallGateway(sc({ rsvp: "going" })).eventRoomIneligibility("ev-1", "viewer-1"), null);
    } finally { failStaffRead = 0; }
  });
  it("CG6 the engine: joining an event room over an unread age gate → denied degraded_unavailable", async () => {
    const real = makeCallGateway(sc({ profiles: { error: ERR } }));
    const gw = { ...real, isSessionTerminated: async () => false, wasRemovedFromCall: async () => false } as any;
    const r: any = await canUserJoinCall(gw, { userId: "viewer-1", callId: "call-1", contextType: "event", contextId: "ev-1", threadId: null } as any).catch((e: unknown) => ({ thrown: String(e) }));
    assert.equal(r.allowed ?? r.ok ?? null, false, JSON.stringify(r));
    assert.equal(r.reason, "degraded_unavailable", JSON.stringify(r));
  });
  it("CGc CONTROL: a readable adult with an RSVP → eligible; with none → not_event_eligible", async () => {
    assert.equal(await makeCallGateway(sc({ rsvp: "going" })).eventRoomIneligibility("ev-1", "viewer-1"), null);
    assert.equal(await makeCallGateway(sc({})).eventRoomIneligibility("ev-1", "viewer-1"), "not_event_eligible");
  });
});
