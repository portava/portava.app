/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-101): the round-13 sweep of
 * `checkEventEligibility`'s callers. GET /events/:id — the event page a Discovery or map event card
 * opens — answered a viewer gate it could not READ as 404 "Event not found or access denied", and a
 * failed `events` read as "Event not found": a failed read stated as the event's absence.
 * `checkEventEligibility` now marks its unavailable arms `unread` (§110, D-W11X2-93); the route answers
 * them, and a failed event read, as `degraded_unavailable` (retryable), never as not found.
 *
 *   ED1  a public event, the viewer's ban read (event_roles) fails → never 404 "not found"
 *   ED2  the events read fails → never 404 "Event not found"
 *   EDc  CONTROL: the viewer IS banned (the read succeeded) → still 404; a healthy read → 200
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import eventsRouter from "../routes/events.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const VIEWER = "ab000000-0000-4000-a000-0000000000d1";
const HOST = "ab000000-0000-4000-a000-0000000000d2";
const EVENT = "ee000000-0000-4000-a000-0000000000d9";
const TOKEN = "tok-r13-event";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const EV = { id: EVENT, host_id: HOST, title: "Jazz", visibility: "public", state: "open", starts_at: new Date(Date.now() + 86_400_000).toISOString(), age_min: null, age_max: null, trust_score_min: null, verified_only: false };

function client(opts: { fail?: string[]; banned?: boolean } = {}) {
  const fail = new Set(opts.fail ?? []);
  const b = (table: string): any => {
    const calls: Array<[string, unknown[]]> = [];
    const answer = (single: boolean) => {
      if (table === "feature_flags") return { data: single ? { enabled: false } : [], error: null };
      if (table === "profiles" && single) return { data: { id: VIEWER, account_status: "active" }, error: null };
      if (fail.has(table)) return { data: null, error: ERR };
      if (table === "events") return { data: single ? EV : [EV], error: null };
      if (table === "event_roles" && opts.banned && calls.some(([k, a]) => k === "eq" && a[0] === "role" && a[1] === "banned")) return { data: { role: "banned" }, error: null };
      return { data: single ? null : [], error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      return (...args: unknown[]) => { calls.push([k, args]); return p; };
    } });
    return p;
  };
  return { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) }, from: b, rpc: () => Promise.resolve({ data: [], error: null }) };
}

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", eventsRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
async function detail(c: ReturnType<typeof client>) {
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}/events/${EVENT}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() as any };
}

describe("GET /events/:id over a gate it could not read (§110, D-W11X2-101)", () => {
  it("ED1 the viewer's ban read fails → never 404 'not found'", async () => {
    const { status, body } = await detail(client({ fail: ["event_roles"] }));
    assert.notEqual(status, 404, JSON.stringify(body));
    assert.equal(body.error, "degraded_unavailable", JSON.stringify(body));
  });
  it("ED2 the events read fails → never 404 'Event not found'", async () => {
    const { status, body } = await detail(client({ fail: ["events"] }));
    assert.notEqual(status, 404, JSON.stringify(body));
    assert.equal(body.error, "degraded_unavailable", JSON.stringify(body));
  });
  it("EDc CONTROL: a banned viewer (read succeeded) → still 404; healthy → 200", async () => {
    const banned = await detail(client({ banned: true }));
    assert.equal(banned.status, 404, JSON.stringify(banned.body));
    const ok = await detail(client());
    assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  });
});
