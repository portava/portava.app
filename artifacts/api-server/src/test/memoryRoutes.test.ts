/**
 * Memory API — route-level integration tests.
 *
 * Mounts the real compass router on a real express server and drives the three
 * memory endpoints over HTTP, so the wiring itself is covered (not just the
 * helpers): auth required, query/body validation, the caller's OWN id is what
 * reaches the service_role RPC (never a client-supplied id — the 2182 lesson),
 * surface allow-listing, and idempotent feedback.
 *
 *   GET  /api/compass/me/memory?surface=&limit=
 *   GET  /api/compass/me/memory/rediscover?city=
 *   POST /api/compass/me/memory/feedback
 *
 * Run: node --import tsx/esm --test src/test/memoryRoutes.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-00000000ae01";
const MALLORY = "bad00000-0000-0000-0000-00000000bad0";

type RpcCall = { name: string; params: any };
let rpcCalls: RpcCall[] = [];
let inserts: Array<{ table: string; row: any }> = [];

/** Fake Supabase client with auth + rpc + a minimal insert path. */
function makeClient(cfg: {
  retrieve?: any[];
  rediscover?: any[];
  rpcError?: string;
  insertError?: { code?: string; message?: string } | null;
} = {}) {
  return {
    auth: {
      getUser: async (token: string) => {
        const map: Record<string, string> = { "alice-token": ALICE };
        const id = map[token] ?? null;
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "not authed" } };
      },
    },
    rpc: async (name: string, params: any) => {
      rpcCalls.push({ name, params });
      if (cfg.rpcError === name) return { data: null, error: { message: "boom" } };
      if (name === "memory_retrieve") return { data: cfg.retrieve ?? [], error: null };
      if (name === "memory_rediscover") return { data: cfg.rediscover ?? [], error: null };
      return { data: null, error: null };
    },
    from: (table: string) => ({
      insert: async (row: any) => {
        inserts.push({ table, row });
        return { data: null, error: cfg.insertError ?? null };
      },
    }),
  } as any;
}

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
});

beforeEach(() => {
  rpcCalls = [];
  inserts = [];
});

async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token: string | null = "alice-token",
): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: any = null;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed };
}

describe("GET /api/compass/me/memory", () => {
  it("requires authentication", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("GET", "/compass/me/memory", undefined, null);
    assert.ok(res.status === 401 || res.status === 403, `expected auth failure, got ${res.status}`);
    assert.deepEqual(rpcCalls, [], "an unauthenticated request must not reach the RPC");
  });

  it("returns projected memories for the caller", async () => {
    _setTestClient(makeClient({ retrieve: [{ memory_type: "episodic", content: "Visited Lisbon" }] }), true as any);
    const res = await api("GET", "/compass/me/memory");
    assert.equal(res.status, 200);
    assert.equal(res.body.memories.length, 1);
    assert.equal(res.body.memories[0].content, "Visited Lisbon");
  });

  it("passes the AUTHENTICATED caller's id to the RPC, not a client-supplied one", async () => {
    _setTestClient(makeClient(), true as any);
    // Mallory tries to read someone else's memory by smuggling a user id.
    await api("GET", `/compass/me/memory?user_id=${MALLORY}&p_user_id=${MALLORY}`);
    const call = rpcCalls.find((c) => c.name === "memory_retrieve");
    assert.ok(call, "memory_retrieve should have been called");
    assert.equal(call!.params.p_user_id, ALICE, "must use the session identity");
    assert.notEqual(call!.params.p_user_id, MALLORY);
  });

  it("allow-lists the surface and falls back to compass", async () => {
    _setTestClient(makeClient(), true as any);
    await api("GET", "/compass/me/memory?surface=passport");
    assert.equal(rpcCalls.at(-1)!.params.p_surface, "passport");

    rpcCalls = [];
    await api("GET", "/compass/me/memory?surface=../etc/passwd");
    assert.equal(rpcCalls.at(-1)!.params.p_surface, "compass", "unknown surface falls back, never passes through");
  });

  it("clamps the limit", async () => {
    _setTestClient(makeClient(), true as any);
    await api("GET", "/compass/me/memory?limit=99999");
    assert.ok(rpcCalls.at(-1)!.params.p_limit <= 100);

    rpcCalls = [];
    await api("GET", "/compass/me/memory?limit=notanumber");
    assert.equal(rpcCalls.at(-1)!.params.p_limit, 20, "garbage limit falls back to the default");
  });

  it("an RPC error surfaces as an error status, not a crash", async () => {
    _setTestClient(makeClient({ rpcError: "memory_retrieve" }), true as any);
    const res = await api("GET", "/compass/me/memory");
    assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
  });
});

describe("GET /api/compass/me/memory/rediscover", () => {
  it("requires a city", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("GET", "/compass/me/memory/rediscover");
    assert.equal(res.status, 400);
    assert.deepEqual(rpcCalls, []);
  });

  it("returns rediscovery rows for the given city", async () => {
    _setTestClient(makeClient({ rediscover: [{ content: "Visited Lisbon", reason: "been_here_before" }] }), true as any);
    const res = await api("GET", "/compass/me/memory/rediscover?city=Lisbon");
    assert.equal(res.status, 200);
    assert.equal(res.body.rediscover[0].reason, "been_here_before");
    const call = rpcCalls.find((c) => c.name === "memory_rediscover")!;
    assert.equal(call.params.p_city, "Lisbon");
    assert.equal(call.params.p_user_id, ALICE);
  });
});

describe("POST /api/compass/me/memory/feedback", () => {
  it("rejects an unknown kind", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("POST", "/compass/me/memory/feedback", { kind: "sabotage", subjectType: "city", subjectId: "Lisbon" });
    assert.equal(res.status, 400);
    assert.deepEqual(inserts, []);
  });

  it("requires a target (projectionId, or subjectType+subjectId)", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("POST", "/compass/me/memory/feedback", { kind: "already_known" });
    assert.equal(res.status, 400);
    assert.deepEqual(inserts, []);
  });

  it("records already_known against a subject, keyed to the caller", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("POST", "/compass/me/memory/feedback", {
      kind: "already_known", subjectType: "city", subjectId: "Lisbon",
    });
    assert.equal(res.status, 201);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].table, "memory_feedback");
    assert.equal(inserts[0].row.user_id, ALICE, "feedback is always keyed to the session identity");
    assert.equal(inserts[0].row.kind, "already_known");
    assert.equal(inserts[0].row.subject_id, "Lisbon");
  });

  it("rejects a projection id the caller does not own (no cross-user suppression)", async () => {
    // The ownership lookup is scoped to the caller, so another user's projection
    // resolves to nothing. Guessing an id must not hide someone else's memory.
    const client = makeClient();
    (client as any).from = (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
      insert: async (row: any) => { inserts.push({ table, row }); return { data: null, error: null }; },
    });
    _setTestClient(client, true as any);
    const res = await api("POST", "/compass/me/memory/feedback", {
      kind: "hide", projectionId: "11111111-2222-3333-4444-555555555555",
    });
    assert.equal(res.status, 404, "a foreign projection id must not be actionable");
    assert.deepEqual(inserts, [], "no feedback row may be written for a foreign projection");
  });

  it("is idempotent — a duplicate signal (23505) still reports success", async () => {
    _setTestClient(makeClient({ insertError: { code: "23505", message: "duplicate key" } }), true as any);
    const res = await api("POST", "/compass/me/memory/feedback", {
      kind: "hide", subjectType: "place", subjectId: "p-1",
    });
    assert.equal(res.status, 201, "a repeat signal must not read as a failure");
  });

  it("a real DB error is still an error", async () => {
    _setTestClient(makeClient({ insertError: { code: "42501", message: "denied" } }), true as any);
    const res = await api("POST", "/compass/me/memory/feedback", {
      kind: "hide", subjectType: "place", subjectId: "p-1",
    });
    assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
  });
});
