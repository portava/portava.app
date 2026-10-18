/**
 * census-trust (wave 5, 2026-10-18) — the host's "Event cancelled" push reads
 * EVERY attendee, and a read that fails is logged, never silent.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventAttendeePushRecipients.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECT. routes/events.ts getAttendeeRecipients — the recipient list of
 * the host's cancel push (POST /events/:id/cancel and DELETE /events/:id), and
 * of the postpone, details-updated and pinned-update pushes — read the going /
 * maybe RSVPs and then their push tokens UNPAGED, destructuring `{ data }` only:
 *   - past PostgREST's row cap (db-max-rows, 1000 hosted) the read was cut, and
 *     the attendees past it were never told the event was cancelled;
 *   - a read that FAILED resolved `data: null`, which became "nobody is going":
 *     nobody was told, and nothing anywhere said so (the callers' catch blocks
 *     log, but nothing was thrown; the details-updated push's catch was bare).
 *
 * THE FIX. Both reads go through the house pager (lib/moderationCounts.ts
 * readEveryRow, ordered on a unique key; the token read in chunks of ids), and
 * a read that fails THROWS into the caller's existing catch, which logs it at
 * WARN with the event id — the fan-out convention (routes/circle.ts
 * logCircleFanoutFailure: a failed recipients read raises and is logged). The
 * route's own contract is unchanged: the cancel is written and answered
 * exactly as before; the push stays fire-and-forget.
 *
 * DOUBLES: helpers/adminModerationDouble.ts (schemaStrictSupabase + paging, a
 * row cap that cuts every list answer silently as max-rows does, and read
 * overrides). Pushes are caught at lib/push.ts's fetch seam; nothing leaves
 * the process. Logs are caught on req.log.
 *
 * Each case says whether it was RED or GREEN on the code before this change
 * (6f0eea215).
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _setTestFetch } from "../lib/push.js";
import eventsRouter from "../routes/events.js";
import { installModerationDouble, isListRead, selectOf, type Call } from "./helpers/adminModerationDouble.js";
import type { Seed, Row } from "./helpers/schemaStrictSupabase.js";

const HOST  = "a3333333-3333-4333-8333-33333333d0a0";
const EVENT = "b4444444-4444-4444-8444-44444444d0a0";
const TOKENS: Record<string, string> = { "host-token": HOST };
const FAIL = { message: "simulated failure", code: "57014" };
const at = (n: number) => new Date(Date.UTC(2026, 9, 3, 0, 0, n)).toISOString();
const person = (n: number) => `a${String(n).padStart(7, "0")}-5555-4555-8555-55555555d0a0`;

/** `going` + `maybe` attendees with push tokens, plus one can't-go (never told). */
function world(going: number, maybe: number, state = "open"): Seed {
  const profiles: Row[] = [{ id: HOST, handle: "host", username: "host", name: "host", display_name: "host", role: "user", account_status: "active", created_at: at(0), expo_push_token: null }];
  const rsvps: Row[] = [];
  const add = (n: number, status: string) => {
    profiles.push({ id: person(n), handle: `p${n}`, username: `p${n}`, name: `p${n}`, display_name: `p${n}`, role: "user", account_status: "active", created_at: at(0), expo_push_token: `ExponentPushToken[p${n}]` });
    rsvps.push({ event_id: EVENT, user_id: person(n), status, created_at: at(20 + n), updated_at: at(20 + n) });
  };
  let n = 1;
  for (let i = 0; i < going; i++) add(n++, "going");
  for (let i = 0; i < maybe; i++) add(n++, "maybe");
  add(n++, "cant_go");
  return {
    profiles, event_rsvps: rsvps,
    user_account_states: [], compass_settings: [], event_activity_log: [], event_roles: [], event_updates: [], trust_events: [],
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }],
    events: [{ id: EVENT, host_id: HOST, title: "Hosted event", state, visibility: "public", featured: false, city: "Bangkok", starts_at: at(9000), created_at: at(15), updated_at: at(15), chat_enabled: false }],
  };
}
const ev = (s: Seed) => s.events!.find((e) => e.id === EVENT)!;
const tokensOf = (ids: number[]) => ids.map((n) => `ExponentPushToken[p${n}]`).sort();
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** The attendee read (going + maybe) — not the trust charge's own `going` count, which reads the same table. */
const isAttendeeRead = (calls: Call[]) => isListRead(calls) && calls.some(([m, a]) => m === "in" && a[0] === "status");
/** The push-token read — not requireUser's single-row profile read. */
const isTokenRead = (calls: Call[]) => isListRead(calls) && selectOf(calls).includes("expo_push_token");

let server: http.Server;
let base = "";
let logs: Array<{ level: string; obj: any; msg: string }> = [];
let pushes: string[][] = [];
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const rec = (level: string) => (obj: any, msg?: string) => { logs.push({ level, obj, msg: String(msg ?? "") }); };
    req.log = { error: rec("error"), warn: rec("warn"), info() {}, debug() {} };
    next();
  });
  app.use(eventsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null, false);
  _setTestServiceClient(null);
});
beforeEach(() => {
  _resetRateLimit();
  logs = [];
  pushes = [];
  _setTestFetch((async (_url: any, init: any) => {
    const msgs = JSON.parse(String(init?.body ?? "[]"));
    pushes.push(msgs.map((m: any) => m.to));
    return new Response(JSON.stringify({ data: msgs.map(() => ({ status: "ok" })) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any);
});
afterEach(() => _setTestFetch(null));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(10); }
const told = () => pushes.flat().sort();

type Door = { name: string; label: RegExp; state?: string; status: number; call: () => Promise<{ status: number; body: any; raw: string }>; after?: (s: Seed) => void };
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer host-token", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
const CANCEL_POST: Door = { name: "POST /events/:id/cancel", label: /^event-cancelled push notify failed$/, status: 200, call: () => call("POST", `/events/${EVENT}/cancel`, { reason: "weather" }), after: (s) => assert.equal(ev(s).state, "cancelled") };
const CANCEL_DELETE: Door = { name: "DELETE /events/:id", label: /^event-cancelled push notify failed$/, status: 200, call: () => call("DELETE", `/events/${EVENT}`), after: (s) => assert.equal(ev(s).state, "cancelled") };
const POSTPONE: Door = { name: "POST /events/:id/postpone", label: /^event-postponed push notify failed$/, status: 200, call: () => call("POST", `/events/${EVENT}/postpone`, {}), after: (s) => assert.equal(ev(s).state, "draft") };
const UPDATED: Door = { name: "PATCH /events/:id (a key detail)", label: /^event-updated push notify failed$/, status: 200, call: () => call("PATCH", `/events/${EVENT}`, { locationName: "A new place" }) };
const PINNED: Door = { name: "POST /events/:id/updates (pinned)", label: /^event-update push notify failed$/, status: 201, call: () => call("POST", `/events/${EVENT}/updates`, { body: "Gate moved", pinned: true }) };

// ══════════════════════════════════════════════════════════════════════════════
// A. Every attendee is told — past the row cap
// ══════════════════════════════════════════════════════════════════════════════

describe("A. the host's cancel push reads every going / maybe attendee, past the row cap", () => {
  it("GREEN before (CONTROL): a host's cancel tells the going and maybe attendees, and nobody else", async () => {
    const s = world(2, 1);
    installModerationDouble(s, { tokens: TOKENS });
    const r = await CANCEL_POST.call();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { ok: true });
    await until(() => pushes.length > 0);
    assert.deepEqual(told(), tokensOf([1, 2, 3]), "going 1-2 and maybe 3; the can't-go 4 is not told");
  });

  for (const door of [CANCEL_POST, CANCEL_DELETE, POSTPONE]) {
    it(`RED before: ${door.name} tells EVERY attendee when they are more than one page — the read was cut at the cap`, async () => {
      const s = world(5, 2);
      installModerationDouble(s, { tokens: TOKENS, cap: 3 });
      const r = await door.call();
      assert.equal(r.status, door.status, r.raw);
      door.after?.(s);
      await until(() => told().length >= 7);
      await sleep(50);
      assert.deepEqual(told(), tokensOf(range(1, 7)), "all seven going / maybe attendees, each once; the can't-go 8 is not told");
      assert.deepEqual(logs.filter((l) => l.level === "warn" && /push notify failed/.test(l.msg)), [], "no failure is logged when the reads succeed");
    });
  }

  it("RED before: past one chunk of ids, every attendee's push token is read and paged — each read names at most 100 ids, and each id once", async () => {
    const s = world(104, 0);
    const { statements } = installModerationDouble(s, { tokens: TOKENS, cap: 40 });
    const r = await CANCEL_POST.call();
    assert.equal(r.status, 200, r.raw);
    await until(() => told().length >= 104, 4000);
    await sleep(50);
    assert.deepEqual(told(), tokensOf(range(1, 104)));
    // The chunk bounds the `.in()` request URI; a read naming every id would push the same tokens (they are de-duplicated) through ever longer URIs.
    const chunks = statements.filter((st) => st.table === "profiles" && isTokenRead(st.calls)).map((st) => st.calls.find(([m, a]) => m === "in" && a[0] === "id")![1][1] as string[]);
    assert.ok(chunks.length >= 2, `vacuity: ${chunks.length} token reads`);
    for (const c of chunks) assert.ok(c.length <= 100, `a token read named ${c.length} ids`);
    const named = [...new Set(chunks.flat())];
    assert.equal(named.length, 104, "every attendee's id is named");
    const byChunk = new Map<string, number>(); for (const c of chunks) byChunk.set(c.join(), (byChunk.get(c.join()) ?? 0) + 1);
    assert.equal(named.length, [...byChunk.keys()].reduce((n, k) => n + k.split(",").length, 0), "no id is named by two different chunks");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B. A read that fails is LOGGED — the route's contract unchanged
// ══════════════════════════════════════════════════════════════════════════════

describe("B. a failed attendee read is logged, not silent; the route answers as it always did", () => {
  for (const door of [CANCEL_POST, CANCEL_DELETE, POSTPONE, UPDATED, PINNED]) {
    it(`RED before: ${door.name} — an unreadable RSVP list is logged at WARN naming event_rsvps, and nobody is told on a guess`, async () => {
      const s = world(2, 1);
      installModerationDouble(s, { tokens: TOKENS, overrides: { event_rsvps: (calls) => (isAttendeeRead(calls) ? { data: null, error: FAIL, count: null } : null) } });
      const r = await door.call();
      assert.equal(r.status, door.status, `the route's own answer is unchanged: ${r.raw}`);
      door.after?.(s);
      await until(() => logs.some((l) => door.label.test(l.msg)));
      const hit = logs.find((l) => door.label.test(l.msg));
      assert.ok(hit, `no "${door.label.source}" log — the failure was silent. Logged: ${JSON.stringify(logs.map((l) => l.msg))}`);
      assert.equal(hit!.level, "warn");
      assert.equal(hit!.obj?.eventId, EVENT);
      assert.match(String(hit!.obj?.err?.message), /the attendees could not be read \(event_rsvps\): simulated failure; nobody was told/);
      await sleep(50);
      assert.deepEqual(pushes, [], "nobody is told from a read that failed");
    });
  }

  it("RED before: an unreadable push-token list is logged naming profiles — the cancel still stands", async () => {
    const s = world(2, 1);
    installModerationDouble(s, { tokens: TOKENS, overrides: { profiles: (calls) => (isTokenRead(calls) ? { data: null, error: FAIL, count: null } : null) } });
    const r = await CANCEL_POST.call();
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "cancelled");
    await until(() => logs.some((l) => CANCEL_POST.label.test(l.msg)));
    const hit = logs.find((l) => CANCEL_POST.label.test(l.msg));
    assert.ok(hit, `the token-read failure was silent. Logged: ${JSON.stringify(logs.map((l) => l.msg))}`);
    assert.match(String(hit!.obj?.err?.message), /push tokens could not be read \(profiles\): simulated failure; nobody was told/);
    await sleep(50);
    assert.deepEqual(pushes, []);
  });

  it("GREEN before (CONTROL): a failed cancel write is still the route's own refusal — no push, whatever the attendee reads would say", async () => {
    const s = world(2, 1);
    installModerationDouble(s, { tokens: TOKENS, strict: { writeError: { table: "events", error: { message: "update refused" } } } });
    const r = await CANCEL_POST.call();
    assert.notEqual(r.status, 200, r.raw);
    assert.equal(ev(s).state, "open");
    await sleep(100);
    assert.deepEqual(pushes, []);
  });
});
