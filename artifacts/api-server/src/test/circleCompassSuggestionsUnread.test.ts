/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-96): GET /circle/compass-suggestions — the
 * "Suggested for your Circle" Compass cards the For You home renders (CircleCompassSuggestions ←
 * app/(tabs)/index.tsx) — never builds a card on a read that failed.
 *
 * Every read in the route was destructured `{ data }` alone, so a failed read became a stated fact on a
 * card (§110.1 BK4): a failed meeting-point read was "No meeting point set yet", a failed caller-presence
 * read was "Enable location sharing with your group" to a traveller who IS sharing, and a failed
 * context-presence read dropped the "N members sharing now" card as if nobody were. Each read's `.error`
 * is now bound: a card is emitted only over inputs that were read, and the body names what could not be
 * read (`refusal`, `circle_suggestions_unread`, partial or nothing, with `failedSources`). A healthy body
 * is byte-identical.
 *
 *   V12-CS0  CONTROL: host, sharing, one other member active, a meeting point set → circle_active only  (verifier probe)
 *   V12-CS1  the circle_meeting_points read fails → never the "No meeting point set yet" card
 *   V12-CS2  the caller's circle_presence read fails (the caller IS sharing) → never "turn on Circle"
 *   CS3      the context's presence read fails → no card for that context, the refusal names it
 *   CS4      the trip_members read fails (no context read) → no card, refusal coverage nothing
 *   CS5      the host read fails → no set_meeting_point card, the other card kept, partial
 *   CSb      CONTROL: a healthy body carries no refusal key — byte-identical
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import circleRouter from "../routes/circle.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "ab000000-0000-4000-a000-0000000000c1";
const OTHER = "ab000000-0000-4000-a000-0000000000c2";
const TRIP = "a1000000-0000-4000-a000-0000000000c9";
const TOKEN = "tok-v12-circle";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };

function client(fail: { meetingPoint?: boolean; callerPresence?: boolean; allPresence?: boolean; tripMembers?: boolean; host?: boolean; noMeetingPoint?: boolean }) {
  const b = (table: string): any => {
    const calls: Array<[string, unknown[]]> = [];
    const eq = (col: string) => calls.find(([k, a]) => k === "eq" && a[0] === col)?.[1][1];
    const answer = (single: boolean) => {
      if (table === "feature_flags") return { data: { enabled: true }, error: null };
      if (table === "trip_members") return fail.tripMembers ? { data: null, error: ERR } : { data: [{ trip_id: TRIP }], error: null };
      if (table === "trips" && fail.host && calls.some(([k, a]) => k === "select" && a[0] === "owner_id")) return { data: null, error: ERR };
      if (table === "trips") return { data: { title: "Lisbon crew", destination_city: "Lisbon", owner_id: VIEWER }, error: null };
      if (table === "circle_presence" && single) return fail.callerPresence ? { data: null, error: ERR } : { data: { status: "active", is_stale: false }, error: null };
      if (table === "circle_presence" && fail.allPresence) return { data: null, error: ERR };
      if (table === "circle_presence") return { data: [{ user_id: VIEWER, status: "active", is_stale: false }, { user_id: OTHER, status: "active", is_stale: false }], error: null };
      if (table === "circle_meeting_points") return fail.meetingPoint ? { data: null, error: ERR } : { data: fail.noMeetingPoint ? null : { id: "mp1" }, error: null };
      void eq;
      return { data: single ? null : [], error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      return (...args: unknown[]) => { calls.push([k, args]); return p; };
    } });
    return p;
  };
  return { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) }, from: b, rpc: () => Promise.resolve({ data: null, error: null }) };
}

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", circleRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => _resetRateLimit());
const cards = async (f: Parameters<typeof client>[0]) => {
  _setTestClient(client(f) as any, true);
  const r = await fetch(`${base}/circle/compass-suggestions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() as any };
};

describe("GET /circle/compass-suggestions over failed per-context reads (verifier probe, §110)", () => {
  it("V12-CS0 CONTROL: host, sharing, one other active, a meeting point set → circle_active only", async () => {
    const { body } = await cards({});
    assert.deepEqual(body.cards?.map((c: any) => c.cardType), ["circle_active"], JSON.stringify(body));
    assert.equal(body.cards[0].metadata.activeCount, 1);
  });
  it("V12-CS1 the meeting-point read fails → never the 'No meeting point set yet' card", async () => {
    const { body } = await cards({ meetingPoint: true });
    assert.ok(!(body.cards ?? []).some((c: any) => c.cardType === "set_meeting_point"), `a failed read was stated as "no meeting point": ${JSON.stringify(body)}`);
  });
  it("V12-CS2 the caller's own presence read fails (the caller IS sharing) → never 'turn on Circle'", async () => {
    const { body } = await cards({ callerPresence: true });
    assert.ok(!(body.cards ?? []).some((c: any) => c.cardType === "turn_on_circle"), `a failed read was stated as "not sharing": ${JSON.stringify(body)}`);
  });
});

describe("GET /circle/compass-suggestions names what it could not read (§110, D-W11X2-96)", () => {
  it("CS3 the context's presence read fails → no card for that context, the refusal names it", async () => {
    const { body } = await cards({ allPresence: true });
    assert.deepEqual(body.cards, [], JSON.stringify(body));
    assert.equal(body.refusal?.code, "circle_suggestions_unread", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["circle_presence"]);
  });
  it("CS4 the trip_members read fails → no card, refusal coverage nothing", async () => {
    const { body } = await cards({ tripMembers: true });
    assert.deepEqual(body.cards, []);
    assert.equal(body.refusal?.coverage, "nothing", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["trip_members"]);
  });
  it("CS5 the host read fails → no set_meeting_point card, circle_active kept, partial", async () => {
    const { body } = await cards({ host: true, noMeetingPoint: true });
    assert.deepEqual(body.cards?.map((c: any) => c.cardType), ["circle_active"], JSON.stringify(body));
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["trips"]);
  });
  it("CSb CONTROL: a healthy body carries no refusal key — byte-identical", async () => {
    const { body } = await cards({ noMeetingPoint: true });
    assert.equal(JSON.stringify(body), '{"cards":[{"cardType":"circle_active","contextType":"trip","contextId":"a1000000-0000-4000-a000-0000000000c9","contextTitle":"Lisbon crew","metadata":{"activeCount":1}},{"cardType":"set_meeting_point","contextType":"trip","contextId":"a1000000-0000-4000-a000-0000000000c9","contextTitle":"Lisbon crew","metadata":{}}]}');
  });
});
