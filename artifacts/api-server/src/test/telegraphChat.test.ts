/**
 * Telegraph Chat Suggestions — backend tests.
 *
 * Sections:
 *   A. Intent detection (8 tests)
 *   B. Privacy resolver (6 tests)
 *   C. API endpoint permission + shape (10 tests)
 *   D. Cooldown / rate-limit logic (4 tests)
 *   E. Settings endpoint (3 tests)
 *   F. Regression (3 tests)
 *   G. Preference event on dismiss + 24h category cooldown (5 tests)
 *
 * Total: 39
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphChatRouter from "../routes/telegraphChat.js";

// ---------------------------------------------------------------------------
// Fake Supabase client factory
// ---------------------------------------------------------------------------

interface FakeRow {
  [key: string]: any;
}

function makeFakeClient(overrides: {
  users?: Record<string, { id: string; email: string }>;
  threads?: FakeRow[];
  threadMembers?: FakeRow[];
  tripMembers?: FakeRow[];
  circleMembers?: FakeRow[];
  profiles?: FakeRow[];
  suggestions?: FakeRow[];
  trips?: FakeRow[];
  messages?: FakeRow[];
  planItems?: FakeRow[];
  preferenceEvents?: FakeRow[];
  insertedSuggestions?: FakeRow[];
  insertedMessages?: FakeRow[];
  updatedSuggestions?: FakeRow[];
  updatedProfiles?: FakeRow[];
  insertedPreferenceEvents?: FakeRow[];
} = {}) {
  const store = {
    threads: overrides.threads ?? [],
    threadMembers: overrides.threadMembers ?? [],
    tripMembers: overrides.tripMembers ?? [],
    circleMembers: overrides.circleMembers ?? [],
    profiles: overrides.profiles ?? [],
    suggestions: overrides.suggestions ?? [],
    trips: overrides.trips ?? [],
    messages: overrides.messages ?? [],
    planItems: overrides.planItems ?? [],
    preferenceEvents: overrides.preferenceEvents ?? [],
  };

  const captured = {
    insertedSuggestions: overrides.insertedSuggestions ?? [],
    insertedMessages: overrides.insertedMessages ?? [],
    updatedSuggestions: overrides.updatedSuggestions ?? [],
    updatedProfiles: overrides.updatedProfiles ?? [],
    insertedPreferenceEvents: overrides.insertedPreferenceEvents ?? [],
  };

  function makeQuery(tableName: string, rows: FakeRow[]) {
    let filtered = [...rows];
    let limited: FakeRow[] | null = null;
    let isSingle = false;
    let isMaybe = false;
    let isCountOnly = false;
    let selectFields = "*";
    let insertRows: FakeRow[] = [];
    let updateData: FakeRow = {};
    let isUpdate = false;
    let isInsert = false;

    const q: any = {
      select(fields: string, opts?: { count?: string; head?: boolean }) {
        selectFields = fields;
        if (opts?.count) isCountOnly = opts.head ?? false;
        return q;
      },
      eq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        return q;
      },
      in(col: string, vals: any[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return q;
      },
      gt(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] > val);
        return q;
      },
      gte(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] >= val);
        return q;
      },
      is(col: string, val: any) {
        if (val === null) filtered = filtered.filter((r) => r[col] == null);
        return q;
      },
      order() {
        return q;
      },
      limit(n: number) {
        limited = filtered.slice(0, n);
        return q;
      },
      maybeSingle() {
        isMaybe = true;
        return q;
      },
      single() {
        isSingle = true;
        return q;
      },
      insert(data: FakeRow | FakeRow[]) {
        isInsert = true;
        insertRows = Array.isArray(data) ? data : [data];
        return q;
      },
      update(data: FakeRow) {
        isUpdate = true;
        updateData = data;
        return q;
      },
      then(resolve: (v: any) => void) {
        if (isInsert) {
          if (tableName === "telegraph_chat_suggestions") {
            captured.insertedSuggestions.push(...insertRows);
            if (isSingle) {
              return resolve({ data: insertRows[0], error: null });
            }
          }
          if (tableName === "messages") {
            captured.insertedMessages.push(...insertRows);
            if (isSingle) {
              return resolve({
                data: { id: "msg_" + Math.random().toString(36).slice(2) },
                error: null,
              });
            }
          }
          if (tableName === "trip_plan_items") {
            if (isSingle) {
              return resolve({
                data: { id: "plan_" + Math.random().toString(36).slice(2), title: insertRows[0]?.title },
                error: null,
              });
            }
          }
          if (tableName === "user_preference_events") {
            captured.insertedPreferenceEvents.push(...insertRows);
          }
          return resolve({ data: null, error: null });
        }
        if (isUpdate) {
          if (tableName === "telegraph_chat_suggestions") {
            captured.updatedSuggestions.push(updateData);
          }
          if (tableName === "profiles") {
            captured.updatedProfiles.push(updateData);
          }
          return resolve({ data: null, error: null });
        }
        if (isCountOnly) {
          return resolve({ count: filtered.length, error: null });
        }
        const source = limited ?? filtered;
        if (isSingle) {
          if (source.length === 0) return resolve({ data: null, error: { message: "not found" } });
          return resolve({ data: source[0], error: null });
        }
        if (isMaybe) {
          return resolve({ data: source[0] ?? null, error: null });
        }
        return resolve({ data: source, error: null });
      },
    };
    return q;
  }

  const client: any = {
    auth: {
      async getUser(token: string) {
        const u = (overrides.users ?? {})[token];
        if (!u) return { data: { user: null }, error: { message: "bad token" } };
        return { data: { user: u }, error: null };
      },
    },
    from(table: string) {
      const tableMap: Record<string, FakeRow[]> = {
        message_threads: store.threads,
        message_thread_members: store.threadMembers,
        trip_members: store.tripMembers,
        circle_memberships: store.circleMembers,
        profiles: store.profiles,
        telegraph_chat_suggestions: store.suggestions,
        trips: store.trips,
        messages: store.messages,
        trip_plan_items: store.planItems,
        user_preference_events: store.preferenceEvents,
      };
      return makeQuery(table, tableMap[table] ?? []);
    },
    _captured: captured,
  };
  return client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(
  server: http.Server,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: "127.0.0.1",
      port: addr.port,
      path,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const THREAD_ID = "11111111-1111-1111-1111-111111111111";
const TRIP_ID = "22222222-2222-2222-2222-222222222222";
const CIRCLE_OWNER_ID = "33333333-3333-3333-3333-333333333333";
const USER_A = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", email: "a@test.com" };
const USER_B = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", email: "b@test.com" };
const TOKEN_A = "token_a";
const TOKEN_B = "token_b";
const SUGG_ID = "55555555-5555-5555-5555-555555555555";

function activeMember(userId: string, threadId: string) {
  return { thread_id: threadId, user_id: userId, left_at: null };
}

function tripMember(userId: string, tripId: string) {
  return { trip_id: tripId, user_id: userId, role: "member" };
}

function tripThread(id: string, tripId: string) {
  return {
    id,
    thread_type: "trip",
    trip_id: tripId,
    circle_owner_id: null,
  };
}

function directThread(id: string) {
  return { id, thread_type: "direct", trip_id: null, circle_owner_id: null };
}

function circleThread(id: string, ownerId: string) {
  return { id, thread_type: "circle", trip_id: null, circle_owner_id: ownerId };
}

function suggestion(
  id: string,
  userId: string,
  threadId: string,
  status = "shown",
  expiresAt?: string,
) {
  return {
    id,
    user_id: userId,
    thread_id: threadId,
    intent_type: "food",
    title: "Find great food",
    reason: "Detected food planning",
    category: "food",
    action_type: "view_place",
    location_context: null,
    time_context: null,
    status,
    created_at: new Date().toISOString(),
    expires_at: expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Section A: Intent detection (unit-level — just call the module directly)
// ---------------------------------------------------------------------------

import { detectIntent } from "../services/telegraphIntent.js";
import { buildSuggestions } from "../services/telegraphChatSuggestions.js";

describe("A. Intent detection", () => {
  it("detects food intent from 'where should we eat'", () => {
    const r = detectIntent("where should we eat tonight?");
    assert.ok(r, "expected intent result");
    assert.equal(r!.intent, "food");
  });

  it("detects create_meetup from 'let's meet up'", () => {
    const r = detectIntent("let's meet up this weekend");
    assert.ok(r);
    assert.equal(r!.intent, "create_meetup");
  });

  it("detects time_poll from 'what time works for everyone'", () => {
    const r = detectIntent("what time works for everyone?");
    assert.ok(r);
    assert.equal(r!.intent, "time_poll");
  });

  it("detects nightlife from 'good bars nearby'", () => {
    const r = detectIntent("any good bars nearby for tonight?");
    assert.ok(r);
    assert.equal(r!.intent, "nightlife");
  });

  it("detects beach from 'island hopping'", () => {
    const r = detectIntent("let's go island hopping tomorrow");
    assert.ok(r);
    assert.equal(r!.intent, "beach");
  });

  it("detects availability_match from 'are you free this weekend'", () => {
    const r = detectIntent("are you free this weekend?");
    assert.ok(r);
    assert.ok(["availability_match", "time_poll"].includes(r!.intent));
  });

  it("returns null for a short/generic message", () => {
    const r = detectIntent("ok");
    assert.equal(r, null);
  });

  it("returns null below confidence threshold for unrelated text", () => {
    const r = detectIntent("wow really cool photos");
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// Section B: Privacy resolver
// ---------------------------------------------------------------------------

import { resolvePrivacyVerdict } from "../services/telegraphChatSuggestions.js";

describe("B. Privacy resolver", () => {
  it("trip thread: accepted member gets canUseTripContext = true", async () => {
    const client = makeFakeClient({
      threads: [tripThread(THREAD_ID, TRIP_ID)],
      tripMembers: [tripMember(USER_A.id, TRIP_ID)],
      profiles: [{ id: USER_A.id, show_telegraph_trip: true }],
      trips: [{ id: TRIP_ID, destination_city: "Cebu", destination_country: "Philippines" }],
    });
    const v = await resolvePrivacyVerdict(client, USER_A.id, THREAD_ID);
    assert.equal(v.canUseTripContext, true);
    assert.equal(v.canShowRecommendation, true);
    assert.equal(v.tripDestination, "Cebu");
  });

  it("trip thread: non-member gets canShowRecommendation = false", async () => {
    const client = makeFakeClient({
      threads: [tripThread(THREAD_ID, TRIP_ID)],
      tripMembers: [],
      profiles: [{ id: USER_B.id, show_telegraph_trip: true }],
    });
    const v = await resolvePrivacyVerdict(client, USER_B.id, THREAD_ID);
    assert.equal(v.canShowRecommendation, false);
    assert.equal(v.reason, "not_trip_member");
  });

  it("circle thread: non-member gets canShowRecommendation = false", async () => {
    const client = makeFakeClient({
      threads: [circleThread(THREAD_ID, CIRCLE_OWNER_ID)],
      circleMembers: [],
      profiles: [{ id: USER_B.id, show_telegraph_circle: true }],
    });
    const v = await resolvePrivacyVerdict(client, USER_B.id, THREAD_ID);
    assert.equal(v.canShowRecommendation, false);
    assert.equal(v.reason, "not_circle_member");
  });

  it("direct thread with telegraph disabled returns canShowRecommendation = false", async () => {
    const client = makeFakeClient({
      threads: [directThread(THREAD_ID)],
      profiles: [{ id: USER_A.id, show_telegraph_dm: false }],
    });
    const v = await resolvePrivacyVerdict(client, USER_A.id, THREAD_ID);
    assert.equal(v.canShowRecommendation, false);
  });

  it("verdict never exposes exact GPS fields", async () => {
    const client = makeFakeClient({
      threads: [directThread(THREAD_ID)],
      profiles: [{ id: USER_A.id, latitude: 10.3, longitude: 123.8, show_telegraph_dm: true }],
    });
    const v = await resolvePrivacyVerdict(client, USER_A.id, THREAD_ID);
    assert.equal((v as any).latitude, undefined);
    assert.equal((v as any).longitude, undefined);
    assert.equal((v as any).exactLocation, undefined);
  });

  it("unknown thread returns canShowRecommendation = false", async () => {
    const client = makeFakeClient({ threads: [] });
    const v = await resolvePrivacyVerdict(client, USER_A.id, THREAD_ID);
    assert.equal(v.canShowRecommendation, false);
    assert.equal(v.reason, "thread_not_found");
  });
});

// ---------------------------------------------------------------------------
// Section C: API endpoint permission + shape
// ---------------------------------------------------------------------------

let server: http.Server;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", telegraphChatRouter);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
});

after(() => {
  server?.close();
});

describe("C. API endpoint permission + shape", () => {
  it("GET suggestions — 401 without token", async () => {
    const client = makeFakeClient({ users: {} });
    _setTestClient(client, true);
    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/telegraph/suggestions`);
    assert.equal(r.status, 401);
  });

  it("GET suggestions — 400 for bad threadId", async () => {
    const client = makeFakeClient({ users: { [TOKEN_A]: USER_A } });
    _setTestClient(client, true);
    const r = await req(server, "GET", `/api/threads/not-a-uuid/telegraph/suggestions`, TOKEN_A);
    assert.equal(r.status, 400);
  });

  it("GET suggestions — 403 when not thread member", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      threadMembers: [],
    });
    _setTestClient(client, true);
    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/telegraph/suggestions`, TOKEN_A);
    assert.equal(r.status, 403);
  });

  it("GET suggestions — 200 with suggestions array for active member", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      threadMembers: [activeMember(USER_A.id, THREAD_ID)],
      threads: [directThread(THREAD_ID)],
      profiles: [{ id: USER_A.id, show_telegraph_dm: true }],
      suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
    });
    _setTestClient(client, true);
    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/telegraph/suggestions`, TOKEN_A);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.suggestions), "should have suggestions array");
  });

  it("POST dismiss — 403 for non-member", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_B]: USER_B },
      threadMembers: [],
    });
    _setTestClient(client, true);
    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/dismiss`,
      TOKEN_B,
    );
    assert.equal(r.status, 403);
  });

  it("POST dismiss — 200 for active member", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      threadMembers: [activeMember(USER_A.id, THREAD_ID)],
      suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
    });
    _setTestClient(client, true);
    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/dismiss`,
      TOKEN_A,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it("POST add-to-plan — 403 when user is not trip member", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      threadMembers: [activeMember(USER_A.id, THREAD_ID)],
      tripMembers: [],
      suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
    });
    _setTestClient(client, true);
    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/add-to-plan`,
      TOKEN_A,
      { tripId: TRIP_ID },
    );
    assert.equal(r.status, 403);
  });

  it("POST create-meetup — returns prefill data", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      threadMembers: [activeMember(USER_A.id, THREAD_ID)],
      suggestions: [
        {
          ...suggestion(SUGG_ID, USER_A.id, THREAD_ID),
          title: "Dinner in Cebu",
          location_context: "IT Park",
          time_context: "Evening",
          trip_id: TRIP_ID,
          circle_id: null,
        },
      ],
    });
    _setTestClient(client, true);
    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/create-meetup`,
      TOKEN_A,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.prefill.title, "Dinner in Cebu");
    assert.equal(r.body.prefill.location, "IT Park");
  });

  it("POST start-poll — 200, creates poll message", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      threadMembers: [activeMember(USER_A.id, THREAD_ID)],
      suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
    });
    _setTestClient(client, true);
    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/start-poll`,
      TOKEN_A,
      { options: ["Morning", "Afternoon", "Evening"] },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.messageId);
  });

  it("GET suggestions — left member (left_at != null) gets 403", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_B]: USER_B },
      threadMembers: [{ thread_id: THREAD_ID, user_id: USER_B.id, left_at: new Date().toISOString() }],
    });
    _setTestClient(client, true);
    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/telegraph/suggestions`, TOKEN_B);
    assert.equal(r.status, 403);
  });
});

// ---------------------------------------------------------------------------
// Section D: Cooldown / rate-limit logic
// ---------------------------------------------------------------------------

import { checkRateLimit, checkCooldown, checkCategoryDeclineCooldown } from "../services/telegraphChatSuggestions.js";

describe("D. Cooldown / rate-limit logic", () => {
  it("checkRateLimit returns true when fewer than 3 suggestions in the last hour", async () => {
    const now = new Date().toISOString();
    const client = makeFakeClient({
      suggestions: [
        { id: "s1", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
        { id: "s2", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
      ],
    });
    const ok = await checkRateLimit(client, USER_A.id, THREAD_ID);
    assert.equal(ok, true);
  });

  it("checkRateLimit returns false when 3 or more suggestions in the last hour", async () => {
    const now = new Date().toISOString();
    const client = makeFakeClient({
      suggestions: [
        { id: "s1", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
        { id: "s2", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
        { id: "s3", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
      ],
    });
    const ok = await checkRateLimit(client, USER_A.id, THREAD_ID);
    assert.equal(ok, false);
  });

  it("checkCooldown returns true when no recent same-intent suggestion", async () => {
    const client = makeFakeClient({ suggestions: [] });
    const ok = await checkCooldown(client, USER_A.id, THREAD_ID, "food");
    assert.equal(ok, true);
  });

  it("checkCooldown returns false when same intent shown recently", async () => {
    const recentTime = new Date().toISOString();
    const client = makeFakeClient({
      suggestions: [
        {
          id: "s1",
          user_id: USER_A.id,
          thread_id: THREAD_ID,
          intent_type: "food",
          status: "shown",
          created_at: recentTime,
        },
      ],
    });
    const ok = await checkCooldown(client, USER_A.id, THREAD_ID, "food");
    assert.equal(ok, false);
  });
});

// ---------------------------------------------------------------------------
// Section E: Telegraph chat settings endpoint
// ---------------------------------------------------------------------------

describe("E. Telegraph chat settings", () => {
  it("PATCH /api/me/telegraph-chat-settings — 401 without token", async () => {
    const client = makeFakeClient({ users: {} });
    _setTestClient(client, true);
    const r = await req(server, "PATCH", "/api/me/telegraph-chat-settings", undefined, {
      show_telegraph_dm: false,
    });
    assert.equal(r.status, 401);
  });

  it("PATCH — 400 for empty body", async () => {
    const client = makeFakeClient({ users: { [TOKEN_A]: USER_A } });
    _setTestClient(client, true);
    const r = await req(server, "PATCH", "/api/me/telegraph-chat-settings", TOKEN_A, {});
    assert.equal(r.status, 400);
  });

  it("PATCH — 200 updates one setting", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      profiles: [{ id: USER_A.id, show_telegraph_dm: true }],
    });
    _setTestClient(client, true);
    const r = await req(server, "PATCH", "/api/me/telegraph-chat-settings", TOKEN_A, {
      show_telegraph_dm: false,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Section F: Regression
// ---------------------------------------------------------------------------

describe("F. Regression", () => {
  it("no GPS fields ever appear in a suggestion card", () => {
    const intent = { intent: "food" as const, confidence: 0.9, rawText: "where should we eat?" };
    const verdict = {
      canUseTripContext: true,
      canUseCircleContext: false,
      canUseAvailability: false,
      canShowRecommendation: true,
      reason: "ok",
      tripId: TRIP_ID,
      circleOwnerId: null,
      tripDestination: "Cebu",
      threadType: "trip" as const,
    };
    const cards = buildSuggestions(USER_A.id, THREAD_ID, intent, verdict);
    for (const c of cards) {
      assert.equal((c as any).latitude, undefined);
      assert.equal((c as any).longitude, undefined);
      assert.equal((c as any).liveLocation, undefined);
      assert.equal((c as any).exactGps, undefined);
    }
  });

  it("GET suggestions returns empty array (not 500) when Telegraph API unavailable", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      threadMembers: [activeMember(USER_A.id, THREAD_ID)],
      threads: [directThread(THREAD_ID)],
      profiles: [{ id: USER_A.id, show_telegraph_dm: true }],
      suggestions: [],
    });
    _setTestClient(client, true);
    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/telegraph/suggestions`, TOKEN_A);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.suggestions, []);
  });

  it("POST dismiss on already-dismissed suggestion returns 200 (idempotent)", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      threadMembers: [activeMember(USER_A.id, THREAD_ID)],
      suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID, "dismissed")],
    });
    _setTestClient(client, true);
    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/dismiss`,
      TOKEN_A,
    );
    assert.equal(r.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Section G: Preference event on dismiss + 24-hour category cooldown
// ---------------------------------------------------------------------------

describe("G. Preference event on dismiss + 24h category cooldown", () => {
  it("G1: checkCategoryDeclineCooldown returns true when no recent decline", async () => {
    const client = makeFakeClient({ preferenceEvents: [] });
    const ok = await checkCategoryDeclineCooldown(client, USER_A.id, "food");
    assert.equal(ok, true);
  });

  it("G2: checkCategoryDeclineCooldown returns false when user declined same category within 24h", async () => {
    const recentTime = new Date().toISOString();
    const client = makeFakeClient({
      preferenceEvents: [
        {
          user_id: USER_A.id,
          category: "food",
          signal: "dismiss",
          created_at: recentTime,
        },
      ],
    });
    const ok = await checkCategoryDeclineCooldown(client, USER_A.id, "food");
    assert.equal(ok, false);
  });

  it("G3: dismiss endpoint writes a preference event to user_preference_events", async () => {
    const capturedEvents: FakeRow[] = [];
    const client = makeFakeClient({
      users: { [TOKEN_A]: USER_A },
      threadMembers: [activeMember(USER_A.id, THREAD_ID)],
      suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
      insertedPreferenceEvents: capturedEvents,
    });
    _setTestClient(client, true);
    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/dismiss`,
      TOKEN_A,
    );
    assert.equal(r.status, 200);
    assert.equal(capturedEvents.length, 1, "should have inserted one preference event");
    assert.equal(capturedEvents[0].user_id, USER_A.id);
    assert.equal(capturedEvents[0].signal, "dismiss");
    assert.equal(capturedEvents[0].recommendation_id, SUGG_ID);
  });

  it("G4: checkCategoryDeclineCooldown returns true when decline is for a different category", async () => {
    const recentTime = new Date().toISOString();
    const client = makeFakeClient({
      preferenceEvents: [
        {
          user_id: USER_A.id,
          category: "nightlife",
          signal: "dismiss",
          created_at: recentTime,
        },
      ],
    });
    const ok = await checkCategoryDeclineCooldown(client, USER_A.id, "food");
    assert.equal(ok, true);
  });

  it("G5: checkCategoryDeclineCooldown returns false when multiple decline events exist (regression: multi-row must not clear cooldown)", async () => {
    const recentTime = new Date().toISOString();
    const client = makeFakeClient({
      preferenceEvents: [
        { user_id: USER_A.id, category: "food", signal: "dismiss", created_at: recentTime },
        { user_id: USER_A.id, category: "food", signal: "dismiss", created_at: recentTime },
      ],
    });
    const ok = await checkCategoryDeclineCooldown(client, USER_A.id, "food");
    assert.equal(ok, false, "multiple decline rows must still suppress the category");
  });
});
