/**
 * Telegraph §17.2 / §30 Reliability — idempotent resend (T231), sequence resume
 * (T233) and resume backpressure (T376), migration 3654.
 *
 * The fake below MODELS what the claims stand on rather than stubbing past it:
 *   - 2810's PARTIAL unique index on (thread_id, sender_id, idempotency_key):
 *     a second insert with the same triple fails 23505 naming the index;
 *   - 2810's sequence trigger: while telegraph_message_kernel_enabled is on, an
 *     insert takes message_threads.last_sequence + 1;
 *   - `.gt` / `.order` on `sequence` numerically.
 * A lookup delay lets two concurrent sends both MISS the replay lookup, so the
 * race is decided by the index exactly as it would be on the database.
 *
 * Run: node --import tsx/esm --test src/test/telegraphReliability.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import messagingRouter from "../routes/messaging.js";
import {
  _resetResumeInFlight, _setResumeInFlightForTest, resumeInFlight,
  RESUME_LIMIT_PER_WINDOW, RESUME_PAGE_MAX, parseIdempotencyKey, resumeSummary,
} from "../services/telegraphReliability.js";

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";
const STRANGER = "dddddddd-0000-4000-8000-000000000004";
const DM = "00000000-0000-4000-8000-0000000000d1";     // ME + OTHER
const GROUP = "00000000-0000-4000-8000-0000000000a1";  // ME + OTHER + CAROL
const FOREIGN = "00000000-0000-4000-8000-0000000000f1"; // OTHER + CAROL only
const NOWHERE = "00000000-0000-4000-8000-0000000000e1"; // no such thread

interface State {
  flags: Record<string, boolean>;
  members: any[];
  threads: Record<string, any>;
  messages: any[];
  blocks: any[];
  inserts: any[];
  lookupDelayMs: number;
  lookupError: boolean;
  blocksError: boolean;
}

let state: State;

function fresh(): State {
  return {
    flags: {},
    members: [
      { thread_id: DM, user_id: ME, left_at: null }, { thread_id: DM, user_id: OTHER, left_at: null },
      { thread_id: GROUP, user_id: ME, left_at: null }, { thread_id: GROUP, user_id: OTHER, left_at: null },
      { thread_id: GROUP, user_id: CAROL, left_at: null },
      { thread_id: FOREIGN, user_id: OTHER, left_at: null }, { thread_id: FOREIGN, user_id: CAROL, left_at: null },
    ],
    threads: {
      [DM]: { id: DM, is_e2ee: false, thread_type: "direct", last_sequence: 0 },
      [GROUP]: { id: GROUP, is_e2ee: false, thread_type: "group", last_sequence: 0 },
      [FOREIGN]: { id: FOREIGN, is_e2ee: false, thread_type: "direct", last_sequence: 0 },
    },
    messages: [],
    blocks: [],
    inserts: [],
    lookupDelayMs: 0,
    lookupError: false,
    blocksError: false,
  };
}

const ON_ALL = {
  telegraph_idempotent_send_enabled: true,
  telegraph_sequence_resume_enabled: true,
  telegraph_message_kernel_enabled: true,
};

let nextId = 1;
function uuid(): string {
  const n = String(nextId++).padStart(12, "0");
  return `eeeeeeee-0000-4000-8000-${n}`;
}

function cmp(col: string, a: any, b: any): number {
  if (col === "sequence") return Number(a) - Number(b);
  return (Date.parse(a) || 0) - (Date.parse(b) || 0);
}

function makeClient() {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    let ins: any = null;
    let upd: any = null;
    let single = false;
    let idemLookup = false;

    const rows = (): any[] => {
      if (table === "feature_flags") return Object.entries(state.flags).map(([flag, enabled]) => ({ flag, enabled }));
      if (table === "message_thread_members") return state.members;
      if (table === "message_threads") return Object.values(state.threads);
      if (table === "messages") return state.messages;
      if (table === "blocks") return state.blocks;
      if (table === "profiles") return [ME, OTHER, CAROL, STRANGER].map((id) => ({ id, handle: id.slice(0, 4), name: id.slice(0, 4), preferred_language: "en" }));
      return [];
    };

    const resolve = async (): Promise<any> => {
      if (ins !== null) {
        const row = { id: uuid(), deleted_at: null, edited_at: null, reply_to_id: null, sequence: null, ...ins };
        if (table === "messages") {
          if (row.idempotency_key != null && state.messages.some((m) =>
            m.thread_id === row.thread_id && m.sender_id === row.sender_id && m.idempotency_key === row.idempotency_key)) {
            return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "messages_idempotency_uniq"' } };
          }
          if (state.flags.telegraph_message_kernel_enabled) {
            const t = state.threads[row.thread_id];
            t.last_sequence += 1;
            row.sequence = t.last_sequence;
          }
          state.messages.push(row);
          state.inserts.push(ins);
        }
        return { data: single ? row : [row], error: null };
      }
      if (upd !== null) return { data: null, error: null };
      if (idemLookup) {
        if (state.lookupError) return { data: null, error: { code: "57014", message: "statement timeout" } };
        // The read is taken NOW (a snapshot) and answered after the delay, so two
        // concurrent sends both observe "no earlier send" — the race is real.
        const snap = rows().filter((r) => filters.every((f) => f(r)));
        if (state.lookupDelayMs) await new Promise((r) => setTimeout(r, state.lookupDelayMs));
        return { data: single ? (snap[0] ?? null) : snap, error: null };
      }
      if (table === "blocks" && state.blocksError) return { data: null, error: { code: "08006", message: "connection failure" } };
      let out = rows().filter((r) => filters.every((f) => f(r)));
      if (order) { const { col, asc } = order; out = [...out].sort((a, b) => (asc ? 1 : -1) * cmp(col, a[col], b[col])); }
      if (limit !== null) out = out.slice(0, limit);
      if (single) return { data: out[0] ?? null, error: null };
      return { data: out, error: null, count: out.length };
    };

    const t: any = {
      select() { return p; },
      insert(d: any) { ins = d; return p; },
      update(d: any) { upd = d; return p; },
      upsert() { upd = {}; return p; },
      eq(c: string, v: any) { if (c === "idempotency_key") idemLookup = true; filters.push((r) => r[c] === v); return p; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return p; },
      in(c: string, v: any[]) { filters.push((r) => v.map(String).includes(String(r[c]))); return p; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return p; },
      gt(c: string, v: any) { filters.push((r) => r[c] != null && cmp(c, r[c], v) > 0); return p; },
      lt(c: string, v: any) { filters.push((r) => r[c] != null && cmp(c, r[c], v) < 0); return p; },
      gte(c: string, v: any) { filters.push((r) => r[c] != null && cmp(c, r[c], v) >= 0); return p; },
      order(col: string, o?: any) { order = { col, asc: o?.ascending !== false }; return p; },
      limit(n: number) { limit = n; return p; },
      maybeSingle() { single = true; return p; },
      single() { single = true; return p; },
      then(res: (v: any) => void, rej?: (e: unknown) => void) { return resolve().then(res, rej); },
    };
    const p: any = new Proxy(t, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => p;
      },
    });
    return p;
  }
  return {
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

async function call(method: "GET" | "POST", path: string, asUser: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, retryAfter: r.headers.get("retry-after") };
}

const send = (thread: string, as: string, body: string, clientId?: string) =>
  call("POST", `/threads/${thread}/messages`, as, { body, ...(clientId ? { clientId } : {}) });

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } }; next(); });
  app.use("/api", messagingRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
});

beforeEach(() => {
  state = fresh();
  _resetRateLimit();
  _clearSendTierCache();
  _resetResumeInFlight();
  _setTestClient(makeClient(), true);
});

const KEY = "0f2c4e6a-1b3d-4f5a-8c9e-aa0011223344";

// ════════════════════════════════════════════════════════════════════════════
describe("T231 idempotent resend (telegraph_idempotent_send_enabled)", () => {
  it("a resend with the same key answers 200 with the ORIGINAL message and writes no second row", async () => {
    state.flags = { ...ON_ALL };
    const first = await send(DM, ME, "meet at the gate", KEY);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await send(DM, ME, "meet at the gate", KEY);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.id, first.body.id);
    assert.equal(again.body.idempotentReplay, true);
    assert.equal(again.body.clientId, KEY);
    assert.equal(state.messages.length, 1);
    assert.equal(state.inserts[0].idempotency_key, KEY, "the key is stored with the flag ON");
    assert.equal(state.inserts[0].client_message_id, KEY);
  });

  it("an explicit idempotencyKey wins over clientId", async () => {
    state.flags = { ...ON_ALL };
    const r = await call("POST", `/threads/${DM}/messages`, ME, { body: "x", clientId: "client-aaaaaaaa", idempotencyKey: "idem-bbbbbbbb" });
    assert.equal(r.status, 201);
    assert.equal(state.inserts[0].idempotency_key, "idem-bbbbbbbb");
  });

  it("CONCURRENT duplicate sends: exactly one row; the loser answers with the winner's message", async () => {
    state.flags = { ...ON_ALL };
    state.lookupDelayMs = 40; // both requests MISS the lookup; the index decides
    const [a, b] = await Promise.all([send(DM, ME, "on my way", KEY), send(DM, ME, "on my way", KEY)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 201], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
    assert.equal(a.body.id, b.body.id);
    assert.equal(state.messages.length, 1, "duplicate canonical messages must be 0 (§28)");
  });

  it("five concurrent duplicates still write one row", async () => {
    state.flags = { ...ON_ALL };
    state.lookupDelayMs = 30;
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => send(GROUP, ME, "five", KEY)));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 200).length, 4);
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
    assert.equal(state.messages.length, 1);
  });

  it("a key reused for a DIFFERENT payload is refused 409 — never answered with the original", async () => {
    state.flags = { ...ON_ALL };
    await send(DM, ME, "first text", KEY);
    const r = await send(DM, ME, "second text", KEY);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "conflict");
    assert.equal(JSON.stringify(r.body).includes("first text"), false, "the refusal does not echo the original");
    assert.equal(state.messages.length, 1);
  });

  it("V-TR F2: an E2EE retry re-encrypts (new ciphertext) and is answered with the ORIGINAL, never 409", async () => {
    state.flags = { ...ON_ALL };
    state.threads[DM].is_e2ee = true;
    const first = await call("POST", `/threads/${DM}/messages`, ME, { ciphertext: "cipher-one", clientId: KEY });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await call("POST", `/threads/${DM}/messages`, ME, { ciphertext: "cipher-two-fresh-ratchet", clientId: KEY });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.id, first.body.id);
    assert.equal(again.body.idempotentReplay, true);
    assert.equal(state.messages.length, 1);
  });

  it("V-TR F2: an E2EE key reused for a different KIND of message is still refused 409", async () => {
    state.flags = { ...ON_ALL };
    state.threads[DM].is_e2ee = true;
    await call("POST", `/threads/${DM}/messages`, ME, { ciphertext: "cipher-one", clientId: KEY });
    const r = await call("POST", `/threads/${DM}/messages`, ME, { ciphertext: "cipher-two", clientId: KEY, msgType: "system", subtype: "post_card" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(state.messages.length, 1);
  });

  it("V-TR F3: the RACE loser with a DIFFERENT payload is refused 409, not answered with the winner", async () => {
    state.flags = { ...ON_ALL };
    state.lookupDelayMs = 40;
    const [a, b] = await Promise.all([send(DM, ME, "first text", KEY), send(DM, ME, "other text", KEY)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
    assert.equal(state.messages.length, 1);
  });

  it("V-TR F5: a resend of a message deleted since it landed replays the TOMBSTONE (deleted: true), never 409, never revived", async () => {
    state.flags = { ...ON_ALL };
    const first = await send(DM, ME, "regret", KEY);
    const row = state.messages.find((m) => m.id === first.body.id);
    row.deleted_at = "2026-10-10T12:00:00.000Z"; row.body = "";
    const again = await send(DM, ME, "regret", KEY);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.deleted, true);
    assert.equal(again.body.body, null);
    assert.equal(state.messages.length, 1);
  });

  it("another sender's identical key finds NOTHING of theirs and sends normally", async () => {
    state.flags = { ...ON_ALL };
    const mine = await send(GROUP, ME, "hello", KEY);
    const theirs = await send(GROUP, OTHER, "hello", KEY);
    assert.equal(theirs.status, 201);
    assert.notEqual(theirs.body.id, mine.body.id);
    assert.equal(theirs.body.idempotentReplay, undefined);
    assert.equal(state.messages.length, 2);
  });

  it("the same key in ANOTHER thread is a new message (the lookup never crosses threads)", async () => {
    state.flags = { ...ON_ALL };
    const a = await send(DM, ME, "hello", KEY);
    const b = await send(GROUP, ME, "hello", KEY);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.id, b.body.id);
  });

  it("a non-member presenting someone's key learns nothing: the membership refusal comes first", async () => {
    state.flags = { ...ON_ALL };
    await send(FOREIGN, OTHER, "private", KEY);
    const r = await send(FOREIGN, ME, "private", KEY);
    assert.equal(r.status, 403);
    assert.equal(JSON.stringify(r.body).includes("private"), false);
    assert.equal(state.messages.length, 1);
  });

  it("BLOCK AFTER SEND: once blocked, a resend of the delivered message is refused 403 and writes nothing", async () => {
    state.flags = { ...ON_ALL };
    const first = await send(DM, ME, "are you there", KEY);
    assert.equal(first.status, 201);
    state.blocks.push({ blocker_id: OTHER, blocked_id: ME });
    const r = await send(DM, ME, "are you there", KEY);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.idempotentReplay, undefined);
    assert.equal(state.messages.length, 1);
  });

  it("an unreadable replay lookup refuses 503 rather than risking a duplicate", async () => {
    state.flags = { ...ON_ALL };
    state.lookupError = true;
    const r = await send(DM, ME, "hello", KEY);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(state.messages.length, 0);
  });

  it("a replay spends no send budget: 30 resends of one message never hit the 20/10min stranger limit", async () => {
    state.flags = { ...ON_ALL };
    const first = await send(DM, ME, "retrying", KEY);
    assert.equal(first.status, 201);
    for (let i = 0; i < 30; i++) {
      const r = await send(DM, ME, "retrying", KEY);
      assert.equal(r.status, 200, `resend ${i}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal(state.messages.length, 1);
  });

  it("flag OFF: the pre-3654 behaviour — a resend writes a second row and no key column is ever named", async () => {
    state.flags = { telegraph_message_kernel_enabled: true };
    const a = await send(DM, ME, "hello", KEY);
    const b = await send(DM, ME, "hello", KEY);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(state.messages.length, 2);
    for (const ins of state.inserts) {
      assert.deepEqual(Object.keys(ins).sort(), ["body", "ciphertext", "created_at", "msg_type", "sender_id", "subtype", "thread_id"]);
    }
  });

  it("parseIdempotencyKey admits uuids and refuses junk", () => {
    assert.equal(parseIdempotencyKey(KEY), KEY);
    assert.equal(parseIdempotencyKey("short"), null);
    assert.equal(parseIdempotencyKey("has space in it"), null);
    assert.equal(parseIdempotencyKey("x".repeat(65)), null);
    assert.equal(parseIdempotencyKey(42), null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
function seedConversation(thread: string, n: number, senders: string[]) {
  for (let i = 1; i <= n; i++) {
    state.threads[thread].last_sequence = i;
    state.messages.push({
      id: uuid(), thread_id: thread, sender_id: senders[(i - 1) % senders.length], body: `m${i}`,
      created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), deleted_at: null, edited_at: null,
      original_language: null, msg_type: "text", subtype: null, media_url: null, media_type: null,
      media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null, sequence: i,
    });
  }
}

const resume = (thread: string, as: string, after: number | string) =>
  call("GET", `/threads/${thread}/messages?afterSequence=${after}`, as);

describe("T233 reconnect resume by sequence (telegraph_sequence_resume_enabled + kernel)", () => {
  it("RECONNECT GAP: everything after the acknowledged sequence, oldest first, nothing before it", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(DM, 5, [OTHER, ME]);
    const r = await resume(DM, ME, 2);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.messages.map((m: any) => m.sequence), [3, 4, 5]);
    assert.deepEqual(r.body.messages.map((m: any) => m.body), ["m3", "m4", "m5"]);
    assert.deepEqual(r.body.resume, { afterSequence: 2, nextSequence: 5, hasMore: false });
  });

  it("a gap larger than one page is closed by paging with nextSequence until hasMore is false", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(GROUP, RESUME_PAGE_MAX + 37, [OTHER, CAROL]);
    const seen: number[] = [];
    let cursor = 0;
    for (let page = 0; page < 5; page++) {
      const r = await resume(GROUP, ME, cursor);
      assert.equal(r.status, 200);
      seen.push(...r.body.messages.map((m: any) => m.sequence));
      cursor = r.body.resume.nextSequence;
      if (!r.body.resume.hasMore) break;
    }
    assert.equal(seen.length, RESUME_PAGE_MAX + 37);
    assert.deepEqual(seen, Array.from({ length: RESUME_PAGE_MAX + 37 }, (_, i) => i + 1), "no message lost, none repeated");
  });

  it("a message sent while away (kernel allocates its sequence) is in the next resume", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(DM, 3, [OTHER]);
    const r1 = await resume(DM, ME, 3);
    assert.deepEqual(r1.body.messages, []);
    const sent = await send(DM, OTHER, "landed", "k-landed-00000001");
    assert.equal(sent.status, 201);
    const r2 = await resume(DM, ME, r1.body.resume.nextSequence);
    assert.deepEqual(r2.body.messages.map((m: any) => [m.sequence, m.body]), [[4, "landed"]]);
  });

  it("a foreign thread and a thread that does not exist answer ONE uniform 404", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(FOREIGN, 3, [OTHER, CAROL]);
    const foreign = await resume(FOREIGN, ME, 0);
    const missing = await resume(NOWHERE, ME, 0);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, missing.body, "nothing distinguishes someone else's thread from no thread");
    assert.equal(JSON.stringify(foreign.body).includes("m1"), false);
  });

  it("a LEFT member resumes nothing (uniform 404)", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(GROUP, 3, [OTHER]);
    state.members.find((m) => m.thread_id === GROUP && m.user_id === ME).left_at = "2026-10-02T00:00:00.000Z";
    const r = await resume(GROUP, ME, 0);
    assert.equal(r.status, 404);
  });

  it("BLOCK: a resume never carries the blocked person's messages (either direction); others' and own stay", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(GROUP, 6, [OTHER, CAROL, ME]);
    state.blocks.push({ blocker_id: ME, blocked_id: OTHER });
    const r = await resume(GROUP, ME, 0);
    assert.equal(r.status, 200);
    assert.equal(r.body.messages.some((m: any) => m.senderId === OTHER), false);
    assert.deepEqual(r.body.messages.map((m: any) => m.sequence), [2, 3, 5, 6]);
    assert.equal(r.body.resume.nextSequence, 6, "the cursor still advances past the dropped rows");

    state.blocks = [{ blocker_id: OTHER, blocked_id: ME }];
    const r2 = await resume(GROUP, ME, 0);
    assert.equal(r2.body.messages.some((m: any) => m.senderId === OTHER), false, "blocked BY them is the same answer");
  });

  it("BLOCK AFTER SEND: messages delivered before the block are not resumed after it", async () => {
    state.flags = { ...ON_ALL };
    const sent = await send(DM, OTHER, "before the block", "k-before-block-01");
    assert.equal(sent.status, 201);
    state.blocks.push({ blocker_id: ME, blocked_id: OTHER });
    const r = await resume(DM, ME, 0);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.messages, []);
  });

  it("unreadable block state refuses 503 — never a page that may cross a block", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(DM, 2, [OTHER]);
    state.blocksError = true;
    const r = await resume(DM, ME, 0);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(JSON.stringify(r.body).includes("m1"), false);
  });

  it("a malformed cursor is refused 400, never read as 0", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(DM, 2, [OTHER]);
    for (const bad of ["-1", "1.5", "abc", "", "1e3"]) {
      const r = await resume(DM, ME, bad);
      assert.equal(r.status, 400, `cursor ${JSON.stringify(bad)}: ${r.status}`);
    }
  });

  it("withSequence=1 labels an ordinary page with sequences (the client's cursor), and carries no resume block", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(DM, 3, [OTHER]);
    const r = await call("GET", `/threads/${DM}/messages?withSequence=1`, ME);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.messages.map((m: any) => m.sequence), [3, 2, 1]);
    assert.equal(r.body.resume, undefined);
  });

  for (const [label, flags] of [
    ["resume flag OFF", { telegraph_message_kernel_enabled: true }],
    ["kernel flag OFF", { telegraph_sequence_resume_enabled: true }],
  ] as const) {
    it(`${label}: afterSequence/withSequence are ignored and the answer is byte-identical to the plain page`, async () => {
      state.flags = { ...flags };
      seedConversation(DM, 3, [OTHER]);
      const plain = await call("GET", `/threads/${DM}/messages`, ME);
      const withParams = await call("GET", `/threads/${DM}/messages?afterSequence=1&withSequence=1`, ME);
      assert.equal(plain.status, 200);
      assert.deepEqual(withParams.body, plain.body);
      assert.equal(JSON.stringify(plain.body).includes('"sequence"'), false);
      const foreign = await call("GET", `/threads/${FOREIGN}/messages?afterSequence=0`, ME);
      assert.equal(foreign.status, 403, "flags OFF: the route's original refusal, unchanged");
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
describe("T376 backpressure — explicit 429 semantics on resume", () => {
  it("the per-person budget answers 429 with Retry-After past the limit", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(DM, 1, [OTHER]);
    for (let i = 0; i < RESUME_LIMIT_PER_WINDOW; i++) {
      const r = await resume(DM, ME, 0);
      assert.equal(r.status, 200, `call ${i}`);
    }
    const r = await resume(DM, ME, 0);
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "rate_limited");
    assert.ok(Number(r.retryAfter) >= 1, `Retry-After ${r.retryAfter}`);
    const other = await resume(DM, OTHER, 0);
    assert.equal(other.status, 200, "one person's storm does not spend another's budget");
  });

  it("load shedding: a saturated process answers 429 + Retry-After instead of queueing the read", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(DM, 1, [OTHER]);
    _setResumeInFlightForTest(64);
    const r = await resume(DM, ME, 0);
    assert.equal(r.status, 429);
    assert.equal(r.retryAfter, "2");
    _resetResumeInFlight();
    const ok = await resume(DM, ME, 0);
    assert.equal(ok.status, 200);
  });

  it("every admitted resume releases its in-flight slot (success, 404 and 503 alike)", async () => {
    state.flags = { ...ON_ALL };
    seedConversation(DM, 1, [OTHER]);
    await resume(DM, ME, 0);
    await resume(NOWHERE, ME, 0);
    state.blocksError = true;
    await resume(DM, ME, 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resumeInFlight(), 0);
  });

  it("resumeSummary decides hasMore and the cursor on the RAW read", () => {
    const raw = [{ sequence: 4 }, { sequence: 5 }, { sequence: 6 }];
    assert.deepEqual(resumeSummary(raw, 3, 2), { scanned: 2, hasMore: true, nextSequence: 5 });
    assert.deepEqual(resumeSummary(raw, 3, 3), { scanned: 3, hasMore: false, nextSequence: 6 });
    assert.deepEqual(resumeSummary([], 9, 3), { scanned: 0, hasMore: false, nextSequence: 9 });
  });
});
