/**
 * Compass Phase 4 — tool calling tests.
 *
 * Covers:
 *  A. Privacy guards: sanitizeToolResult strips coordinates and private keys
 *  B. search_places: candidates are DB-backed, coordinate-free, honest when empty
 *  C. search_events: blocked hosts filtered out
 *  D. get_circle_activity: permission-gated (no circles → honest empty)
 *  E. check_trip_conflicts: overlap detection
 *  F. add_to_trip: proposal only — no write; authorization enforced
 *  G. /compass/ask loop: tool calls + results persisted in message payload,
 *     pendingProposals surfaced on the response
 *  H. Confirmation flow: confirm executes exactly once (re-authorized),
 *     decline never writes, double-resolve is rejected
 *
 * Runtime: node:test. Run: node --import tsx/esm --test src/test/compass-tools.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import {
  executeCompassTool,
  sanitizeToolResult,
  COMPASS_TOOL_DEFINITIONS,
} from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID   = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const TRIP_ID  = "eeee0000-eeee-eeee-eeee-000000000001";
const PLACE_ID = "f0f0f0f0-ffff-ffff-ffff-000000000001";
const CONV_ID  = "cccc0000-cccc-cccc-cccc-000000000001";

function profileFor(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId: ALICE_ID,
    blockedUserIds: [],
    blockerUserIds: [],
    mutedUserIds: [],
    ...overrides,
  } as unknown as CompassProfile;
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

type Db = Record<string, any[]>;

function makeDb(overrides: Db = {}): Db {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    compass_conversations: [],
    compass_conversation_messages: [],
    compass_profiles: [],
    compass_user_preferences: [],
    user_hashtag_follows: [],
    profiles: [],
    user_location_state: [],
    trips: [],
    trip_members: [],
    trip_plan_items: [],
    discovery_places: [],
    events: [],
    circles: [],
    circle_memberships: [],
    blocks: [],
    user_follows: [],
    user_interactions: [],
    ...overrides,
  };
}

function makeClient(db: Db) {
  const inserts: Record<string, any[]> = {};

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];
    let inserted: any = null;

    const likeFilter = (col: string, pat: string) => {
      const re = new RegExp("^" + String(pat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
      filtered = filtered.filter((r) => re.test(String(r[col] ?? "")));
    };

    const b: any = {
      select: (_c?: string) => b,
      eq:  (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in:  (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      is:  (col: string, val: any) => { filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      gte: (col: string, val: any) => { filtered = filtered.filter((r) => String(r[col] ?? "") >= String(val)); return b; },
      lte: (col: string, val: any) => { filtered = filtered.filter((r) => String(r[col] ?? "") <= String(val)); return b; },
      ilike: (col: string, pat: string) => { likeFilter(col, pat); return b; },
      like:  (col: string, pat: string) => { likeFilter(col, pat); return b; },
      or:  (_expr: string) => b, // free-text OR is a no-op in the fake — rows pass through
      not: () => b,
      order: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve(
        inserted !== null
          ? { data: inserted, error: null }
          : { data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } },
      ),
      then: (resolve: any) => resolve({ data: filtered, error: null }),
      update: () => b,
      insert: (payload: any) => {
        const row = { id: `row_${Math.random().toString(36).slice(2)}`, ...(Array.isArray(payload) ? payload[0] : payload), created_at: new Date().toISOString(), last_active_at: new Date().toISOString() };
        inserted = row;
        (inserts[table] ??= []).push(row);
        (db[table] ??= []).push(row);
        return b;
      },
    };
    return b;
  }

  return {
    from: (table: string) => builder(table, db[table] ?? []),
    auth: {
      getUser: async (token: string) =>
        token === "test-token"
          ? { data: { user: { id: ALICE_ID } }, error: null }
          : { data: { user: null }, error: { message: "not authed" } },
    },
    _getInserts: () => inserts,
  } as any;
}

// ── A. sanitizeToolResult ─────────────────────────────────────────────────────

describe("A. Privacy guard — sanitizeToolResult", () => {
  it("strips coordinate and private keys recursively", () => {
    const dirty = {
      name: "Cafe",
      lat: 10.3, lng: 123.9, latitude: 1, longitude: 2, location_lat: 3,
      email: "x@y.z", phone: "123", address: "Exact St 4", notes: "secret",
      host_id: BOB_ID, owner_id: BOB_ID,
      nested: [{ title: "ok", lng: 5, expo_push_token: "tok" }],
    };
    const clean = sanitizeToolResult(dirty) as any;
    assert.equal(clean.name, "Cafe");
    for (const k of ["lat", "lng", "latitude", "longitude", "location_lat", "email", "phone", "address", "notes", "host_id", "owner_id"]) {
      assert.ok(!(k in clean), `${k} should be stripped`);
    }
    assert.equal(clean.nested[0].title, "ok");
    assert.ok(!("lng" in clean.nested[0]));
    assert.ok(!("expo_push_token" in clean.nested[0]));
  });
});

// ── B–F. Tool executor ────────────────────────────────────────────────────────

describe("B. search_places", () => {
  it("returns DB-backed candidates with no coordinates", async () => {
    const db = makeDb({
      discovery_places: [
        { id: PLACE_ID, name: "Lantaw Cafe", category: "cafe", city: "Cebu", neighborhood: "Busay", rating: 4.6, verified: true, blurb: "views", lat: 10.35, lng: 123.87 },
      ],
    });
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "search_places", { city: "Cebu" });
    assert.equal(result.candidates.length, 1);
    const c = result.candidates[0];
    assert.equal(c.id, PLACE_ID);
    assert.ok(c.name.includes("Lantaw Cafe"), "name should be present (UGC-wrapped)");
    assert.ok(c.name.startsWith("<portava:ugc>"), "UGC text must be delimiter-wrapped");
    assert.ok(!("lat" in c) && !("lng" in c), "coordinates must never reach the model");
  });

  it("returns an honest empty result when nothing matches", async () => {
    const result: any = await executeCompassTool(makeClient(makeDb()), ALICE_ID, profileFor(), "search_places", { city: "Nowhere" });
    assert.deepEqual(result.candidates, []);
    assert.ok(String(result.info).toLowerCase().includes("no matching"), "must say honestly that nothing was found");
  });
});

describe("C. search_events", () => {
  it("filters out events hosted by blocked users", async () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    const db = makeDb({
      events: [
        { id: "ev1", title: "Beach cleanup", city: "Cebu", country: "PH", starts_at: future, category: "outdoors", host_id: BOB_ID, state: "published", visibility: "public" },
        { id: "ev2", title: "Food crawl", city: "Cebu", country: "PH", starts_at: future, category: "food", host_id: "safe-host", state: "published", visibility: "public" },
      ],
    });
    const profile = profileFor({ blockedUserIds: [BOB_ID] });
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profile, "search_events", { city: "Cebu" });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].id, "ev2");
    assert.ok(!("host_id" in result.candidates[0]), "host_id must not reach the model");
  });
});

describe("D. get_circle_activity", () => {
  it("returns an honest empty result when the user has no circles", async () => {
    const result: any = await executeCompassTool(makeClient(makeDb()), ALICE_ID, profileFor(), "get_circle_activity", {});
    assert.deepEqual(result.circles, []);
    assert.ok(String(result.info).length > 0);
  });

  it("only returns circles the user owns or belongs to, with members block-filtered", async () => {
    const db = makeDb({
      circles: [
        { id: "c1", name: "Cebu crew", owner_id: ALICE_ID },
        { id: "c2", name: "Not my circle", owner_id: "stranger" },
      ],
      circle_memberships: [
        { user_id: ALICE_ID, other_id: BOB_ID, status: "accepted" },
        { user_id: ALICE_ID, other_id: "friend-1", status: "accepted" },
      ],
      profiles: [
        { id: BOB_ID, handle: "bob" },
        { id: "friend-1", handle: "friendly" },
      ],
    });
    const profile = profileFor({ blockedUserIds: [BOB_ID] });
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profile, "get_circle_activity", {});
    assert.equal(result.circles.length, 1, "stranger's circle must not appear");
    assert.deepEqual(result.circles[0].memberHandles, ["@friendly"], "blocked member must be filtered");
  });
});

describe("E. check_trip_conflicts", () => {
  it("detects an overlapping trip", async () => {
    const db = makeDb({
      trips: [{ id: TRIP_ID, owner_id: ALICE_ID, title: "Cebu trip", destination_city: "Cebu", start_date: "2026-08-01", end_date: "2026-08-07", status: "upcoming" }],
    });
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "check_trip_conflicts", { startDate: "2026-08-05", endDate: "2026-08-10" });
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].id, TRIP_ID);
  });

  it("returns an honest empty result when nothing overlaps", async () => {
    const result: any = await executeCompassTool(makeClient(makeDb()), ALICE_ID, profileFor(), "check_trip_conflicts", { startDate: "2026-08-05" });
    assert.deepEqual(result.conflicts, []);
  });
});

describe("F. add_to_trip — proposal only", () => {
  function tripDb(): Db {
    return makeDb({
      trips: [{ id: TRIP_ID, owner_id: ALICE_ID, title: "Cebu trip", plan_edit_permission: "all_members", status: "upcoming" }],
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner", status: "accepted" }],
      discovery_places: [{ id: PLACE_ID, name: "Lantaw Cafe", category: "cafe", city: "Cebu", lat: 10.35, lng: 123.87 }],
    });
  }

  it("returns a pending proposal and writes nothing", async () => {
    const db = tripDb();
    const client = makeClient(db);
    const result: any = await executeCompassTool(client, ALICE_ID, profileFor(), "add_to_trip", { tripId: TRIP_ID, placeId: PLACE_ID });
    assert.ok(result.proposal, "should return a proposal");
    assert.equal(result.proposal.status, "pending_confirmation");
    assert.equal(result.proposal.tripId, TRIP_ID);
    assert.equal(result.proposal.placeId, PLACE_ID);
    assert.equal(result.proposal.title, "Lantaw Cafe");
    assert.deepEqual(client._getInserts()["trip_plan_items"] ?? [], [], "PROPOSE ONLY — no write");
  });

  it("refuses when the user is not a trip member", async () => {
    const db = tripDb();
    db.trip_members = [];
    db.trips[0].owner_id = "someone-else";
    const client = makeClient(db);
    const result: any = await executeCompassTool(client, ALICE_ID, profileFor(), "add_to_trip", { tripId: TRIP_ID, title: "Beach" });
    assert.ok(result.error, "must refuse");
    assert.ok(!result.proposal);
  });

  it("refuses a fabricated placeId — candidates must be DB-backed", async () => {
    const db = tripDb();
    const client = makeClient(db);
    const result: any = await executeCompassTool(client, ALICE_ID, profileFor(), "add_to_trip", { tripId: TRIP_ID, placeId: "11111111-2222-3333-4444-555555555555" });
    assert.ok(String(result.error).includes("Place not found"));
  });
});

// ── G/H. Route-level tests ────────────────────────────────────────────────────

let app: Express;
let server: Server;
let port: number;

before(async () => {
  const { default: compassRouter } = await import("../routes/compass.js");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as any).port;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestOpenAI(null);
});

beforeEach(() => invalidateFlagsCache());
afterEach(() => _setTestOpenAI(null));

async function post(path: string, body: Record<string, unknown>) {
  const r = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/** OpenAI mock: classifier low-confidence; main LLM does one search_places tool round then answers from the candidates. */
function makeToolLoopOpenAI(onMainCall?: (opts: any, mainCalls: number) => void) {
  let mainCalls = 0;
  return {
    chat: {
      completions: {
        create: async (opts: any) => {
          const isClassifier = opts.max_completion_tokens === 60 && opts.temperature === 0;
          if (isClassifier) {
            return { choices: [{ message: { content: JSON.stringify({ intent: "recommendation", confidence: 0.9 }), role: "assistant" } }] };
          }
          mainCalls++;
          onMainCall?.(opts, mainCalls);
          if (mainCalls === 1) {
            assert.ok(Array.isArray(opts.tools) && opts.tools.length === COMPASS_TOOL_DEFINITIONS.length, "tools must be offered to the model");
            return { choices: [{ message: {
              role: "assistant", content: null,
              tool_calls: [{ id: "tc_1", type: "function", function: { name: "search_places", arguments: JSON.stringify({ city: "Cebu" }) } }],
            } }] };
          }
          const toolMsg = (opts.messages as any[]).find((m: any) => m.role === "tool");
          assert.ok(toolMsg, "tool result must be in the follow-up context");
          return { choices: [{ message: { role: "assistant", content: JSON.stringify({ message: "Try Lantaw Cafe — a verified spot in Busay.", payload: null, quickActions: [] }) } }] };
        },
      },
    },
  } as any;
}

describe("G. /compass/ask tool loop", () => {
  it("executes tools, answers from DB-backed candidates, and persists toolCalls in the message payload", async () => {
    const db = makeDb({
      discovery_places: [{ id: PLACE_ID, name: "Lantaw Cafe", category: "cafe", city: "Cebu", rating: 4.6, verified: true, blurb: "views", lat: 10.35, lng: 123.87 }],
    });
    const client = makeClient(db);
    _setTestClient(client, "test-token");
    _setTestOpenAI(makeToolLoopOpenAI());

    const { status, body } = await post("/api/compass/ask", { prompt: "coffee in Cebu?" });
    assert.equal(status, 200);
    assert.ok(String(body.message).includes("Lantaw Cafe"));

    // Assistant message payload must carry the tool call + result.
    const msgs = db.compass_conversation_messages.filter((m) => m.role === "assistant");
    assert.equal(msgs.length, 1);
    const payload = msgs[0].payload as any;
    assert.ok(payload, "payload must be persisted");
    assert.equal(payload.toolCalls.length, 1);
    assert.equal(payload.toolCalls[0].name, "search_places");
    const persisted = JSON.stringify(payload.toolCalls[0].result);
    assert.ok(persisted.includes("Lantaw Cafe"), "tool result must be persisted");
    assert.ok(!persisted.includes("10.35") && !persisted.includes("123.87"), "no coordinates in persisted tool results");
  });

  it("Phase 5: hydrates model-declared uiBlocks from real tool candidates and drops invented ids", async () => {
    const db = makeDb({
      discovery_places: [{ id: PLACE_ID, name: "Lantaw Cafe", category: "cafe", city: "Cebu", rating: 4.6, verified: true, blurb: "views", lat: 10.35, lng: 123.87 }],
    });
    const client = makeClient(db);
    _setTestClient(client, "test-token");
    _setTestOpenAI(makeToolLoopOpenAI((opts, mainCalls) => {
      if (mainCalls === 2) {
        // Final answer declares one real and one invented place id.
        (opts as any).__final = true;
      }
    }));
    // Replace final-answer content: use a dedicated mock emitting blocks.
    _setTestOpenAI({
      chat: { completions: { create: async (opts: any) => {
        const isClassifier = opts.max_completion_tokens === 60 && opts.temperature === 0;
        if (isClassifier) {
          return { choices: [{ message: { content: JSON.stringify({ intent: "recommendation", confidence: 0.9 }), role: "assistant" } }] };
        }
        const hasToolMsg = (opts.messages as any[]).some((m: any) => m.role === "tool");
        if (!hasToolMsg) {
          return { choices: [{ message: { role: "assistant", content: null,
            tool_calls: [{ id: "tc_1", type: "function", function: { name: "search_places", arguments: JSON.stringify({ city: "Cebu" }) } }] } }] };
        }
        return { choices: [{ message: { role: "assistant", content: JSON.stringify({
          message: "Try Lantaw Cafe.",
          payload: { type: "recommendation", picks: [{ title: "Lantaw Cafe" }], primaryPick: 0,
            blocks: [{ type: "place_cards", placeIds: [PLACE_ID, "invented-place-id"] }] },
          quickActions: [],
        }) } }] };
      } } },
    } as any);

    const { status, body } = await post("/api/compass/ask", { prompt: "coffee in Cebu?" });
    assert.equal(status, 200);
    const uiBlocks = body.uiBlocks as any[];
    assert.ok(Array.isArray(uiBlocks) && uiBlocks.length === 1, "one validated block expected");
    assert.equal(uiBlocks[0].type, "place_cards");
    assert.deepEqual(uiBlocks[0].places.map((p: any) => p.id), [PLACE_ID], "invented id must be dropped");
    assert.equal(uiBlocks[0].places[0].name, "Lantaw Cafe");

    // Persisted alongside the message payload.
    const msgs = db.compass_conversation_messages.filter((m) => m.role === "assistant");
    const payload = msgs[msgs.length - 1].payload as any;
    assert.ok(Array.isArray(payload.uiBlocks) && payload.uiBlocks.length === 1, "uiBlocks persisted");
  });

  it("surfaces add_to_trip pendingProposals on the response and persists them", async () => {
    const db = makeDb({
      trips: [{ id: TRIP_ID, owner_id: ALICE_ID, title: "Cebu trip", plan_edit_permission: "all_members", status: "upcoming" }],
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner", status: "accepted" }],
      discovery_places: [{ id: PLACE_ID, name: "Lantaw Cafe", category: "cafe", city: "Cebu" }],
    });
    const client = makeClient(db);
    _setTestClient(client, "test-token");

    let mainCalls = 0;
    _setTestOpenAI({
      chat: { completions: { create: async (opts: any) => {
        if (opts.max_completion_tokens === 60 && opts.temperature === 0) {
          return { choices: [{ message: { content: JSON.stringify({ intent: "action", confidence: 0.95 }), role: "assistant" } }] };
        }
        mainCalls++;
        if (mainCalls === 1) {
          return { choices: [{ message: { role: "assistant", content: null,
            tool_calls: [{ id: "tc_1", type: "function", function: { name: "add_to_trip", arguments: JSON.stringify({ tripId: TRIP_ID, placeId: PLACE_ID }) } }] } }] };
        }
        return { choices: [{ message: { role: "assistant", content: JSON.stringify({ message: "I can add Lantaw Cafe to your Cebu trip — confirm below.", payload: null, quickActions: [] }) } }] };
      } } },
    } as any);

    const { status, body } = await post("/api/compass/ask", { prompt: "add lantaw to my trip" });
    assert.equal(status, 200);
    const proposals = body.pendingProposals as any[];
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].status, "pending_confirmation");
    assert.deepEqual(client._getInserts()["trip_plan_items"] ?? [], [], "nothing written before confirmation");

    const msgs = db.compass_conversation_messages.filter((m) => m.role === "assistant");
    assert.equal((msgs[0].payload as any).pendingProposals.length, 1, "proposal persisted in payload column");
  });
});

describe("H. Proposal confirmation flow", () => {
  function seededDb(proposalId: string): Db {
    return makeDb({
      compass_conversations: [{ id: CONV_ID, user_id: ALICE_ID, last_active_at: new Date().toISOString() }],
      compass_conversation_messages: [{
        id: "m1", conversation_id: CONV_ID, role: "assistant", content: "confirm?",
        payload: { pendingProposals: [{ proposalId, tripId: TRIP_ID, tripTitle: "Cebu trip", placeId: PLACE_ID, title: "Lantaw Cafe", category: "cafe", dayDate: null, status: "pending_confirmation" }] },
        created_at: new Date().toISOString(),
      }],
      trips: [{ id: TRIP_ID, owner_id: ALICE_ID, title: "Cebu trip", plan_edit_permission: "all_members", status: "upcoming" }],
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner", status: "accepted" }],
      discovery_places: [{ id: PLACE_ID, name: "Lantaw Cafe", category: "cafe", city: "Cebu" }],
    });
  }

  it("confirm executes the write with re-authorization, then blocks double-execution", async () => {
    const pid = "12345678-1234-1234-1234-123456789abc";
    const db = seededDb(pid);
    const client = makeClient(db);
    _setTestClient(client, "test-token");

    const first = await post(`/api/compass/proposals/${pid}/confirm`, { conversationId: CONV_ID });
    assert.equal(first.status, 201);
    assert.equal(first.body.status, "confirmed");
    const items = client._getInserts()["trip_plan_items"];
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Lantaw Cafe");
    assert.equal(items[0].source_type, "place");

    const second = await post(`/api/compass/proposals/${pid}/confirm`, { conversationId: CONV_ID });
    assert.equal(second.status, 409, "double-confirm must be rejected");
    assert.equal(client._getInserts()["trip_plan_items"].length, 1, "no second write");
  });

  it("decline records the resolution and writes nothing", async () => {
    const pid = "22345678-1234-1234-1234-123456789abc";
    const db = seededDb(pid);
    const client = makeClient(db);
    _setTestClient(client, "test-token");

    const r = await post(`/api/compass/proposals/${pid}/decline`, { conversationId: CONV_ID });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "declined");
    assert.deepEqual(client._getInserts()["trip_plan_items"] ?? [], []);

    const confirmAfter = await post(`/api/compass/proposals/${pid}/confirm`, { conversationId: CONV_ID });
    assert.equal(confirmAfter.status, 409, "confirm after decline must be rejected");
  });

  it("404s for a proposal in someone else's conversation", async () => {
    const pid = "32345678-1234-1234-1234-123456789abc";
    const db = seededDb(pid);
    db.compass_conversations[0].user_id = BOB_ID; // conversation not owned by caller
    const client = makeClient(db);
    _setTestClient(client, "test-token");

    const r = await post(`/api/compass/proposals/${pid}/confirm`, { conversationId: CONV_ID });
    assert.equal(r.status, 404);
    assert.deepEqual(client._getInserts()["trip_plan_items"] ?? [], []);
  });

  it("re-authorizes at confirm time — membership revoked after proposal ⇒ 403, no write", async () => {
    const pid = "42345678-1234-1234-1234-123456789abc";
    const db = seededDb(pid);
    db.trip_members = []; // membership revoked since proposal was made
    db.trips[0].owner_id = "someone-else";
    const client = makeClient(db);
    _setTestClient(client, "test-token");

    const r = await post(`/api/compass/proposals/${pid}/confirm`, { conversationId: CONV_ID });
    assert.equal(r.status, 403);
    assert.deepEqual(client._getInserts()["trip_plan_items"] ?? [], []);
  });
});
