/**
 * H266 — Compass renders the turn's Memory facts deterministically when the AI
 * presentation fails; the honest sentence only where there are no facts.
 *
 * census-highlights-memories H266 (§28.17 "always provide a deterministic
 * fallback renderer when AI presentation fails"). The pure renderer is
 * `compass/compassMemoryFallback.ts`; the route is `POST /api/compass/ask`.
 *
 * Run: node --import tsx/esm --test src/test/compassMemoryFallback.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import {
  COMPASS_MEMORY_FALLBACK_RENDERER,
  MAX_RENDERED_FACTS,
  compassAiFailureFallback,
  compassAiFailureFallbackWithRetrieval,
  memoryFactsFromToolLog,
  partialToolLogOf,
  renderCompassMemoryFallback,
  trackPartialToolLog,
} from "../compass/compassMemoryFallback.js";

const HONEST = "Compass AI assistant is temporarily unavailable. Please try again shortly.";

const fact = (id: string, claim: string) => ({
  memory_id: id,
  title: "<portava:ugc>x</portava:ugc>",
  historical: { truth_class: "historical", claim, establishes_current_status: false },
});

// ── The renderer ─────────────────────────────────────────────────────────────

describe("memoryFactsFromToolLog", () => {
  it("reads facts from the five fact-bearing Memory tools, in order, once each", () => {
    const facts = memoryFactsFromToolLog([
      { name: "memory_search", result: { memories: [fact("m1", "Recorded: \"A\" — Lisbon, Portugal, on 2026-03-02."), fact("m2", "Recorded: \"B\".")] } },
      { name: "memory_get", result: { memory: fact("m3", "Recorded: \"C\".") } },
      { name: "memory_get_shared", result: { memories: [fact("m1", "Recorded: \"A\" — Lisbon, Portugal, on 2026-03-02.")] } },
      { name: "memory_get_place_history", result: { visits: [fact("m4", "Recorded: \"D\".")] } },
      { name: "memory_get_trip_memories", result: { memories: [fact("m5", "Recorded: \"E\".")] } },
    ]);
    assert.deepEqual(facts.map((f) => f.memoryId), ["m1", "m2", "m3", "m4", "m5"]);
    assert.equal(facts[0]!.claim, "Recorded: \"A\" — Lisbon, Portugal, on 2026-03-02.");
  });

  it("drafts, corrections, evidence, refusals and other tools are not facts to present", () => {
    const facts = memoryFactsFromToolLog([
      { name: "memory_create_draft", result: { draft: { fields: { title: "x" } }, memory: fact("d1", "Recorded: \"draft\".") } },
      { name: "memory_suggest_correction", result: { memory_id: "c1", proposed_patch: {} } },
      { name: "memory_get_evidence", result: { memory_id: "e1", attached_artifacts: [] } },
      { name: "memory_search", result: { error: "The user's own Memories could not be read right now." } },
      { name: "search_places", result: { memories: [fact("p1", "Recorded: \"place\".")] } },
      { name: "memory_search", result: { memories: [{ memory_id: "noclaim" }, { historical: { claim: "no id" } }, null] } },
    ]);
    assert.deepEqual(facts, []);
  });
});

describe("renderCompassMemoryFallback / compassAiFailureFallback", () => {
  it("no facts: null, and the honest sentence comes back unchanged with no renderer tag", () => {
    assert.equal(renderCompassMemoryFallback([]), null);
    assert.deepEqual(compassAiFailureFallback([], HONEST), { message: HONEST });
  });

  it("facts: each claim verbatim on its own line, tagged with the renderer", () => {
    const log = [{ name: "memory_search", result: { memories: [fact("m1", "Recorded: \"Tram 28\" — Lisbon, Portugal, on 2026-03-02.")] } }];
    const r = compassAiFailureFallback(log, HONEST);
    assert.equal(r.fallbackRenderer, COMPASS_MEMORY_FALLBACK_RENDERER);
    assert.equal(r.memoryFactCount, 1);
    assert.ok(r.message.includes("\n• Recorded: \"Tram 28\" — Lisbon, Portugal, on 2026-03-02."), r.message);
    assert.ok(!r.message.includes("temporarily unavailable"));
  });

  it("caps the list and says how many more there are", () => {
    const many = Array.from({ length: MAX_RENDERED_FACTS + 3 }, (_, i) => fact(`m${i}`, `Recorded: "M${i}".`));
    const r = renderCompassMemoryFallback([{ name: "memory_search", result: { memories: many } }])!;
    assert.equal(r.factCount, MAX_RENDERED_FACTS + 3);
    assert.equal(r.text.split("\n").filter((l) => l.startsWith("• ")).length, MAX_RENDERED_FACTS);
    assert.ok(r.text.endsWith("…and 3 more."), r.text);
  });

  it("retrieval runs only when the turn read no fact, and a throwing retrieval is the honest sentence", async () => {
    const turn = [{ name: "memory_get", result: { memory: fact("m1", "Recorded: \"A\".") } }];
    let calls = 0;
    const r1 = await compassAiFailureFallbackWithRetrieval(turn, async () => { calls++; return { memories: [] }; }, HONEST);
    assert.equal(calls, 0, "the turn's own facts are rendered; nothing is re-read");
    assert.ok(r1.message.includes("Recorded: \"A\"."));
    const r2 = await compassAiFailureFallbackWithRetrieval([], async () => ({ memories: [fact("m2", "Recorded: \"B\".")] }), HONEST);
    assert.equal(r2.fallbackRenderer, COMPASS_MEMORY_FALLBACK_RENDERER);
    assert.ok(r2.message.includes("• Recorded: \"B\"."));
    assert.deepEqual(await compassAiFailureFallbackWithRetrieval([], async () => { throw new Error("db down"); }, HONEST), { message: HONEST });
    assert.deepEqual(await compassAiFailureFallbackWithRetrieval([], async () => ({ error: "unreadable" }), HONEST), { message: HONEST });
  });

  it("the partial log is the array the loop was given, per key", () => {
    const a = {};
    const b = {};
    const logA = trackPartialToolLog<{ name: string; result: unknown }>(a);
    logA.push({ name: "memory_get", result: { memory: fact("m1", "Recorded: \"A\".") } });
    trackPartialToolLog(b);
    assert.equal(partialToolLogOf(a).length, 1);
    assert.equal(partialToolLogOf(b).length, 0);
    assert.deepEqual(partialToolLogOf({}), []);
  });
});

// ── The route ────────────────────────────────────────────────────────────────

const ALICE = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const BOB = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002";
const CONV = "cccc0000-cccc-4ccc-8ccc-000000000001";

function makeClient(extra: Record<string, any[]> = {}) {
  const db: Record<string, any[]> = {
    ...extra,
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    memories: [
      { id: "11111111-1111-4111-8111-111111111111", owner_id: ALICE, title: "Tram 28 at dusk", caption: null, visibility: "private",
        allowed_user_ids: null, hidden_user_ids: null, state: "published", location_city: "Lisbon", location_country: "Portugal",
        starts_at: "2026-03-02T18:00:00Z", ends_at: null, created_at: "2026-03-02T19:00:00Z", trip_id: null, place_id: null, event_id: null },
      { id: "22222222-2222-4222-8222-222222222222", owner_id: BOB, title: "Bob's Lisbon secret", caption: null, visibility: "private",
        allowed_user_ids: null, hidden_user_ids: null, state: "published", location_city: "Lisbon", location_country: "Portugal",
        starts_at: "2026-03-03T18:00:00Z", ends_at: null, created_at: "2026-03-03T19:00:00Z", trip_id: null, place_id: null, event_id: null },
    ],
  };
  function chain(table: string) {
    let rows = [...(db[table] ?? [])];
    let ins: any = null;
    const b: any = {
      select: () => b,
      eq: (k: string, v: any) => { rows = rows.filter((r) => r[k] === v); return b; },
      neq: (k: string, v: any) => { rows = rows.filter((r) => r[k] !== v); return b; },
      in: (k: string, vs: any[]) => { rows = rows.filter((r) => vs.includes(r[k])); return b; },
      is: (k: string, v: any) => { rows = rows.filter((r) => (v === null ? r[k] == null : r[k] === v)); return b; },
      not: () => b, or: () => b, like: () => b, ilike: () => b, gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      order: () => b, limit: () => b, range: () => b, contains: () => b, overlaps: () => b,
      insert: (p: any) => { ins = Array.isArray(p) ? p[0] : p; (db[table] ??= []).push({ id: CONV, ...ins }); return b; },
      update: () => b, upsert: () => b, delete: () => b,
      maybeSingle: () => Promise.resolve({ data: ins ? { id: CONV, ...ins } : rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: ins ? { id: CONV, ...ins } : rows[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(res, rej),
    };
    return b;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: { id: ALICE } }, error: null }) },
  };
}

/** Classifier answers; main round 1 calls memory_search; every later main call does `later`. */
function model(later: "throw" | "empty", toolQuery = "Lisbon tram") {
  let main = 0;
  return {
    chat: {
      completions: {
        create: async (opts: any) => {
          if (opts.max_completion_tokens === 256) {
            return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "question", confidence: 0.9 }) } }] };
          }
          main++;
          if (main === 1 && toolQuery) {
            return { choices: [{ message: { role: "assistant", content: null,
              tool_calls: [{ id: "tc1", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: toolQuery }) } }] } }] };
          }
          if (later === "throw") throw new Error("model unavailable");
          return { choices: [{ message: { role: "assistant", content: null } }] };
        },
      },
    },
  };
}

describe("POST /api/compass/ask — the AI fails after the Memory facts were read", () => {
  let server: Server;
  let port = 0;
  before(async () => {
    const { default: compassRouter } = await import("../routes/compass.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = { info() {}, error() {}, warn() {}, debug() {} }; next(); });
    app.use("/api", compassRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as any).port;
  });
  after(() => { server.close(); _setTestClient(null as any, false); _setTestOpenAI(null); });
  beforeEach(() => { invalidateFlagsCache(); _setTestClient(makeClient() as any, true); });
  afterEach(() => { _setTestOpenAI(null); });

  async function ask(prompt = "When did I ride the tram in Lisbon?"): Promise<Record<string, any>> {
    const r = await fetch(`http://127.0.0.1:${port}/api/compass/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ prompt }),
    });
    assert.equal(r.status, 200);
    return (await r.json()) as Record<string, any>;
  }

  it("a model failure after memory_search renders the facts the tool returned, not the outage sentence", async () => {
    _setTestOpenAI(model("throw") as any);
    const body = await ask();
    assert.equal(body.fallback, true);
    assert.equal(body.fallbackReason, "ai_error");
    assert.equal(body.fallbackRenderer, COMPASS_MEMORY_FALLBACK_RENDERER);
    assert.ok(String(body.message).includes("• Recorded: \"Tram 28 at dusk\" — Lisbon, Portugal, on 2026-03-02."), body.message);
    assert.ok(!String(body.message).includes("temporarily unavailable"));
  });

  it("the turn's OWN facts are rendered even when the question alone would find none", async () => {
    // The model searched "tram"; the question shares no token with the Memory,
    // so only the facts the failed turn had read can produce this answer.
    _setTestOpenAI(model("throw", "tram") as any);
    const body = await ask("What did I do that evening?");
    assert.equal(body.fallbackRenderer, COMPASS_MEMORY_FALLBACK_RENDERER);
    assert.ok(String(body.message).includes("• Recorded: \"Tram 28 at dusk\""), body.message);
  });

  it("renders only what the tool was allowed to return: another person's private Memory is never in it", async () => {
    _setTestOpenAI(model("throw", "Lisbon secret") as any);
    const body = await ask();
    assert.ok(!String(body.message).includes("Bob"), body.message);
  });

  it("the model failed before reading any Memory: the fallback reads them itself, deterministically, from the question", async () => {
    _setTestOpenAI(model("throw", "") as any);
    const body = await ask();
    assert.equal(body.fallbackReason, "ai_error");
    assert.equal(body.fallbackRenderer, COMPASS_MEMORY_FALLBACK_RENDERER);
    assert.ok(String(body.message).includes("• Recorded: \"Tram 28 at dusk\" — Lisbon, Portugal, on 2026-03-02."), body.message);
  });

  it("no Memory matches the question: the honest sentence, with no renderer tag", async () => {
    _setTestOpenAI(model("throw", "") as any);
    const body = await ask("Best ramen in Osaka?");
    assert.equal(body.message, HONEST);
    assert.equal(body.fallbackRenderer, undefined);
  });

  it("the model's search found nothing and the question matches nothing: the honest sentence", async () => {
    _setTestOpenAI(model("throw", "Kyoto temple") as any);
    const body = await ask("Kyoto temple visit?");
    assert.equal(body.message, HONEST);
  });

  it("the fallback's own read honours the owner's controls: a DO_NOT_RESURFACE Memory is not rendered", async () => {
    _setTestClient(makeClient({ memory_resurfacing_preferences: [
      { owner_id: ALICE, memory_id: "11111111-1111-4111-8111-111111111111", control: "DO_NOT_RESURFACE" },
    ] }) as any, true);
    _setTestOpenAI(model("throw", "") as any);
    const body = await ask();
    assert.equal(body.message, HONEST, body.message);
  });

  it("streaming: a model failure after memory_search sends the rendered facts on the error event", async () => {
    let main = 0;
    _setTestOpenAI({
      chat: {
        completions: {
          create: async (opts: any) => {
            if (!opts.stream) return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "question", confidence: 0.9 }) } }] };
            main++;
            if (main > 1) throw new Error("model unavailable");
            return {
              [Symbol.asyncIterator]: async function* () {
                yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "memory_search", arguments: JSON.stringify({ query: "Lisbon tram" }) } }] } }] };
              },
            };
          },
        },
      },
    } as any);
    const r = await fetch(`http://127.0.0.1:${port}/api/compass/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ prompt: "When did I ride the tram in Lisbon?", stream: true }),
    });
    const events = (await r.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    const err = events.find((e) => e.error === true);
    assert.ok(err, JSON.stringify(events));
    assert.equal(err.fallbackRenderer, COMPASS_MEMORY_FALLBACK_RENDERER);
    assert.ok(String(err.message).includes("• Recorded: \"Tram 28 at dusk\""), err.message);
  });

  it("streaming: the model answered with no text after reading Memories: the done event carries the facts", async () => {
    let main = 0;
    _setTestOpenAI({
      chat: {
        completions: {
          create: async (opts: any) => {
            if (!opts.stream && opts.max_completion_tokens === 256) return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "question", confidence: 0.9 }) } }] };
            main++;
            const first = main === 1;
            if (!opts.stream) return { choices: [{ message: { role: "assistant", content: null } }] };
            return {
              [Symbol.asyncIterator]: async function* () {
                if (first) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "memory_search", arguments: JSON.stringify({ query: "Lisbon tram" }) } }] } }] };
              },
            };
          },
        },
      },
    } as any);
    const r = await fetch(`http://127.0.0.1:${port}/api/compass/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ prompt: "When did I ride the tram in Lisbon?", stream: true }),
    });
    const events = (await r.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    const done = events.find((e) => e.done === true);
    assert.ok(done, JSON.stringify(events));
    assert.ok(String(done.message).includes("• Recorded: \"Tram 28 at dusk\""), done.message);
  });

  it("the model answered with no text after reading Memories: the facts, not 'had trouble putting them into words'", async () => {
    _setTestOpenAI(model("empty") as any);
    const body = await ask();
    assert.ok(String(body.message).includes("• Recorded: \"Tram 28 at dusk\""), body.message);
    assert.ok(!String(body.message).includes("putting them into words"));
  });
});
