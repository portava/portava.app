/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; sweep SW29): Discovery search never serves the viewer's own
 * attendance on an event result over a failed read.
 *
 * `searchEvents` (lib/inputAssistance/searchCandidates.ts) read the viewer's going RSVPs with no error bound and served
 * `actionState: { isAttending: false }` on every result ("you are not going") when the read failed; the client draws its
 * Join button from it. The read is now bound: a failed one still serves the row with its venue gate closed (the
 * search safety contract, discoverySearchSafetyContracts) but with `actionState: null`, the attendance unknown, which
 * the client draws as "View", never "Join".
 *
 *   SE0 CONTROL: the viewer is going → the result carries isAttending true
 *   SE1 the event_rsvps read FAILS → the row served, actionState null, never isAttending false
 *   SE2 CONTROL: not going → isAttending false
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchSearchWithCoverage } from "../lib/inputAssistance/searchCandidates.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const HOST = "22222222-2222-4222-8222-222222222222";
const EVENT = { id: "66666666-6666-4666-8666-666666666666", title: "Rooftop quiz", host_id: HOST, cover_url: null, city: "Lisbon", country: "PT", starts_at: new Date(Date.now() + 86_400_000).toISOString(), visibility: "public", state: "open", created_at: "2026-09-01T00:00:00Z", location_lat: 38.7, location_lng: -9.1, show_exact_location: false };
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };

function client(opts: { going: boolean; failRsvps?: boolean }) {
  const answer = (table: string) => {
    if (table === "events") return { data: [EVENT], error: null };
    if (table === "profiles") return { data: [{ id: HOST }], error: null };
    if (table === "event_rsvps") return opts.failRsvps ? { data: null, error: ERR } : { data: opts.going ? [{ event_id: EVENT.id }] : [], error: null };
    return { data: [], error: null };
  };
  return {
    from: (table: string) => {
      const b: any = new Proxy({}, { get: (_t, k: string) => (k === "then" ? (f: any, r: any) => Promise.resolve(answer(table)).then(f, r) : () => b) });
      return b;
    },
  };
}
const run = (c: any) => dispatchSearchWithCoverage(c, "Rooftop", VIEWER, new Set(), new Set(), "events", 0, 10);

describe("census-discovery §122 (SW29): search never says 'not going' over a failed RSVP read", () => {
  it("SE0 CONTROL: going → isAttending true", async () => {
    const { results } = await run(client({ going: true }));
    assert.deepEqual(results.map((r) => [r.id, r.actionState]), [[EVENT.id, { isAttending: true }]]);
  });
  it("SE1 the event_rsvps read FAILS → the row served, actionState null", async () => {
    const { results } = await run(client({ going: true, failRsvps: true }));
    assert.deepEqual(results.map((r) => [r.id, r.actionState]), [[EVENT.id, null]]);
  });
  it("SE2 CONTROL: not going → isAttending false", async () => {
    const { results } = await run(client({ going: false }));
    assert.deepEqual(results.map((r) => [r.id, r.actionState]), [[EVENT.id, { isAttending: false }]]);
  });
});
