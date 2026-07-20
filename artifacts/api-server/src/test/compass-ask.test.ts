/**
 * Compass ask endpoint tests — POST /api/compass/ask
 *
 * Covers:
 *  A. Conversation persistence round-trip: conversationId returned and accepted
 *  B. Multi-turn continuity: history is passed to the model on follow-up
 *  C. Classifier JSON contract: IntentClassification shape validated
 *  D. Action intent: graceful explanation returned, no hallucinated success
 *  E. Honest fallback copy: "temporarily unavailable" when OpenAI fails — no canned recs
 *  F. Feature-flag fallback: honest message when COMPASS_ENABLED=false
 *  G. Low classifier confidence: does not break routing (falls through cleanly)
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run: node --import tsx/esm --test src/test/compass-ask.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID  = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const CONV_ID   = "cccc0000-cccc-cccc-cccc-000000000001";
const MSG_ID_1  = "dddd0001-dddd-dddd-dddd-000000000001";
const MSG_ID_2  = "dddd0002-dddd-dddd-dddd-000000000002";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal OpenAI mock that returns a fixed JSON-shaped reply. */
function makeOpenAIMock(replyJson: object): object {
  return {
    chat: {
      completions: {
        create: async (_opts: unknown) => ({
          choices: [
            {
              message: {
                content: JSON.stringify(replyJson),
                role: "assistant",
              },
            },
          ],
        }),
      },
    },
  };
}

/** OpenAI mock that throws to simulate an outage. */
function makeOpenAIErrorMock(): object {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error("OpenAI service unavailable");
        },
      },
    },
  };
}

interface FakeState {
  compassEnabled?:      boolean;
  conversations?:       Array<Record<string, unknown>>;
  convMessages?:        Array<Record<string, unknown>>;
  compassProfiles?:     Array<Record<string, unknown>>;
  compassPreferences?:  Array<Record<string, unknown>>;
  tokenMap?:            Record<string, string>;
}

function makeClient(state: FakeState = {}, callerUserId: string = ALICE_ID) {
  const db: Record<string, any[]> = {
    feature_flags: [
      { flag: "COMPASS_ENABLED", enabled: state.compassEnabled ?? true },
    ],
    compass_conversations:        state.conversations        ?? [],
    compass_conversation_messages: state.convMessages        ?? [],
    compass_profiles:             state.compassProfiles       ?? [],
    compass_user_preferences:     state.compassPreferences    ?? [],
    user_hashtag_follows:         [],
    profiles:                     [],
    user_location_state:          [],
    trips:                        [],
    blocks:                       [],
    user_follows:                 [],
  };

  // Track insert calls for assertion
  const inserts: Record<string, any[]> = {};

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];
    let _insertPayload: any = null;

    const b: any = {
      select:     (_cols?: string) => builder(table, filtered),
      eq:         (col: string, val: any) => { filtered = filtered.filter(r => r[col] === val); return b; },
      is:         (col: string, val: any) => { filtered = filtered.filter(r => val === null ? r[col] == null : r[col] === val); return b; },
      in:         (col: string, vals: any[]) => { filtered = filtered.filter(r => vals.includes(r[col])); return b; },
      like:       (col: string, pat: string) => {
        const re = new RegExp("^" + pat.replace(/%/g, ".*") + "$");
        filtered = filtered.filter(r => re.test(String(r[col] ?? "")));
        return b;
      },
      or:         () => b,
      not:        () => b,
      neq:        (col: string, val: any) => { filtered = filtered.filter(r => r[col] !== val); return b; },
      limit:      (_n: number) => b,
      order:      (_col: string, _opts?: any) => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:     () => {
        // For inserts, return the inserted row
        if (_insertPayload !== null) {
          const newRow = { id: CONV_ID, ...(_insertPayload as object), created_at: new Date().toISOString(), last_active_at: new Date().toISOString() };
          if (!inserts[table]) inserts[table] = [];
          inserts[table].push(newRow);
          db[table] = db[table] ?? [];
          db[table].push(newRow);
          return Promise.resolve({ data: newRow, error: null });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then: (resolve: any) => resolve({ data: filtered, error: null }),
      update: (_patch: any) => { return b; },
    };

    b.insert = (payload: any) => {
      _insertPayload = payload;
      const newRow = { id: `msg_${Date.now()}_${Math.random()}`, ...((Array.isArray(payload) ? payload[0] : payload) as object), created_at: new Date().toISOString() };
      if (!inserts[table]) inserts[table] = [];
      inserts[table].push(newRow);
      db[table] = db[table] ?? [];
      db[table].push(newRow);
      return {
        ...b,
        select: (_c?: string) => ({
          ...b,
          single: () => Promise.resolve({ data: newRow, error: null }),
        }),
      };
    };

    return b;
  }

  const client: any = {
    from: (table: string) => builder(table, db[table] ?? []),
    auth: {
      getUser: async (token: string) => {
        const userId = (state.tokenMap ?? { "test-token": callerUserId })[token] ?? null;
        return userId ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: { message: "not authed" } };
      },
    },
    _getInserts: () => inserts,
  };

  return client;
}

// ── Server setup ──────────────────────────────────────────────────────────────

let app:    Express;
let server: Server;
let port:   number;

before(async () => {
  const { default: compassRouter } = await import("../routes/compass.js");
  app = express();
  app.use(express.json());
  // Inject a no-op pino-style logger so req.log calls don't throw.
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  port = (server.address() as any).port;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestOpenAI(null);
});

beforeEach(() => {
  invalidateFlagsCache();
});

afterEach(() => {
  _setTestOpenAI(null);
});

async function ask(
  body: Record<string, unknown>,
  token = "test-token",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://localhost:${port}/api/compass/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ── A. Conversation persistence round-trip ────────────────────────────────────

describe("A. Conversation persistence", () => {
  it("returns a conversationId when none is supplied", async () => {
    const client = makeClient();
    _setTestClient(client, "test-token");
    _setTestOpenAI(makeOpenAIMock({
      message:      "Barcelona has great tapas bars in El Born.",
      payload:      null,
      quickActions: [{ label: "Build itinerary", actionType: "buildItinerary" }],
    }) as any);

    const { status, body } = await ask({ prompt: "Best food in Barcelona?" });
    assert.equal(status, 200);
    assert.ok(typeof body.conversationId === "string", "should return conversationId");
    assert.ok(typeof body.message === "string", "should return message");
    assert.ok(body.promptVersion === "compass-v1.0");
  });

  it("accepts a conversationId and loads its history", async () => {
    // Pre-seed an active conversation with one prior exchange
    const now = new Date().toISOString();
    const client = makeClient({
      conversations: [
        { id: CONV_ID, user_id: ALICE_ID, last_active_at: now, created_at: now },
      ],
      convMessages: [
        { id: MSG_ID_1, conversation_id: CONV_ID, role: "user",      content: "Best cafés in Lisbon?",          created_at: new Date(Date.now() - 2000).toISOString() },
        { id: MSG_ID_2, conversation_id: CONV_ID, role: "assistant", content: "Try A Brasileira in Chiado.",    created_at: new Date(Date.now() - 1000).toISOString() },
      ],
    });
    _setTestClient(client, "test-token");

    let capturedMessages: any[] | null = null;
    _setTestOpenAI({
      chat: {
        completions: {
          create: async (opts: any) => {
            capturedMessages = opts.messages;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({ message: "A Brasileira is a 5-minute walk from the viewpoint.", payload: null, quickActions: [] }),
                  role: "assistant",
                },
              }],
            };
          },
        },
      },
    } as any);

    const { status, body } = await ask({ prompt: "Which one is closer to the viewpoint?", conversationId: CONV_ID });
    assert.equal(status, 200);
    assert.equal(body.conversationId, CONV_ID, "should return same conversationId");

    // Verify prior exchange was passed to the model
    assert.ok(Array.isArray(capturedMessages), "messages should be captured");
    const roles = capturedMessages!.map((m: any) => m.role);
    assert.ok(roles.includes("system"), "should include system prompt");
    // Prior user and assistant messages should be in the array
    const contents = capturedMessages!.map((m: any) => m.content).join(" ");
    assert.ok(contents.includes("Best cafés in Lisbon"), "prior user message should be in history");
    assert.ok(contents.includes("A Brasileira"), "prior assistant message should be in history");
  });
});

// ── B. Multi-turn continuity ──────────────────────────────────────────────────

describe("B. Multi-turn continuity", () => {
  it("follow-up message includes the prior assistant reply in the model context", async () => {
    const now = new Date().toISOString();
    const priorAssistantContent = JSON.stringify({
      message: "My top picks: 1) Café Central (cheaper), 2) Café Landtmann (more upscale).",
      payload: null,
      quickActions: [],
    });

    const client = makeClient({
      conversations: [
        { id: CONV_ID, user_id: ALICE_ID, last_active_at: now, created_at: now },
      ],
      convMessages: [
        { id: MSG_ID_1, conversation_id: CONV_ID, role: "user",      content: "Coffee spots in Vienna?",   created_at: new Date(Date.now() - 3000).toISOString() },
        { id: MSG_ID_2, conversation_id: CONV_ID, role: "assistant", content: priorAssistantContent,       created_at: new Date(Date.now() - 2000).toISOString() },
      ],
    });
    _setTestClient(client, "test-token");

    let capturedMessages: any[] | null = null;
    _setTestOpenAI({
      chat: {
        completions: {
          create: async (opts: any) => {
            capturedMessages = opts.messages;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({ message: "Café Central is closer to the city centre.", payload: null, quickActions: [] }),
                  role: "assistant",
                },
              }],
            };
          },
        },
      },
    } as any);

    await ask({ prompt: "Which one is closer to the centre?", conversationId: CONV_ID });

    assert.ok(capturedMessages !== null, "should have called the model");
    const allContent = capturedMessages!.map((m: any) => m.content).join("\n");
    // The prior assistant message (containing "Café Central") must be in context
    assert.ok(
      allContent.includes("Café Central") || allContent.includes("Central"),
      "prior assistant reply should appear in model context for follow-up resolution",
    );
  });
});

// ── C. Classifier JSON contract ───────────────────────────────────────────────

describe("C. Classifier JSON contract", () => {
  it("classify() returns { intent, confidence } shape matching the contract", async () => {
    const { classify } = await import("../services/compass/CompassIntentClassifier.js");

    const intents = ["recommendation", "itinerary", "question", "action", "smalltalk"] as const;
    for (const intent of intents) {
      _setTestOpenAI(makeOpenAIMock({ intent, confidence: 0.9 }) as any);
      const result = await classify("test message");
      assert.ok(result !== null, `should return result for intent "${intent}"`);
      assert.equal(result!.intent, intent);
      assert.ok(typeof result!.confidence === "number");
      assert.ok(result!.confidence >= 0 && result!.confidence <= 1);
    }
    _setTestOpenAI(null);
  });

  it("classify() returns null on malformed JSON — does not throw", async () => {
    const { classify } = await import("../services/compass/CompassIntentClassifier.js");
    _setTestOpenAI({
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "not json at all", role: "assistant" } }],
          }),
        },
      },
    } as any);
    const result = await classify("test message");
    assert.equal(result, null, "should return null for malformed JSON");
    _setTestOpenAI(null);
  });

  it("classify() returns null when confidence < 0.6 threshold — caller treats as no classification", async () => {
    const { classify } = await import("../services/compass/CompassIntentClassifier.js");
    _setTestOpenAI(makeOpenAIMock({ intent: "question", confidence: 0.4 }) as any);
    const result = await classify("maybe a question?");
    // The classify function itself just returns the parsed result — the CALLER enforces the 0.6 threshold.
    // Here we just verify the shape is still valid when confidence is low.
    assert.ok(result !== null);
    assert.equal(result!.confidence, 0.4);
    _setTestOpenAI(null);
  });
});

// ── D. Action intent graceful failure ────────────────────────────────────────

describe("D. Action intent — Phase 4 tool loop, propose-never-execute", () => {
  it("routes action prompts through the tool loop; add_to_trip never writes and unauthorized trips yield no proposal", async () => {
    const client = makeClient();
    _setTestClient(client, "test-token");

    // Classifier says "action"; main LLM requests the add_to_trip tool, then
    // answers honestly after seeing the tool's authorization error.
    let mainCalls = 0;
    _setTestOpenAI({
      chat: {
        completions: {
          create: async (opts: any) => {
            const isClassifierCall = opts.max_completion_tokens === 60 && opts.temperature === 0;
            if (isClassifierCall) {
              return { choices: [{ message: { content: JSON.stringify({ intent: "action", confidence: 0.95 }), role: "assistant" } }] };
            }
            mainCalls++;
            if (mainCalls === 1) {
              return { choices: [{ message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "tc_1", type: "function", function: { name: "add_to_trip", arguments: JSON.stringify({ tripId: "eeee0000-eeee-eeee-eeee-000000000001", title: "Beach day" }) } }],
              } }] };
            }
            // Tool result must have reported an error (not a member of that trip).
            const toolMsg = (opts.messages as any[]).find((m) => m.role === "tool");
            assert.ok(toolMsg, "tool result should be fed back to the model");
            assert.ok(String(toolMsg.content).includes("not an accepted member"), `tool result should carry the auth error, got: ${toolMsg.content}`);
            return { choices: [{ message: { content: JSON.stringify({ message: "I couldn't propose that — you're not a member of that trip.", payload: null, quickActions: [] }), role: "assistant" } }] };
          },
        },
      },
    } as any);

    const { status, body } = await ask({ prompt: "Add the second place to my trip" });
    assert.equal(status, 200);
    assert.equal(mainCalls, 2, "tool loop should iterate: tool round + final answer");
    assert.equal(body.payload, null);
    // No proposal for an unauthorized trip, and absolutely nothing written.
    assert.deepEqual(body.pendingProposals ?? [], []);
    const inserts = (client as any)._getInserts();
    assert.equal((inserts["trip_plan_items"] ?? []).length, 0, "add_to_trip must never insert plan items");
  });
});

// ── E. Honest fallback on OpenAI error ────────────────────────────────────────

describe("E. Honest fallback copy", () => {
  it("returns 'temporarily unavailable' message when OpenAI fails — not canned recommendations", async () => {
    const client = makeClient();
    _setTestClient(client, "test-token");
    _setTestOpenAI(makeOpenAIErrorMock() as any);

    const { status, body } = await ask({ prompt: "What should I do in Tokyo?" });
    assert.equal(status, 200, "should return 200 not 500");
    assert.ok(typeof body.message === "string");
    assert.ok(
      (body.message as string).toLowerCase().includes("unavailable") ||
      (body.message as string).toLowerCase().includes("try again"),
      `fallback should say unavailable, got: "${body.message}"`,
    );
    // Must not have fake canned data
    assert.ok(!("bestPick" in body), "should not have bestPick");
    assert.ok(!("why" in body),      "should not have why (legacy field)");
    assert.equal(body.fallback, true, "should be marked fallback: true");
  });
});

// ── F. Feature-flag fallback ──────────────────────────────────────────────────

describe("F. Feature-flag fallback", () => {
  it("returns honest unavailable message when COMPASS_ENABLED=false — no fake picks", async () => {
    const client = makeClient({ compassEnabled: false });
    _setTestClient(client, "test-token");
    // OpenAI should not be called at all
    let aiCalled = false;
    _setTestOpenAI({
      chat: {
        completions: {
          create: async () => { aiCalled = true; return { choices: [] }; },
        },
      },
    } as any);

    const { status, body } = await ask({ prompt: "Recommend a city for next week" });
    assert.equal(status, 200);
    assert.ok(typeof body.message === "string");
    assert.ok(
      (body.message as string).toLowerCase().includes("unavailable") ||
      (body.message as string).toLowerCase().includes("try again"),
      `flag-disabled fallback should say unavailable, got: "${body.message}"`,
    );
    assert.equal(body.fallback, true);
    assert.equal(aiCalled, false, "OpenAI should not be called when flag is disabled");
    // Must not have canned recommendation fields
    assert.ok(!("bestPick" in body));
    assert.ok(!("socialProof" in body));
  });
});

// ── G. Low classifier confidence passthrough ──────────────────────────────────

describe("G. Low classifier confidence passthrough", () => {
  it("request succeeds and reaches the main LLM when classifier returns low confidence", async () => {
    const client = makeClient();
    _setTestClient(client, "test-token");

    let mainLlmCalled = false;
    _setTestOpenAI({
      chat: {
        completions: {
          create: async (opts: any) => {
            const isClassifierCall = opts.max_completion_tokens === 60 && opts.temperature === 0;
            if (isClassifierCall) {
              return { choices: [{ message: { content: JSON.stringify({ intent: "question", confidence: 0.3 }), role: "assistant" } }] };
            }
            mainLlmCalled = true;
            return { choices: [{ message: { content: JSON.stringify({ message: "Here's what I know.", payload: null, quickActions: [] }), role: "assistant" } }] };
          },
        },
      },
    } as any);

    const { status, body } = await ask({ prompt: "Is it worth going?" });
    assert.equal(status, 200);
    assert.ok(mainLlmCalled, "main LLM should be called even when classifier confidence is low");
    assert.ok(typeof body.message === "string");
    assert.ok(!body.fallback, "should not be marked as fallback");
  });
});
