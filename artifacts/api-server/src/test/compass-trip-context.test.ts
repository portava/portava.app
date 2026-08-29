/**
 * Compass trip context + classifier routing tests — POST /api/compass/ask
 *
 * Covers:
 *  A. Active trip with 2 plan items today → model request context carries the
 *     "[Trip context]" block with "Active trip:" and both item titles
 *  B. No trips → no "[Trip context]" marker in the model request
 *  C. Trips query throws → request still succeeds, no trip block (fail-soft)
 *  D. Classifier {intent:"itinerary", confidence:0.9} → itinerary branch taken
 *     (itinerary directive injected; itinerary payload returned)
 *  E. Classifier confidence 0.3 → plain conversation path (no directive)
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run: node --import tsx/esm --test src/test/compass-trip-context.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const CONV_ID  = "cccc0000-cccc-cccc-cccc-000000000001";
const TRIP_ID  = "eeee0000-eeee-eeee-eeee-000000000001";

/** Distinctive prefix of the itinerary directive injected by the /ask route. */
const ITINERARY_DIRECTIVE_MARKER = "The user is asking for an itinerary";

// ── Date helpers (UTC, matching the module's no-timezone fallback) ────────────

const DAY_MS = 86_400_000;
const todayYmd = () => new Date().toISOString().slice(0, 10);
const ymdPlus  = (days: number) =>
  new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  compassEnabled?: boolean;
  trips?:          Array<Record<string, unknown>>;
  tripMembers?:    Array<Record<string, unknown>>;
  tripPlanItems?:  Array<Record<string, unknown>>;
  /** Tables whose from() call throws synchronously (error-path testing). */
  throwTables?:    string[];
}

function makeClient(state: FakeState = {}, callerUserId: string = ALICE_ID) {
  const db: Record<string, any[]> = {
    feature_flags: [
      { flag: "COMPASS_ENABLED", enabled: state.compassEnabled ?? true },
    ],
    compass_conversations:         [],
    compass_conversation_messages: [],
    compass_profiles:              [],
    compass_user_preferences:      [],
    user_hashtag_follows:          [],
    profiles:                      [],
    user_location_state:           [],
    trips:                         state.trips         ?? [],
    trip_members:                  state.tripMembers   ?? [],
    trip_plan_items:               state.tripPlanItems ?? [],
    blocks:                        [],
    user_follows:                  [],
  };

  const throwTables = new Set(state.throwTables ?? []);

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
      gte:        () => b,
      lte:        () => b,
      gt:         () => b,
      lt:         () => b,
      ilike:      () => b,
      contains:   () => b,
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
    from: (table: string) => {
      if (throwTables.has(table)) throw new Error(`fake client: ${table} unavailable`);
      return builder(table, db[table] ?? []);
    },
    auth: {
      getUser: async (token: string) => {
        return token === "test-token"
          ? { data: { user: { id: callerUserId } }, error: null }
          : { data: { user: null }, error: { message: "not authed" } };
      },
    },
    _getInserts: () => inserts,
  };

  return client;
}

// ── OpenAI mock with model-request capture ────────────────────────────────────

interface Capture {
  /** Messages of the LAST main-model call (classifier calls excluded). */
  mainMessages: any[] | null;
  mainCalls:    number;
}

/**
 * Classifier calls (max_completion_tokens=256) get the supplied
 * intent reply; main-model calls are captured and answered with mainReply.
 */
function makeCapturingOpenAI(
  capture:    Capture,
  intent:     { intent: string; confidence: number },
  mainReply:  object,
): object {
  return {
    chat: {
      completions: {
        create: async (opts: any) => {
          const isClassifierCall = opts.max_completion_tokens === 256;
          if (isClassifierCall) {
            return { choices: [{ message: { content: JSON.stringify(intent), role: "assistant" } }] };
          }
          capture.mainCalls++;
          capture.mainMessages = opts.messages;
          return { choices: [{ message: { content: JSON.stringify(mainReply), role: "assistant" } }] };
        },
      },
    },
  };
}

function joinedContent(messages: any[] | null): string {
  return (messages ?? []).map((m: any) => String(m.content ?? "")).join("\n");
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
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
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
  const r = await fetch(`http://127.0.0.1:${port}/api/compass/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ── A. Active trip grounding ──────────────────────────────────────────────────

describe("A. Active trip grounding in /ask context", () => {
  it("injects [Trip context] with the active trip headline and today's item titles", async () => {
    const today = todayYmd();
    const client = makeClient({
      trips: [{
        id: TRIP_ID,
        owner_id: ALICE_ID,
        title: "Barcelona Summer",
        destination_city: "Barcelona",
        destination_country: "Spain",
        status: "active",
        start_date: ymdPlus(-1),
        end_date: ymdPlus(2),
        timezone: null,
      }],
      tripPlanItems: [
        { id: "i1", trip_id: TRIP_ID, title: "Sagrada Familia tour",  day_date: today, status: "confirmed", starts_at: `${today}T09:00:00.000Z`, sort_order: 1, removed_at: null },
        { id: "i2", trip_id: TRIP_ID, title: "Tapas crawl in El Born", day_date: today, status: "tentative", starts_at: null,                     sort_order: 2, removed_at: null },
      ],
    });
    _setTestClient(client, true);

    const capture: Capture = { mainMessages: null, mainCalls: 0 };
    _setTestOpenAI(makeCapturingOpenAI(
      capture,
      { intent: "question", confidence: 0.9 },
      { message: "You're mid-trip — start with the Sagrada Familia.", payload: null, quickActions: [] },
    ) as any);

    const { status, body } = await ask({ prompt: "What should I do first today?" });
    assert.equal(status, 200);
    assert.ok(typeof body.message === "string");

    const ctx = joinedContent(capture.mainMessages);
    assert.ok(ctx.includes("[Trip context]"), "model request should carry the [Trip context] marker");
    assert.ok(ctx.includes("Active trip:"), "model request should carry the Active trip line");
    // The trip title is UGC (a co-member can set it), so it must reach the prompt
    // wrapped in <portava:ugc> — not as bare, trustable text.
    assert.ok(ctx.includes('"<portava:ugc>Barcelona Summer</portava:ugc>" in Barcelona, Spain'), "trip title should be UGC-wrapped in the headline");
    assert.ok(ctx.includes("day 2 of 4"), "headline should carry day N of M");
    assert.ok(ctx.includes("Sagrada Familia tour"),  "today's first item title should be in context");
    assert.ok(ctx.includes("Tapas crawl in El Born"), "today's second item title should be in context");
    assert.ok(ctx.includes("Today's plan:"), "today's plan line should be present");
    assert.ok(ctx.includes("(09:00)"), "timed item should carry its HH:MM");
  });
});

// ── B. No trips → no trip block ───────────────────────────────────────────────

describe("B. No trips", () => {
  it("omits the [Trip context] marker entirely when the user has no trips", async () => {
    const client = makeClient(); // empty trips / members / items
    _setTestClient(client, true);

    const capture: Capture = { mainMessages: null, mainCalls: 0 };
    _setTestOpenAI(makeCapturingOpenAI(
      capture,
      { intent: "question", confidence: 0.9 },
      { message: "Lisbon is lovely in October.", payload: null, quickActions: [] },
    ) as any);

    const { status, body } = await ask({ prompt: "Is Lisbon nice in October?" });
    assert.equal(status, 200);
    assert.ok(typeof body.message === "string");
    assert.ok(capture.mainMessages !== null, "main model should be called");

    const ctx = joinedContent(capture.mainMessages);
    assert.ok(!ctx.includes("[Trip context]"), "no [Trip context] marker without trips");
  });
});

// ── C. Trips query throws → fail-soft ─────────────────────────────────────────

describe("C. Trips query failure is fail-soft", () => {
  it("request still succeeds with no trip block when the trips table throws", async () => {
    const client = makeClient({ throwTables: ["trips", "trip_members"] });
    _setTestClient(client, true);

    const capture: Capture = { mainMessages: null, mainCalls: 0 };
    _setTestOpenAI(makeCapturingOpenAI(
      capture,
      { intent: "question", confidence: 0.9 },
      { message: "Here's what I know.", payload: null, quickActions: [] },
    ) as any);

    const { status, body } = await ask({ prompt: "Any tips for tomorrow?" });
    assert.equal(status, 200, "trip-context failure must never break /ask");
    assert.ok(typeof body.message === "string");
    assert.ok(!body.fallback, "should not degrade to the fallback reply");
    assert.ok(capture.mainMessages !== null, "main model should still be called");

    const ctx = joinedContent(capture.mainMessages);
    assert.ok(!ctx.includes("[Trip context]"), "no trip block when the trips query throws");
  });
});

// ── D. Classifier decides: itinerary at high confidence ───────────────────────

describe("D. Itinerary intent at confidence 0.9 takes the itinerary branch", () => {
  it("injects the itinerary directive and returns the itinerary payload", async () => {
    const client = makeClient();
    _setTestClient(client, true);

    const capture: Capture = { mainMessages: null, mainCalls: 0 };
    _setTestOpenAI(makeCapturingOpenAI(
      capture,
      { intent: "itinerary", confidence: 0.9 },
      {
        message: "Here's a two-day Barcelona plan.",
        payload: {
          type: "itinerary",
          destination: "Barcelona",
          days: [
            { label: "Day 1", highlights: ["Gothic Quarter", "Barceloneta"] },
            { label: "Day 2", highlights: ["Park Güell", "Gràcia"] },
          ],
        },
        quickActions: [],
      },
    ) as any);

    const { status, body } = await ask({ prompt: "Plan me two days in Barcelona" });
    assert.equal(status, 200);

    // The itinerary branch is taken: directive present as a system message.
    assert.ok(capture.mainMessages !== null, "main model should be called");
    const directiveMsg = (capture.mainMessages ?? []).find(
      (m: any) => m.role === "system" && String(m.content ?? "").includes(ITINERARY_DIRECTIVE_MARKER),
    );
    assert.ok(directiveMsg, "itinerary directive should be injected as a system message");

    // And the itinerary payload path is returned to the client.
    assert.ok(body.payload && (body.payload as any).type === "itinerary", "payload should be an itinerary");
    assert.equal((body.intent as any)?.intent, "itinerary", "classified intent is returned for observability");
  });
});

// ── E. Low confidence → plain conversation path ───────────────────────────────

describe("E. Itinerary intent at confidence 0.3 falls through to conversation", () => {
  it("does not inject the itinerary directive at low confidence", async () => {
    const client = makeClient();
    _setTestClient(client, true);

    const capture: Capture = { mainMessages: null, mainCalls: 0 };
    _setTestOpenAI(makeCapturingOpenAI(
      capture,
      { intent: "itinerary", confidence: 0.3 },
      { message: "Happy to help — what kind of days do you enjoy?", payload: null, quickActions: [] },
    ) as any);

    const { status, body } = await ask({ prompt: "Maybe plan something?" });
    assert.equal(status, 200);
    assert.ok(typeof body.message === "string");
    assert.ok(!body.fallback, "should not be marked fallback");
    assert.ok(capture.mainMessages !== null, "main model should be called (normal loop)");

    const ctx = joinedContent(capture.mainMessages);
    assert.ok(
      !ctx.includes(ITINERARY_DIRECTIVE_MARKER),
      "itinerary directive must NOT be injected below the confidence threshold",
    );
    assert.equal(body.payload, null, "plain conversation reply carries no payload");
  });
});
