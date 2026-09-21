/**
 * Block lookups on the HIGHLIGHTS surface must fail CLOSED.
 *
 * Highlights/Memories Development Architecture Spec v1
 *   §10   "Blocking and account deletion must suppress future social
 *          resurfacing and unlink profile identity as policy requires."
 *   §28.11 "Never swallow projection/schema failures into plausible-looking
 *          empty history without structured error state."
 *
 * WHAT WAS WRONG
 * --------------
 * supabase-js RESOLVES rather than throws on a database error, so `.data` is
 * null and `data ?? []` is empty when a query fails. Four sites in
 * routes/highlights.ts read the blocks table and none of them checked `.error`:
 *
 *   resolveViewAccess            `if (blockedByMe.data || blockingMe.data)`
 *   GET /users/:id/highlights    `if (blocker.data || blocked.data)`
 *   GET /highlights/active       `new Set([...(blockedByMe.data ?? []), ...])`
 *   GET /highlights/following-feed  same
 *
 * In every one of them a transient blocks-table failure read as "these users
 * are NOT blocked" and the highlight — plus, through resolveViewAccess, the
 * right to view, like, reply to and report it — was served to a viewer whose
 * block state could not be established.
 *
 * The memories surface fixed exactly this in isBlocked() and its discovery feed
 * (audit MEM·M6, src/test/memoriesBlockFailClosed.test.ts). The highlights
 * surface never got the same treatment. This file is the missing half.
 *
 * Mutation-proven: with the `.error` checks removed, every assertion below flips.
 *
 * Run: node --import tsx/esm --test src/test/highlightsBlockFailClosed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const OWNER   = "22222222-2222-2222-2222-222222222222";
const HL      = "33333333-3333-3333-3333-333333333333";

const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

const HIGHLIGHT = {
  id: HL,
  owner_id: OWNER,
  media_url: "https://example.com/h.jpg",
  media_type: "image/jpeg",
  video_duration_seconds: null,
  caption: null,
  location_name: null,
  location_city: null,
  location_country: null,
  visibility: "public",
  expires_at: FUTURE,
  created_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
};

/**
 * Every `blocks` query ERRORS. Everything else is benign, so the buggy
 * permissive path could complete and serve content — which is the whole point:
 * the failure has to be survivable for the leak to be silent.
 */
function makeFakeClient() {
  function chain(table: string) {
    let head = false;
    const obj: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; return obj; },
      insert() { return obj; }, update() { return obj; }, upsert() { return obj; }, delete() { return obj; },
      eq() { return obj; }, neq() { return obj; }, in() { return obj; },
      lt() { return obj; }, gt() { return obj; }, is() { return obj; }, not() { return obj; },
      order() { return obj; }, limit() { return obj; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(f: any, r: any) { return resolve(false).then(f, r); },
    };
    async function resolve(single: boolean): Promise<{ data: any; error: any; count: number | null }> {
      if (table === "blocks") {
        return { data: null, error: { message: "blocks lookup failed" }, count: null };
      }
      if (table === "profiles") {
        return {
          data: { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null },
          error: null, count: null,
        };
      }
      if (table === "highlights") {
        return { data: single ? HIGHLIGHT : [HIGHLIGHT], error: null, count: head ? 1 : null };
      }
      if (table === "user_follows") {
        return { data: single ? { following_id: OWNER } : [{ following_id: OWNER }], error: null, count: null };
      }
      if (table === "feature_flags") {
        return { data: single ? null : [], error: null, count: null };
      }
      return { data: single ? null : [], error: null, count: head ? 0 : 0 };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
  };
}

async function startApp() {
  _setTestClient(makeFakeClient() as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", highlightsRouter);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

/** The two response shapes these routes emit, narrowed to what is asserted. */
interface HighlightsBody { highlights?: unknown[]; error?: string }

async function req(base: string, path: string, method = "GET"): Promise<{ status: number; body: HighlightsBody | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { connection: "close", Authorization: "Bearer tok", "Content-Type": "application/json" },
    body: method === "POST" ? "{}" : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as HighlightsBody | null };
}

describe("highlights block reads fail closed on error", () => {
  it("GET /users/:id/highlights serves an EMPTY list, not the highlights", async () => {
    const app = await startApp();
    try {
      const { status, body } = await req(app.baseUrl, `/api/users/${OWNER}/highlights`);
      assert.equal(status, 200);
      assert.deepEqual(body?.highlights, [],
        "an unresolvable block state must not be read as 'not blocked'");
    } finally { await app.close(); }
  });

  it("GET /highlights/active returns db_error rather than an unfiltered feed", async () => {
    const app = await startApp();
    try {
      const { status, body } = await req(app.baseUrl, "/api/highlights/active");
      assert.equal(status, 500);
      assert.equal(body?.error, "db_error");
    } finally { await app.close(); }
  });

  it("GET /highlights/following-feed returns db_error rather than an unfiltered feed", async () => {
    const app = await startApp();
    try {
      const { status, body } = await req(app.baseUrl, "/api/highlights/following-feed");
      assert.equal(status, 500);
      assert.equal(body?.error, "db_error");
    } finally { await app.close(); }
  });

  it("POST /highlights/:id/view is refused (404) — resolveViewAccess gates every engagement verb", async () => {
    const app = await startApp();
    try {
      const { status } = await req(app.baseUrl, `/api/highlights/${HL}/view`, "POST");
      assert.equal(status, 404);
    } finally { await app.close(); }
  });

  it("POST /highlights/:id/like is refused (404) for the same reason", async () => {
    const app = await startApp();
    try {
      const { status } = await req(app.baseUrl, `/api/highlights/${HL}/like`, "POST");
      assert.equal(status, 404);
    } finally { await app.close(); }
  });
});
