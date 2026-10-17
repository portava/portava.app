/**
 * Fable pass 3 §1.1 — a help request the door could not tell is NOT LOST: the durable re-drive
 * (services/telegraph/safetyNotifications.ts "THE DURABLE RE-DRIVE", lib/safetySignalRedriveScheduler.ts).
 *
 * Before it, an unreadable roster or blocks read was retried for ~1.25 s (250 ms + 1 s) and then the help request's
 * notification was dropped for good (ERROR-logged, never re-attempted).
 *
 * WHAT WOULD TURN THIS RED
 *   - a transient roster or blocks outage longer than the door's retries still losing the help request;
 *   - any member told twice — by the door and the re-drive, by two attempts, or after a restart;
 *   - a late delivery reaching someone who left, someone a block made since covers, someone who joined after the
 *     message, or anyone at all when a gate is unreadable;
 *   - a help request unsent/deleted meanwhile, or already answered by an ALL CLEAR, sent late (and a LATER separate
 *     help request or a check-in wrongly cancelling it); a stale ALL CLEAR landing after a new help request;
 *   - attempts that are not bounded (seven re-drives, 10 s → 15 min, doubling) or that hammer every tick;
 *   - the re-drive giving up silently instead of with an ERROR, or not giving up;
 *   - the re-drive needing anything in memory: a SECOND node process, handed only the database, must deliver.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphSafetySignalRedrive.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NotificationService, type CreateNotificationInput, type NotificationRow } from "../services/notifications/NotificationService.js";
import {
  SAFETY_ALERT_EVENT,
  SAFETY_ALL_CLEAR_EVENT,
  SAFETY_REDRIVE_SCHEDULE_MS,
  SAFETY_REDRIVE_WINDOW_MS,
  _resetSafetyRedriveMemo,
  notifySafetySignal,
  redriveSafetySignal,
  type SafetyNotifyDeps,
  type SafetySignal,
} from "../services/telegraph/safetyNotifications.js";
import {
  SAFETY_REDRIVE_JOB_KEY,
  _resetSafetySignalRedriveStatus,
  dueIndexFor,
  getSafetySignalRedriveStatus,
  runSafetySignalRedrivePass,
  runSafetySignalRedriveTick,
  safetySignalRedriveHealthDetail,
} from "../lib/safetySignalRedriveScheduler.js";
import { fakeSafetyDb, type FakeSafetyDb, type Row } from "./helpers/fakeSafetyRedriveDb.js";
import { notifyNewMessage } from "../services/telegraph/messageNotifications.js";
import { THREAD_NOTIFICATION_POLICY_FLAG } from "../services/telegraph/threadNotificationState.js";

const ALICE = "74000000-0000-4000-8000-000000000001"; // asks for help
const BOB = "74000000-0000-4000-8000-000000000002";   // told
const CARL = "74000000-0000-4000-8000-000000000003";  // blocked Alice
const DANA = "74000000-0000-4000-8000-000000000004";  // MUTED the thread
const ERIN = "74000000-0000-4000-8000-000000000005";  // left before the message
const FRAN = "74000000-0000-4000-8000-000000000006";  // Alice blocked her
const GINA = "74000000-0000-4000-8000-000000000007";  // MENTIONS-only and temporarily muted
const HANK = "74000000-0000-4000-8000-000000000008";  // joins AFTER the message
const THREAD = "74000000-0000-4000-8000-0000000000d1";
const MSG = "74000000-0000-4000-8000-0000000000e1";
const T0 = Date.parse("2026-10-17T12:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const TOLD = [BOB, DANA, GINA].sort();
const sorted = (xs: string[]) => [...xs].sort();

const member = (user_id: string, over: Row = {}) => ({ thread_id: THREAD, user_id, joined_at: "2026-10-01T00:00:00.000Z", visible_from_at: null, left_at: null, muted_at: null, notification_level: "all", muted_until: null, ...over });
const safetyRow = (id: string, sender: string, ms: number, kind: string) =>
  ({ id, thread_id: THREAD, sender_id: sender, created_at: at(ms), deleted_at: null, msg_type: "safety", subtype: kind, body: JSON.stringify({ kind: "SAFETY", envelopeVersion: "1", payload: { kind, label: "behind the pier gate" } }) });
const needHelpQuick = (id: string, sender: string, ms: number) =>
  ({ id, thread_id: THREAD, sender_id: sender, created_at: at(ms), deleted_at: null, msg_type: "coordination", subtype: "need_help", body: JSON.stringify({ kind: "COORDINATION", envelopeVersion: "1", payload: { state: "NEED_HELP" } }) });

function world(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    feature_flags: [],
    message_thread_members: [
      member(ALICE), member(BOB), member(CARL), member(DANA, { notification_level: "muted", muted_at: "2026-10-01T00:00:00.000Z" }),
      member(ERIN, { left_at: "2026-10-02T00:00:00.000Z" }), member(FRAN), member(GINA, { notification_level: "mentions", muted_until: "2099-01-01T00:00:00.000Z" }),
    ],
    blocks: [{ blocker_id: CARL, blocked_id: ALICE }, { blocker_id: ALICE, blocked_id: FRAN }],
    profiles: [{ id: ALICE, handle: "alice", display_name: "Alice Real" }],
    profile_privacy_settings: [],
    messages: [safetyRow(MSG, ALICE, 0, "need_help")],
    notifications: [],
    job_health: [],
    ...extra,
  };
}

/** Deps that persist like NotificationService does (metadata.causal_event_id), so the re-drive's "already told" read sees them. */
function writing(sc: FakeSafetyDb, opts: { refuse?: ReadonlySet<string>; gate?: Promise<void>; reached?: () => void } = {}) {
  const created: CreateNotificationInput[] = [];
  const deps: SafetyNotifyDeps = {
    async create(i) {
      opts.reached?.();
      if (opts.gate) await opts.gate;
      if (opts.refuse?.has(i.userId)) return null;
      created.push(i);
      const row = { id: `rec-${sc.db.notifications!.length + 1}`, user_id: i.userId, event_type: i.eventType, metadata: { ...(i.metadata ?? {}), ...(i.causalEventId ? { causal_event_id: i.causalEventId } : {}) } };
      sc.db.notifications!.push(row);
      return { id: row.id, userId: i.userId } as NotificationRow;
    },
    async route() { /* the push is the router's */ },
  };
  return { deps, created };
}
function logs() {
  const errors: string[] = [];
  const warns: string[] = [];
  return { errors, warns, log: { error: (_o: object, m: string) => { errors.push(m); }, warn: (_o: object, m: string) => { warns.push(m); } } };
}
const quiet = { warn: () => undefined, error: () => undefined };
const door = (sc: FakeSafetyDb, deps: SafetyNotifyDeps, over: { messageId?: string; signal?: SafetySignal } = {}) =>
  notifySafetySignal(sc as any, { threadId: THREAD, senderId: ALICE, messageId: over.messageId ?? MSG, signal: over.signal ?? "need_help", nowMs: T0 }, { deps, retryDelaysMs: [0, 0], log: quiet });
const pass = (sc: FakeSafetyDb, ms: number, deps: SafetyNotifyDeps, log: { warn(o: object, m: string): void; error?(o: object, m: string): void } = quiet) =>
  runSafetySignalRedrivePass({ client: sc, nowMs: T0 + ms, deps, log });
/** Every 5 s tick from `fromMs` to `toMs`; returns the instants that attempted something. */
async function ticks(sc: FakeSafetyDb, fromMs: number, toMs: number, deps: SafetyNotifyDeps, log = quiet as { warn(o: object, m: string): void; error?(o: object, m: string): void }) {
  const attemptsAt: number[] = [];
  for (let ms = fromMs; ms <= toMs; ms += 5_000) if ((await pass(sc, ms, deps, log)).attempted > 0) attemptsAt.push(ms);
  return attemptsAt;
}
const rowsFor = (sc: FakeSafetyDb, userId: string, messageId = MSG) =>
  sc.db.notifications!.filter((n) => n.user_id === userId && n.metadata?.causal_event_id === `MESSAGE:${messageId}`);

beforeEach(() => {
  _resetSafetyRedriveMemo();
  _resetSafetySignalRedriveStatus();
});

// ── 1. the schedule ──────────────────────────────────────────────────────────

describe("the schedule: seven re-drives, 10 s to 15 minutes, doubling", () => {
  it("is bounded and backs off", () => {
    assert.deepEqual([...SAFETY_REDRIVE_SCHEDULE_MS], [10_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000]);
    assert.equal(SAFETY_REDRIVE_WINDOW_MS, 15 * 60_000);
    for (let i = 2; i < SAFETY_REDRIVE_SCHEDULE_MS.length - 1; i++) assert.equal(SAFETY_REDRIVE_SCHEDULE_MS[i], 2 * SAFETY_REDRIVE_SCHEDULE_MS[i - 1]!);
    assert.equal(dueIndexFor(9_999), -1);
    assert.equal(dueIndexFor(10_000), 0);
    assert.equal(dueIndexFor(299_000), 4);
    assert.equal(dueIndexFor(3_600_000), 6);
  });
});

// ── 2. the outage outlasts the door ──────────────────────────────────────────

describe("a transient outage longer than the door's retries no longer loses the help request", () => {
  it("roster: refused at the door, told by the re-drive at the first point after it heals — the same words, the same causal event", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    sc.fail.message_thread_members = "always";
    assert.deepEqual(await door(sc, w.deps), { status: "refused", stage: "roster" });
    assert.equal(w.created.length, 0, "an unreadable roster still tells nobody AT THAT MOMENT");
    delete sc.fail.message_thread_members;
    assert.equal((await pass(sc, 9_000, w.deps)).attempted, 0, "before the first point the door may still be at it");
    const p = await pass(sc, 10_000, w.deps);
    assert.equal(p.attempted, 1);
    assert.equal(p.told, 3);
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), TOLD, "Carl blocked Alice, Alice blocked Fran, Erin left, Alice asked");
    for (const c of w.created) {
      assert.equal(c.eventType, SAFETY_ALERT_EVENT);
      assert.equal(c.causalEventId, `MESSAGE:${MSG}`);
      assert.deepEqual(c.params, { actor: "@alice", signal: "asked for help", threadId: THREAD }, "fixed words only");
      assert.deepEqual(c.metadata, { cause: "SAFETY", signal: "need_help" });
      assert.equal("senderId" in c, false);
    }
  });

  it("blocks: refused at the door (nobody told on an unknown block state), told by the re-drive once blocks read", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    sc.fail.blocks = "always";
    assert.deepEqual(await door(sc, w.deps), { status: "refused", stage: "blocks" });
    assert.equal(w.created.length, 0);
    delete sc.fail.blocks;
    assert.equal((await pass(sc, 10_000, w.deps)).told, 3);
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), TOLD);
  });

  it("an outage that outlasts a point: re-attempted at the NEXT point, not every tick (back-off)", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    sc.fail.message_thread_members = "always";
    await door(sc, w.deps);
    assert.deepEqual(await ticks(sc, 0, 25_000, w.deps), [10_000], "one attempt at 10 s, none at 15/20/25 s");
    delete sc.fail.message_thread_members;
    assert.deepEqual(await ticks(sc, 30_000, 16 * 60_000, w.deps), [30_000], "healed: told at 30 s, then settled");
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), TOLD);
  });

  it("§9.1's NEED_HELP quick state (the coordination carrier) is re-driven the same way", async () => {
    const sc = fakeSafetyDb(world({ messages: [needHelpQuick(MSG, ALICE, 0)] }));
    const w = writing(sc);
    sc.fail.message_thread_members = "always";
    await door(sc, w.deps);
    delete sc.fail.message_thread_members;
    await pass(sc, 10_000, w.deps);
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), TOLD);
    assert.ok(w.created.every((c) => c.eventType === SAFETY_ALERT_EVENT && c.params!.signal === "asked for help"));
  });

  it("a heads-up is re-driven in its own words", async () => {
    const sc = fakeSafetyDb(world({ messages: [safetyRow(MSG, ALICE, 0, "heads_up")] }));
    const w = writing(sc);
    sc.fail.blocks = "always";
    await door(sc, w.deps, { signal: "heads_up" });
    delete sc.fail.blocks;
    await pass(sc, 10_000, w.deps);
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), TOLD);
    assert.ok(w.created.every((c) => c.params!.signal === "raised a safety heads-up"));
  });
});

// ── 3. never told twice ──────────────────────────────────────────────────────

describe("never told twice: the causal event MESSAGE:<id>", () => {
  it("a door that told everyone settles the message in-process: the re-drive does not even read it again", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    await door(sc, w.deps);
    const rosterReads = sc.reads.message_thread_members;
    assert.deepEqual(await ticks(sc, 0, 16 * 60_000, w.deps), []);
    assert.equal(sc.reads.message_thread_members, rosterReads);
    assert.equal(w.created.length, 3);
  });

  it("after a restart (memo gone) ONE catch-up check finds every member holding it and tells nobody — through the real NotificationService", async () => {
    const sc = fakeSafetyDb(world());
    const ns = new NotificationService(sc as any);
    const deps: SafetyNotifyDeps = { create: (i) => ns.create(i), route: async () => undefined };
    await door(sc, deps);
    assert.equal(sc.db.notifications!.length, 3);
    _resetSafetyRedriveMemo();
    assert.deepEqual(await ticks(sc, 0, 16 * 60_000, deps), [10_000], "one check, then settled");
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
    assert.equal(sc.db.notifications!.length, 3);
  });

  it("a member the door could not write is told by the re-drive — that member only", async () => {
    const sc = fakeSafetyDb(world());
    const first = writing(sc, { refuse: new Set([BOB]) });
    const r = await door(sc, first.deps);
    assert.ok(r.status === "notified" && r.withheld.some((x) => x.userId === BOB && x.reason === "not_created"));
    const later = writing(sc);
    assert.deepEqual(await ticks(sc, 0, 16 * 60_000, later.deps), [10_000]);
    assert.deepEqual(later.created.map((c) => c.userId), [BOB]);
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
  });

  it("a member whose create THREW at the door is re-attempted too; one whose push failed is not (the row exists)", async () => {
    const sc = fakeSafetyDb(world());
    const inner = writing(sc);
    const deps: SafetyNotifyDeps = {
      async create(i) { if (i.userId === DANA) throw new Error("insert timed out"); return inner.deps.create(i); },
      async route(row) { if (row.userId === GINA) throw new Error("push provider down"); },
    };
    const r = await door(sc, deps);
    assert.ok(r.status === "notified" && r.withheld.some((x) => x.userId === DANA && x.reason === "failed"));
    const later = writing(sc);
    await ticks(sc, 0, 16 * 60_000, later.deps);
    assert.deepEqual(later.created.map((c) => c.userId), [DANA]);
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
  });

  it("the whole window of passes after a refused door writes exactly one row per member", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    sc.fail.blocks = 6; // the door's three attempts (two reads each)
    await door(sc, w.deps);
    assert.deepEqual(await ticks(sc, 0, 16 * 60_000, w.deps), [10_000]);
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
  });

  it("an unreadable 'already told' read tells nobody that attempt (never twice), and the next point tells them", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    sc.fail.message_thread_members = "always";
    await door(sc, w.deps);
    delete sc.fail.message_thread_members;
    sc.fail.notifications = "always";
    const p = await pass(sc, 10_000, w.deps);
    assert.equal(p.retrying, 1);
    assert.equal(w.created.length, 0);
    delete sc.fail.notifications;
    assert.equal((await pass(sc, 30_000, w.deps)).told, 3);
  });

  it("a pass never attempts a message a door in this process is still telling", async () => {
    const sc = fakeSafetyDb(world());
    let release!: () => void;
    let reached = false;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = writing(sc, { gate, reached: () => { reached = true; } });
    const doorDone = door(sc, slow.deps);
    while (!reached) await new Promise((r) => setImmediate(r));
    const other = writing(sc);
    const p = await pass(sc, 10_000, other.deps);
    assert.equal(p.inFlight, 1);
    assert.equal(p.attempted, 0);
    release();
    await doorDone;
    assert.deepEqual(await ticks(sc, 15_000, 16 * 60_000, other.deps), [], "the door told everyone: settled");
    assert.equal(other.created.length, 0);
    for (const u of TOLD) assert.equal(rowsFor(sc, u).length, 1, u);
  });
});

// ── 4. every attempt re-reads every gate ─────────────────────────────────────

describe("every attempt re-reads the message, the members and the blocks", () => {
  const refusedDoor = async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    sc.fail.message_thread_members = "always";
    await door(sc, w.deps);
    delete sc.fail.message_thread_members;
    return { sc, w };
  };

  it("a member who left during the window is not told", async () => {
    const { sc, w } = await refusedDoor();
    sc.db.message_thread_members!.find((m) => m.user_id === BOB)!.left_at = at(5_000);
    await pass(sc, 10_000, w.deps);
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), [DANA, GINA].sort());
  });

  it("a block made during the window is honoured, either direction", async () => {
    const { sc, w } = await refusedDoor();
    sc.db.blocks!.push({ blocker_id: GINA, blocked_id: ALICE }, { blocker_id: ALICE, blocked_id: DANA });
    const p = await pass(sc, 10_000, w.deps);
    assert.deepEqual(w.created.map((c) => c.userId), [BOB]);
    assert.equal(p.settled, 1);
  });

  it("blocks unreadable at the re-drive: nobody told that attempt; told at the next point", async () => {
    const { sc, w } = await refusedDoor();
    sc.fail.blocks = "always";
    assert.equal((await pass(sc, 10_000, w.deps)).retrying, 1);
    assert.equal(w.created.length, 0);
    delete sc.fail.blocks;
    await pass(sc, 30_000, w.deps);
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), TOLD);
  });

  it("someone who joined AFTER the message is not told by the late delivery (the door could not have told them)", async () => {
    const { sc, w } = await refusedDoor();
    sc.db.message_thread_members!.push(member(HANK, { joined_at: at(3_000), visible_from_at: at(3_000) }));
    const outcome = await redriveSafetySignal(sc as any, MSG, { deps: w.deps });
    assert.ok(outcome.status === "settled" && outcome.withheld.some((x) => x.userId === HANK && x.reason === "joined_after"));
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), TOLD);
  });

  it("a help request unsent or deleted meanwhile tells nobody, and is not attempted again", async () => {
    const { sc, w } = await refusedDoor();
    sc.db.messages!.find((m) => m.id === MSG)!.deleted_at = at(4_000);
    assert.equal((await redriveSafetySignal(sc as any, MSG, { deps: w.deps })).status, "settled");
    _resetSafetyRedriveMemo();
    const p = await pass(sc, 10_000, w.deps);
    assert.equal(p.considered, 0, "a deleted row is not even in the window scan");
    assert.equal(w.created.length, 0);
  });

  it("an unreadable message read is a retry, not a delivery", async () => {
    const { sc, w } = await refusedDoor();
    // The pass's window scan is the first `messages` read; fail the attempt's own re-read of the message (the second).
    const realFrom = sc.from.bind(sc);
    let n = 0;
    (sc as any).from = (t: string) => (t === "messages" && ++n === 2 ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "messages unreadable" } }) }) }) } : realFrom(t));
    const p = await pass(sc, 10_000, w.deps);
    assert.equal(p.retrying, 1);
    assert.equal(w.created.length, 0);
  });
});

// ── 5. a raised mode that ended meanwhile ────────────────────────────────────

describe("an ALL CLEAR posted after the help request answers it: the SOS is NOT sent late", () => {
  // The other signal rows in these threads are re-driven too (no door ran for them here), so each case reads only
  // what was told about MSG itself.
  const aboutMsg = (w: { created: CreateNotificationInput[] }) => w.created.filter((c) => c.causalEventId === `MESSAGE:${MSG}`);
  const outage = async (messages: Row[], signal: SafetySignal = "need_help") => {
    const sc = fakeSafetyDb(world({ messages }));
    const w = writing(sc);
    const l = logs();
    sc.fail.message_thread_members = "always";
    await door(sc, w.deps, { signal });
    await pass(sc, 10_000, w.deps, l.log); // still failing: retried at 30 s
    delete sc.fail.message_thread_members;
    return { sc, w, l };
  };

  it("need_help, then ALL CLEAR at 20 s: settled 'cleared' at 30 s, nobody woken for an emergency that is over", async () => {
    const { sc, w, l } = await outage([safetyRow(MSG, ALICE, 0, "need_help"), safetyRow("clear-1", ALICE, 20_000, "all_clear")]);
    await pass(sc, 30_000, w.deps, l.log);
    assert.deepEqual(aboutMsg(w), [], "no SOS for MSG");
    assert.ok(w.created.every((c) => c.eventType === SAFETY_ALL_CLEAR_EVENT), "the ALL CLEAR itself is its own P1 (its door's rule: it ended a raised mode)");
    assert.ok(l.warns.some((m) => /must not be sent late/.test(m)), l.warns.join(" | "));
    assert.equal((await redriveSafetySignal(sc as any, MSG, { deps: w.deps })).status, "settled");
  });

  it("a heads-up cleared the same way", async () => {
    const { sc, w } = await outage([safetyRow(MSG, ALICE, 0, "heads_up"), safetyRow("clear-1", BOB, 20_000, "all_clear")], "heads_up");
    await pass(sc, 30_000, w.deps);
    assert.deepEqual(aboutMsg(w), []);
  });

  it("a LATER, separate help request does not cancel it; nor does a check-in (safetyMode rule 2)", async () => {
    const { sc, w } = await outage([safetyRow(MSG, ALICE, 0, "need_help"), safetyRow("again", BOB, 20_000, "need_help"), safetyRow("ci", ALICE, 21_000, "check_in")]);
    await pass(sc, 30_000, w.deps);
    assert.deepEqual(sorted(aboutMsg(w).map((c) => c.userId)), TOLD);
  });

  it("an ALL CLEAR that ended a raised mode is re-driven as telegraph.safety_all_clear (P1)", async () => {
    const { sc, w } = await outage([needHelpQuick("h1", ALICE, -60_000), safetyRow(MSG, ALICE, 0, "all_clear")], "all_clear");
    await pass(sc, 30_000, w.deps);
    assert.deepEqual(sorted(aboutMsg(w).map((c) => c.userId)), TOLD);
    assert.ok(aboutMsg(w).every((c) => c.eventType === SAFETY_ALL_CLEAR_EVENT && c.params!.signal === "posted ALL CLEAR"));
  });

  it("…but not once a NEW help request came after it (a late ALL CLEAR would read as clearing that one)", async () => {
    const { sc, w } = await outage([needHelpQuick("h1", ALICE, -60_000), safetyRow(MSG, ALICE, 0, "all_clear"), safetyRow("h2", ALICE, 20_000, "need_help")], "all_clear");
    await pass(sc, 30_000, w.deps);
    assert.deepEqual(aboutMsg(w), [], "no late ALL CLEAR for MSG");
    assert.ok(w.created.length > 0 && w.created.every((c) => c.causalEventId === "MESSAGE:h2" && c.eventType === SAFETY_ALERT_EVENT), "the NEW help request is its own, and goes");
  });

  it("an ALL CLEAR that ends nothing is an ordinary message, never this producer's", async () => {
    const sc = fakeSafetyDb(world({ messages: [safetyRow(MSG, ALICE, 0, "all_clear")] }));
    const w = writing(sc);
    const outcome = await redriveSafetySignal(sc as any, MSG, { deps: w.deps });
    assert.ok(outcome.status === "settled" && outcome.reason === "ends_nothing");
    assert.equal(w.created.length, 0);
  });
});

// ── 6. bounded: it gives up after the window, at ERROR ──────────────────────

describe("bounded: seven attempts, then it gives up with an ERROR", () => {
  it("a roster that never reads: attempts at exactly the seven points, one GAVE UP error, nothing after the window", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    const l = logs();
    sc.fail.message_thread_members = "always";
    await door(sc, w.deps);
    const attemptsAt: number[] = [];
    for (let ms = 0; ms <= 20 * 60_000; ms += 5_000) {
      if ((await runSafetySignalRedriveTick({ client: sc, nowMs: T0 + ms, deps: w.deps, log: l.log })).attempted > 0) attemptsAt.push(ms);
    }
    assert.deepEqual(attemptsAt, [...SAFETY_REDRIVE_SCHEDULE_MS]);
    assert.equal(sc.reads.message_thread_members, 3 + 7, "the door's three reads, then one per re-drive");
    assert.equal(l.errors.filter((m) => /GAVE UP/.test(m)).length, 1, l.errors.join(" | "));
    assert.equal(w.created.length, 0, "an unreadable roster names nobody, to the end");
    const s = getSafetySignalRedriveStatus();
    assert.equal(s.gaveUpTotal, 1);
    assert.match(safetySignalRedriveHealthDetail(s) ?? "", /1 help request\(s\) given up on/);
  });

  it("a restart mid-window costs at most ONE extra (catch-up) attempt, and the deadline still holds", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    sc.fail.message_thread_members = "always";
    await door(sc, w.deps);
    const a = await ticks(sc, 0, 5 * 60_000, w.deps);
    _resetSafetyRedriveMemo();
    const b = await ticks(sc, 5 * 60_000 + 5_000, 20 * 60_000, w.deps);
    assert.deepEqual(a, [10_000, 30_000, 60_000, 120_000, 240_000]);
    assert.deepEqual(b, [305_000, 480_000, 900_000], "catch-up at the first pass after the restart, then the schedule");
  });

  it("the window scan reads only signal rows inside it: older than 15 minutes, a check-in or a text are never attempted", async () => {
    const sc = fakeSafetyDb(world({ messages: [
      safetyRow("old", ALICE, -20 * 60_000, "need_help"),
      safetyRow("ci", ALICE, 0, "check_in"),
      { id: "txt", thread_id: THREAD, sender_id: ALICE, created_at: at(0), deleted_at: null, msg_type: "text", subtype: null, body: "help" },
    ] }));
    const w = writing(sc);
    assert.deepEqual(await ticks(sc, 0, 16 * 60_000, w.deps), []);
    assert.equal(w.created.length, 0);
  });
});

// ── 7. health ────────────────────────────────────────────────────────────────

describe("health: GET /healthz/schedulers job safetySignalRedrive and its job_health row", () => {
  it("a failed window scan is a failing pass and is persisted at once; a healthy one records its success", async () => {
    const sc = fakeSafetyDb(world());
    sc.fail.messages = "always";
    const bad = await runSafetySignalRedriveTick({ client: sc, nowMs: T0, deps: writing(sc).deps, log: quiet });
    assert.equal(bad.outcome, "error");
    assert.equal(getSafetySignalRedriveStatus().consecutiveFailures, 1);
    const row = sc.db.job_health!.find((r) => r.job === SAFETY_REDRIVE_JOB_KEY)!;
    assert.equal(row.last_run_at, at(0));
    assert.equal(row.last_success_at, undefined);
    delete sc.fail.messages;
    await runSafetySignalRedriveTick({ client: sc, nowMs: T0 + 5_000, deps: writing(sc).deps, log: quiet });
    assert.equal(getSafetySignalRedriveStatus().consecutiveFailures, 0);
    assert.equal(sc.db.job_health!.find((r) => r.job === SAFETY_REDRIVE_JOB_KEY)!.last_success_at, at(5_000));
  });
});

// ── 8. a real process restart ────────────────────────────────────────────────

describe("survives a process restart: a SECOND node process, handed only the database, tells everyone", () => {
  it("process 1 refuses at the door and is gone; process 2 (empty memo, real NotificationService) delivers once and settles", () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    sc.fail.blocks = "always";
    return door(sc, w.deps).then((r) => {
      assert.deepEqual(r, { status: "refused", stage: "blocks" });
      const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "sos-redrive-"));
      const file = path.join(dir, "state.json");
      fs.writeFileSync(file, JSON.stringify({ db: sc.db, passesAtMs: [T0 + 10_000, T0 + 30_000, T0 + 15 * 60_000] }));
      const here = path.dirname(fileURLToPath(import.meta.url));
      const child = spawnSync(process.execPath, ["--import", "tsx/esm", path.join(here, "helpers", "safetyRedriveRestartChild.ts"), file], {
        cwd: path.resolve(here, "..", ".."), env: process.env, encoding: "utf8", timeout: 120_000,
      });
      assert.equal(child.status, 0, `child failed: ${child.stderr}`);
      const out = JSON.parse(fs.readFileSync(file, "utf8")) as { db: Record<string, Row[]>; results: Array<{ attempted: number; told: number; settled: number }>; pid: number };
      fs.rmSync(dir, { recursive: true, force: true });
      assert.notEqual(out.pid, process.pid);
      assert.deepEqual(out.results.map((x) => [x.attempted, x.told]), [[1, 3], [0, 0], [0, 0]]);
      const sos = out.db.notifications!.filter((n) => n.event_type === SAFETY_ALERT_EVENT);
      assert.deepEqual(sorted(sos.map((n) => String(n.user_id))), TOLD);
      assert.ok(sos.every((n) => n.metadata?.causal_event_id === `MESSAGE:${MSG}` && n.priority === "urgent"));
    });
  });
});

// ── 9. owner ruling 2026-10-17: archived conversations ───────────────────────

describe("owner ruling 2026-10-17: a help request is not routed to a member who ARCHIVED the conversation", () => {
  const ARCHIVED_AT = "2026-10-16T09:00:00.000Z";
  const archive = (sc: FakeSafetyDb, userId: string, when: string | null) => { sc.db.message_thread_members!.find((m) => m.user_id === userId)!.archived_at = when; };
  const sosRows = (sc: FakeSafetyDb, messageId = MSG) => sc.db.notifications!.filter((n) => n.metadata?.causal_event_id === `MESSAGE:${messageId}`);

  it("need_help: the archived member is not told, everyone else is; the message stays in the history unchanged", async () => {
    const sc = fakeSafetyDb(world());
    archive(sc, BOB, ARCHIVED_AT);
    const history = JSON.stringify(sc.db.messages);
    const w = writing(sc);
    const r = await door(sc, w.deps);
    assert.ok(r.status === "notified" && r.withheld.some((x) => x.userId === BOB && x.reason === "archived"));
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), [DANA, GINA].sort());
    assert.equal(JSON.stringify(sc.db.messages), history, "history preserved: the request itself is untouched");
    assert.deepEqual(await ticks(sc, 0, 16 * 60_000, w.deps), [], "an archive exclusion is not a failure: the door settled it");
    assert.equal(rowsFor(sc, BOB).length, 0);
  });

  it("a heads-up and §9.1's NEED_HELP quick state are help requests too", async () => {
    for (const [row, signal] of [[safetyRow(MSG, ALICE, 0, "heads_up"), "heads_up"], [needHelpQuick(MSG, ALICE, 0), "need_help"]] as const) {
      const sc = fakeSafetyDb(world({ messages: [row] }));
      archive(sc, GINA, ARCHIVED_AT);
      const w = writing(sc);
      await door(sc, w.deps, { signal });
      assert.deepEqual(sorted(w.created.map((c) => c.userId)), [BOB, DANA].sort(), signal);
    }
  });

  it("after unarchiving (archived_at cleared), the NEXT help request routes normally; the earlier one is not re-sent", async () => {
    const sc = fakeSafetyDb(world({ messages: [safetyRow(MSG, ALICE, 0, "need_help"), safetyRow("m-2", ALICE, 60_000, "need_help")] }));
    archive(sc, BOB, ARCHIVED_AT);
    const w = writing(sc);
    await door(sc, w.deps);
    archive(sc, BOB, null);
    await notifySafetySignal(sc as any, { threadId: THREAD, senderId: ALICE, messageId: "m-2", signal: "need_help", nowMs: T0 + 60_000 }, { deps: w.deps, retryDelaysMs: [0, 0], log: quiet });
    assert.equal(rowsFor(sc, BOB, "m-2").length, 1, "unarchived: told");
    await ticks(sc, 0, 16 * 60_000, w.deps);
    assert.equal(rowsFor(sc, BOB, MSG).length, 0, "the request that arrived while archived is not delivered late");
  });

  it("an archive made DURING the re-drive window is honoured (archive state re-read on every attempt)", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    sc.fail.message_thread_members = "always";
    await door(sc, w.deps);
    delete sc.fail.message_thread_members;
    archive(sc, BOB, at(5_000));
    const outcome = await redriveSafetySignal(sc as any, MSG, { deps: w.deps });
    assert.ok(outcome.status === "settled" && outcome.withheld.some((x) => x.userId === BOB && x.reason === "archived"));
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), [DANA, GINA].sort());
  });

  it("existing requests are untouched: archiving AFTER a help request reached you removes nothing", async () => {
    const sc = fakeSafetyDb(world());
    const w = writing(sc);
    await door(sc, w.deps);
    archive(sc, BOB, at(5_000));
    _resetSafetyRedriveMemo();
    await ticks(sc, 0, 16 * 60_000, w.deps);
    assert.equal(rowsFor(sc, BOB).length, 1);
    assert.equal(sosRows(sc).length, 3);
  });

  it("an unreadable archive state is an unreadable roster (one statement): nobody told now, ERROR, re-driven — never silently dropped", async () => {
    const sc = fakeSafetyDb(world());
    const selects: string[] = [];
    const realFrom = sc.from.bind(sc);
    (sc as any).from = (t: string) => { const q = realFrom(t); if (t !== "message_thread_members") return q; const sel = q.select; q.select = (cols: string) => { selects.push(cols); return sel(cols); }; return q; };
    const w = writing(sc);
    sc.fail.message_thread_members = "always";
    const l = logs();
    const r = await notifySafetySignal(sc as any, { threadId: THREAD, senderId: ALICE, messageId: MSG, signal: "need_help", nowMs: T0 }, { deps: w.deps, retryDelaysMs: [0, 0], log: l.log });
    assert.deepEqual(r, { status: "refused", stage: "roster" });
    assert.ok(selects.every((c) => /\barchived_at\b/.test(c) && /\buser_id\b/.test(c)), `archive is read with the roster: ${selects.join(" | ")}`);
    assert.ok(l.errors.some((m) => /REFUSED.*re-drive/.test(m)));
    delete sc.fail.message_thread_members;
    await pass(sc, 10_000, w.deps);
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), TOLD);
  });

  it("NOT changed: the ALL CLEAR still reaches an archived member (not a request; they may have had the SOS)", async () => {
    const sc = fakeSafetyDb(world({ messages: [needHelpQuick("h1", ALICE, -60_000), safetyRow(MSG, ALICE, 0, "all_clear")] }));
    archive(sc, BOB, ARCHIVED_AT);
    const w = writing(sc);
    await door(sc, w.deps, { signal: "all_clear" });
    assert.deepEqual(sorted(w.created.map((c) => c.userId)), TOLD);
  });

  it("NOT changed: an ordinary message (T256) still notifies an archived member exactly as before", async () => {
    const sc = fakeSafetyDb(world({ feature_flags: [{ flag: THREAD_NOTIFICATION_POLICY_FLAG, enabled: true }], messages: [{ id: "t1", thread_id: THREAD, sender_id: ALICE, created_at: at(0), deleted_at: null, msg_type: "text", subtype: null, body: "hi" }] }));
    archive(sc, BOB, ARCHIVED_AT);
    const w = writing(sc);
    const r = await notifyNewMessage(sc as any, { threadId: THREAD, senderId: ALICE, messageId: "t1", msgType: "text", subtype: null, nowMs: T0 }, { deps: w.deps });
    assert.ok(r.status === "notified", JSON.stringify(r));
    assert.ok(w.created.some((c) => c.userId === BOB && c.eventType === "telegraph.message"), "the ruling is about help requests only");
  });
});
