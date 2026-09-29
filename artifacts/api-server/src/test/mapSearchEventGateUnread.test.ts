/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-93): GET /map/search never reports an
 * events source whose rows were withheld UNCHECKED as complete.
 *
 * The events source is `loadNearbyEvents` (routes/mapSearch.ts), which returned null only when the
 * `events` read itself failed. Every row it read then passes per-event gates that FAIL CLOSED on a
 * failed read — `checkEventEligibility`'s ban, trust, age and verified reads, and the friends-only
 * `user_friendships` read (`{ data }` alone) — and a withheld row was `continue`d. So an unreadable
 * gate table withheld every event unchecked and the source was reported `{ refusal: null }`: a failed
 * read presented as "no events near you" (§110.1 BK2). The reader now counts what it withheld because
 * a check could not be read (`nearbyEventsWithheldUnchecked`), the route names it
 * (`event_gates_unreadable`), and the NOW gateway stops naming the events layer as read. A healthy
 * body is byte-identical.
 *
 *   V12-MS0  CONTROL: two public events nearby, every read healthy → both served, refusal null   (verifier probe)
 *   V12-MS1  the `event_roles` read fails → must not be `{ refusal: null, collected: 0 }`
 *   V12-MS2  a friend's friends-only event, the `user_friendships` read fails → not complete
 *   MS3      a trust-gated event, the `trust_profiles` read fails → the source says what it withheld unchecked
 *   MS4      a verified-only event, the viewer's `verified` read fails → the same (never "verified users only")
 *   MS5      an age-gated event, the viewer's age read fails → the same
 *   MSb      CONTROL: a healthy body carries no new key — `sources` is byte-identical
 *   MSd      CONTROL: a friends-only event of a NON-friend, every read healthy → withheld, and the source complete
 *   GW0      CONTROL: GET /map/projection names the events layer over healthy gates
 *   GW1      GET /map/projection over an unreadable gate does not name the events layer as read
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import mapSearchRouter from "../routes/mapSearch.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "ab000000-0000-4000-a000-000000000012";
const HOST = "ab000000-0000-4000-a000-0000000000f1";
const TOKEN = "tok-v12-map";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const soon = () => new Date(Date.now() + 3 * 3600_000).toISOString();
const ev = (id: string, visibility: string, over: Record<string, unknown> = {}) => ({ id, host_id: HOST, title: `Event ${id}`, location_name: "Club", location_lat: 38.72, location_lng: -9.14, show_exact_location: true, starts_at: soon(), ends_at: null, cover_url: null, visibility, state: "open", age_min: null, age_max: null, trust_score_min: null, verified_only: false, ...over });

/** The verifier's client, with `failSelect` failing one table's read only when its select names a column. */
function client(opts: { fail?: string[]; failSelect?: Record<string, string>; events: any[]; friends?: boolean }) {
  const fail = new Set(opts.fail ?? []);
  const b = (table: string): any => {
    let selected = "";
    const answer = (single: boolean) => {
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ flag: "map_projection_enabled", enabled: true }], error: null };
      if (fail.has(table)) return { data: null, error: ERR };
      if (opts.failSelect?.[table] && selected.includes(opts.failSelect[table])) return { data: null, error: ERR };
      if (table === "events") return { data: opts.events, error: null };
      if (table === "user_friendships" && opts.friends) return { data: single ? { user_a: VIEWER } : [{ user_a: VIEWER }], error: null };
      return { data: single ? null : [], error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      if (k === "select") return (cols?: string) => { selected = String(cols ?? ""); return p; };
      return () => p;
    } });
    return p;
  };
  return { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) }, from: b, rpc: () => Promise.resolve({ data: [], error: null }) };
}

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", mapSearchRouter);
  app.use("/api", mapProjectionRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => _clearProtectedZoneCache());
const search = async () => { const r = await fetch(`${base}/map/search?lat=38.72&lng=-9.14&types=event`, { headers: { Authorization: `Bearer ${TOKEN}` } }); return { status: r.status, body: await r.json() as any }; };
const projection = async () => { const r = await fetch(`${base}/map/projection?bbox=-9.2,38.7,-9.1,38.75&zoom=14&kinds=event`, { headers: { Authorization: `Bearer ${TOKEN}` } }); return { status: r.status, body: await r.json() as any }; };

describe("GET /map/search's events source over an unreadable per-event gate (§110, D-W11X2-93)", () => {
  it("V12-MS0 CONTROL: two public events, healthy reads → both served, refusal null", async () => {
    _setTestClient(client({ events: [ev("e1", "public"), ev("e2", "public")] }) as any, true);
    const { body } = await search();
    assert.equal(body.sources?.event?.collected, 2, JSON.stringify(body.sources));
    assert.equal(body.sources?.event?.refusal, null);
  });
  it("V12-MS1 the event_roles read fails → the events source must not be complete-and-empty", async () => {
    _setTestClient(client({ events: [ev("e1", "public"), ev("e2", "public")], fail: ["event_roles"] }) as any, true);
    const { body } = await search();
    assert.ok(!(body.sources?.event?.refusal === null && body.total === 0), `two events withheld unchecked, served as an empty neighbourhood: ${JSON.stringify({ sources: body.sources, total: body.total })}`);
  });
  it("V12-MS2 a friends-only event, the user_friendships read fails → the source must not claim completeness", async () => {
    _setTestClient(client({ events: [ev("e1", "public"), ev("e3", "friends_only")], fail: ["user_friendships"] }) as any, true);
    const { body } = await search();
    assert.ok(body.sources?.event?.refusal !== null, `the friends-only event was withheld unchecked and the source says complete: ${JSON.stringify({ sources: body.sources, total: body.total })}`);
    assert.equal(body.sources.event.refusal, "event_gates_unreadable");
    assert.equal(body.sources.event.collected, 1, "the checked event is still served");
    assert.equal(body.sources.event.withheldUnchecked, 1);
  });
  it("MS3 a trust-gated event, the trust_profiles read fails → the source names what it withheld unchecked", async () => {
    _setTestClient(client({ events: [ev("e4", "public", { trust_score_min: 10 })], fail: ["trust_profiles"] }) as any, true);
    const { body } = await search();
    assert.deepEqual(body.sources.event, { refusal: "event_gates_unreadable", collected: 0, withheldUnchecked: 1 }, JSON.stringify(body.sources));
  });
  it("MS4 a verified-only event, the viewer's verified read fails → the same, never withheld as 'not verified'", async () => {
    _setTestClient(client({ events: [ev("e5", "public", { verified_only: true })], failSelect: { profiles: "verified" } }) as any, true);
    const { body } = await search();
    assert.deepEqual(body.sources.event, { refusal: "event_gates_unreadable", collected: 0, withheldUnchecked: 1 }, JSON.stringify(body.sources));
  });
  it("MS5 an age-gated event, the viewer's age read fails → the same, never withheld as 'too young'", async () => {
    _setTestClient(client({ events: [ev("e6", "public", { age_min: 18 })], failSelect: { profiles: "date_of_birth" } }) as any, true);
    const { body } = await search();
    assert.deepEqual(body.sources.event, { refusal: "event_gates_unreadable", collected: 0, withheldUnchecked: 1 }, JSON.stringify(body.sources));
  });
  it("MSb CONTROL: a healthy body carries no new key — sources byte-identical", async () => {
    _setTestClient(client({ events: [ev("e1", "public"), ev("e2", "public")] }) as any, true);
    const { body } = await search();
    assert.equal(JSON.stringify(body.sources), '{"traveler":null,"gem":null,"event":{"refusal":null,"collected":2}}');
  });
  it("MSd CONTROL: a non-friend's friends-only event, every read healthy → withheld, and the source complete", async () => {
    _setTestClient(client({ events: [ev("e1", "public"), ev("e3", "friends_only")] }) as any, true);
    const { body } = await search();
    assert.equal(JSON.stringify(body.sources.event), '{"refusal":null,"collected":1}');
  });
});

describe("GET /map/projection's events layer over an unreadable per-event gate (§110, D-W11X2-93)", () => {
  it("GW0 CONTROL: healthy gates → the events layer is named, its event served", async () => {
    _setTestClient(client({ events: [ev("e1", "public")] }) as any, true);
    const { status, body } = await projection();
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(Array.isArray(body.sources) && body.sources.includes("events"), JSON.stringify(body.sources));
  });
  it("GW1 the event_roles read fails → the events layer is not named as read", async () => {
    _setTestClient(client({ events: [ev("e1", "public")], fail: ["event_roles"] }) as any, true);
    const { status, body } = await projection();
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(Array.isArray(body.sources) && !body.sources.includes("events"), `a layer withheld unchecked was named as read: ${JSON.stringify(body.sources)}`);
  });
});
