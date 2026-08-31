/**
 * Phase 6: Layered Compass Memory tests.
 *
 * Covers:
 *  A. Persistence: "Teach My Compass" creates a structured memory that survives
 *     into later sessions (list + prompt injection on a fresh conversation).
 *  B. Edit / forget: PATCH changes take effect; DELETE removes from list and
 *     from the injected prompt block.
 *  C. Circle isolation: circle memories are only injected for the named circle
 *     when the caller is a verified member — never for other circles, never
 *     without circle context, and teaching into a foreign circle is 403.
 *  D. Prompt-size bounds: the memory block never exceeds its char budget.
 *  E. Privacy scrub: coordinates / emails / phone-like runs never persist.
 *  F. Compression cadence: raw messages distill into structured insights only
 *     after the message threshold, and the cadence counter advances.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/compass-memory.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import {
  buildMemoryPromptBlock,
  compressConversationIfDue,
  createMemory,
  updateMemory,
  forgetMemory,
  scrubMemoryText,
  MEMORY_PROMPT_BUDGET_CHARS,
  TAUGHT_CONFIDENCE_FLOOR,
} from "../compass/CompassMemoryService.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB   = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const CIRCLE_A_OWNER = "c3c3c3c3-cccc-cccc-cccc-000000000003";
const CIRCLE_B_OWNER = "d4d4d4d4-dddd-dddd-dddd-000000000004";

// ── Fake Supabase client ─────────────────────────────────────────────────────

type Row = Record<string, any>;

function makeClient(seed: Record<string, Row[]> = {}, callerUserId = ALICE) {
  const db: Record<string, Row[]> = {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    compass_conversations: [],
    compass_conversation_messages: [],
    compass_memories: [],
    circle_memberships: [],
    compass_user_preferences: [],
    user_hashtag_follows: [],
    profiles: [],
    user_location_state: [],
    trips: [],
    trip_members: [],
    blocks: [],
    user_follows: [],
    ...seed,
  };

  function builder(table: string) {
    const rows = () => (db[table] = db[table] ?? []);
    const filters: Array<(r: Row) => boolean> = [];
    let orderSpec: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let pending: { type: "update"; patch: Row } | { type: "delete" } | null = null;
    let insertedRows: Row[] | null = null;

    function readResult(): Row[] {
      let list = rows().filter((r) => filters.every((f) => f(r)));
      if (orderSpec) {
        const { col, asc } = orderSpec;
        list = [...list].sort((a, b) => {
          const av = String(a[col] ?? ""); const bv = String(b[col] ?? "");
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN !== null) list = list.slice(0, limitN);
      return list;
    }

    function exec(): Row[] {
      if (insertedRows) return insertedRows;
      if (pending?.type === "update") {
        const matched = rows().filter((r) => filters.every((f) => f(r)));
        for (const r of matched) Object.assign(r, (pending as any).patch);
        return matched;
      }
      if (pending?.type === "delete") {
        const matched = rows().filter((r) => filters.every((f) => f(r)));
        db[table] = rows().filter((r) => !matched.includes(r));
        return matched;
      }
      return readResult();
    }

    const b: any = {
      select: (_c?: string) => b,
      eq:  (col: string, val: any) => { filters.push((r) => r[col] === val); return b; },
      in:  (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return b; },
      is:  (col: string, val: any) => { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      like: (col: string, pattern: string) => {
        const re = new RegExp("^" + pattern.split("").map((ch) => (ch === "%" ? ".*" : /[a-zA-Z0-9_ ]/.test(ch) ? ch : "\\" + ch)).join("") + "$");
        filters.push((r) => re.test(String(r[col] ?? "")));
        return b;
      },
      order: (col: string, opts?: { ascending?: boolean }) => { orderSpec = { col, asc: opts?.ascending !== false }; return b; },
      limit: (n: number) => { limitN = n; return b; },
      insert: (payload: Row | Row[]) => {
        const arr = Array.isArray(payload) ? payload : [payload];
        const now = new Date().toISOString();
        insertedRows = arr.map((p) => ({ id: randomUUID(), created_at: now, updated_at: now, last_active_at: now, ...p }));
        rows().push(...insertedRows);
        return b;
      },
      update: (patch: Row) => { pending = { type: "update", patch }; return b; },
      delete: () => { pending = { type: "delete" }; return b; },
      upsert: (payload: Row) => { insertedRows = [payload]; rows().push(payload); return b; },
      single: () => { const l = exec(); return Promise.resolve(l[0] ? { data: l[0], error: null } : { data: null, error: { message: "no rows" } }); },
      maybeSingle: () => { const l = exec(); return Promise.resolve({ data: l[0] ?? null, error: null }); },
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: exec(), error: null }).then(resolve, reject),
    };
    return b;
  }

  return {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (token: string) => {
        const map: Record<string, string> = { "test-token": callerUserId, "bob-token": BOB };
        const userId = map[token] ?? null;
        return userId
          ? { data: { user: { id: userId } }, error: null }
          : { data: { user: null }, error: { message: "not authed" } };
      },
    },
    _db: db,
  } as any;
}

function makeOpenAIMock(reply: object | ((opts: any) => object)): any {
  return {
    chat: {
      completions: {
        create: async (opts: any) => ({
          choices: [{ message: { role: "assistant", content: JSON.stringify(typeof reply === "function" ? reply(opts) : reply) } }],
        }),
      },
    },
  };
}

const openAIError: any = {
  chat: { completions: { create: async () => { throw new Error("unavailable"); } } },
};

// ── Server setup ─────────────────────────────────────────────────────────────

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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestOpenAI(null);
});

beforeEach(() => {
  invalidateFlagsCache();
  clearCompassProfileCache();
  _setTestOpenAI(null);
});

async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token = "test-token",
): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}

// ── A. Persistence across sessions ───────────────────────────────────────────

describe("A. Teach My Compass — persistence", () => {
  it("turns an explicit statement into a structured preference", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    _setTestOpenAI(makeOpenAIMock({ category: "food", content: "Prefers vegetarian food" }));

    const { status, body } = await api("POST", "/compass/me/memories/teach", {
      statement: "I'm vegetarian, please stop suggesting steakhouses",
    });
    assert.equal(status, 201);
    assert.equal(body.memory.scope, "long_term");
    assert.equal(body.memory.category, "food");
    assert.equal(body.memory.content, "Prefers vegetarian food");
    assert.equal(body.memory.source, "taught");

    const list = await api("GET", "/compass/me/memories");
    assert.equal(list.status, 200);
    assert.equal(list.body.memories.length, 1);
  });

  it("falls back to the raw statement when the model is unavailable", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    _setTestOpenAI(openAIError);

    const { status, body } = await api("POST", "/compass/me/memories/teach", {
      statement: "I always travel with my dog",
    });
    assert.equal(status, 201);
    assert.equal(body.memory.content, "I always travel with my dog");
    assert.equal(body.memory.category, "general");
  });

  it("injects persisted memories into a brand-new conversation's prompt", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    await createMemory(client, ALICE, {
      scope: "long_term", category: "food", content: "Prefers vegetarian food", source: "taught",
    });

    let captured: any[] | null = null;
    _setTestOpenAI(makeOpenAIMock((opts: any) => {
      captured = opts.messages;
      return { message: "ok", payload: null, quickActions: [] };
    }));

    // No conversationId supplied → this is a fresh session.
    const { status } = await api("POST", "/compass/ask", { prompt: "Where should I eat tonight?" });
    assert.equal(status, 200);
    const userMsg = (captured ?? []).filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
    assert.ok(userMsg.includes("Prefers vegetarian food"), "memory should reach the prompt");
    assert.ok(userMsg.includes("Compass memory"), "memory block header present");
  });
});

// ── B. Edit / forget ─────────────────────────────────────────────────────────

describe("B. Compass Remembers — edit and forget", () => {
  it("PATCH edits content and DELETE forgets, affecting prompt injection", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    const mem = await createMemory(client, ALICE, {
      scope: "long_term", category: "budget", content: "Prefers budget hostels", source: "taught",
    });
    assert.ok(mem);

    const patched = await api("PATCH", `/compass/me/memories/${mem!.id}`, { content: "Prefers boutique hotels" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.memory.content, "Prefers boutique hotels");

    let block = await buildMemoryPromptBlock(client, ALICE);
    assert.ok(block.join("\n").includes("Prefers boutique hotels"));
    assert.ok(!block.join("\n").includes("budget hostels"));

    const del = await api("DELETE", `/compass/me/memories/${mem!.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.forgotten, true);

    const list = await api("GET", "/compass/me/memories");
    assert.equal(list.body.memories.length, 0);
    block = await buildMemoryPromptBlock(client, ALICE);
    assert.equal(block.length, 0);
  });

  it("cannot edit or forget another user's memory", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    const mem = await createMemory(client, ALICE, {
      scope: "long_term", content: "Loves street food", source: "taught",
    });
    const patched = await api("PATCH", `/compass/me/memories/${mem!.id}`, { content: "hacked" }, "bob-token");
    assert.equal(patched.status, 404);
    const del = await api("DELETE", `/compass/me/memories/${mem!.id}`, undefined, "bob-token");
    assert.equal(del.status, 404);
  });
});

// ── C. Circle isolation ──────────────────────────────────────────────────────

describe("C. Circle isolation", () => {
  function circleSeed() {
    return {
      circle_memberships: [
        { user_id: CIRCLE_A_OWNER, other_id: ALICE }, // Alice ∈ circle A only
      ],
    };
  }

  it("injects only the named circle's memories, never another circle's", async () => {
    const client = makeClient(circleSeed());
    _setTestClient(client, true as any);
    await createMemory(client, ALICE, {
      scope: "circle", circleOwnerId: CIRCLE_A_OWNER, content: "Group A wants a beach day Friday", source: "taught",
    });
    // Alice also carries a fact learned in circle B context (e.g. stale membership row removed since).
    client._db.compass_memories.push({
      id: randomUUID(), user_id: ALICE, scope: "circle", circle_owner_id: CIRCLE_B_OWNER,
      category: "general", content: "Group B is planning a surprise party", source: "taught",
      confidence: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const blockA = (await buildMemoryPromptBlock(client, ALICE, { circleOwnerId: CIRCLE_A_OWNER })).join("\n");
    assert.ok(blockA.includes("beach day Friday"), "circle A fact visible in circle A context");
    assert.ok(!blockA.includes("surprise party"), "circle B fact must NOT leak into circle A context");

    // No circle context → no circle facts at all.
    const blockNone = (await buildMemoryPromptBlock(client, ALICE)).join("\n");
    assert.ok(!blockNone.includes("beach day Friday"));
    assert.ok(!blockNone.includes("surprise party"));

    // Not a member of circle B → nothing from circle B.
    const blockB = (await buildMemoryPromptBlock(client, ALICE, { circleOwnerId: CIRCLE_B_OWNER })).join("\n");
    assert.ok(!blockB.includes("surprise party"), "non-member gets no circle B facts");
  });

  it("ask with circleOwnerId injects that circle's facts; without it, none", async () => {
    const client = makeClient(circleSeed());
    _setTestClient(client, true as any);
    await createMemory(client, ALICE, {
      scope: "circle", circleOwnerId: CIRCLE_A_OWNER, content: "Group A wants a beach day Friday", source: "taught",
    });

    let captured: any[] | null = null;
    const mock = makeOpenAIMock((opts: any) => { captured = opts.messages; return { message: "ok", payload: null, quickActions: [] }; });
    _setTestOpenAI(mock);

    await api("POST", "/compass/ask", { prompt: "What should the group do?", circleOwnerId: CIRCLE_A_OWNER });
    let userMsg = (captured ?? []).filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
    assert.ok(userMsg.includes("beach day Friday"));

    captured = null;
    await api("POST", "/compass/ask", { prompt: "What should I do?" });
    userMsg = (captured ?? []).filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
    assert.ok(!userMsg.includes("beach day Friday"), "circle fact must not appear without circle context");
  });

  it("teaching into a circle you don't belong to is rejected", async () => {
    const client = makeClient(circleSeed());
    _setTestClient(client, true as any);
    const { status } = await api("POST", "/compass/me/memories/teach", {
      statement: "The group loves karaoke",
      circleOwnerId: CIRCLE_B_OWNER,
    });
    assert.equal(status, 403);
    assert.equal(client._db.compass_memories.length, 0);
  });
});

// ── D. Prompt-size bounds ────────────────────────────────────────────────────

describe("D. Prompt-size bounds", () => {
  it("memory block never exceeds MEMORY_PROMPT_BUDGET_CHARS", async () => {
    const client = makeClient();
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      client._db.compass_memories.push({
        id: randomUUID(), user_id: ALICE, scope: "long_term", circle_owner_id: null,
        category: "general",
        content: `Durable insight number ${i} — ${"x".repeat(180)}`,
        source: "compressed", confidence: 0.8,
        created_at: new Date(now - i * 1000).toISOString(),
        updated_at: new Date(now - i * 1000).toISOString(),
      });
    }
    const block = await buildMemoryPromptBlock(client, ALICE);
    const total = block.join("\n").length;
    assert.ok(total > 0, "block should not be empty");
    assert.ok(total <= MEMORY_PROMPT_BUDGET_CHARS + block.length, `block too large: ${total}`);
  });
});

// ── E. Privacy scrub ─────────────────────────────────────────────────────────

describe("E. Privacy scrub", () => {
  it("removes coordinates, emails, and phone numbers before persistence", async () => {
    const scrubbed = scrubMemoryText(
      "Meet at 10.31572, 123.88543 — call +63 917 555 1234 or mail alice@example.com",
    );
    assert.ok(!/\d{2}\.\d{4}/.test(scrubbed), "coordinates removed");
    assert.ok(!scrubbed.includes("@example.com"), "email removed");
    assert.ok(!scrubbed.includes("917"), "phone removed");

    const client = makeClient();
    _setTestClient(client, true as any);
    _setTestOpenAI(openAIError); // deterministic fallback stores (scrubbed) statement
    const { body } = await api("POST", "/compass/me/memories/teach", {
      statement: "My hotel is at 10.31572, 123.88543 — reach me at alice@example.com",
    });
    assert.ok(body.memory.content.includes("[location removed]"));
    assert.ok(body.memory.content.includes("[email removed]"));
  });

  it("caps memory content length", () => {
    assert.ok(scrubMemoryText("y".repeat(2000)).length <= 280);
  });
});

// ── G. Contradiction resolution ──────────────────────────────────────────────

describe("G. Contradiction resolution — newer preference wins", () => {
  /** OpenAI mock that flags every EXISTING candidate id as contradicted. */
  function contradictionMock() {
    return makeOpenAIMock((opts: any) => {
      const user = (opts.messages ?? []).find((m: any) => m.role === "user")?.content ?? "";
      if (!String(user).startsWith("NEW:")) return [];
      const ids = [...String(user).matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]);
      return ids;
    });
  }

  it("a newer taught preference supersedes an older conflicting one — only the newer reaches the prompt", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    _setTestOpenAI(openAIError); // no candidates yet → no contradiction call anyway
    await createMemory(client, ALICE, {
      scope: "long_term", category: "food", content: "Loves steakhouses and BBQ joints",
      source: "compressed", confidence: 0.7,
    });

    _setTestOpenAI(contradictionMock());
    const newer = await createMemory(client, ALICE, {
      scope: "long_term", category: "food", content: "Is vegetarian", source: "taught",
    });
    assert.ok(newer);

    assert.equal(client._db.compass_memories.length, 1, "older conflicting memory removed");
    assert.equal(client._db.compass_memories[0].content, "Is vegetarian");

    const block = (await buildMemoryPromptBlock(client, ALICE)).join("\n");
    assert.ok(block.includes("Is vegetarian"), "newer preference in prompt");
    assert.ok(!block.includes("steakhouses"), "older contradicted preference gone from prompt");
  });

  it("a lower-confidence newer memory decays the older's confidence instead of deleting it", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    _setTestOpenAI(openAIError);
    await createMemory(client, ALICE, {
      scope: "long_term", category: "food", content: "Loves steakhouses", source: "taught", confidence: 1,
    });

    _setTestOpenAI(contradictionMock());
    await createMemory(client, ALICE, {
      scope: "long_term", category: "food", content: "Seems to prefer vegetarian spots",
      source: "inferred", confidence: 0.6,
    });

    assert.equal(client._db.compass_memories.length, 2, "high-confidence older memory kept");
    const older = client._db.compass_memories.find((m: Row) => m.content === "Loves steakhouses");
    assert.equal(older.confidence, 0.5, "older confidence halved");
  });

  it("repeated low-confidence contradictions never decay a taught memory below the floor", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    _setTestOpenAI(openAIError);
    await createMemory(client, ALICE, {
      scope: "long_term", category: "food", content: "Loves steakhouses", source: "taught", confidence: 1,
    });

    _setTestOpenAI(contradictionMock());
    // Compression keeps re-extracting the same weak contradiction with
    // slightly different phrasing (dedupe only blocks identical content).
    for (let i = 0; i < 5; i++) {
      await createMemory(client, ALICE, {
        scope: "long_term", category: "food",
        content: `Seems to prefer vegetarian spots (pass ${i})`,
        source: "compressed", confidence: 0.4,
      });
    }

    const taught = client._db.compass_memories.find((m: Row) => m.content === "Loves steakhouses");
    assert.ok(taught, "taught memory still present");
    assert.equal(taught.confidence, TAUGHT_CONFIDENCE_FLOOR, "taught confidence clamped at the floor");
  });

  it("non-taught memories can still decay below the taught floor", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    _setTestOpenAI(openAIError);
    await createMemory(client, ALICE, {
      scope: "long_term", category: "food", content: "Loves steakhouses", source: "compressed", confidence: 0.8,
    });

    _setTestOpenAI(contradictionMock());
    for (let i = 0; i < 2; i++) {
      await createMemory(client, ALICE, {
        scope: "long_term", category: "food",
        content: `Seems vegetarian (pass ${i})`,
        source: "inferred", confidence: 0.1,
      });
    }

    const older = client._db.compass_memories.find((m: Row) => m.content === "Loves steakhouses");
    assert.equal(older.confidence, 0.2, "compressed memory decays freely (0.8 → 0.4 → 0.2)");
  });

  it("does not touch same-category memories in a different scope or when the model is unavailable", async () => {
    const client = makeClient();
    _setTestClient(client, true as any);
    _setTestOpenAI(openAIError);
    await createMemory(client, ALICE, {
      scope: "long_term", category: "food", content: "Loves steakhouses", source: "taught",
    });
    // Model unavailable → contradiction pass is a no-op; both persist.
    await createMemory(client, ALICE, {
      scope: "long_term", category: "food", content: "Is vegetarian", source: "taught",
    });
    assert.equal(client._db.compass_memories.length, 2, "model outage keeps both memories");

    // Different scope: session memory never contradicts long_term candidates
    // (candidates are same-scope only).
    _setTestOpenAI(contradictionMock());
    await createMemory(client, ALICE, {
      scope: "session", category: "food", content: "Wants seafood tonight",
      source: "compressed", conversationId: randomUUID(),
    });
    assert.equal(client._db.compass_memories.length, 3, "cross-scope memories untouched");
  });
});

// ── F. Compression cadence ───────────────────────────────────────────────────

describe("F. Compression cadence", () => {
  it("does nothing below the message threshold", async () => {
    const convId = randomUUID();
    const client = makeClient({
      compass_conversations: [{ id: convId, user_id: ALICE, compressed_message_count: 0 }],
      compass_conversation_messages: [
        { id: randomUUID(), conversation_id: convId, role: "user", content: "hi", created_at: new Date().toISOString() },
      ],
    });
    _setTestOpenAI(makeOpenAIMock([{ category: "food", content: "should not appear", scope: "long_term" }]));
    const created = await compressConversationIfDue(client, ALICE, convId);
    assert.equal(created, 0);
    assert.equal(client._db.compass_memories.length, 0);
  });

  it("distills structured insights once the threshold is reached and advances the counter", async () => {
    const convId = randomUUID();
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      id: randomUUID(), conversation_id: convId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `I keep asking about cheap vegan food (${i})` : "Here are ideas",
      created_at: new Date(Date.now() - (8 - i) * 1000).toISOString(),
    }));
    const client = makeClient({
      compass_conversations: [{ id: convId, user_id: ALICE, compressed_message_count: 0 }],
      compass_conversation_messages: msgs,
    });
    _setTestOpenAI(makeOpenAIMock([
      { category: "food", content: "Prefers cheap vegan food", scope: "long_term" },
      { category: "budget", content: "Traveling on a tight budget", scope: "long_term" },
    ]));

    const created = await compressConversationIfDue(client, ALICE, convId);
    assert.equal(created, 2);
    const stored = client._db.compass_memories.map((m: Row) => m.content);
    assert.ok(stored.includes("Prefers cheap vegan food"));
    assert.equal(client._db.compass_memories[0].source, "compressed");
    assert.equal(client._db.compass_conversations[0].compressed_message_count, 8);

    // Second run with no new messages: cadence respected, nothing duplicated.
    const again = await compressConversationIfDue(client, ALICE, convId);
    assert.equal(again, 0);
    assert.equal(client._db.compass_memories.length, 2);
  });
});

// ── MEM·M7: updateMemory / forgetMemory must not mask a DB error as not-found ──
//
// A minimal sc whose update/delete resolve with a Supabase error. Before the
// fix these functions discarded { error } and returned null / false, so a real
// write failure was reported to the user as "memory not found" / "nothing
// deleted". They must now surface the failure (throw).

describe("F. MEM·M7 — compass memory write errors are not swallowed", () => {
  function erroringClient(): any {
    const chain: any = {
      update: () => chain,
      delete: () => chain,
      eq: () => chain,
      select: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
      then: (res: any, rej: any) => Promise.resolve({ data: null, error: { message: "boom" } }).then(res, rej),
    };
    return { from: () => chain };
  }

  it("updateMemory throws when the update errors (not a silent null)", async () => {
    await assert.rejects(
      () => updateMemory(erroringClient(), ALICE, randomUUID(), { content: "hi" }),
      /update failed/,
      "a DB error on update must surface, not read as not-found",
    );
  });

  it("forgetMemory throws when the delete errors (not a silent false)", async () => {
    await assert.rejects(
      () => forgetMemory(erroringClient(), ALICE, randomUUID()),
      /delete failed/,
      "a DB error on delete must surface, not read as nothing-deleted",
    );
  });
});
