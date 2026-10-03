/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-107, D-W11X2-108): `checkEventEligibility`'s
 * block check and staff-role read, and GET /events/:id's own block check, are three-state.
 *
 * The block check (`isBlocked` → lib/blockGuard.ts `isBlockedBetween`) answers `true` on a failed read,
 * and the staff-role read bound no error. Neither was marked `unread`, so an event withheld over a FAILED
 * read was withheld as a verdict: GET /map/search reported its events source complete and empty, the NOW
 * gateway named the events layer as read, and GET /events/:id answered "not found" (§111.1 B2, B3;
 * D-W11X2-93's "argued, not built" and D-W11X2-101 corrected). The block read is now `readBlockBetween`
 * (blocked / unread); a failed staff read re-runs the viewer gates and marks any refusal `unread`, because
 * staff status would have bypassed it; GET /events/:id answers a failed block read `degraded_unavailable`.
 *
 * The round-13 verifier's probes, copied in unchanged (V13-MB0..2, ED0, ED1, ST0, ST1), and this lane's:
 *   MB3  CONTROL: a real block (the read succeeded) → the event is withheld as a verdict; the source complete
 *   ST2  CONTROL: the staff read fails on an event with no viewer gate → served (nothing refused, nothing unread)
 *   ED3  CONTROL: GET /events/:id for a blocked pair (the read succeeded) → still 404
 *   FG1  an age-gated event, the `events_trust_gates_enabled` read fails → the gates run; the refusal is unread (was: gates skipped)
 *   FG2  GET /events/:id, the same → degraded_unavailable
 *   FGc  CONTROL: the gate flag read fails on an event with no gate → served, complete
 *   BN1  the ban read fails, the staff read succeeds → unread (the round-13 X29, which the staff re-check now masks elsewhere)
 *   CV1  GET /events/:id, a friends-only event, the friendship read fails → degraded_unavailable (was: the locked private wall)
 *   CV2  the same, the RSVP read fails → degraded_unavailable
 *   CV3  an invite-only event, the RSVP read fails → degraded_unavailable
 *   CV4  a cancelled event, the staff-role read fails → degraded_unavailable (staff may view it); CV4c its control
 *   CVc  CONTROL: a non-friend, every read healthy → the locked preview
 *   FGe  CONTROL: the gate flag off → the age-gated event is served
 *   FGd  CONTROL: the gate flag on, an age-gated event, no date of birth → withheld as a verdict
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import mapSearchRouter from "../routes/mapSearch.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import eventsRouter from "../routes/events.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const VIEWER = "ab000000-0000-4000-a000-000000000013";
const HOST = "ab000000-0000-4000-a000-0000000000f3";
const EID = "e1000000-0000-4000-a000-000000000001";
const TOKEN = "tok-v13-gates";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const soon = () => new Date(Date.now() + 3 * 3600_000).toISOString();
const ev = (id: string, over: Record<string, unknown> = {}) => ({ id, host_id: HOST, title: `Event ${id}`, location_name: "Club", location_lat: 38.72, location_lng: -9.14, show_exact_location: true, starts_at: soon(), ends_at: null, cover_url: null, visibility: "public", state: "open", age_min: null, age_max: null, trust_score_min: null, verified_only: false, ...over });

/** failIf(table, select, calls) decides per read. `calls` records every builder method name. */
function client(opts: { events: any[]; failIf?: (table: string, select: string, calls: string[]) => boolean; coHost?: boolean; blocked?: boolean; gateFlagFails?: boolean; gateFlagOff?: boolean }) {
  const b = (table: string): any => {
    let selected = ""; const calls: string[] = []; const eqArgs: string[] = [];
    const answer = (single: boolean) => {
      if (table === "feature_flags" && opts.gateFlagFails && eqArgs.includes("events_trust_gates_enabled")) return { data: null, error: ERR };
      if (table === "feature_flags" && opts.gateFlagOff && eqArgs.includes("events_trust_gates_enabled")) return { data: { enabled: false }, error: null };
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ flag: "map_projection_enabled", enabled: true }], error: null };
      if (opts.failIf?.(table, selected, calls)) return { data: null, error: ERR };
      if (table === "events") return single ? { data: opts.events[0] ?? null, error: null } : { data: opts.events, error: null };
      if (table === "blocks" && opts.blocked && selected === "blocker_id") return { data: [{ blocker_id: VIEWER }], error: null };
      if (table === "event_roles" && opts.coHost && calls.includes("in")) return { data: { role: "co_host" }, error: null };
      if (table === "profiles" && selected === "verified") return { data: { verified: false }, error: null };
      return { data: single ? null : [], error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      if (k === "select") return (cols?: string) => { selected = String(cols ?? ""); calls.push("select"); return p; };
      return (...a: unknown[]) => { calls.push(k); if (k === "eq") eqArgs.push(String(a[1])); return p; };
    } });
    return p;
  };
  return { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) }, from: b, rpc: () => Promise.resolve({ data: [], error: null }) };
}
/** The per-event block read (isBlockedBetween selects "blocker_id" alone); the route's block set selects "blocker_id, blocked_id". */
const perEventBlocksFail = (t: string, s: string) => t === "blocks" && s === "blocker_id";
/** checkEventEligibility's staff read: event_roles filtered with .in("role", …). */
const staffReadFails = (t: string, _s: string, calls: string[]) => t === "event_roles" && calls.includes("in");

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", mapSearchRouter); app.use("/api", mapProjectionRouter); app.use("/api", eventsRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => _clearProtectedZoneCache());
const use = (c: any) => { _setTestClient(c, true); _setTestServiceClient(c); };
const get = async (path: string) => { const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } }); return { status: r.status, body: await r.json() as any }; };
const search = () => get(`/map/search?lat=38.72&lng=-9.14&types=event`);
const projection = () => get(`/map/projection?bbox=-9.2,38.7,-9.1,38.75&zoom=14&kinds=event`);

describe("v13: the per-event block and staff reads, over a failed read", () => {
  it("V13-MB0 CONTROL: healthy reads → both events served, the source complete", async () => {
    use(client({ events: [ev("e1"), ev("e2")] }));
    const { body } = await search();
    assert.equal(JSON.stringify(body.sources?.event), '{"refusal":null,"collected":2}', JSON.stringify(body.sources));
  });
  it("V13-MB1 /map/search: the per-event block read fails → the events source must not be complete-and-empty", async () => {
    use(client({ events: [ev("e1"), ev("e2")], failIf: perEventBlocksFail }));
    const { body } = await search();
    assert.ok(!(body.sources?.event?.refusal === null && body.total === 0), `two events withheld over a failed block read, served as an empty neighbourhood: ${JSON.stringify({ sources: body.sources, total: body.total })}`);
  });
  it("V13-MB2 /map/projection: the per-event block read fails → the events layer is not named as read", async () => {
    use(client({ events: [ev("e1")], failIf: perEventBlocksFail }));
    const { status, body } = await projection();
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(Array.isArray(body.sources) && !body.sources.includes("events"), `a layer withheld over a failed read was named as read: ${JSON.stringify(body.sources)}`);
  });
  it("V13-ED0 CONTROL: GET /events/:id, healthy reads → 200", async () => {
    use(client({ events: [ev(EID)] }));
    const { status, body } = await get(`/events/${EID}`);
    assert.equal(status, 200, JSON.stringify(body));
  });
  it("V13-ED1 GET /events/:id: the block read fails → never 404 'not found'", async () => {
    use(client({ events: [ev(EID)], failIf: perEventBlocksFail }));
    const { status, body } = await get(`/events/${EID}`);
    assert.notEqual(status, 404, `a failed block read was answered as 'not found': ${status} ${JSON.stringify(body)}`);
  });
  it("V13-ST0 CONTROL: the same co-host, the staff-role read healthy → the event is served, the source complete", async () => {
    use(client({ events: [ev("e7", { verified_only: true })], coHost: true }));
    const { body } = await search();
    assert.equal(JSON.stringify(body.sources?.event), '{"refusal":null,"collected":1}', JSON.stringify(body.sources));
  });
  it("V13-ST1 /map/search: a co-host's staff-role read fails on a verified-only event → not a complete source", async () => {
    use(client({ events: [ev("e7", { verified_only: true })], coHost: true, failIf: staffReadFails }));
    const { body } = await search();
    assert.ok(body.sources?.event?.refusal !== null, `the event was withheld as 'verified users only' over a failed staff read, and the source says complete: ${JSON.stringify(body.sources)}`);
  });
  it("MB3 CONTROL: a real block (the read succeeded) → withheld as a verdict, the source complete", async () => {
    use(client({ events: [ev("e1"), ev("e2")], blocked: true }));
    const { body } = await search();
    assert.equal(JSON.stringify(body.sources?.event), '{"refusal":null,"collected":0}', JSON.stringify(body.sources));
  });
  it("ST2 CONTROL: the staff read fails on an event with no viewer gate → served, nothing unread", async () => {
    use(client({ events: [ev("e8")], coHost: true, failIf: staffReadFails }));
    const { body } = await search();
    assert.equal(JSON.stringify(body.sources?.event), '{"refusal":null,"collected":1}', JSON.stringify(body.sources));
  });
  it("ED3 CONTROL: GET /events/:id for a blocked pair (the read succeeded) → still 404", async () => {
    use(client({ events: [ev(EID)], blocked: true }));
    const { status, body } = await get(`/events/${EID}`);
    assert.equal(status, 404, JSON.stringify(body));
  });
  it("ED1b GET /events/:id: the block read fails → degraded_unavailable (retryable), not a verdict", async () => {
    use(client({ events: [ev(EID)], failIf: perEventBlocksFail }));
    const { body } = await get(`/events/${EID}`);
    assert.equal(body.error, "degraded_unavailable", JSON.stringify(body));
  });
  it("FG1 an age-gated event, the events_trust_gates_enabled read fails → the gates are not skipped; the refusal is unread, the source not complete", async () => {
    use(client({ events: [ev("e9", { age_min: 18 })], gateFlagFails: true }));
    const { body } = await search();
    assert.equal(body.total, 0, `an unread gate flag skipped the age gate: ${JSON.stringify(body).slice(0, 400)}`);
    assert.notEqual(body.sources?.event?.refusal, null, JSON.stringify(body.sources));
  });
  it("FG2 GET /events/:id on an age-gated event, the gate flag read fails → degraded_unavailable, never served or 'not found'", async () => {
    use(client({ events: [ev(EID, { age_min: 18 })], gateFlagFails: true }));
    const { status, body } = await get(`/events/${EID}`);
    assert.equal(body.error, "degraded_unavailable", `${status} ${JSON.stringify(body).slice(0, 300)}`);
  });
  it("FGc CONTROL: the gate flag read fails on an event with no gate → served, complete", async () => {
    use(client({ events: [ev("e10")], gateFlagFails: true }));
    const { body } = await search();
    assert.equal(JSON.stringify(body.sources?.event), '{"refusal":null,"collected":1}', JSON.stringify(body.sources));
  });
  it("FGd CONTROL: the gate flag read succeeds (on), an age-gated event and no date of birth → withheld as a verdict, the source complete", async () => {
    use(client({ events: [ev("e11", { age_min: 18 })] }));
    const { body } = await search();
    assert.equal(JSON.stringify(body.sources?.event), '{"refusal":null,"collected":0}', JSON.stringify(body.sources));
  });
  it("FGe CONTROL: the gate flag read OFF → an age-gated event is served (the gates are off by decision), complete", async () => {
    use(client({ events: [ev("e12", { age_min: 18 })], gateFlagOff: true }));
    const { body } = await search();
    assert.equal(JSON.stringify(body.sources?.event), '{"refusal":null,"collected":1}', JSON.stringify(body.sources));
  });
  it("CV1 GET /events/:id on a friends-only event, the friendship read fails → degraded_unavailable, never the private wall", async () => {
    use(client({ events: [ev(EID, { visibility: "friends_only" })], failIf: (t) => t === "user_friendships" }));
    const { status, body } = await get(`/events/${EID}`);
    assert.equal(body.error, "degraded_unavailable", `a failed friendship read was answered as a locked, private event: ${status} ${JSON.stringify(body)}`);
  });
  it("CV2 GET /events/:id on a friends-only event of a non-friend, the RSVP read fails → degraded_unavailable", async () => {
    use(client({ events: [ev(EID, { visibility: "friends_only" })], failIf: (t) => t === "event_rsvps" }));
    const { body } = await get(`/events/${EID}`);
    assert.equal(body.error, "degraded_unavailable", JSON.stringify(body));
  });
  it("CVc CONTROL: a friends-only event of a non-friend, every read healthy → the locked preview", async () => {
    use(client({ events: [ev(EID, { visibility: "friends_only" })] }));
    const { status, body } = await get(`/events/${EID}`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.locked, true, JSON.stringify(body));
  });
  it("CV3 GET /events/:id on an invite-only event, the RSVP read fails → degraded_unavailable, never the private wall", async () => {
    use(client({ events: [ev(EID, { visibility: "invite_only" })], failIf: (t) => t === "event_rsvps" }));
    const { body } = await get(`/events/${EID}`);
    assert.equal(body.error, "degraded_unavailable", JSON.stringify(body));
  });
  it("CV4 GET /events/:id on a cancelled event, the staff-role read fails → degraded_unavailable, never 'not found'", async () => {
    use(client({ events: [ev(EID, { state: "cancelled" })], failIf: (t, _s, calls) => t === "event_roles" && !calls.includes("in") }));
    const { status, body } = await get(`/events/${EID}`);
    assert.equal(body.error, "degraded_unavailable", `${status} ${JSON.stringify(body)}`);
  });
  it("CV4c CONTROL: a cancelled event, every read healthy → 404 as before", async () => {
    use(client({ events: [ev(EID, { state: "cancelled" })] }));
    const { status } = await get(`/events/${EID}`);
    assert.equal(status, 404);
  });
  it("BN1 the ban read fails while the staff read succeeds → the ban arm itself marks the refusal unread (X29)", async () => {
    use(client({ events: [ev("e13")], failIf: (t, _s, calls) => t === "event_roles" && !calls.includes("in") }));
    const { body } = await search();
    assert.notEqual(body.sources?.event?.refusal, null, `a failed ban read withheld the event as a verdict: ${JSON.stringify(body.sources)}`);
  });
});

