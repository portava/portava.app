/**
 * Telegraph §13.3 outbox CONSUMER (census-telegraph T154, T196, T376; migration 3655).
 *
 * The fake models what the claims stand on:
 *   - 2810's trigger: with telegraph_message_kernel_enabled on, an insert into
 *     `messages` writes one `message.sent` outbox row (no body) in the same step;
 *   - 3655's claim: FOR UPDATE SKIP LOCKED is modelled as "a claimed row carries
 *     a lease and is invisible to a second claim until the lease passes", and
 *     attempts are counted AT CLAIM with a max;
 *   - 3655's ack: idempotent on published_at IS NULL, returns the count acked.
 *
 * Run: node --import tsx/esm --test src/test/telegraphOutboxDrain.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetOutboxFanoutCache } from "../lib/telegraphOutboxDrainScheduler.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import { subscribe, type TelegraphEvent } from "../lib/telegraphEvents.js";
import messagingRouter from "../routes/messaging.js";
import {
  runTelegraphOutboxDrainPass, runTelegraphOutboxDrainTick, getTelegraphOutboxDrainStatus,
  _resetTelegraphOutboxDrainStatus, TELEGRAPH_OUTBOX_MAX_ATTEMPTS, outboxFanoutInForce,
} from "../lib/telegraphOutboxDrainScheduler.js";

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-0000000000d1";

interface World {
  flags: Record<string, boolean>;
  members: any[];
  threads: Record<string, any>;
  messages: any[];
  outbox: any[];
  jobHealth: any[];
  clock: number;
  messageReadError: boolean;
  claimError: boolean;
  ackError: boolean;
  rpcCalls: string[];
}

let w: World;
let n = 1;
const id = () => `eeeeeeee-0000-4000-8000-${String(n++).padStart(12, "0")}`;

function fresh(): World {
  return {
    flags: {},
    members: [{ thread_id: THREAD, user_id: ME, left_at: null }, { thread_id: THREAD, user_id: OTHER, left_at: null }],
    threads: { [THREAD]: { id: THREAD, is_e2ee: false, thread_type: "direct", last_sequence: 0 } },
    messages: [],
    outbox: [],
    jobHealth: [],
    clock: Date.parse("2026-10-10T12:00:00.000Z"),
    messageReadError: false,
    claimError: false,
    ackError: false,
    rpcCalls: [],
  };
}

const ON = { telegraph_outbox_fanout_enabled: true, telegraph_message_kernel_enabled: true };

function seedOutbox(event_type: string, message: Partial<Record<string, any>> | null) {
  let messageId: string | null = null;
  if (message) {
    messageId = id();
    w.threads[THREAD].last_sequence += 1;
    w.messages.push({ id: messageId, thread_id: THREAD, sender_id: ME, msg_type: "text", subtype: null, body: "secret body",
      created_at: new Date(w.clock).toISOString(), client_message_id: null, deleted_at: null, sequence: w.threads[THREAD].last_sequence, ...message });
  }
  const row = { id: id(), event_type, conversation_id: THREAD, message_id: messageId, sequence: w.threads[THREAD].last_sequence,
    actor_id: ME, dedupe_key: `${event_type}:${messageId}`, created_at: new Date(w.clock + w.outbox.length).toISOString(),
    published_at: null, attempts: 0, locked_until: null, last_error: null, disposition: null,
    payload: { messageId, conversationId: THREAD } };
  w.outbox.push(row);
  return row;
}

function makeClient() {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let ins: any = null; let upd: any = null; let ups: any = null; let single = false; let limit: number | null = null;
    let order: { col: string; asc: boolean } | null = null;
    const rows = (): any[] => {
      if (table === "feature_flags") return Object.entries(w.flags).map(([flag, enabled]) => ({ flag, enabled }));
      if (table === "message_thread_members") return w.members;
      if (table === "message_threads") return Object.values(w.threads);
      if (table === "messages") return w.messages;
      if (table === "profiles") return [{ id: ME, preferred_language: "en" }, { id: OTHER, preferred_language: "en" }];
      return [];
    };
    const resolve = async () => {
      if (ins !== null && table === "messages") {
        const row = { id: id(), deleted_at: null, sequence: null, client_message_id: null, ...ins };
        if (w.flags.telegraph_message_kernel_enabled) {
          w.threads[row.thread_id].last_sequence += 1;
          row.sequence = w.threads[row.thread_id].last_sequence;
          // 2810's AFTER INSERT trigger, same transaction, no body.
          w.outbox.push({ id: id(), event_type: "message.sent", conversation_id: row.thread_id, message_id: row.id, sequence: row.sequence,
            actor_id: row.sender_id, dedupe_key: `message.sent:${row.id}`, created_at: new Date().toISOString(),
            published_at: null, attempts: 0, locked_until: null, last_error: null, disposition: null,
            payload: { messageId: row.id, senderId: row.sender_id } });
        }
        w.messages.push(row);
        return { data: single ? row : [row], error: null };
      }
      if (ins !== null) return { data: null, error: null };
      if (ups !== null) { if (table === "job_health") w.jobHealth.push(ups); return { data: null, error: null }; }
      if (upd !== null) return { data: null, error: null };
      if (table === "messages" && w.messageReadError && filters.length === 1) return { data: null, error: { code: "57014", message: "timeout" } };
      let out = rows().filter((r) => filters.every((f) => f(r)));
      if (order) { const { col, asc } = order; out = [...out].sort((a, b) => (asc ? 1 : -1) * ((Date.parse(a[col]) || 0) - (Date.parse(b[col]) || 0))); }
      if (limit !== null) out = out.slice(0, limit);
      return single ? { data: out[0] ?? null, error: null } : { data: out, error: null, count: out.length };
    };
    const t: any = {
      select() { return p; }, insert(d: any) { ins = d; return p; }, update(d: any) { upd = d; return p; },
      upsert(d: any) { ups = d; return p; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return p; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return p; },
      in(c: string, v: any[]) { filters.push((r) => v.map(String).includes(String(r[c]))); return p; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return p; },
      order(col: string, o?: any) { order = { col, asc: o?.ascending !== false }; return p; },
      limit(k: number) { limit = k; return p; },
      maybeSingle() { single = true; return p; }, single() { single = true; return p; },
      then(res: any, rej: any) { return resolve().then(res, rej); },
    };
    const p: any = new Proxy(t, { get(target, prop) { if (prop in target) return target[prop as string]; if (prop === "catch" || prop === "finally") return undefined; return () => p; } });
    return p;
  }
  async function rpc(fn: string, args: any) {
    w.rpcCalls.push(fn);
    const now = w.clock;
    if (fn === "telegraph_outbox_claim") {
      if (w.claimError) return { data: null, error: { code: "42883", message: "function does not exist" } };
      const due = w.outbox
        .filter((r) => r.published_at === null && (r.locked_until === null || r.locked_until < now) && r.attempts < args.p_max_attempts)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, args.p_limit);
      for (const r of due) { r.locked_until = now + args.p_lease_seconds * 1000; r.attempts += 1; }
      return { data: due.map(({ id: rid, event_type, conversation_id, message_id, sequence, actor_id, dedupe_key, created_at, attempts }) =>
        ({ id: rid, event_type, conversation_id, message_id, sequence, actor_id, dedupe_key, created_at, attempts })), error: null };
    }
    if (fn === "telegraph_outbox_ack") {
      if (w.ackError) return { data: null, error: { code: "08006", message: "connection failure" } };
      let k = 0;
      for (const r of w.outbox) if (args.p_ids.includes(r.id) && r.published_at === null) { r.published_at = now; r.locked_until = null; r.disposition = args.p_disposition; k++; }
      return { data: k, error: null };
    }
    if (fn === "telegraph_outbox_fail") {
      const r = w.outbox.find((x) => x.id === args.p_id && x.published_at === null);
      if (r) { r.locked_until = null; r.last_error = String(args.p_error).slice(0, 200); }
      return { data: null, error: null };
    }
    return { data: null, error: { message: `rpc ${fn} not modelled` } };
  }
  return { from, rpc, auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) } };
}

type Published = { thread: string; event: any; opts: any };
function recorder(outcome: any = "published") {
  const calls: Published[] = [];
  const fn: any = async (_sc: any, thread: string, event: any, opts: any) => { calls.push({ thread, event, opts }); return typeof outcome === "function" ? outcome() : outcome; };
  return { calls, fn };
}

let db: ReturnType<typeof makeClient>;
beforeEach(() => {
  w = fresh();
  db = makeClient();
  _resetTelegraphOutboxDrainStatus();
  _resetRateLimit();
  _clearSendTierCache();
  _setTestClient(db as any, true);
});

describe("T154 the drainer, pass by pass", () => {
  it("flags OFF (either one): claims NOTHING — the rpc is never called", async () => {
    seedOutbox("message.sent", {});
    const variants: Array<Record<string, boolean>> = [{}, { telegraph_outbox_fanout_enabled: true }, { telegraph_message_kernel_enabled: true }];
    for (const flags of variants) {
      w.flags = { ...flags }; _resetOutboxFanoutCache(db);
      const r = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: recorder().fn });
      assert.equal(r.outcome, "off");
    }
    assert.deepEqual(w.rpcCalls, []);
    assert.equal(w.outbox[0].published_at, null);
  });

  it("message.sent → message.created fanned out to the thread, sender excluded, acked fanned_out, no body anywhere", async () => {
    w.flags = { ...ON };
    const row = seedOutbox("message.sent", { client_message_id: "client-0001" });
    const rec = recorder();
    const r = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn });
    assert.equal(r.outcome, "drained");
    assert.equal(r.fannedOut, 1);
    assert.equal(rec.calls.length, 1);
    const c = rec.calls[0]!;
    assert.equal(c.thread, THREAD);
    assert.equal(c.event.type, "message.created");
    assert.equal(c.opts.excludeUserId, ME);
    assert.equal(c.event.payload.messageId, row.message_id);
    assert.equal(c.event.payload.clientId, "client-0001");
    assert.equal(c.event.payload.dedupeKey, row.dedupe_key);
    assert.equal(JSON.stringify(c.event).includes("secret body"), false, "the outbox path carries no body");
    assert.equal(w.outbox[0].disposition, "fanned_out");
    assert.notEqual(w.outbox[0].published_at, null);
  });

  it("edited / unsent / deleted rows are acked route_direct and NOT re-published (their routes publish directly)", async () => {
    w.flags = { ...ON };
    seedOutbox("message.edited", {}); seedOutbox("message.unsent", {}); seedOutbox("message.deleted", {});
    const rec = recorder();
    const r = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn });
    assert.equal(r.routeDirect, 3);
    assert.equal(rec.calls.length, 0);
    assert.deepEqual(w.outbox.map((o) => o.disposition), ["route_direct", "route_direct", "route_direct"]);
  });

  it("a message retracted BEFORE fan-out is announced to nobody (message_absent)", async () => {
    w.flags = { ...ON };
    seedOutbox("message.sent", { deleted_at: "2026-10-10T12:00:01.000Z" });
    seedOutbox("message.sent", null);
    const rec = recorder();
    const r = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn });
    assert.equal(r.absent, 2);
    assert.equal(rec.calls.length, 0);
  });

  it("an unreadable message is FAILED (lease released, not acked) and delivered on the retry", async () => {
    w.flags = { ...ON };
    seedOutbox("message.sent", {});
    w.messageReadError = true;
    const rec = recorder();
    const r1 = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn });
    assert.equal(r1.outcome, "failed");
    assert.equal(r1.failed, 1);
    assert.equal(w.outbox[0].published_at, null);
    assert.equal(w.outbox[0].last_error, "message_unreadable");
    assert.equal(w.outbox[0].locked_until, null, "released for a prompt retry");
    w.messageReadError = false;
    const r2 = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn });
    assert.equal(r2.fannedOut, 1);
    assert.equal(rec.calls.length, 1, "delivered exactly once overall");
  });

  it("an unreadable AUDIENCE is a failure to retry, never an ack", async () => {
    w.flags = { ...ON };
    seedOutbox("message.sent", {});
    const r = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: recorder("audience_unreadable").fn });
    assert.equal(r.failed, 1);
    assert.equal(w.outbox[0].published_at, null);
    assert.equal(w.outbox[0].last_error, "audience_unreadable");
  });

  it("a poison row stops being claimed at max attempts and stays unacked for triage", async () => {
    w.flags = { ...ON };
    seedOutbox("message.sent", {});
    w.messageReadError = true;
    for (let i = 0; i < TELEGRAPH_OUTBOX_MAX_ATTEMPTS + 3; i++) await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: recorder().fn });
    assert.equal(w.outbox[0].attempts, TELEGRAPH_OUTBOX_MAX_ATTEMPTS);
    assert.equal(w.outbox[0].published_at, null);
  });

  it("two concurrent drainers take disjoint batches: every row published exactly once", async () => {
    w.flags = { ...ON };
    for (let i = 0; i < 7; i++) seedOutbox("message.sent", {});
    const rec = recorder();
    await Promise.all([
      runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn, limit: 4 }),
      runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn, limit: 4 }),
    ]);
    const ids = rec.calls.map((c) => c.event.payload.messageId);
    assert.equal(ids.length, 7);
    assert.equal(new Set(ids).size, 7);
    assert.ok(w.outbox.every((o) => o.disposition === "fanned_out"));
  });

  it("a redelivery after a lost ack is absorbed: the ack is idempotent and the event carries its dedupe key", async () => {
    w.flags = { ...ON };
    seedOutbox("message.sent", {});
    w.ackError = true;
    const rec = recorder();
    const r1 = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn });
    assert.equal(r1.reason, "ack_failed");
    w.ackError = false;
    w.clock += 61_000; // the lease passes
    await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn });
    assert.equal(rec.calls.length, 2, "at-least-once: a lost ack redelivers");
    assert.equal(rec.calls[0]!.event.payload.dedupeKey, rec.calls[1]!.event.payload.dedupeKey, "…with the same key a consumer dedupes on");
    assert.notEqual(w.outbox[0].published_at, null);
  });

  it("a failed claim is a FAILED pass, never 'nothing to consume'", async () => {
    w.flags = { ...ON };
    w.claimError = true;
    const r = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: recorder().fn });
    assert.deepEqual([r.outcome, r.reason], ["failed", "claim_failed"]);
  });

  it("outboxFanoutInForce is false on a flag read error", async () => {
    const broken = { from: () => { throw new Error("connection refused"); } };
    assert.equal(await outboxFanoutInForce(broken), false);
  });
});

describe("T154 health — the job cannot read healthy without a success", () => {
  it("an OFF tick is not an attempt and writes no job_health row", async () => {
    await runTelegraphOutboxDrainTick({ client: db, publish: recorder().fn });
    const s = getTelegraphOutboxDrainStatus();
    assert.equal(s.lastAttemptAt, null);
    assert.equal(w.jobHealth.length, 0);
  });

  it("a successful tick sets lastSuccessAt and persists job_health; a failing one counts", async () => {
    w.flags = { ...ON };
    await runTelegraphOutboxDrainTick({ client: db, publish: recorder().fn, now: new Date(w.clock) });
    let s = getTelegraphOutboxDrainStatus();
    assert.ok(s.lastSuccessAt);
    assert.equal(w.jobHealth.at(-1).job, "telegraphOutboxDrain");
    assert.ok(w.jobHealth.at(-1).last_success_at);
    w.claimError = true;
    await runTelegraphOutboxDrainTick({ client: db, publish: recorder().fn, now: new Date(w.clock + 1000) });
    s = getTelegraphOutboxDrainStatus();
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(w.jobHealth.at(-1).last_success_at, undefined, "a failure persists the attempt, never a success");
  });
});

// ── The send route, end to end ───────────────────────────────────────────────
let server: ReturnType<typeof createServer>;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } }; next(); });
  app.use("/api", messagingRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); _setTestClient(null as any, false); });

async function sendAndCollect(path = `/threads/${THREAD}/messages`, body: unknown = { body: "hello from the outbox", clientId: "client-route-0001" }): Promise<TelegraphEvent[]> {
  const got: TelegraphEvent[] = [];
  const unsub = subscribe(OTHER, (e) => { if (e.type === "message.created") got.push(e); });
  try {
    const r = await fetch(`${base}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${ME}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 201, await r.text());
    await new Promise((res) => setTimeout(res, 150));
  } finally { unsub(); }
  return got;
}

describe("T154 the send route with fan-out in force", () => {
  it("ON: message.created reaches the other member exactly once, FROM the outbox row (dedupe key), and the row is consumed", async () => {
    w.flags = { ...ON };
    const got = await sendAndCollect();
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.equal((got[0]!.payload as any).dedupeKey, `message.sent:${w.messages[0].id}`);
    assert.equal(w.outbox.length, 1);
    assert.equal(w.outbox[0].disposition, "fanned_out");
  });

  it("OFF: the route publishes directly, exactly as before — no outbox claim at all", async () => {
    w.flags = { telegraph_message_kernel_enabled: true };
    const got = await sendAndCollect();
    assert.equal(got.length, 1);
    assert.equal((got[0]!.payload as any).dedupeKey, undefined);
    assert.equal((got[0]!.payload as any).clientId, "client-route-0001");
    assert.equal(w.rpcCalls.includes("telegraph_outbox_claim"), false);
  });
});

describe("V-TR F1: ONE publisher of message.created for every door", () => {
  it("the MEDIA door, fan-out ON: the other member receives exactly one message.created (from the outbox)", async () => {
    w.flags = { ...ON };
    const got = await sendAndCollect(`/threads/${THREAD}/media`, { mediaUrl: `post-media/${ME}/p.webp`, mediaType: "image", clientId: "client-media-0001" });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.equal((got[0]!.payload as any).dedupeKey, `message.sent:${w.messages[0].id}`);
  });

  it("the MEDIA door, fan-out OFF: published directly, once, as before", async () => {
    w.flags = { telegraph_message_kernel_enabled: true };
    const got = await sendAndCollect(`/threads/${THREAD}/media`, { mediaUrl: `post-media/${ME}/p.webp`, mediaType: "image", clientId: "client-media-0002" });
    assert.equal(got.length, 1);
    assert.equal((got[0]!.payload as any).dedupeKey, undefined);
  });

  it("publishMessageCreated: ON publishes nothing itself (the drainer announces the row); OFF publishes exactly once", async () => {
    const { publishMessageCreated } = await import("../lib/telegraphOutboxDrainScheduler.js");
    w.flags = { ...ON };
    const ev = { type: "message.created" as const, payload: { messageId: "m-1" } };
    assert.equal(await publishMessageCreated(db as any, THREAD, ev), "outbox");
    const off = makeClient(); w.flags = { telegraph_message_kernel_enabled: true };
    const got: TelegraphEvent[] = [];
    const unsub = subscribe(OTHER, (e) => { if (e.type === "message.created") got.push(e); });
    try { assert.equal(await publishMessageCreated(off as any, THREAD, ev), "published"); } finally { unsub(); }
    assert.equal(got.length, 1);
  });

  it("STRUCTURAL: no message-writing door publishes message.created except through publishMessageCreated", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const doors = ["routes/messaging.ts", "routes/telegraphShare.ts", "routes/telegraphVoice.ts", "routes/telegraphCoordination.ts",
      "services/telegraph/threadEnvelopeWrites.ts", "lib/threadMessage.ts"];
    let sites = 0;
    for (const d of doors) {
      const text = readFileSync(join(src, d), "utf8");
      const re = /type:\s*['"]message\.created['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        sites += 1;
        const before = text.slice(Math.max(0, m.index - 260), m.index);
        assert.match(before, /publishMessageCreated\(/, `${d}: a message.created publish that bypasses the one publisher`);
        assert.doesNotMatch(before.slice(before.lastIndexOf("publishMessageCreated(")), /publishToThread\(/, `${d}: direct publishToThread`);
      }
    }
    assert.equal(sites, 7, "every door's publish site is counted (messaging text + media, share, voice, coordination, envelope, plain thread message)");
  });
});

describe("V-TR F3/F6: the drainer's guards", () => {
  it("a row naming a DIFFERENT conversation than its message is failed, never announced to that audience", async () => {
    w.flags = { ...ON };
    const row = seedOutbox("message.sent", {});
    row.conversation_id = "00000000-0000-4000-8000-0000000000ff";
    const rec = recorder();
    const r = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn });
    assert.equal(r.failed, 1);
    assert.equal(rec.calls.length, 0);
    assert.equal(w.outbox[0].last_error, "conversation_mismatch");
  });

  it("a BACKLOG row older than the fan-out horizon is acked expired, not replayed as a fresh message.created", async () => {
    w.flags = { ...ON };
    seedOutbox("message.sent", {});
    w.outbox[0].created_at = new Date(w.clock - 11 * 60_000).toISOString();
    seedOutbox("message.sent", {});
    w.outbox[1].created_at = new Date(w.clock - 9 * 60_000).toISOString();
    const rec = recorder();
    const r = await runTelegraphOutboxDrainPass({ client: db, nowMs: w.clock, publish: rec.fn });
    assert.equal(r.expired, 1);
    assert.equal(r.fannedOut, 1);
    assert.equal(rec.calls.length, 1);
    assert.deepEqual(w.outbox.map((o) => o.disposition), ["expired", "fanned_out"]);
  });
});
