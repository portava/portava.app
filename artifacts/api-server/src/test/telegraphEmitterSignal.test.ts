/**
 * Telegraph emitter FAILURE VISIBILITY.
 *
 * The bus is deliberately best-effort: a realtime miss must never break a write
 * path, and the client polls as a fallback. But "swallowed" had come to mean
 * "invisible" — an unreadable message_thread_members made `publishToThread`
 * take the same silent `return` as a thread whose members had all left, so
 * every realtime event for every thread could stop with no log line, no
 * counter, and nothing in any response. An emitter that cannot fail visibly
 * cannot be operated: the only symptom is users saying the app feels slow, and
 * that is unattributable.
 *
 * These tests assert the SIGNAL, not the delivery: for each way the bus can
 * lose an event, exactly one counter moves and one log line names what was
 * lost. Every case also asserts a non-zero inspection count, so a test that
 * examined nothing fails instead of passing.
 *
 * Run: node --import tsx/esm --test src/test/telegraphEmitterSignal.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { logger } from "../lib/logger.js";
import {
  subscribe,
  publishToUsers,
  publishToUsersLocal,
  publishToThread,
  setBroadcastHook,
  setTerminateBroadcastHook,
  registerTerminator,
  terminateUserConnections,
  telegraphEmitterStats,
  _resetTelegraphEmitterStats,
  type TelegraphEvent,
  type TelegraphEmitterStats,
} from "../lib/telegraphEvents.js";

const THREAD = "3f0a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8";
const ALICE = "tg-emitter-alice";
const BOB = "tg-emitter-bob";

interface Captured { level: string; obj: any; msg: string }
let captured: Captured[] = [];
const originals: Record<string, any> = {};

function captureLogs(): void {
  for (const level of ["error", "warn", "info", "debug"] as const) {
    originals[level] = (logger as any)[level];
    (logger as any)[level] = (obj: any, msg?: string) => {
      captured.push({ level, obj, msg: String(msg ?? obj) });
    };
  }
}
function restoreLogs(): void {
  for (const level of Object.keys(originals)) (logger as any)[level] = originals[level];
}

/** Minimal thenable modelling ONE supabase read outcome. */
function memberClient(outcome: { data?: any[] | null; error?: { message: string } | null; throws?: boolean }) {
  let reads = 0;
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    // Two-argument then: `await` calls then(resolve, reject), and a one-argument
    // shim turns a rejection into an unhandled one that kills the runner.
    then(resolve: (v: any) => void, reject?: (e: unknown) => void) {
      reads++;
      const p = outcome.throws
        ? Promise.reject(new Error("socket hang up"))
        // supabase-js RESOLVES on a database error — data null alongside error.
        : Promise.resolve({ data: outcome.data ?? null, error: outcome.error ?? null });
      return p.then(resolve, reject);
    },
  };
  return { client: { from: () => builder } as any, reads: () => reads };
}

function delta(before: TelegraphEmitterStats, after: TelegraphEmitterStats): Partial<TelegraphEmitterStats> {
  const d: any = {};
  for (const k of Object.keys(after) as Array<keyof TelegraphEmitterStats>) {
    if (after[k] !== before[k]) d[k] = after[k] - before[k];
  }
  return d;
}

const errorsMatching = (re: RegExp) => captured.filter((c) => c.level === "error" && re.test(c.msg));

beforeEach(() => {
  captured = [];
  _resetTelegraphEmitterStats();
  setBroadcastHook(undefined as any);
  setTerminateBroadcastHook(undefined as any);
  captureLogs();
});

afterEach(() => {
  restoreLogs();
  setBroadcastHook(undefined as any);
  setTerminateBroadcastHook(undefined as any);
});

describe("telegraph emitters — a lost event leaves a trace", () => {
  it("counters start at zero and are readable (vacuity guard)", () => {
    const s = telegraphEmitterStats();
    const keys = Object.keys(s);
    assert.ok(keys.length >= 8, `expected the full counter set, saw ${keys.join(",")}`);
    for (const k of keys) assert.equal((s as any)[k], 0, `${k} should start at zero`);
  });

  it("a healthy publishToThread delivers and moves ONLY the success counters", async () => {
    const got: TelegraphEvent[] = [];
    const un = subscribe(ALICE, (e) => got.push(e));
    const { client, reads } = memberClient({ data: [{ user_id: ALICE }, { user_id: BOB }] });

    const before = telegraphEmitterStats();
    await publishToThread(client, THREAD, { type: "message.created", payload: { id: "m1" } });
    const d = delta(before, telegraphEmitterStats());
    un();

    assert.equal(reads(), 1, "fixture check: the members read must actually have been issued");
    assert.equal(got.length, 1, "the live subscriber must have received the event");
    assert.equal(got[0]!.threadId, THREAD);
    assert.deepEqual(d, { published: 1, delivered: 1 },
      `a clean publish must not move any failure counter; saw ${JSON.stringify(d)}`);
    assert.deepEqual(errorsMatching(/./).map((c) => c.msg), [], "clean path must log no errors");
  });

  it("an UNREADABLE membership table is counted and logged, not silently returned", async () => {
    const got: TelegraphEvent[] = [];
    const un = subscribe(ALICE, (e) => got.push(e));
    const { client, reads } = memberClient({ error: { message: "57014 statement timeout" } });

    const before = telegraphEmitterStats();
    await publishToThread(client, THREAD, { type: "message.created", payload: { id: "m2" } });
    const after = telegraphEmitterStats();
    un();

    assert.equal(reads(), 1, "fixture check: the read must have been issued");
    assert.equal(got.length, 0, "nothing can be delivered when the audience is unknown");

    const d = delta(before, after);
    assert.equal(d.audienceResolutionFailures, 1, `expected one audience failure, saw ${JSON.stringify(d)}`);
    assert.equal(d.eventsDroppedUnresolvedAudience, 1, "the dropped event must be counted");
    assert.equal(d.emptyAudience, undefined,
      "an unreadable table must NOT be recorded as 'everyone left the thread' — that is the whole defect");

    const lines = errorsMatching(/audience read FAILED/i);
    assert.equal(lines.length, 1, `expected one audience-failure error log, saw ${JSON.stringify(captured.map((c) => c.msg))}`);
    assert.equal(lines[0]!.obj?.threadId, THREAD, "the log must name the thread that lost its events");
    assert.equal(lines[0]!.obj?.type, "message.created", "the log must name the event type that was lost");
    assert.ok(lines[0]!.obj?.err, "the log must carry the swallowed database error");
  });

  it("a THROWN members read is counted and logged too", async () => {
    const { client } = memberClient({ throws: true });
    const before = telegraphEmitterStats();
    await publishToThread(client, THREAD, { type: "thread.updated" });
    const d = delta(before, telegraphEmitterStats());

    assert.equal(d.eventsDroppedUnresolvedAudience, 1, `saw ${JSON.stringify(d)}`);
    assert.equal(errorsMatching(/threw resolving members/i).length, 1,
      "an exception must not be quieter than a database error");
  });

  it("a GENUINELY empty audience is distinguishable from a failed read", async () => {
    const { client } = memberClient({ data: [] });
    const before = telegraphEmitterStats();
    await publishToThread(client, THREAD, { type: "thread.updated" });
    const d = delta(before, telegraphEmitterStats());

    assert.deepEqual(d, { emptyAudience: 1 },
      `an empty thread is not a failure and must move only emptyAudience; saw ${JSON.stringify(d)}`);
    assert.deepEqual(errorsMatching(/./).map((c) => c.msg), [],
      "an empty thread must not be reported as an outage");
  });

  it("a failed cross-instance fan-out is an ERROR with the audience size", () => {
    const un = subscribe(ALICE, () => {});
    setBroadcastHook(() => { throw new Error("redis channel closed"); });

    const before = telegraphEmitterStats();
    publishToUsers([ALICE, BOB], { type: "message.created", payload: { id: "m3" } });
    const d = delta(before, telegraphEmitterStats());
    un();

    assert.equal(d.broadcastErrors, 1, `saw ${JSON.stringify(d)}`);
    assert.equal(d.delivered, 1, "local delivery still happened — only the other instances lost it");
    const lines = errorsMatching(/broadcast hook threw/i);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.obj?.audience, 2, "the log must say how many users were affected");
  });

  it("a subscriber callback that throws is counted per-connection", () => {
    const un1 = subscribe(ALICE, () => { throw new Error("res.write after end"); });
    const delivered: TelegraphEvent[] = [];
    const un2 = subscribe(BOB, (e) => delivered.push(e));

    const before = telegraphEmitterStats();
    publishToUsers([ALICE, BOB], { type: "read.updated" });
    const d = delta(before, telegraphEmitterStats());
    un1(); un2();

    assert.equal(d.subscriberErrors, 1, `saw ${JSON.stringify(d)}`);
    assert.equal(d.delivered, 1, "one broken connection must not stop the other");
    assert.equal(delivered.length, 1, "the healthy subscriber still received the event");
  });

  it("publishToUsersLocal (remote relay path) counts its own failures", () => {
    const un = subscribe(ALICE, () => { throw new Error("boom"); });
    const before = telegraphEmitterStats();
    publishToUsersLocal([ALICE], { type: "message.created", ts: new Date().toISOString() });
    const d = delta(before, telegraphEmitterStats());
    un();
    assert.equal(d.subscriberErrors, 1,
      `the relay path is a delivery path and must be as observable as the local one; saw ${JSON.stringify(d)}`);
  });

  it("a failed terminate fan-out is an ERROR — revoked sessions stay open elsewhere", () => {
    let localTerminated = 0;
    const un = registerTerminator(ALICE, () => { localTerminated++; });
    setTerminateBroadcastHook(() => { throw new Error("channel down"); });

    const before = telegraphEmitterStats();
    terminateUserConnections(ALICE);
    const d = delta(before, telegraphEmitterStats());
    un();

    assert.equal(localTerminated, 1, "fixture check: the local connection must have been closed");
    assert.equal(d.terminateBroadcastErrors, 1, `saw ${JSON.stringify(d)}`);
    const lines = errorsMatching(/terminate broadcast hook threw/i);
    assert.equal(lines.length, 1, "a half-applied access revocation must be an error, not a warning");
    assert.equal(lines[0]!.obj?.userId, ALICE);
  });

  it("counters accumulate across events (a rate is observable, not just a single failure)", async () => {
    const { client } = memberClient({ error: { message: "down" } });
    for (let i = 0; i < 4; i++) {
      await publishToThread(client, THREAD, { type: "message.created", payload: { i } });
    }
    const s = telegraphEmitterStats();
    assert.equal(s.eventsDroppedUnresolvedAudience, 4,
      "an operator must be able to see four events lost, not merely that something failed once");
    assert.equal(errorsMatching(/audience read FAILED/i).length, 4);
  });
});
