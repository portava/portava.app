/**
 * An event's safety notes reach `events.safety_notes`.
 *
 * THE DEFECT
 * ==========
 * The create sheet sends `safetyNotes` (and `joinMode`). CreateEventSchema did not
 * declare `safetyNotes`, zod strips undeclared keys, and neither insert wrote the
 * column — so a host who wrote "meet at the lobby, not the side gate" saw the event
 * created and the note gone. `events.safety_notes` exists (0080_events_extension)
 * and formatEvent already serves it to the host. The app's create flow publishes
 * through POST /events/drafts/:draftId/publish (PublishDraftSchema extends
 * CreateEventSchema), so that insert is pinned as well as POST /events and
 * PATCH /events/:id. `joinMode` stays stripped: there are no join-mode semantics
 * on the server to persist it into.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventSafetyNotesPersisted.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import eventsRouter from "../routes/events.js";

const HOST = "aaaaaaaa-8888-4000-a000-000000000001";
const EVENT = "bbbbbbbb-8888-4000-a000-000000000002";
const DRAFT = "cccccccc-8888-4000-a000-000000000003";
const TOK = "tok-host-safety";
const NOTES = "Meet at the hotel lobby, not the side gate. Ask for Linh.";

type Rows = Record<string, any[]>;
interface Write { table: string; kind: "insert" | "update"; row: any }

/** The table-driven fake eventsTicketUrlOnUpdate.test.ts uses, recording inserts as well as updates. */
function makeClient(rows: Rows, writes: Write[]) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let patch: any = null;
    let inserted: any = null;
    const matched = () => (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
    function settle(single: boolean) {
      if (patch !== null) {
        const hit = matched();
        writes.push({ table, kind: "update", row: patch });
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve({ data: single ? (hit[0] ?? null) : hit, error: null, count: hit.length });
      }
      if (inserted) {
        const row = { id: `${table}-inserted`, ...inserted };
        writes.push({ table, kind: "insert", row: inserted });
        (rows[table] ??= []).push(row);
        return Promise.resolve({ data: single ? row : [row], error: null, count: 1 });
      }
      const out = matched();
      return Promise.resolve({ data: single ? (out[0] ?? null) : out, error: null, count: out.length });
    }
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not() { return b; }, gt() { return b; }, gte() { return b; }, lte() { return b; }, lt() { return b; },
      ilike() { return b; }, contains() { return b; }, overlaps() { return b; }, or() { return b; },
      order() { return b; }, range() { return b; }, limit() { return b; },
      insert(p: any) { inserted = Array.isArray(p) ? p[0] : p; return b; },
      upsert(p: any) { inserted = Array.isArray(p) ? p[0] : p; return b; },
      update(p: any) { patch = p; return b; },
      delete() { return b; },
      maybeSingle() { return settle(true); },
      single() { return settle(true); },
      then(f: any, j: any) { return settle(false).then(f, j); },
    };
    return b;
  }
  return {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: {
      getUser: async (tok: string) =>
        tok === TOK ? { data: { user: { id: HOST } }, error: null } : { data: { user: null }, error: { message: "bad token" } },
    },
  };
}

const START = new Date(Date.now() + 3 * 86_400_000).toISOString();

function baseRows(): Rows {
  return {
    feature_flags: [{ flag: "events_enabled", enabled: true }],
    events: [{
      id: EVENT, host_id: HOST, state: "open", visibility: "public", title: "Night market walk",
      description: "d", location_name: "Hoi An night market", chat_enabled: false, starts_at: START, ends_at: null,
      max_attendees: null, waitlist_enabled: false, rsvp_closed: false, price_type: "free", price_url: null,
      safety_notes: "old notes", updated_at: "2026-10-20T00:00:00.000Z",
    }],
    event_drafts: [{ id: DRAFT, host_id: HOST, data: { title: "Lantern walk", startsAt: START, locationName: "An Hoi bridge", visibility: "public", safetyNotes: NOTES, joinMode: "approval" } }],
    event_roles: [{ event_id: EVENT, user_id: HOST, role: "host" }],
    event_rsvps: [], event_attendees: [], event_waitlist: [], event_attendee_states: [], event_media: [],
    event_join_requests: [], event_activity_log: [], profiles: [], blocks: [],
    notifications: [], message_threads: [], trust_events: [], trust_profiles: [],
  };
}

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use(eventsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  await new Promise<void>((r) => server.close(() => r()));
});

function install(rows: Rows): Write[] {
  const writes: Write[] = [];
  const c = makeClient(rows, writes);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return writes;
}
async function call(method: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const eventInsert = (w: Write[]) => w.find((x) => x.table === "events" && x.kind === "insert")?.row;

describe("events.safety_notes is written from the host's safetyNotes", () => {
  it("POST /events (draft) inserts safety_notes", async () => {
    const writes = install(baseRows());
    const r = await call("POST", "/events", { title: "Lantern walk", safetyNotes: NOTES, joinMode: "approval" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = eventInsert(writes);
    assert.ok(row, "an events row was inserted");
    assert.equal(row.safety_notes, NOTES);
    assert.equal("join_mode" in row, false, "joinMode is not given a meaning the server does not have");
  });

  it("POST /events without safetyNotes inserts null", async () => {
    const writes = install(baseRows());
    const r = await call("POST", "/events", { title: "Lantern walk" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(eventInsert(writes)?.safety_notes, null);
  });

  it("POST /events/drafts/:draftId/publish — the app's create flow — carries the draft's notes into the event", async () => {
    const rows = baseRows();
    rows.events = []; // the duplicate check (same host, place and time) must find nothing to refuse on
    const writes = install(rows);
    const r = await call("POST", `/events/drafts/${DRAFT}/publish`, {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(eventInsert(writes)?.safety_notes, NOTES);
  });

  it("PATCH /events/:id writes safety_notes when sent, clears it with null, and leaves it alone when absent", async () => {
    let writes = install(baseRows());
    let r = await call("PATCH", `/events/${EVENT}`, { safetyNotes: NOTES });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(writes.find((w) => w.table === "events" && w.kind === "update")?.row.safety_notes, NOTES);

    writes = install(baseRows());
    r = await call("PATCH", `/events/${EVENT}`, { safetyNotes: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(writes.find((w) => w.table === "events" && w.kind === "update")?.row.safety_notes, null);

    writes = install(baseRows());
    r = await call("PATCH", `/events/${EVENT}`, { title: "Renamed walk" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal("safety_notes" in (writes.find((w) => w.table === "events" && w.kind === "update")?.row ?? {}), false);
  });

  it("over-long notes are refused rather than truncated", async () => {
    install(baseRows());
    const r = await call("POST", "/events", { title: "Lantern walk", safetyNotes: "x".repeat(1001) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});
