/**
 * census-telegraph T254 — the cross-instance double-tell of a help request, closed by the DATABASE:
 * migration 3901 (one safety notification per member per help request) and its code half in
 * services/telegraph/safetyNotifications.ts (a create the index refused is `already_told` once the winner's row is SEEN).
 *
 * WHAT WOULD TURN THIS RED
 *   - the losing instance treating the index's refusal as a failure: an ERROR, a re-drive, a GAVE UP;
 *   - counting a member as told WITHOUT seeing a row (an insert that failed for another reason, or an unreadable read-back);
 *   - the code half changing anything while 3901 is absent (today's double-tell stays exactly today's);
 *   - 3901 not refusing the second row, refusing rows that are not the safety producer's, deleting a duplicate it finds,
 *     or not being re-runnable.
 *
 * The code half runs on the re-drive's own fake database (helpers/fakeSafetyRedriveDb.ts) through the REAL
 * NotificationService, with 3901 MODELLED on the fake's insert: a second row carrying the same (user_id,
 * metadata.causal_event_id) with source_type 'thread_safety_alert' answers 23505, as PostgreSQL does. The index itself
 * is EXECUTED on PGlite (the repo's convention; PostgreSQL 16.4 in-process) over the baseline definition of
 * public.notifications.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphSafetyOncePerMember.test.ts
 */
import { describe, it, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { NotificationService } from "../services/notifications/NotificationService.js";
import {
  SAFETY_ALERT_EVENT,
  SAFETY_ALL_CLEAR_EVENT,
  SAFETY_NOTIFICATION_SOURCE,
  _resetSafetyRedriveMemo,
  notifySafetySignal,
  redriveEntry,
  redriveSafetySignal,
  type SafetyNotifyDeps,
  type SafetyNotifyOutcome,
  type SafetyRedriveOutcome,
  type SafetySignal,
} from "../services/telegraph/safetyNotifications.js";
import { _resetSafetySignalRedriveStatus, getSafetySignalRedriveStatus, runSafetySignalRedriveTick } from "../lib/safetySignalRedriveScheduler.js";
import { fakeSafetyDb, type FakeSafetyDb, type Row } from "./helpers/fakeSafetyRedriveDb.js";
import { maskForKeywordScan, postconditionBlocks } from "../scripts/lib/migrationSqlBlocks.js";

const FILE = "3901_telegraph_safety_notification_once_per_member.sql";
const sql = readFileSync(new URL(`../migrations/${FILE}`, import.meta.url), "utf8");
const INDEX = "notifications_safety_once_per_member_uniq";

const ALICE = "39010000-0000-4000-8000-000000000001"; // asks for help
const BOB = "39010000-0000-4000-8000-000000000002";
const CARL = "39010000-0000-4000-8000-000000000003";  // blocked Alice
const DANA = "39010000-0000-4000-8000-000000000004";
const FRAN = "39010000-0000-4000-8000-000000000006";  // Alice blocked her
const GINA = "39010000-0000-4000-8000-000000000007";
const THREAD = "39010000-0000-4000-8000-0000000000d1";
const MSG = "39010000-0000-4000-8000-0000000000e1";
const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const TOLD = [BOB, DANA, GINA].sort();
const sorted = (xs: readonly string[]) => [...xs].sort();

const member = (user_id: string, over: Row = {}) => ({ thread_id: THREAD, user_id, joined_at: "2026-10-01T00:00:00.000Z", visible_from_at: null, left_at: null, archived_at: null, muted_at: null, notification_level: "all", muted_until: null, ...over });
const safetyRow = (id: string, ms: number, kind: string) =>
  ({ id, thread_id: THREAD, sender_id: ALICE, created_at: at(ms), deleted_at: null, msg_type: "safety", subtype: kind, body: JSON.stringify({ kind: "SAFETY", envelopeVersion: "1", payload: { kind, label: "behind the pier gate" } }) });

function world(messages: Row[] = [safetyRow(MSG, 0, "need_help")]): Record<string, Row[]> {
  return {
    feature_flags: [],
    message_thread_members: [member(ALICE), member(BOB), member(CARL), member(DANA), member(FRAN), member(GINA)],
    blocks: [{ blocker_id: CARL, blocked_id: ALICE }, { blocker_id: ALICE, blocked_id: FRAN }],
    profiles: [{ id: ALICE, handle: "alice", display_name: "Alice Real" }],
    profile_privacy_settings: [],
    messages,
    notifications: [],
    job_health: [],
  };
}

// ── 3901, modelled on the fake's insert ─────────────────────────────────────
/** The index's predicate and key, as 3901 states them. */
function refusedBy3901(rows: readonly Row[], r: Row): boolean {
  const causal = r?.metadata?.causal_event_id;
  if (r?.source_type !== "thread_safety_alert" || typeof causal !== "string") return false;
  return rows.some((n) => n.user_id === r.user_id && n.source_type === "thread_safety_alert" && n.metadata?.causal_event_id === causal);
}
type Indexed = FakeSafetyDb & { conflicts: string[]; beforeInsert?: (r: Row) => void };
/** The same database, with 3901's unique index in force on public.notifications. */
function with3901(sc: FakeSafetyDb): Indexed {
  const out = { ...sc, conflicts: [] as string[] } as Indexed;
  out.from = (table: string) => {
    const chain = sc.from(table);
    if (table !== "notifications") return chain;
    return new Proxy(chain, {
      get(o: any, k) {
        if (k !== "insert") return o[k];
        return (r: Row) => {
          out.beforeInsert?.(r);
          if (!refusedBy3901(sc.db.notifications ?? [], r)) return o.insert(r);
          out.conflicts.push(String(r.user_id));
          const res = { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${INDEX}"` } };
          const c: any = { select: () => c, single: () => Promise.resolve(res), maybeSingle: () => Promise.resolve(res), then: (a: any, b: any) => Promise.resolve(res).then(a, b) };
          return c;
        };
      },
    });
  };
  return out;
}

/** One API instance: its own NotificationService over the shared database; `gate` runs before each create. */
function instance(sc: FakeSafetyDb, gate?: (userId: string) => Promise<void>): SafetyNotifyDeps {
  const ns = new NotificationService(sc as any);
  return {
    create: (i) => ns.create(i),
    createDetailed: async (i) => { if (gate) await gate(i.userId); return ns.createDetailed(i); },
    route: async () => undefined,
  };
}
/** Both instances reach the create for a member before either writes: each read "untold" first. */
function rendezvous(parties: number) {
  const at = new Map<string, { n: number; open: Promise<void>; release: () => void }>();
  return async (key: string) => {
    let e = at.get(key);
    if (!e) { let release!: () => void; const open = new Promise<void>((r) => { release = r; }); e = { n: 0, open, release }; at.set(key, e); }
    e.n += 1;
    if (e.n >= parties) e.release();
    await e.open;
  };
}
function logs() {
  const errors: string[] = [];
  const warns: string[] = [];
  return { errors, warns, log: { error: (_o: object, m: string) => { errors.push(m); }, warn: (_o: object, m: string) => { warns.push(m); } } };
}
const rowsFor = (sc: FakeSafetyDb, userId: string, messageId = MSG) =>
  sc.db.notifications!.filter((n) => n.user_id === userId && n.metadata?.causal_event_id === `MESSAGE:${messageId}`);
const reasons = (w: ReadonlyArray<{ userId: string; reason: string }>) => Object.fromEntries(w.map((x) => [x.userId, x.reason]));
const otherRow = (userId: string, eventType: string = SAFETY_ALERT_EVENT, messageId = MSG) =>
  ({ id: `other-${userId}`, user_id: userId, category: "safety", event_type: eventType, source_type: "thread_safety_alert", source_id: THREAD, created_at: at(0), metadata: { cause: "SAFETY", causal_event_id: `MESSAGE:${messageId}` } });
const settledComplete = (r: SafetyRedriveOutcome) => r.status === "settled" && r.reason === "complete";

beforeEach(() => {
  _resetSafetyRedriveMemo();
  _resetSafetySignalRedriveStatus();
});

describe("3901 in force: the second create is refused, and the loser counts the member as TOLD", () => {
  it("two instances re-drive the same help request at once: each member holds ONE row; the loser settles, no ERROR, nobody re-driven", async () => {
    const sc = with3901(fakeSafetyDb(world()));
    const meet = rendezvous(2);
    const a = logs();
    const b = logs();
    const [ra, rb] = await Promise.all([
      redriveSafetySignal(sc as any, MSG, { deps: instance(sc, meet), log: a.log }),
      redriveSafetySignal(sc as any, MSG, { deps: instance(sc, meet), log: b.log }),
    ]);
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, `${u} holds exactly one row`);
    assert.deepEqual(sorted(sc.conflicts), TOLD, "anti-vacuity: every member's second create reached the index");
    assert.ok(settledComplete(ra) && settledComplete(rb), `both settle: ${JSON.stringify([ra, rb])}`);
    assert.deepEqual(sorted([...ra.notified, ...rb.notified]), TOLD, "each member is told by exactly one instance");
    for (const u of TOLD) {
      const loser = ra.notified.includes(u) ? rb : ra;
      assert.equal(loser.status === "settled" && reasons(loser.withheld)[u], "already_told", `${u}: the loser counts them as told`);
    }
    assert.deepEqual([...a.errors, ...b.errors], [], "a refused duplicate is not a failure");
    assert.ok([...a.warns, ...b.warns].some((m) => /already told/i.test(m)), [...a.warns, ...b.warns].join(" | "));
  });

  it("a door and a re-drive on another instance race: the door's lost members are already_told and the door SETTLES the message", async () => {
    const sc = with3901(fakeSafetyDb(world()));
    const meet = rendezvous(2);
    const d = logs();
    const [door, redrive] = await Promise.all([
      notifySafetySignal(sc as any, { threadId: THREAD, senderId: ALICE, messageId: MSG, signal: "need_help", nowMs: T0 }, { deps: instance(sc, meet), retryDelaysMs: [0, 0], log: d.log }),
      redriveSafetySignal(sc as any, MSG, { deps: instance(sc, meet), log: d.log }),
    ]);
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
    assert.equal(sc.conflicts.length, 3, "anti-vacuity: three refused creates");
    assert.ok(door.status === "notified" && settledComplete(redrive), JSON.stringify([door, redrive]));
    const doorTold = door.status === "notified" ? door.notified : [];
    assert.deepEqual(sorted([...doorTold, ...redrive.notified]), TOLD);
    const doorReasons = door.status === "notified" ? reasons(door.withheld) : {};
    for (const u of TOLD) if (!doorTold.includes(u)) assert.equal(doorReasons[u], "already_told", u);
    assert.equal(doorReasons[CARL], "blocked");
    assert.equal(doorReasons[FRAN], "blocked");
    assert.equal(redriveEntry(MSG, T0).settled, true, "the door told everyone it could: nothing left for the re-drive");
    assert.deepEqual(d.errors, []);
  });

  it("the DOOR loses a member to another instance: that member is already_told, the door settles the message, and no pass re-drives it", async () => {
    const sc = with3901(fakeSafetyDb(world()));
    // Another instance's re-drive wrote GINA's row just before this door's insert for her.
    sc.beforeInsert = (r) => { if (r.user_id === GINA && rowsFor(sc, GINA).length === 0) sc.db.notifications!.push(otherRow(GINA)); };
    const d = logs();
    const deps = instance(sc);
    const door = await notifySafetySignal(sc as any, { threadId: THREAD, senderId: ALICE, messageId: MSG, signal: "need_help", nowMs: T0 }, { deps, retryDelaysMs: [0, 0], log: d.log });
    assert.ok(door.status === "notified", JSON.stringify(door));
    assert.deepEqual(sorted(door.status === "notified" ? door.notified : []), [BOB, DANA]);
    assert.equal(door.status === "notified" && reasons(door.withheld)[GINA], "already_told");
    assert.deepEqual(sc.conflicts, [GINA]);
    assert.equal(redriveEntry(MSG, T0).settled, true, "the door counts GINA as told: nothing is left for the re-drive");
    const attempts: number[] = [];
    for (let ms = 0; ms <= 20 * 60_000; ms += 5_000) {
      if ((await runSafetySignalRedriveTick({ client: sc, nowMs: T0 + ms, deps, log: d.log })).attempted > 0) attempts.push(ms);
    }
    assert.deepEqual(attempts, [], "settled in-process: no re-drive attempt");
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
    assert.deepEqual(d.errors, []);
  });

  it("a row lands between the 'already told' read and the create: one attempt, settled — no second point, no ERROR, no GAVE UP", async () => {
    const sc = with3901(fakeSafetyDb(world()));
    sc.fail.message_thread_members = "always"; // the door names nobody
    const deps = instance(sc);
    const door = await notifySafetySignal(sc as any, { threadId: THREAD, senderId: ALICE, messageId: MSG, signal: "need_help", nowMs: T0 }, { deps, retryDelaysMs: [0, 0], log: logs().log });
    assert.deepEqual(door, { status: "refused", stage: "roster" });
    delete sc.fail.message_thread_members;
    // Another instance's create for BOB commits after this instance read "untold" and before its own insert.
    sc.beforeInsert = (r) => { if (r.user_id === BOB && rowsFor(sc, BOB).length === 0) sc.db.notifications!.push(otherRow(BOB)); };
    const l = logs();
    const attempts: number[] = [];
    for (let ms = 0; ms <= 20 * 60_000; ms += 5_000) {
      if ((await runSafetySignalRedriveTick({ client: sc, nowMs: T0 + ms, deps, log: l.log })).attempted > 0) attempts.push(ms);
    }
    assert.deepEqual(attempts, [10_000], "settled by its first attempt");
    assert.deepEqual(sc.conflicts, [BOB], "anti-vacuity: BOB's create was refused by the index");
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
    assert.deepEqual(l.errors, [], "neither a not-created ERROR nor a GAVE UP");
    assert.equal(getSafetySignalRedriveStatus().gaveUpTotal, 0);
  });

  it("the ALL CLEAR (P1) the same way: a refused duplicate is already_told, not a failure", async () => {
    const sc = with3901(fakeSafetyDb(world([safetyRow("h1", -60_000, "need_help"), safetyRow(MSG, 0, "all_clear")])));
    sc.beforeInsert = (r) => { if (r.user_id === DANA && rowsFor(sc, DANA).length === 0) sc.db.notifications!.push(otherRow(DANA, SAFETY_ALL_CLEAR_EVENT)); };
    const l = logs();
    const r = await redriveSafetySignal(sc as any, MSG, { deps: instance(sc), log: l.log });
    assert.ok(settledComplete(r), JSON.stringify(r));
    assert.deepEqual(sorted(r.notified), [BOB, GINA]);
    assert.equal(r.status === "settled" && reasons(r.withheld)[DANA], "already_told");
    assert.deepEqual(sc.conflicts, [DANA]);
    assert.equal(rowsFor(sc, DANA).length, 1);
    assert.deepEqual(l.errors, []);
  });
});

describe("evidence, never assumption: a create that failed counts as told ONLY when the member's row is seen", () => {
  it("an insert that failed for another reason (no row to see) stays not_created: ERROR-logged and re-driven, exactly as today", async () => {
    const base = fakeSafetyDb(world());
    const sc = { ...base } as FakeSafetyDb;
    sc.from = (table: string) => {
      const chain = base.from(table);
      if (table !== "notifications") return chain;
      return new Proxy(chain, { get(o: any, k) {
        if (k !== "insert") return o[k];
        return (r: Row) => {
          if (r.user_id !== BOB) return o.insert(r);
          const res = { data: null, error: { code: "08006", message: "connection failure" } };
          const c: any = { select: () => c, single: () => Promise.resolve(res), then: (a: any, b: any) => Promise.resolve(res).then(a, b) };
          return c;
        };
      } });
    };
    const l = logs();
    const r = await redriveSafetySignal(sc as any, MSG, { deps: instance(sc), log: l.log });
    assert.equal(r.status, "retry", JSON.stringify(r));
    assert.equal(r.status === "retry" && r.stage, "deliver");
    assert.deepEqual(sorted(r.notified), [DANA, GINA]);
    assert.equal(rowsFor(sc, BOB).length, 0);
    assert.ok(l.errors.some((m) => /not created/.test(m)), l.errors.join(" | "));
  });

  it("the index refused it but the read-back cannot be read: not_created (ERROR), re-driven, and the next point settles at the 'already told' read", async () => {
    const sc = with3901(fakeSafetyDb(world()));
    sc.beforeInsert = (r) => {
      if (r.user_id !== BOB || rowsFor(sc, BOB).length > 0) return;
      sc.db.notifications!.push(otherRow(BOB));
      sc.fail.notifications = 1; // the outage starts now: the very next notifications read fails
    };
    const l = logs();
    const first = await redriveSafetySignal(sc as any, MSG, { deps: instance(sc), log: l.log });
    assert.equal(first.status, "retry", JSON.stringify(first));
    assert.deepEqual(sc.conflicts, [BOB]);
    assert.ok(l.errors.some((m) => /not created/.test(m)), "unseen is not told");
    sc.beforeInsert = undefined;
    delete sc.fail.notifications; // the outage is over
    const again = await redriveSafetySignal(sc as any, MSG, { deps: instance(sc), log: l.log });
    assert.ok(settledComplete(again), JSON.stringify(again));
    assert.deepEqual(again.notified, [], "everyone already holds it");
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
  });
});

describe("safe BEFORE 3901 applies: without the index nothing is refused, so today's behaviour is unchanged", () => {
  it("two instances racing both write (the double-tell 3901 closes), both settle, and nothing is logged as a failure", async () => {
    const sc = fakeSafetyDb(world());
    const meet = rendezvous(2);
    const l = logs();
    const [ra, rb] = await Promise.all([
      redriveSafetySignal(sc as any, MSG, { deps: instance(sc, meet), log: l.log }),
      redriveSafetySignal(sc as any, MSG, { deps: instance(sc, meet), log: l.log }),
    ]);
    assert.ok(settledComplete(ra) && settledComplete(rb), JSON.stringify([ra, rb]));
    assert.deepEqual(sorted(ra.notified), TOLD);
    assert.deepEqual(sorted(rb.notified), TOLD);
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 2, `${u}: two rows without the index (the residual 3901 closes)`);
    assert.deepEqual(l.errors, []);
    assert.ok(!l.warns.some((m) => /already told/i.test(m)), "no conflict path without the index");
  });

  it("a door alone writes one row per member and settles, as before", async () => {
    const sc = fakeSafetyDb(world());
    const out: SafetyNotifyOutcome = await notifySafetySignal(sc as any, { threadId: THREAD, senderId: ALICE, messageId: MSG, signal: "need_help" as SafetySignal, nowMs: T0 }, { deps: instance(sc), retryDelaysMs: [0, 0], log: logs().log });
    assert.ok(out.status === "notified");
    assert.deepEqual(sorted(out.status === "notified" ? out.notified : []), TOLD);
    assert.equal(redriveEntry(MSG, T0).settled, true);
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
  });
});

describe("3901 — static shape", () => {
  it("indexes exactly the producer's rows: its source constant and causal key are the index's predicate", () => {
    assert.equal(SAFETY_NOTIFICATION_SOURCE, "thread_safety_alert");
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS notifications_safety_once_per_member_uniq\n {2}ON public\.notifications \(user_id, \(metadata->>'causal_event_id'\)\)\n {2}WHERE source_type = 'thread_safety_alert'\n {4}AND \(metadata->>'causal_event_id'\) IS NOT NULL;/);
  });

  it("is one transaction: $pre$ first, the postcondition re-runnable after the COMMIT, no data written", () => {
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
    assert.ok(sql.indexOf("DO $pre$") < sql.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS"));
    const post = postconditionBlocks(sql);
    assert.equal(post.length, 1, "exactly one re-runnable postcondition block");
    assert.ok(sql.indexOf(post[0]!.text) > sql.lastIndexOf("COMMIT;"));
    const code = maskForKeywordScan(sql); // comments and string literals blanked; DO bodies kept
    assert.doesNotMatch(code, /\b(DELETE|UPDATE|INSERT|TRUNCATE|DROP)\b/i, "inspects existing data, never changes it");
    assert.doesNotMatch(code, /CONCURRENTLY/i, "the applier refuses a file it cannot wrap in one transaction");
  });
});

const NOTIFICATIONS = `
  CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, user_id uuid NOT NULL, category text NOT NULL, event_type text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL, title text NOT NULL, body text NOT NULL, action_url text, image_url text,
    source_type text, source_id text, actor_id uuid, metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    privacy_level text DEFAULT 'standard'::text NOT NULL, read_at timestamptz, dismissed_at timestamptz, expires_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL);
  CREATE INDEX notifications_user_created_idx ON public.notifications USING btree (user_id, created_at DESC);`;
const ins = (user: string, source: string | null, causal: string | null) =>
  `INSERT INTO public.notifications (user_id, category, event_type, title, body, source_type, metadata)
   VALUES ('${user}', 'safety', 'telegraph.sos', 't', 'b', ${source === null ? "NULL" : `'${source}'`}, ${causal === null ? "'{}'::jsonb" : `jsonb_build_object('causal_event_id', '${causal}')`})`;

test("3901 executes on PostgreSQL (PGlite): the second row is refused, nothing else is, and existing duplicates are refused, never deleted", async (t) => { // PGlite is a devDependency: this always executes (never a counted skip)
  const { PGlite } = await import(process.env.DISCOVERY_PGLITE_MODULE ?? "@electric-sql/pglite");
  const fresh = async () => { const db = new PGlite(); await db.exec(NOTIFICATIONS); return db; };
  const count = async (db: any) => Number((await db.query("SELECT count(*)::int AS n FROM public.notifications")).rows[0].n);
  const idx = async (db: any) => (await db.query(`SELECT to_regclass('public.${INDEX}') AS r`)).rows[0].r;

  await t.test("applies, and applies again (idempotent); the index is exactly the one stated", async () => {
    const db = await fresh();
    await db.exec(sql);
    await db.exec(sql);
    const r = (await db.query(`SELECT pg_get_indexdef('public.${INDEX}'::regclass) AS d`)).rows[0].d;
    assert.equal(r, `CREATE UNIQUE INDEX ${INDEX} ON public.notifications USING btree (user_id, ((metadata ->> 'causal_event_id'::text))) WHERE ((source_type = 'thread_safety_alert'::text) AND ((metadata ->> 'causal_event_id'::text) IS NOT NULL))`);
    await db.close();
  });

  await t.test("the second safety row for one (member, help request) is refused with 23505, naming the index", async () => {
    const db = await fresh();
    await db.exec(sql);
    await db.query(ins(BOB, "thread_safety_alert", `MESSAGE:${MSG}`));
    await assert.rejects(db.query(ins(BOB, "thread_safety_alert", `MESSAGE:${MSG}`)), (e: any) => e.code === "23505" && String(e.message).includes(INDEX));
    assert.equal(await count(db), 1);
    await db.close();
  });

  await t.test("refuses nothing else: another member, another help request, another producer, no causal id", async () => {
    const db = await fresh();
    await db.exec(sql);
    await db.query(ins(BOB, "thread_safety_alert", `MESSAGE:${MSG}`));
    await db.query(ins(DANA, "thread_safety_alert", `MESSAGE:${MSG}`));
    await db.query(ins(BOB, "thread_safety_alert", "MESSAGE:another"));
    await db.query(ins(BOB, "thread_message", `MESSAGE:${MSG}`));
    await db.query(ins(BOB, "thread_message", `MESSAGE:${MSG}`));
    await db.query(ins(BOB, null, `MESSAGE:${MSG}`));
    await db.query(ins(BOB, "thread_safety_alert", null));
    await db.query(ins(BOB, "thread_safety_alert", null));
    assert.equal(await count(db), 8);
    await db.close();
  });

  await t.test("existing duplicates: the precondition refuses, names one, and nothing is created or deleted", async () => {
    const db = await fresh();
    await db.query(ins(BOB, "thread_safety_alert", `MESSAGE:${MSG}`));
    await db.query(ins(BOB, "thread_safety_alert", `MESSAGE:${MSG}`));
    await assert.rejects(db.exec(sql), (e: any) => /PRECONDITION FAILED \(3901\): 1 \(member, help request\) group/.test(e.message) && e.message.includes(BOB));
    await db.exec("ROLLBACK").catch(() => undefined); // the file's BEGIN is left open on this single session; psql would discard it at exit
    assert.equal(await idx(db), null);
    assert.equal(await count(db), 2, "the duplicates are untouched");
    await db.close();
  });

  await t.test("an index of that name with another definition is refused, not built on", async () => {
    const db = await fresh();
    await db.exec(`CREATE UNIQUE INDEX ${INDEX} ON public.notifications (user_id, (metadata->>'causal_event_id'))`);
    await assert.rejects(db.exec(sql), /PRECONDITION FAILED \(3901\): an index named/);
    await db.exec("ROLLBACK").catch(() => undefined);
    await db.close();
  });

  await t.test("the postcondition re-runs alone in a new session, and is load-bearing", async () => {
    const db = await fresh();
    await db.exec(sql);
    const post = postconditionBlocks(sql)[0]!.text;
    await db.exec("DISCARD ALL");
    await db.exec(post);
    await db.exec(`DROP INDEX public.${INDEX}`);
    await assert.rejects(db.exec(post), /POSTCONDITION FAILED \(3901\): notifications_safety_once_per_member_uniq does not exist/);
    await db.close();
  });

  await t.test("the header's rollback recipe removes it, and the file re-applies after it", async () => {
    const db = await fresh();
    await db.exec(`CREATE TABLE public.schema_migration_ledger (filename text PRIMARY KEY, checksum text, applied_by text);
                   INSERT INTO public.schema_migration_ledger VALUES ('${FILE}', 'x', 'test');`);
    await db.exec(sql);
    const recipe = sql.slice(sql.indexOf("-- ROLLBACK"), sql.indexOf("\nBEGIN;\n")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
    await db.exec(recipe);
    assert.equal(await idx(db), null);
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM public.schema_migration_ledger")).rows[0].n), 0);
    await db.exec(sql);
    assert.notEqual(await idx(db), null);
    await db.close();
  });
});
