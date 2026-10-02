/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2): the events routes over the fail-closed double, shared by this
 * round's event suites. world() is the round-19 lane's own harness (eventsCountStampsUnread.test.ts), as the round-19
 * verifier copied it into its probes, with one addition: `dbMaxRows`, which caps every multi-row answer at PostgREST's
 * `db-max-rows` and honours `.range()`, as the real server does (the fail-closed double ignores both).
 */
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import { _setTestServiceClient } from "../../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec, type FakeReadContext } from "./failClosedSupabase.js";

export const HOST   = "22222222-2222-4222-8222-222222222222";
export const VIEWER = "11111111-1111-4111-8111-111111111111";
export const W1     = "33333333-3333-4333-8333-333333333333";
export const W2     = "44444444-4444-4444-8444-444444444444";
export const GONE   = "55555555-5555-4555-8555-555555555555";
export const EVENT  = "66666666-6666-4666-8666-666666666666";
export const TOKENS: Record<string, string> = { "t-host": HOST, "t-viewer": VIEWER, "t-w1": W1 };
export const ERR = { message: "canceling statement due to statement timeout", code: "57014" };

export interface WorldOpts {
  ev?: Record<string, any>;
  /** More event rows, beside EVENT. */
  moreEvents?: Record<string, any>[];
  banned?: string[];
  waitlist?: Record<string, any>[];
  rsvps?: Record<string, any>[];
  failOn?: (c: FakeReadContext) => any;
  failWritesOn?: (t: string) => any;
  extra?: Record<string, Record<string, any>[]>;
  /** Cap every multi-row read at this many rows, honouring `.range()` (PostgREST's db-max-rows). */
  dbMaxRows?: number;
}

export interface WriteRec { table: string; kind: string; payload: any; filters: Array<[string, string, unknown]> }

export function eventRow(over: Record<string, any> = {}) {
  return {
    id: EVENT, host_id: HOST, title: "Rooftop quiz", state: "waitlist", rsvp_closed: false, visibility: "public", city: "Lisbon",
    verified_only: false, trust_score_min: null, age_min: null, age_max: null,
    capacity: 10, max_attendees: 10, going_count: 0, waitlist_enabled: true, waitlist_count: 0,
    chat_enabled: false, chat_thread_id: null, location_lat: 38.72, location_lng: -9.14,
    starts_at: "2030-01-01T00:00:00.000Z", ends_at: null, created_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

export function world(o: WorldOpts = {}): { spec: FakeClientSpec; client: any; writes: WriteRec[]; reads: FakeReadContext[] } {
  const people = [HOST, VIEWER, W1, W2, GONE];
  const reads: FakeReadContext[] = [];
  const spec: FakeClientSpec = {
    users: TOKENS,
    rows: {
      feature_flags: [
        { flag: "events_enabled", enabled: true },
        { flag: "events_waitlist_enabled", enabled: true },
        { flag: "events_trust_gates_enabled", enabled: true },
      ],
      events: [eventRow(o.ev), ...(o.moreEvents ?? [])],
      event_roles: (o.banned ?? []).map((u) => ({ event_id: EVENT, user_id: u, role: "banned" })),
      blocks: [],
      event_rsvps: o.rsvps ?? [],
      event_waitlist: o.waitlist ?? [],
      event_reports: [], event_attendee_states: [],
      profiles: people.map((id) => ({ id, handle: `h${id.slice(0, 4)}`, name: "N", date_of_birth: "1990-06-15", location_country: "US", verified: true })),
      identity_verifications: [],
      ...(o.extra ?? {}),
    },
    failOn: (c: FakeReadContext) => { reads.push(c); return o.failOn?.(c) ?? null; }, failWritesOn: o.failWritesOn, inserted: {}, updated: {},
  };
  const client = makeFailClosedClient(spec);
  const writes: WriteRec[] = [];
  const from = client.from.bind(client);
  client.from = (table: string) => {
    const b = from(table);
    if (typeof b.ilike !== "function") b.ilike = (col: string, val: unknown) => b.filter(col, "ilike", val);
    if (table === "blocks") b.or = (expr: string) => { const ids = [...new Set([...expr.matchAll(/blocker_id\.eq\.([0-9a-f-]+)/g)].map((m) => m[1]))]; b.in("blocker_id", ids); b.in("blocked_id", ids); return b; };
    let rec: WriteRec | null = null;
    for (const kind of ["insert", "upsert", "update", "delete"]) {
      const orig = b[kind];
      b[kind] = (p?: any, opts?: any) => { rec = { table, kind, payload: p ?? null, filters: [] }; writes.push(rec); return orig(p, opts); };
    }
    for (const op of ["eq", "in", "is"]) {
      const orig = b[op];
      b[op] = (col: string, val: unknown) => { if (rec) rec.filters.push([op, col, val]); return orig(col, val); };
    }
    if (o.dbMaxRows != null) {
      const cap = o.dbMaxRows;
      let range: [number, number] | null = null;
      const origRange = b.range;
      b.range = (a: number, z: number) => { range = [a, z]; origRange.call(b, a, z); return b; };
      const origThen = b.then;
      b.then = (onF: any, onR: any) => origThen.call(b, (r: any) => {
        if (rec || !r || !Array.isArray(r.data)) return r;
        let data = r.data as unknown[];
        if (range) data = data.slice(range[0], range[1] + 1);
        return { ...r, data: data.slice(0, cap) };
      }).then(onF, onR);
    }
    return b;
  };
  _setTestClient(client, true); _setTestServiceClient(client);
  return { spec, client, writes, reads };
}

export const eventsUpdates = (w: WriteRec[]) => w.filter((x) => x.table === "events" && x.kind === "update").map((x) => x.payload);
export const stamps = (w: WriteRec[], key: string) => eventsUpdates(w).filter((p) => p && key in p && p[key] !== undefined).map((p) => p[key]);
export const offerRow = (u: string, position: number, offer: string | null) => ({ event_id: EVENT, user_id: u, position, offer_expires_at: offer });

/** The events router on a local server; `req(token, method, path, body)` answers `{ status, text, body }`. */
export async function eventsServer(): Promise<{ req: (token: string, method: string, path: string, body?: unknown) => Promise<{ status: number; text: string; body: any }>; close: () => void }> {
  const mod = await import("../../routes/events.js");
  const app = express(); app.use(express.json());
  app.use((req: any, _r: unknown, n: () => void) => { req.log = { info() {}, warn() {}, error() {}, debug() {}, child() { return req.log; } }; n(); });
  app.use(mod.default);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    req: async (token, method, path, body) => {
      const r = await fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, text, body: parsed };
    },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}
