/**
 * Wave 5 follow-up B4 — the events waitlist's same-instant race, through the REAL events router, on PostgreSQL
 * (PGlite 16, in-process), with migration 3906 applied ("present") and not applied ("absent": production today).
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventsWaitlistSeatLockRace.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECT (census-trust, follow-up B2's "Still open"; wave5-waitlist3 handback §4). Two passes in the same instant
 * both read "no live offer"; the first claims W1, the second reads the queue head after that claim and claims W2: two
 * offers for one seat. Two holders of live offers for the last seat both count going < max_attendees and both upsert
 * going: two seated in one seat. Neither has a code-only fix: the guard spans two tables.
 *
 * THE RACE IS PRODUCED, NOT HOPED FOR. Every statement the route sends goes through one runner, which holds the
 * statements a race needs held:
 *   claim race   two requests whose syncs each offer the free seat to the queue. The FIRST queue-head read waits until
 *                BOTH passes have read "no live offer"; the SECOND waits until the first pass's claim has run. That is
 *                exactly the interleaving the old claim lost.
 *   accept race  two accepts for the last seat. Each one's seat-taking write (the upsert today, the locked accept under
 *                3906) waits until BOTH requests have reached it, so both have passed every check first.
 * The same harness, the same statements, the same gates: ABSENT reproduces the defect (anti-vacuity — the harness can
 * produce the race), PRESENT closes it. PGlite is one session, so the database itself never waits on a lock here;
 * what it proves is that the function's count, taken after the event row is locked, sees the first claim or seat.
 * The lock WAIT is proven on real PostgreSQL by src/test/db/eventWaitlistSeatLock.db.test.ts (CI local-db).
 *
 * THE DOUBLE. sqlPostgrestAdapter (src/test/db/) renders each supabase-js builder call as SQL and runs it on PGlite,
 * through `wrapForJson` so rows come back as PostgREST serialises them (timestamps as ISO text). Added here: `.rpc()`
 * (named arguments, as PostgREST passes them; an absent function is PostgreSQL's own 42883) and `.upsert()`
 * (INSERT … ON CONFLICT DO UPDATE). Tables: the baseline's own definitions (baseline/20260819_baseline_structure.sql,
 * verbatim) for every table the paths touch; one stand-in: events without its PostGIS `geog` column (PGlite has no
 * PostGIS; nothing here reads it).
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _setTestFetch } from "../lib/push.js";
import { logger } from "../lib/logger.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import eventsRouter from "../routes/events.js";
import { makeSqlClient, wrapForJson, lit } from "./db/sqlPostgrestAdapter.js";
import { EVENT_WAITLIST_SCHEMA as SCHEMA } from "./helpers/eventWaitlistPgliteSchema.js";

const MIGRATION = "3906_event_waitlist_seat_under_event_lock.sql";
const sql3906 = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");

// ── people, event ─────────────────────────────────────────────────────────────
const HOST = "f1111111-1111-4111-8111-111111111101";
const A1   = "f1111111-1111-4111-8111-111111111102";
const A2   = "f1111111-1111-4111-8111-111111111103";
const W1   = "f1111111-1111-4111-8111-111111111104";
const W2   = "f1111111-1111-4111-8111-111111111105";
const W3   = "f1111111-1111-4111-8111-111111111106";
const W4   = "f1111111-1111-4111-8111-111111111107";
const EV   = "f2222222-2222-4222-8222-222222222201";
const PEOPLE: Record<string, string> = { host: HOST, a1: A1, a2: A2, w1: W1, w2: W2, w3: W3, w4: W4 };
const SPOT_FILLED = "This spot was filled before you accepted. You have been returned to the waitlist queue.";

// ── the double ────────────────────────────────────────────────────────────────
type Db = { exec(s: string): Promise<unknown>; query(s: string): Promise<{ rows: any[] }>; close(): Promise<void> };
type Gate = (sql: string) => Promise<void>;
type RpcFault = (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown } | Error | undefined | Promise<{ data: unknown; error: unknown } | undefined>;
interface Rig { db: Db; client: any; statements: string[]; rpcs: Array<{ fn: string; args: Record<string, unknown>; answer: unknown }>; gate: { before: Gate | null; after: ((sql: string) => void) | null }; fault: { rpc: RpcFault | null } }

let PGlite: any;
async function pglite(): Promise<Db> {
  if (!PGlite) ({ PGlite } = await import(process.env.DISCOVERY_PGLITE_MODULE ?? "@electric-sql/pglite"));
  const db = new PGlite();
  await db.exec(SCHEMA);
  return db;
}

function makeClient(db: Db, rig: Omit<Rig, "client" | "db">) {
  const run = async (q: string): Promise<any[]> => {
    if (rig.gate.before) await rig.gate.before(q);
    rig.statements.push(q);
    const r = await db.query(wrapForJson(q));
    rig.gate.after?.(q);
    return JSON.parse(String(r.rows[0]?.j ?? "[]"));
  };
  const base = makeSqlClient(run);
  const upsert = (tableName: string, row: Record<string, unknown> | Array<Record<string, unknown>>, opts?: { onConflict?: string }) => {
    const rows = Array.isArray(row) ? row : [row];
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)))];
    const conflict = String(opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const set = keys.filter((k) => !conflict.includes(k)).map((k) => `"${k}" = EXCLUDED."${k}"`);
    const q = `INSERT INTO public."${tableName}" AS t0 (${keys.map((k) => `"${k}"`).join(", ")}) VALUES ${rows.map((r) => `(${keys.map((k) => lit(r[k])).join(", ")})`).join(", ")}`
      + (conflict.length ? ` ON CONFLICT (${conflict.map((c) => `"${c}"`).join(", ")}) DO ${set.length ? `UPDATE SET ${set.join(", ")}` : "NOTHING"}` : "") + " RETURNING *";
    const exec = async () => { try { return { data: await run(q), error: null }; } catch (e: any) { return { data: null, error: { code: e?.code, message: String(e?.message ?? e) } }; } };
    const b: any = { select() { return b; }, then(onF: any, onR: any) { return exec().then(onF, onR); } };
    return b;
  };
  return {
    from(t: string) {
      const inner = base.from(t);
      return new Proxy(inner, { get(target: any, p) { return p === "upsert" ? (row: any, o?: any) => upsert(t, row, o) : target[p]; } });
    },
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      if (!/^[a-z_]+$/.test(fn)) throw new Error(`rpc name ${fn}`);
      const injected = await rig.fault.rpc?.(fn, args);
      if (injected !== undefined) { rig.rpcs.push({ fn, args, answer: injected instanceof Error ? injected.message : (injected.error ?? injected.data) }); if (injected instanceof Error) throw injected; return injected; }
      const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(", ");
      const q = `SELECT to_json(public.${fn}(${named})) AS r`;
      try {
        if (rig.gate.before) await rig.gate.before(q);
        rig.statements.push(q);
        const r = await db.query(q);
        rig.gate.after?.(q);
        const answer = { data: r.rows[0]?.r ?? null, error: null };
        rig.rpcs.push({ fn, args, answer: answer.data });
        return answer;
      } catch (e: any) {
        const answer = { data: null, error: { code: String(e?.code ?? ""), message: String(e?.message ?? e) } };
        rig.rpcs.push({ fn, args, answer: answer.error });
        return answer;
      }
    },
    auth: base.auth,
  };
}

interface WorldOpts { present: boolean; max?: number; state?: string; going?: string[]; queue?: Array<[string, number, string | null]> }
const LIVE = "2099-01-01T00:00:00.000Z";
async function world(o: WorldOpts): Promise<Rig> {
  const db = await pglite();
  const ins = (t: string, row: Record<string, unknown>) => `INSERT INTO public.${t} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(lit).join(", ")});`;
  const seed: string[] = [];
  for (const [handle, id] of Object.entries(PEOPLE)) seed.push(ins("profiles", { id, handle, name: handle, expo_push_token: `ExponentPushToken[${handle}]` }));
  for (const flag of ["events_enabled", "events_waitlist_enabled", "push_notifications_enabled"]) seed.push(ins("feature_flags", { flag, enabled: true }));
  seed.push(ins("events", { id: EV, host_id: HOST, title: "Rooftop quiz", state: o.state ?? "waitlist", visibility: "public", max_attendees: o.max ?? 2, waitlist_enabled: true, starts_at: "2030-01-01T00:00:00.000Z" }));
  for (const u of o.going ?? [A1]) seed.push(ins("event_rsvps", { event_id: EV, user_id: u, status: "going" }));
  for (const [u, p, offer] of o.queue ?? []) seed.push(ins("event_waitlist", { event_id: EV, user_id: u, position: p, offer_expires_at: offer }));
  await db.exec(seed.join("\n"));
  if (o.present) await db.exec(sql3906);
  const rig = { db, statements: [] as string[], rpcs: [] as Rig["rpcs"], gate: { before: null, after: null } as Rig["gate"], fault: { rpc: null } as Rig["fault"] };
  const client = makeClient(db, rig);
  _setTestClient(client, true);
  _setTestServiceClient(client as any);
  return { ...rig, client };
}

// ── what happened ─────────────────────────────────────────────────────────────
const q1 = async (d: Rig, s: string) => (await d.db.query(s)).rows;
const liveOffers = async (d: Rig) => (await q1(d, `SELECT user_id FROM public.event_waitlist WHERE event_id = '${EV}' AND offer_expires_at > now() ORDER BY position`)).map((r) => r.user_id);
const goingIds = async (d: Rig) => (await q1(d, `SELECT user_id FROM public.event_rsvps WHERE event_id = '${EV}' AND status = 'going' ORDER BY user_id`)).map((r) => r.user_id);
const queue = async (d: Rig) => (await q1(d, `SELECT user_id, position, offer_expires_at FROM public.event_waitlist WHERE event_id = '${EV}' ORDER BY position`)).map((r) => [r.user_id, r.position, r.offer_expires_at === null ? null : "offer"]);
const noticesTo = async (d: Rig) => (await q1(d, `SELECT user_id FROM public.notifications WHERE event_type = 'event.waitlist_offer' ORDER BY user_id`)).map((r) => r.user_id);
const stateOf = async (d: Rig) => (await q1(d, `SELECT state::text AS s FROM public.events WHERE id = '${EV}'`))[0]?.s;
const lockedCalls = (d: Rig, fn: string) => d.rpcs.filter((r) => r.fn === fn && r.args["p_event_id"] === EV);
const NIL = "00000000-0000-0000-0000-000000000000";
const probes = (d: Rig, fn: string) => d.rpcs.filter((r) => r.fn === fn && r.args["p_event_id"] === NIL);
const said = (level: string, re: RegExp) => logs.some((l) => l.level === level && re.test(`${l.msg} ${JSON.stringify(l.obj ?? {})}`));

/** Resolve when `pred` holds; fail loudly when the race could not be produced. */
function waitFor(pred: () => boolean, what: string, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) return resolve(); if (Date.now() - t0 > ms) return reject(new Error(`the race was not produced: ${what}`)); setTimeout(tick, 2); };
    tick();
  });
}
const isLiveCheck = (s: string) => /FROM public\."event_waitlist" AS t0 WHERE "event_id" = '[^']+' AND "offer_expires_at" > '/.test(s) && /LIMIT 1$/.test(s);
const isHeadRead = (s: string) => /FROM public\."event_waitlist" AS t0 WHERE "event_id" = '[^']+' AND "offer_expires_at" IS NULL ORDER BY "position" ASC LIMIT 1$/.test(s);
const isClaim = (s: string) => (/^UPDATE public\."event_waitlist" AS t0 SET "offer_expires_at" = '\d/.test(s)) || (s.includes("public.claim_waitlist_seat(") && s.includes(EV));
const isSeatWrite = (s: string) => /^INSERT INTO public\."event_rsvps"/.test(s) || (s.includes("public.accept_waitlist_seat(") && s.includes(EV));

/** The claim race's gate: head read #1 after both live checks; head read #2 after the first claim. */
function claimRaceGate(d: Rig): { produced: () => boolean } {
  let checks = 0, heads = 0, claims = 0, secondHeadAfterFirstClaim = false;
  d.gate.before = async (s) => {
    if (!isHeadRead(s)) return;
    const n = ++heads;
    if (n === 1) await waitFor(() => checks >= 2, "both passes read 'no live offer' before either read the queue head");
    if (n === 2) { await waitFor(() => claims >= 1, "the first pass claimed before the second read the head"); secondHeadAfterFirstClaim = true; }
  };
  d.gate.after = (s) => { if (isLiveCheck(s)) checks++; if (isClaim(s)) claims++; };
  return { produced: () => checks >= 2 && secondHeadAfterFirstClaim };
}

/** The accept race's gate: each seat-taking write waits until both accepts have reached theirs. */
function acceptRaceGate(d: Rig): { produced: () => boolean } {
  let arrived = 0;
  d.gate.before = async (s) => {
    if (!isSeatWrite(s)) return;
    arrived++;
    await waitFor(() => arrived >= 2, "both accepts reached their seat-taking write");
  };
  return { produced: () => arrived >= 2 };
}

// ── the server, the logs, the pushes ──────────────────────────────────────────
let server: http.Server;
let base = "";
const logs: Array<{ level: string; msg: string; obj: unknown }> = [];
const pushes: unknown[] = [];
const origLogger = { warn: logger.warn, error: logger.error, info: logger.info };
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const cap = (level: string) => (o: unknown, m?: string) => { logs.push({ level, msg: String(m ?? o), obj: o }); };
    req.log = { error: cap("error"), warn: cap("warn"), info: cap("info"), debug() {}, child() { return req.log; } };
    next();
  });
  app.use(eventsRouter);
  app.use(globalErrorHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null, false);
  _setTestServiceClient(null);
});
let current: Rig | null = null;
beforeEach(() => {
  _resetRateLimit();
  logs.length = 0; pushes.length = 0;
  (logger as any).warn = (o: unknown, m?: string) => { logs.push({ level: "warn", msg: String(m ?? o), obj: o }); };
  (logger as any).error = (o: unknown, m?: string) => { logs.push({ level: "error", msg: String(m ?? o), obj: o }); };
  (logger as any).info = (o: unknown, m?: string) => { logs.push({ level: "info", msg: String(m ?? o), obj: o }); };
  _setTestFetch((async (_u: any, init: any) => { const msgs = JSON.parse(String(init?.body ?? "[]")); pushes.push(msgs); return new Response(JSON.stringify({ data: (msgs as any[]).map(() => ({ status: "ok", id: "t" })) }), { status: 200, headers: { "content-type": "application/json" } }); }) as any);
});
afterEach(async () => {
  _setTestFetch(null); (logger as any).warn = origLogger.warn; (logger as any).error = origLogger.error; (logger as any).info = origLogger.info;
  if (current) { await current.db.close(); current = null; }
});

async function call(method: string, path: string, who: string) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${PEOPLE[who]}`, "content-type": "application/json" } });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
const settle = () => new Promise((r) => setTimeout(r, 40));
const errors = () => logs.filter((l) => l.level === "error").map((l) => l.msg);

// ═════════════════════════════════════════════════════════════════════════════
describe("B4.1 — two passes in the same instant, one free seat: one offer", () => {
  // max 2, going [A1]: one seat free and held for the queue (state waitlist). W1, W2 queued without offers; W3 and W4
  // are queued too and leave the queue at the same instant — each DELETE /waitlist syncs, and each sync's catch-up
  // offers the free seat to the queue.
  const scene = (present: boolean): WorldOpts => ({ present, queue: [[W1, 1, null], [W2, 2, null], [W3, 3, null], [W4, 4, null]] });

  it("ABSENT (3906 unapplied — today): the produced race makes TWO offers for one seat (anti-vacuity: the harness reproduces the defect)", async () => {
    const d = current = await world(scene(false));
    const gate = claimRaceGate(d);
    const [a, b] = await Promise.all([call("DELETE", `/events/${EV}/waitlist`, "w3"), call("DELETE", `/events/${EV}/waitlist`, "w4")]);
    await settle();
    assert.equal(a.status, 200, a.raw); assert.equal(b.status, 200, b.raw);
    assert.ok(gate.produced(), "the interleaving was produced");
    assert.deepEqual(await liveOffers(d), [W1, W2], "two offers for one seat");
    assert.deepEqual(await noticesTo(d), [W1, W2].sort());
    assert.equal(lockedCalls(d, "claim_waitlist_seat").length, 0, "no locked claim was attempted: the function is absent");
    assert.ok(probes(d, "claim_waitlist_seat").length >= 1 && probes(d, "claim_waitlist_seat").every((p) => (p.answer as any)?.code === "42883"), "the probe was sent and answered 42883 (undefined_function)");
    assert.ok(said("info", /not installed \(migration 3906 unapplied\)/));
  });

  it("PRESENT (3906 applied): the same race makes ONE offer — the second claim counts the first under the event lock and is refused", async () => {
    const d = current = await world(scene(true));
    const gate = claimRaceGate(d);
    const [a, b] = await Promise.all([call("DELETE", `/events/${EV}/waitlist`, "w3"), call("DELETE", `/events/${EV}/waitlist`, "w4")]);
    await settle();
    assert.equal(a.status, 200, a.raw); assert.equal(b.status, 200, b.raw);
    assert.ok(gate.produced(), "the interleaving was produced");
    assert.deepEqual(await liveOffers(d), [W1], "one offer for one seat");
    assert.deepEqual(await noticesTo(d), [W1], "only the person who holds the offer is told");
    assert.deepEqual(lockedCalls(d, "claim_waitlist_seat").map((c) => [c.args["p_user_id"], c.answer]), [[W1, "claimed"], [W2, "no_seat"]]);
    assert.equal(await stateOf(d), "waitlist", "the seat stays reserved for the offer holder");
    assert.deepEqual(errors(), []);
    assert.ok(!said("warn", /HELD/), "no_seat is a decided answer, not a failure: nothing is held");
  });
});

describe("B4.2 — two accepts for the last seat: one seated", () => {
  // max 2, going [A1]. W1 and W2 BOTH hold live offers (a surplus offer, e.g. left by B4.1's race before 3906).
  const scene = (present: boolean): WorldOpts => ({ present, queue: [[W1, 1, LIVE], [W2, 2, LIVE], [W3, 3, null]] });

  it("ABSENT (today): both accepts pass the count and both are seated — three going in two seats (anti-vacuity)", async () => {
    const d = current = await world(scene(false));
    const gate = acceptRaceGate(d);
    const [a, b] = await Promise.all([call("POST", `/events/${EV}/waitlist/accept`, "w1"), call("POST", `/events/${EV}/waitlist/accept`, "w2")]);
    await settle();
    assert.ok(gate.produced(), "the interleaving was produced");
    assert.deepEqual([a.status, b.status], [200, 200], `${a.raw} ${b.raw}`);
    assert.deepEqual(await goingIds(d), [A1, W1, W2].sort(), "two seated in one seat");
  });

  it("PRESENT: one is seated; the other is told the spot was filled, keeps their place, and nobody else is offered", async () => {
    const d = current = await world(scene(true));
    const gate = acceptRaceGate(d);
    const [a, b] = await Promise.all([call("POST", `/events/${EV}/waitlist/accept`, "w1"), call("POST", `/events/${EV}/waitlist/accept`, "w2")]);
    await settle();
    assert.ok(gate.produced(), "the interleaving was produced");
    const answers = [a, b].map((r) => `${r.status} ${r.status === 200 ? r.body.status : r.body.message}`).sort();
    assert.deepEqual(answers, ["200 going", `403 ${SPOT_FILLED}`]);
    const going = await goingIds(d);
    assert.equal(going.length, 2, "max_attendees is 2");
    const winner = going.find((u: string) => u !== A1)!;
    const loser = winner === W1 ? W2 : W1;
    assert.deepEqual(await queue(d), [[loser, loser === W1 ? 1 : 2, null], [W3, 3, null]], "the loser keeps their place, offer withdrawn; the winner left the queue");
    assert.deepEqual(await liveOffers(d), [], "no seat is free, so nobody is offered one");
    assert.deepEqual(await noticesTo(d), []);
    assert.equal(await stateOf(d), "waitlist");
    assert.deepEqual(lockedCalls(d, "accept_waitlist_seat").map((c) => c.answer).sort(), ["no_seat", "seated"]);
  });
});

describe("B4.3 — PRESENT, one request at a time: the locked paths do what today's did (controls), and the lock's own refusals", () => {
  it("CONTROL: a going attendee leaves (DELETE /rsvp) — the freed seat is offered to the queue head under the lock, told by notice and push", async () => {
    const d = current = await world({ present: true, going: [A1, A2], queue: [[W1, 1, null], [W2, 2, null]] });
    const r = await call("DELETE", `/events/${EV}/rsvp`, "a2");
    await settle();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(await liveOffers(d), [W1]);
    assert.deepEqual(await noticesTo(d), [W1]);
    assert.equal(pushes.length, 1);
    assert.deepEqual(lockedCalls(d, "claim_waitlist_seat").map((c) => c.answer), ["claimed"]);
    assert.ok(!d.statements.some((s) => /^UPDATE public\."event_waitlist" AS t0 SET "offer_expires_at" = '\d/.test(s)), "the unlocked claim was not sent");
    assert.equal(await stateOf(d), "waitlist");
  });

  it("CONTROL: an accept with a free seat seats the person, removes their queue row, and runs today's after-steps (counts, attendee row, state)", async () => {
    const d = current = await world({ present: true, queue: [[W1, 1, LIVE], [W2, 2, null]] });
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { status: "going", eventId: EV });
    assert.deepEqual(await goingIds(d), [A1, W1].sort());
    assert.deepEqual(await queue(d), [[W2, 2, null]]);
    assert.deepEqual((await q1(d, `SELECT going_count, waitlist_count FROM public.events WHERE id = '${EV}'`))[0], { going_count: 2, waitlist_count: 1 });
    assert.equal((await q1(d, `SELECT count(*)::int AS n FROM public.event_attendees WHERE event_id = '${EV}' AND user_id = '${W1}'`))[0].n, 1);
    assert.equal(await stateOf(d), "waitlist", "2 of 2: full, waitlist on");
    assert.ok(!d.statements.some((s) => /^INSERT INTO public\."event_rsvps"/.test(s)), "the unlocked upsert was not sent");
    assert.ok(!d.statements.some((s) => /^DELETE FROM public\."event_waitlist"/.test(s)), "the queue row went with the RSVP, in the function — not by a second statement");
  });

  it("the event is gone between the pick and the locked claim: no offer, nothing held, nothing written", async () => {
    const d = current = await world({ present: true, going: [A1, A2], queue: [[W1, 1, null]] });
    d.gate.before = async (s) => { if (s.includes("public.claim_waitlist_seat(") && s.includes(EV)) { d.gate.before = null; await d.db.exec(`DELETE FROM public.events WHERE id = '${EV}'`); } };
    const r = await call("DELETE", `/events/${EV}/rsvp`, "a2");
    await settle();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(lockedCalls(d, "claim_waitlist_seat").map((c) => c.answer), ["no_event"]);
    assert.deepEqual(await noticesTo(d), []);
    assert.ok(!said("warn", /HELD/));
  });

  it("CONTROL: an event with no max_attendees has no capacity to count — the claim and the accept proceed as today", async () => {
    const d = current = await world({ present: true, state: "open", going: [A1, A2], queue: [[W1, 1, LIVE], [W2, 2, null]] });
    await d.db.exec(`UPDATE public.events SET max_attendees = NULL WHERE id = '${EV}'`);
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(await goingIds(d), [A1, A2, W1].sort());
    assert.deepEqual(lockedCalls(d, "accept_waitlist_seat").map((c) => c.answer), ["seated"]);
    const claim = await d.db.query(`SELECT public.claim_waitlist_seat('${EV}', '${W2}', now() + interval '1 day') AS a`);
    assert.equal(claim.rows[0].a, "claimed", "no capacity is counted: three going, and W2 is still offered");
  });

  // Each of these changes the row between the route's own checks and the locked accept — the window the lock closes.
  const between = async (d: Rig, statement: string) => {
    d.gate.before = async (s) => { if (s.includes("public.accept_waitlist_seat(") && s.includes(EV)) { d.gate.before = null; await d.db.exec(statement); } };
  };
  it("the offer lapsed after the route's check: 403 'Your spot offer has expired', nothing written (the sweeper releases the row, once)", async () => {
    const d = current = await world({ present: true, queue: [[W1, 1, LIVE], [W2, 2, null]] });
    await between(d, `UPDATE public.event_waitlist SET offer_expires_at = now() - interval '1 minute' WHERE user_id = '${W1}'`);
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body.message, "Your spot offer has expired");
    assert.deepEqual(await goingIds(d), [A1]);
    assert.deepEqual(await queue(d), [[W1, 1, "offer"], [W2, 2, null]]);
  });
  it("the offer was withdrawn after the route's check: 403 'No spot offer is pending for you', nothing written", async () => {
    const d = current = await world({ present: true, queue: [[W1, 1, LIVE]] });
    await between(d, `UPDATE public.event_waitlist SET offer_expires_at = NULL WHERE user_id = '${W1}'`);
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body.message, "No spot offer is pending for you");
    assert.deepEqual(await goingIds(d), [A1]);
  });
  it("the queue row went after the route's check: 404 'Not on waitlist for this event', nothing written", async () => {
    const d = current = await world({ present: true, queue: [[W1, 1, LIVE]] });
    await between(d, `DELETE FROM public.event_waitlist WHERE user_id = '${W1}'`);
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    assert.equal(r.status, 404, r.raw);
    assert.equal(r.body.message, "Not on waitlist for this event");
    assert.deepEqual(await goingIds(d), [A1]);
  });
  it("the event was cancelled after the route's check: 403 'no longer accepting attendees', nobody seated", async () => {
    const d = current = await world({ present: true, queue: [[W1, 1, LIVE]] });
    await between(d, `UPDATE public.events SET state = 'cancelled' WHERE id = '${EV}'`);
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body.message, "This event is no longer accepting attendees");
    assert.deepEqual(await goingIds(d), [A1]);
    assert.deepEqual(await queue(d), [[W1, 1, "offer"]]);
  });
  it("ABSENT, the same cancellation window (anti-vacuity): today's accept seats the person on the cancelled event", async () => {
    const d = current = await world({ present: false, queue: [[W1, 1, LIVE]] });
    d.gate.before = async (s) => { if (/^INSERT INTO public\."event_rsvps"/.test(s)) { d.gate.before = null; await d.db.exec(`UPDATE public.events SET state = 'cancelled' WHERE id = '${EV}'`); } };
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(await goingIds(d), [A1, W1].sort());
  });
});

describe("B4.4 — PRESENT, a failed locked call is a failure: never a fall-back to the unlocked statements", () => {
  const isLocked = (fn: string) => (f: string, args: Record<string, unknown>) => (f === fn && args["p_event_id"] === EV);

  it("the locked claim fails (57014): nobody is offered, the seat is HELD (state not reopened), warn", async () => {
    const d = current = await world({ present: true, going: [A1, A2], queue: [[W1, 1, null]] });
    d.fault.rpc = (f, a) => (isLocked("claim_waitlist_seat")(f, a) ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    const r = await call("DELETE", `/events/${EV}/rsvp`, "a2");
    await settle();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(await liveOffers(d), []);
    assert.deepEqual(await noticesTo(d), []);
    assert.equal(await stateOf(d), "waitlist", "held: not reopened to walk-ins");
    assert.ok(!d.statements.some((s) => /^UPDATE public\."event_waitlist" AS t0 SET "offer_expires_at" = '\d/.test(s)), "the unlocked claim was not sent");
    assert.ok(said("warn", /the locked claim failed — seat not offered/));
    assert.ok(said("warn", /seat is HELD for the queue/));
  });

  it("the locked claim's answer is lost (no code — a dropped connection): the same — held, nothing unlocked sent", async () => {
    const d = current = await world({ present: true, going: [A1, A2], queue: [[W1, 1, null]] });
    d.fault.rpc = (f, a) => (isLocked("claim_waitlist_seat")(f, a) ? { data: null, error: { message: "TypeError: fetch failed", code: "" } } : undefined);
    const r = await call("DELETE", `/events/${EV}/rsvp`, "a2");
    await settle();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(await liveOffers(d), []);
    assert.ok(!d.statements.some((s) => /^UPDATE public\."event_waitlist" AS t0 SET "offer_expires_at" = '\d/.test(s)));
  });

  it("the locked accept fails (57014): 503, nothing written, the offer stands", async () => {
    const d = current = await world({ present: true, queue: [[W1, 1, LIVE]] });
    d.fault.rpc = (f, a) => (isLocked("accept_waitlist_seat")(f, a) ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.message, "We could not confirm your place just now. Please refresh the event, then try again.");
    assert.deepEqual(await goingIds(d), [A1]);
    assert.deepEqual(await queue(d), [[W1, 1, "offer"]]);
    assert.ok(!d.statements.some((s) => /^INSERT INTO public\."event_rsvps"/.test(s)), "the unlocked upsert was not sent");
    assert.ok(said("error", /the locked accept failed/));
  });

  it("the locked accept's answer is lost after it COMMITTED (no code): 503 asks the person to look first; the unlocked accept is not run on top", async () => {
    const d = current = await world({ present: true, queue: [[W1, 1, LIVE]] });
    d.fault.rpc = async (f, a) => {
      if (!isLocked("accept_waitlist_seat")(f, a)) return undefined;
      assert.equal((await d.db.query(`SELECT public.accept_waitlist_seat('${EV}', '${W1}') AS a`)).rows[0].a, "seated"); // it ran and committed; only the answer was lost
      return { data: null, error: { message: "TypeError: fetch failed", code: "" } };
    };
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    await settle();
    assert.equal(r.status, 503, r.raw);
    assert.match(r.body.message, /refresh the event/);
    assert.deepEqual(await goingIds(d), [A1, W1].sort(), "the committed seat stands");
    assert.ok(!d.statements.some((s) => /^INSERT INTO public\."event_rsvps"/.test(s)));
    assert.ok(!d.statements.some((s) => /UPDATE public\."event_waitlist" AS t0 SET "offer_expires_at" = NULL/.test(s)), "not told 'spot filled' and withdrawn on top");
  });

  it("the accept function vanished after the probe (PGRST202 on the real call: nothing ran): today's accept runs and seats them", async () => {
    const d = current = await world({ present: true, queue: [[W1, 1, LIVE]] });
    d.fault.rpc = (f, a) => (isLocked("accept_waitlist_seat")(f, a) ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.accept_waitlist_seat" } } : undefined);
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "w1");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(await goingIds(d), [A1, W1].sort());
    assert.ok(d.statements.some((s) => /^INSERT INTO public\."event_rsvps"/.test(s)), "today's upsert");
  });

  it("the function vanished after the probe (PGRST202 on the real call: nothing ran): today's statements run, and the verdict becomes 'missing'", async () => {
    const d = current = await world({ present: true, going: [A1, A2], queue: [[W1, 1, null]] });
    d.fault.rpc = (f, a) => (isLocked("claim_waitlist_seat")(f, a) ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.claim_waitlist_seat" } } : undefined);
    const r = await call("DELETE", `/events/${EV}/rsvp`, "a2");
    await settle();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(await liveOffers(d), [W1], "offered by today's UPDATE");
    assert.ok(d.statements.some((s) => /^UPDATE public\."event_waitlist" AS t0 SET "offer_expires_at" = '\d/.test(s)));
    d.rpcs.length = 0;
    await d.db.exec(`UPDATE public.event_waitlist SET offer_expires_at = NULL; INSERT INTO public.event_rsvps (event_id, user_id, status) VALUES ('${EV}', '${A2}', 'going');`);
    const again = await call("DELETE", `/events/${EV}/rsvp`, "a2");
    assert.equal(again.status, 200, again.raw);
    assert.deepEqual(d.rpcs.map((c) => c.fn), [], "within the absent TTL the probe is not repeated and no locked call is made");
  });
});

describe("B4.5 — the probe: what establishes the function, and what does not", () => {
  it("a client with no rpc surface at all (a double): today's statements run; nothing is probed or logged", async () => {
    const d = current = await world({ present: true, going: [A1, A2], queue: [[W1, 1, null]] });
    delete (d.client as any).rpc;
    const r = await call("DELETE", `/events/${EV}/rsvp`, "a2");
    await settle();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(await liveOffers(d), [W1]);
    assert.ok(d.statements.some((s) => /^UPDATE public\."event_waitlist" AS t0 SET "offer_expires_at" = '\d/.test(s)));
    assert.ok(!said("warn", /waitlist seat lock/), "no probe was attempted");
  });

  it("READY is memoised: a second promotion within the TTL makes the locked call without probing again", async () => {
    const d = current = await world({ present: true, going: [A1, A2], queue: [[W1, 1, null], [W2, 2, null]] });
    await call("DELETE", `/events/${EV}/rsvp`, "a2");
    await d.db.exec(`INSERT INTO public.event_rsvps (event_id, user_id, status) VALUES ('${EV}', '${A2}', 'going'); DELETE FROM public.event_rsvps WHERE user_id = '${A1}';`);
    await call("DELETE", `/events/${EV}/rsvp`, "a2");
    assert.equal(probes(d, "claim_waitlist_seat").length, 1);
    assert.equal(lockedCalls(d, "claim_waitlist_seat").length, 2);
  });

  for (const [label, fault] of [
    ["a probe that THROWS", () => new Error("socket hang up")],
    ["a probe answered with no code", () => ({ data: null, error: { message: "upstream connect error", code: "" } })],
    ["a probe answered with an unexpected value", () => ({ data: "claimed", error: null })],
  ] as const) {
    it(`UNKNOWN (${label}): today's statements run — only the probe failed, and a probe writes nothing`, async () => {
      const d = current = await world({ present: true, going: [A1, A2], queue: [[W1, 1, null]] });
      d.fault.rpc = (f, a) => (a["p_event_id"] === NIL ? (fault as any)() : undefined);
      const r = await call("DELETE", `/events/${EV}/rsvp`, "a2");
      await settle();
      assert.equal(r.status, 200, r.raw);
      assert.deepEqual(await liveOffers(d), [W1]);
      assert.equal(lockedCalls(d, "claim_waitlist_seat").length, 0);
      assert.ok(d.statements.some((s) => /^UPDATE public\."event_waitlist" AS t0 SET "offer_expires_at" = '\d/.test(s)));
      assert.ok(said("warn", /the unlocked statements run, as before migration 3906/));
    });
  }
});
