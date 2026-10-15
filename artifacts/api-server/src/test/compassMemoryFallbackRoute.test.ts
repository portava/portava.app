/**
 * §28.17 "Always provide a deterministic fallback renderer if AI presentation
 * fails" on the REAL `POST /compass/ask` (census-highlights-memories H266, b58
 * lane HM-A3).
 *
 * The model calls `memory_search`, the tool answers with the user's Memory, and
 * then the model's presentation fails — it throws, or returns no text. Before
 * this lane the user got "Compass AI assistant is temporarily unavailable" or
 * "I found some results but had trouble putting them into words": the fact the
 * tool had just read was thrown away. Now the Memory is rendered without a
 * model, from the tool's own app-composed claim.
 *
 * WHAT WOULD TURN THIS RED
 *   - The tool log not surviving the throw (`toolSink` dropped from
 *     runToolCallingLoop): the ai_error answer is the static sentence again.
 *   - The empty-final branch using the static sentence: test 3.
 *   - The streamed empty-final branch not SENDING the fallback as a delta (the
 *     client builds the bubble from deltas only): test 4.
 *   - The renderer firing when no memory tool ran: test 2 (the control).
 *
 * Needs a loopback listener — run outside the sandbox:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/compassMemoryFallbackRoute.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";

const ALICE = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const CONV_ID = "cccc0000-cccc-4ccc-8ccc-000000000001";
const MEMORY = "33333333-0000-4000-8000-000000000001";
const CLAIM = 'Recorded: "Dragon Bridge fire show" — Da Nang, Vietnam, on 2026-03-04.';

function makeClient() {
  const db: Record<string, any[]> = {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    compass_conversations: [], compass_conversation_messages: [], compass_profiles: [], compass_user_preferences: [],
    user_hashtag_follows: [], profiles: [{ id: ALICE, handle: "alice" }], user_location_state: [], trips: [], blocks: [], user_follows: [],
    memories: [{
      id: MEMORY, owner_id: ALICE, title: "Dragon Bridge fire show", caption: null, visibility: "only_me",
      allowed_user_ids: [], hidden_user_ids: [], state: "published", trip_id: null, event_id: null, place_id: null,
      canonical_location_id: null, starts_at: "2026-03-04T13:00:00.000Z", ends_at: null,
      created_at: "2026-03-04T13:00:00.000Z", updated_at: "2026-03-04T13:00:00.000Z",
      location_city: "Da Nang", location_country: "Vietnam",
    }],
    memory_tags: [],
  };
  const inserts: Record<string, any[]> = {};
  function builder(table: string) {
    let rows = [...(db[table] ?? [])];
    let insertPayload: any = null;
    const b: any = {
      select: () => proxy,
      eq: (c: string, v: any) => { rows = rows.filter((r) => String(r[c]) === String(v)); return proxy; },
      neq: (c: string, v: any) => { rows = rows.filter((r) => String(r[c]) !== String(v)); return proxy; },
      in: (c: string, vs: any[]) => { rows = rows.filter((r) => vs.map(String).includes(String(r[c]))); return proxy; },
      is: (c: string, v: any) => { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return proxy; },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => {
        if (insertPayload !== null) {
          const row = { id: CONV_ID, ...insertPayload, created_at: new Date().toISOString(), last_active_at: new Date().toISOString() };
          (db[table] ??= []).push(row);
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      insert: (payload: any) => {
        insertPayload = Array.isArray(payload) ? payload[0] : payload;
        const row = { id: `row_${Math.random()}`, ...insertPayload, created_at: new Date().toISOString() };
        (inserts[table] ??= []).push(row);
        (db[table] ??= []).push(row);
        return proxy;
      },
      then: (resolve: any) => resolve({ data: rows, error: null, count: rows.length }),
    };
    // Every other builder method (order, limit, or, not, gte, update, upsert…) is a no-op that keeps chaining.
    const proxy: any = new Proxy(b, { get: (t, p) => (p in t ? t[p as string] : p === "catch" || p === "finally" ? undefined : () => proxy) });
    return proxy;
  }
  return {
    from: (table: string) => builder(table),
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => (token === "test-token" ? { data: { user: { id: ALICE } }, error: null } : { data: { user: null }, error: { message: "no" } }) },
    _inserts: inserts,
  } as any;
}

const toolCall = { id: "tc_1", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ city: "Da Nang" }) } };

/** Non-streamed: classifier answers; round 1 calls memory_search; every later main call does `after`. */
function nonStreamMock(after: "throw" | "empty", firstRound: "tool" | "throw" = "tool") {
  let main = 0;
  return {
    calls: () => main,
    mock: {
      chat: {
        completions: {
          create: async (opts: any) => {
            if (opts.max_completion_tokens === 256) return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "question", confidence: 0.9 }) } }] };
            main++;
            if (main === 1) {
              if (firstRound === "throw") throw new Error("model down before any tool");
              return { choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall] } }] };
            }
            if (after === "throw") throw new Error("model down after the tool round");
            return { choices: [{ message: { role: "assistant", content: null } }] };
          },
        },
      },
    },
  };
}

/** Streamed: round 1 streams a memory_search tool call; later rounds stream nothing, or throw. */
function streamMock(after: "empty" | "throw") {
  let main = 0;
  return {
    chat: {
      completions: {
        create: async (opts: any) => {
          if (!opts.stream) return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "question", confidence: 0.9 }) } }] };
          main++;
          const first = main === 1;
          if (!first && after === "throw") throw new Error("model down after the tool round");
          return {
            [Symbol.asyncIterator]: async function* () {
              if (first) yield { choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] };
            },
          };
        },
      },
    },
  };
}

let server: Server;
let port: number;

before(async () => {
  const { default: compassRouter } = await import("../routes/compass.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
});
after(() => { server.close(); _setTestClient(null as any, false); _setTestOpenAI(null); });
beforeEach(() => { invalidateFlagsCache(); _setTestClient(makeClient(), true); });
afterEach(() => { _setTestOpenAI(null); });

async function ask(body: Record<string, unknown>) {
  const r = await fetch(`http://127.0.0.1:${port}/api/compass/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

describe("H266 §28.17 — when the AI presentation fails, the Memory facts are rendered without a model", () => {
  it("1. the model throws after memory_search ran: the answer is the rendered Memory, not the outage sentence", async () => {
    const m = nonStreamMock("throw");
    _setTestOpenAI(m.mock as any);
    const { status, text } = await ask({ prompt: "What did I do in Da Nang?" });
    const body = JSON.parse(text);
    assert.equal(status, 200);
    assert.equal(m.calls(), 2, "fixture: the tool round must have happened before the failure");
    assert.equal(body.fallback, true);
    assert.equal(body.fallbackReason, "ai_error");
    assert.ok(String(body.message).includes(CLAIM), `the Memory the tool read was thrown away: ${body.message}`);
    assert.doesNotMatch(String(body.message), /temporarily unavailable/);
    assert.equal(body.renderer, "memory-fallback@1");
  });

  it("2. CONTROL — the model throws before any tool ran: the honest outage sentence, unchanged, and no renderer claimed", async () => {
    _setTestOpenAI(nonStreamMock("throw", "throw").mock as any);
    const body = JSON.parse((await ask({ prompt: "What did I do in Da Nang?" })).text);
    assert.equal(body.fallbackReason, "ai_error");
    assert.match(String(body.message), /temporarily unavailable/);
    assert.equal(body.renderer, undefined);
  });

  it("3. the model returns no text after memory_search: the rendered Memory, not 'had trouble putting them into words'", async () => {
    _setTestOpenAI(nonStreamMock("empty").mock as any);
    const body = JSON.parse((await ask({ prompt: "What did I do in Da Nang?" })).text);
    assert.ok(String(body.message).includes(CLAIM), `got: ${body.message}`);
    assert.doesNotMatch(String(body.message), /putting them into words/);
    assert.equal(body.renderer, "memory-fallback@1");
  });

  it("4. streamed, the final round is empty: the rendering is SENT as a delta (the client builds the bubble from deltas)", async () => {
    _setTestOpenAI(streamMock("empty") as any);
    const { text } = await ask({ prompt: "What did I do in Da Nang?", stream: true });
    const deltas = text.split("\n\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).filter((e) => typeof e.delta === "string").map((e) => e.delta).join("");
    assert.ok(deltas.includes(CLAIM), `the streamed bubble would be: ${JSON.stringify(deltas)}`);
    assert.ok(text.includes('"renderer":"memory-fallback@1"'));
  });

  it("5. streamed, the model throws after the tool round: the error event carries the rendering", async () => {
    _setTestOpenAI(streamMock("throw") as any);
    const { text } = await ask({ prompt: "What did I do in Da Nang?", stream: true });
    const err = text.split("\n\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.error === true);
    assert.ok(err, "no error event");
    assert.ok(String(err.message).includes(CLAIM), `got: ${err.message}`);
  });
});
