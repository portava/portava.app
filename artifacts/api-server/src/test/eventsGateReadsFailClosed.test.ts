/**
 * census-trust §30 — the events router's viewer gates hold when the read that
 * decides them FAILS.
 *
 * supabase-js RESOLVES a failed read as `{ data: null, error }`. Two shapes in
 * routes/events.ts turned that into "allowed":
 *
 *   S2  `events_trust_gates_enabled` read two-state (`isFlagEnabled`), so an
 *       UNREAD flag was "gates off" and the age / verified / trust gates were
 *       skipped: GET /events listed an 18+ event to a provider-verified minor,
 *       POST /events/:id/waitlist seated them, and every caller of the shared
 *       `checkEventEligibility` (RSVP, detail, join, approvals, map search,
 *       calls, media) admitted them.
 *   S3  the banned-role reads of GET /events and the waitlist bound no error,
 *       so a failed `event_roles` read was "not banned".
 *
 * Each FAIL case below was seen RED on main cd9a11d92 before the fix. The
 * CONTROL cases pin the healthy answers; the `H*` cases pin healthy response
 * BODIES byte-for-byte (sha256 over the body, with the per-request random
 * `sessionId` normalised), captured on main before the fix.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec, type FakeReadContext } from "./helpers/failClosedSupabase.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const OTHER  = "22222222-2222-4222-8222-222222222222";
const TOKEN  = "ev-gates-token";
const EVENT  = "66666666-6666-4666-8666-666666666666";
const EVENT2 = "77777777-7777-4777-8777-777777777777";
const INVITE = "88888888-8888-4888-8888-888888888888";
const ERR = { message: "canceling statement due to statement timeout", code: "57014" };

type Flag = "on" | "off" | "absent";
interface WorldOpts {
  state?: string;
  ageMin?: number | null;
  banned?: boolean;
  minor?: boolean;
  flag?: Flag;
  failOn?: (c: FakeReadContext) => any;
  extraEvents?: Record<string, any>[];
}

function eventRow(id: string, over: Record<string, any> = {}) {
  return {
    id, host_id: OTHER, title: "Late bar crawl", state: "open", rsvp_closed: false, visibility: "public", city: "Lisbon",
    verified_only: false, trust_score_min: null, age_min: 18, age_max: null,
    capacity: 10, max_attendees: null, going_count: 0, waitlist_enabled: true, waitlist_count: 0,
    starts_at: "2030-01-01T00:00:00.000Z", ends_at: null, created_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function world(o: WorldOpts = {}): FakeClientSpec {
  const flag = o.flag ?? "on";
  const flags: Record<string, any>[] = [{ flag: "events_enabled", enabled: true }, { flag: "events_waitlist_enabled", enabled: true }];
  if (flag !== "absent") flags.push({ flag: "events_trust_gates_enabled", enabled: flag === "on" });
  const spec: FakeClientSpec = {
    users: { [TOKEN]: VIEWER },
    rows: {
      feature_flags: flags,
      events: [eventRow(EVENT, { state: o.state ?? "open", age_min: o.ageMin === undefined ? 18 : o.ageMin }), ...(o.extraEvents ?? [])],
      event_roles: o.banned ? [{ event_id: EVENT, user_id: VIEWER, role: "banned" }] : [],
      event_rsvps: [], event_waitlist: [], blocks: [],
      event_invites: [{ id: INVITE, event_id: EVENT, invitee_id: VIEWER, inviter_id: OTHER, status: "pending" }],
      profiles: [{ id: VIEWER, date_of_birth: "1990-06-15", location_country: "US", verified: true }, { id: OTHER, handle: "host", name: "Host" }],
      identity_verifications: [{ user_id: VIEWER, is_over_18: o.minor === false, created_at: "2026-08-01T00:00:00.000Z" }],
    },
    failOn: o.failOn, inserted: {}, updated: {},
  };
  const c = makeFailClosedClient(spec);
  const from = c.from.bind(c);
  c.from = (table: string) => { const b = from(table); if (typeof b.ilike !== "function") b.ilike = (col: string, val: unknown) => b.filter(col, "ilike", val); return b; };
  _setTestClient(c, true); _setTestServiceClient(c);
  return spec;
}
const flagFails = (c: FakeReadContext) => (c.table === "feature_flags" && c.eq("flag") === "events_trust_gates_enabled" ? ERR : null);
const rolesFail = (c: FakeReadContext) => (c.table === "event_roles" ? ERR : null);
const bannedReadFails = (c: FakeReadContext) => (c.table === "event_roles" && c.eq("role") === "banned" ? ERR : null);
const eventsReadFails = (c: FakeReadContext) => (c.table === "events" && c.eq("id") === EVENT ? ERR : null);
const updates = (s: FakeClientSpec, t: string) => (s.updated?.[t] ?? []).length;
const writes = (s: FakeClientSpec, t: string) => (s.inserted?.[t] ?? []).length;
const pin = (body: string) => createHash("sha256").update(body.replace(/"sessionId":"[0-9a-f-]{36}"/g, '"sessionId":"S"')).digest("hex");

describe("census-trust §30: events viewer gates fail closed on a failed read", () => {
  let url = ""; let server: http.Server;
  before(async () => {
    const mod = await import("../routes/events.js");
    const app = express(); app.use(express.json());
    app.use((req: any, _r: unknown, n: () => void) => { req.log = { info() {}, warn() {}, error() {}, debug() {}, child() { return req.log; } }; n(); });
    app.use(mod.default);
    server = http.createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => { server.closeAllConnections(); server.close(); });
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(url + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, text: await r.text() };
  };

  // ── GET /events (S2, S3) ──────────────────────────────────────────────────
  it("EG0 CONTROL: flag on → the 18+ event is not listed to a verified minor", async () => {
    world({}); const r = await req("GET", "/events?state=open");
    assert.equal(r.status, 200); assert.ok(!r.text.includes(EVENT), r.text.slice(0, 300));
  });
  it("EG0b CONTROL: no age limit → the event IS listed (the world reaches the list)", async () => {
    world({ ageMin: null }); const r = await req("GET", "/events?state=open");
    assert.equal(r.status, 200); assert.ok(r.text.includes(EVENT), r.text.slice(0, 300));
  });
  it("EG1 the gate flag read FAILS → the 18+ event is not listed to the minor (gates stay on)", async () => {
    world({ failOn: flagFails }); const r = await req("GET", "/events?state=open");
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(!r.text.includes(EVENT), `an unread gate flag skipped the age gate: ${r.text.slice(0, 300)}`);
  });
  it("EG1b the gate flag read FAILS, an ungated event beside it → that one is still listed (gates on, not a blanket refusal)", async () => {
    world({ failOn: flagFails, extraEvents: [eventRow(EVENT2, { age_min: null })] }); const r = await req("GET", "/events?state=open");
    assert.equal(r.status, 200); assert.ok(r.text.includes(EVENT2) && !r.text.includes(EVENT), r.text.slice(0, 300));
  });
  it("EB0 CONTROL: banned, roles readable → not listed", async () => {
    world({ ageMin: null, banned: true }); const r = await req("GET", "/events?state=open");
    assert.equal(r.status, 200); assert.ok(!r.text.includes(EVENT), r.text.slice(0, 300));
  });
  it("EB1 banned, the event_roles read FAILS → refused 503 degraded_unavailable, the event is not listed", async () => {
    world({ ageMin: null, banned: true, failOn: rolesFail }); const r = await req("GET", "/events?state=open");
    assert.ok(!r.text.includes(EVENT), `a failed ban read listed the banned event: ${r.status} ${r.text.slice(0, 300)}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
  });

  // ── POST /events/:id/waitlist (S2, S3) ────────────────────────────────────
  it("WG0 CONTROL: waitlist, flag readable → the minor is refused 403, no row", async () => {
    const s = world({ state: "full" }); const r = await req("POST", `/events/${EVENT}/waitlist`, {});
    assert.equal(r.status, 403); assert.equal(writes(s, "event_waitlist"), 0);
  });
  it("WG1 waitlist, the gate flag read FAILS → the minor is refused 403, no row", async () => {
    const s = world({ state: "full", failOn: flagFails }); const r = await req("POST", `/events/${EVENT}/waitlist`, {});
    assert.equal(writes(s, "event_waitlist"), 0, `an unread gate flag waitlisted a minor for an 18+ event: ${r.status} ${r.text.slice(0, 300)}`);
    assert.equal(r.status, 403, r.text);
  });
  it("WB0 CONTROL: waitlist, banned, the banned-role read healthy → refused 403, no row", async () => {
    const s = world({ state: "full", ageMin: null, banned: true }); const r = await req("POST", `/events/${EVENT}/waitlist`, {});
    assert.equal(r.status, 403); assert.equal(writes(s, "event_waitlist"), 0);
  });
  it("WB1 waitlist, the banned-role read FAILS → refused 503 degraded_unavailable, no row", async () => {
    const s = world({ state: "full", ageMin: null, banned: true, failOn: bannedReadFails }); const r = await req("POST", `/events/${EVENT}/waitlist`, {});
    assert.equal(writes(s, "event_waitlist"), 0, `a failed ban read waitlisted a banned viewer: ${r.status} ${r.text.slice(0, 300)}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
  });

  // ── checkEventEligibility (sweep: the shared gate behind RSVP / detail / join / map / calls / media) ──
  it("RS0 CONTROL: RSVP, flag readable → the minor is refused 403, no RSVP written", async () => {
    const s = world({}); const r = await req("POST", `/events/${EVENT}/rsvp`, { status: "going" });
    assert.equal(r.status, 403, r.text); assert.equal(writes(s, "event_rsvps"), 0);
  });
  it("RS1 RSVP, the gate flag read FAILS → the minor is refused 403, no RSVP written", async () => {
    const s = world({ failOn: flagFails }); const r = await req("POST", `/events/${EVENT}/rsvp`, { status: "going" });
    assert.equal(writes(s, "event_rsvps"), 0, `an unread gate flag RSVP'd a minor to an 18+ event: ${r.status} ${r.text.slice(0, 300)}`);
    assert.equal(r.status, 403, r.text);
  });
  it("DT1 GET /events/:id, the gate flag read FAILS → the 18+ event is not served to the minor (503 degraded_unavailable: a refusal over an unread gate, not a 'not found' verdict — census-discovery §111, D-W11X2-107)", async () => {
    world({ failOn: flagFails }); const r = await req("GET", `/events/${EVENT}`); assert.ok(!/"title"|"age_min"/.test(r.text), `the 18+ event body reached the minor: ${r.text.slice(0, 300)}`);
    assert.equal(r.status, 503, `an unread gate flag served an 18+ event to a minor: ${r.status} ${r.text.slice(0, 300)}`); assert.equal(JSON.parse(r.text).error, "degraded_unavailable", r.text);
  });

  // ── POST /events/:id/invites/:inviteId/accept (sweep: the events read decides whether the gate runs) ──
  it("IA0 CONTROL: invite accept, healthy reads, minor, 18+ event → refused 403, the invite is not marked accepted", async () => {
    const s = world({}); const r = await req("POST", `/events/${EVENT}/invites/${INVITE}/accept`, {});
    assert.equal(r.status, 403, r.text); assert.equal(updates(s, "event_invites"), 0);
  });
  it("IA1 invite accept, the events read FAILS → refused 503 degraded_unavailable, the invite is not marked accepted", async () => {
    const s = world({ failOn: eventsReadFails }); const r = await req("POST", `/events/${EVENT}/invites/${INVITE}/accept`, {});
    assert.equal(updates(s, "event_invites"), 0, `a failed event read skipped the eligibility gate and accepted the invite: ${r.status} ${r.text}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
  });
  it("H7 healthy invite accept, adult viewer → 200 {\"ok\":true,\"status\":\"accepted\"}, invite marked, RSVP written (as on main)", async () => {
    const s = world({ minor: false }); const r = await req("POST", `/events/${EVENT}/invites/${INVITE}/accept`, {});
    assert.equal(r.status, 200); assert.equal(r.text, '{"ok":true,"status":"accepted"}');
    assert.equal(updates(s, "event_invites"), 1); assert.ok(writes(s, "event_rsvps") >= 1);
  });

  // ── Healthy answers unchanged (flag on / off / absent) ────────────────────
  it("H1 healthy list, flag ON, adult viewer: body byte-identical to main", async () => {
    world({ minor: false }); const r = await req("GET", "/events?state=open");
    assert.equal(r.status, 200); assert.equal(pin(r.text), "2c315b3685d34dde613606871edbd405764ee06bd0e8bc50a8c3df574f522385", r.text);
  });
  it("H2 healthy list, flag OFF, minor viewer: gates off, body byte-identical to main", async () => {
    world({ flag: "off" }); const r = await req("GET", "/events?state=open");
    assert.equal(r.status, 200); assert.ok(r.text.includes(EVENT)); assert.equal(pin(r.text), "2c315b3685d34dde613606871edbd405764ee06bd0e8bc50a8c3df574f522385", r.text);
  });
  it("H3 healthy list, flag row ABSENT, minor viewer: an absent row is not an unread one — gates off, byte-identical to main", async () => {
    world({ flag: "absent" }); const r = await req("GET", "/events?state=open");
    assert.equal(r.status, 200); assert.ok(r.text.includes(EVENT)); assert.equal(pin(r.text), "2c315b3685d34dde613606871edbd405764ee06bd0e8bc50a8c3df574f522385", r.text);
  });
  it("H4 healthy waitlist join, adult viewer → 201 {\"position\":1}", async () => {
    const s = world({ state: "full", minor: false }); const r = await req("POST", `/events/${EVENT}/waitlist`, {});
    assert.equal(r.status, 201); assert.equal(r.text, '{"position":1}'); assert.equal(writes(s, "event_waitlist"), 1);
  });
  it("H5 healthy waitlist join, flag ABSENT, minor viewer → 201 (gates off, as on main)", async () => {
    const s = world({ state: "full", flag: "absent" }); const r = await req("POST", `/events/${EVENT}/waitlist`, {});
    assert.equal(r.status, 201); assert.equal(r.text, '{"position":1}'); assert.equal(writes(s, "event_waitlist"), 1);
  });
  it("H6 healthy RSVP, adult viewer: body byte-identical to main", async () => {
    const s = world({ minor: false }); const r = await req("POST", `/events/${EVENT}/rsvp`, { status: "going" });
    assert.equal(pin(`${r.status} ${r.text}`), "22cf9f6e8425dda9ec147182955ad2cdf8427c791af04ea10fb85afbd8bea871", `${r.status} ${r.text}`); assert.ok(writes(s, "event_rsvps") >= 1);
  });
});
