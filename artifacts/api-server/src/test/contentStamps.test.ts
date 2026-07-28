/**
 * Content Stamps — access control and endpoint tests.
 *
 * POST /api/stamps:
 *   - No auth → 401
 *   - Invalid entityType → 400
 *   - Invalid entityId (non-UUID) → 400
 *   - Post not found (inactive / missing) → 404
 *   - Public post, valid caller → 200 { stampCount, isStamped: true }
 *
 * POST /api/stamps — post access control:
 *   - Private post → 403
 *   - Blocked post (author blocked viewer) → 403
 *   - trip_only post, non-member → 403
 *
 * DELETE /api/stamps/:entityType/:entityId:
 *   - No auth → 401
 *   - Invalid entityType → 400
 *   - Invalid entityId (non-UUID) → 400
 *   - Valid removal → 200 { stampCount, isStamped: false }
 *
 * Runtime: node:test + node:assert/strict, real Express, fake Supabase client.
 * Run: node --import tsx/esm --test src/test/contentStamps.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

// ── Fixture IDs (all valid UUID-format strings) ───────────────────────────────

const ALICE_ID    = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID      = "bbbbbbbb-0000-0000-0000-000000000002";
const POST_PUB    = "cccccccc-0000-0000-0000-000000000001"; // public post by BOB
const POST_PRIV   = "cccccccc-0000-0000-0000-000000000002"; // private post
const POST_BLK    = "cccccccc-0000-0000-0000-000000000003"; // public post, BOB blocked ALICE
const POST_TRIP   = "cccccccc-0000-0000-0000-000000000004"; // trip_only post by BOB
const TRIP_ID     = "dddddddd-0000-0000-0000-000000000001";
const MISSING_ID  = "ffffffff-ffff-ffff-ffff-000000000000";
// Media fixtures (Watch-feed posts used as entity_type='media')
const MEDIA_PUB   = "eeeeeeee-0000-0000-0000-000000000001"; // public Watch post by BOB
const MEDIA_SELF  = "eeeeeeee-0000-0000-0000-000000000002"; // public Watch post by ALICE (self-stamp)
const MEDIA_BLK   = "eeeeeeee-0000-0000-0000-000000000003"; // public Watch post by BOB, BOB blocked ALICE
const MEDIA_TRIP  = "eeeeeeee-0000-0000-0000-000000000004"; // trip_only Watch post by BOB
const TRIP2_ID    = "dddddddd-0000-0000-0000-000000000002";

// ── Test infrastructure ───────────────────────────────────────────────────────

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function startServer(
  app: Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port as number;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

function makeApp(router: any): Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", router);
  return app;
}

// ── Fake Supabase client ──────────────────────────────────────────────────────
//
// Supports: select (with count), insert, upsert, delete, eq filters, or (→
// returns all rows for the table, simulating a matched OR).  Unknown tables
// return empty arrays so fire-and-forget Compass calls never throw.

interface FakeState {
  users?:          Record<string, { id: string }>;
  posts?:          any[];
  blocks?:         any[];
  trip_members?:   any[];
  content_stamps?: any[];
}

function makeClient(state: FakeState = {}) {
  const db: Record<string, any[]> = {
    posts:          state.posts          ?? [],
    blocks:         state.blocks         ?? [],
    trip_members:   state.trip_members   ?? [],
    content_stamps: state.content_stamps ?? [],
  };

  function from(table: string) {
    const eqFilters: Array<(r: any) => boolean> = [];
    let isCount     = false;
    let isHead      = false;
    let insertData: any  = null;
    let upsertData: any  = null;
    let isDeleteOp  = false;
    let useOrAll    = false; // .or() → count all rows (simplification for block checks)

    const b: any = {
      select(_sel?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count === "exact") isCount = true;
        if (opts?.head)              isHead  = true;
        return b;
      },
      insert(row: any)       { insertData = row; return b; },
      update()               { return b; },
      delete()               { isDeleteOp = true; return b; },
      upsert(row: any)       { upsertData = row; return b; },
      eq(col: string, val: any) { eqFilters.push((r) => r[col] === val); return b; },
      neq()  { return b; },
      in()   { return b; },
      or()   { useOrAll = true; return b; },
      not()  { return b; },
      limit(){ return b; },
      order(){ return b; },
      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): any[] {
      const source = db[table] ?? [];
      return source.filter((r: any) => eqFilters.every((f) => f(r)));
    }

    async function resolveSingle(maybe: boolean) {
      if (isDeleteOp || upsertData) return { data: null, error: null };
      if (insertData) return { data: { id: "new-id", ...insertData }, error: null };
      const matched = rows();
      if (!maybe && matched.length === 0)
        return { data: null, error: { message: "not found" } };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (isDeleteOp || upsertData) return { data: null, count: 0, error: null };
      if (insertData) return { data: { id: "new-id", ...insertData }, count: 1, error: null };
      // For count queries (block checks via .or()), return all table rows
      const matched = useOrAll ? (db[table] ?? []) : rows();
      if (isCount) return { data: null, count: matched.length, error: null };
      return { data: matched, count: matched.length, error: null };
    }

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = (state.users ?? {})[token];
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: { id: u.id } }, error: null };
      },
    },
  };
}

// =============================================================================
// A — POST /stamps: auth + input validation
// =============================================================================

describe("A — POST /stamps: auth + input validation", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/contentStamps.js");
    _setTestClient(
      makeClient({
        users: { "alice-tok": { id: ALICE_ID } },
        posts: [
          { id: POST_PUB, author_id: BOB_ID, visibility: "public", trip_id: null, status: "active" },
        ],
        blocks: [],
        content_stamps: [],
      }),
      true,
    );
    const srv = await startServer(makeApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(() => close());

  it("no auth → 401", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityType: "post", entityId: POST_PUB }),
    });
    assert.equal(r.status, 401);
  });

  it("invalid entityType → 400", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "banana", entityId: POST_PUB }),
    });
    assert.equal(r.status, 400);
  });

  it("invalid entityId (not UUID) → 400", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "post", entityId: "not-a-uuid" }),
    });
    assert.equal(r.status, 400);
  });

  it("post not found → 404", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "post", entityId: MISSING_ID }),
    });
    assert.equal(r.status, 404);
  });

  it("public post, valid caller → 200 with stampCount + isStamped:true", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "post", entityId: POST_PUB }),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok("stampCount" in body,  "stampCount field present");
    assert.equal(body.isStamped, true);
  });
});

// =============================================================================
// B — POST /stamps: post access control
// =============================================================================

describe("B — POST /stamps: post access control", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/contentStamps.js");
    _setTestClient(
      makeClient({
        users: { "alice-tok": { id: ALICE_ID } },
        posts: [
          // private — ALICE cannot stamp regardless of relationship
          { id: POST_PRIV, author_id: BOB_ID, visibility: "private",  trip_id: null,    status: "active" },
          // public — but BOB blocked ALICE (or ALICE blocked BOB)
          { id: POST_BLK,  author_id: BOB_ID, visibility: "public",   trip_id: null,    status: "active" },
          // trip_only — ALICE is not a member of TRIP_ID
          { id: POST_TRIP, author_id: BOB_ID, visibility: "trip_only", trip_id: TRIP_ID, status: "active" },
        ],
        blocks: [
          // BOB blocked ALICE — the .or() block check returns this row → 403
          { blocker_id: BOB_ID, blocked_id: ALICE_ID },
        ],
        trip_members: [], // no memberships → isAcceptedTripMember returns false
        content_stamps: [],
      }),
      true,
    );
    const srv = await startServer(makeApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(() => close());

  it("private post → 403", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "post", entityId: POST_PRIV }),
    });
    assert.equal(r.status, 403);
    const body = await r.json() as any;
    assert.ok(body.error, "error field present");
  });

  it("blocked post (author blocked viewer) → 403", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "post", entityId: POST_BLK }),
    });
    assert.equal(r.status, 403);
  });

  it("trip_only post, non-member → 403", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "post", entityId: POST_TRIP }),
    });
    assert.equal(r.status, 403);
  });
});

// =============================================================================
// C — DELETE /stamps/:entityType/:entityId
// =============================================================================

describe("C — DELETE /stamps/:entityType/:entityId", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/contentStamps.js");
    _setTestClient(
      makeClient({
        users: { "alice-tok": { id: ALICE_ID } },
        content_stamps: [
          { user_id: ALICE_ID, entity_type: "post", entity_id: POST_PUB },
        ],
      }),
      true,
    );
    const srv = await startServer(makeApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(() => close());

  it("no auth → 401", async () => {
    const r = await fetch(`${url}/api/stamps/post/${POST_PUB}`, { method: "DELETE" });
    assert.equal(r.status, 401);
  });

  it("invalid entityType → 400", async () => {
    const r = await fetch(`${url}/api/stamps/banana/${POST_PUB}`, {
      method: "DELETE",
      headers: bearer("alice-tok"),
    });
    assert.equal(r.status, 400);
  });

  it("invalid entityId (non-UUID) → 400", async () => {
    const r = await fetch(`${url}/api/stamps/post/not-a-uuid`, {
      method: "DELETE",
      headers: bearer("alice-tok"),
    });
    assert.equal(r.status, 400);
  });

  it("valid stamp removal → 200 with isStamped:false", async () => {
    const r = await fetch(`${url}/api/stamps/post/${POST_PUB}`, {
      method: "DELETE",
      headers: bearer("alice-tok"),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.isStamped, false);
    assert.ok("stampCount" in body, "stampCount field present");
  });
});

// =============================================================================
// D — POST /stamps: media — public + self-stamp (no blocks in state)
// Note: the fake client's .or() returns ALL block rows, so tests that need a
// clean block check must use an isolated describe with no blocks in state.
// =============================================================================

describe("D — POST /stamps: media — public and self-stamp", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/contentStamps.js");
    _setTestClient(
      makeClient({
        users: { "alice-tok": { id: ALICE_ID } },
        posts: [
          { id: MEDIA_PUB,  author_id: BOB_ID,   visibility: "public", trip_id: null, status: "active" },
          { id: MEDIA_SELF, author_id: ALICE_ID,  visibility: "public", trip_id: null, status: "active" },
        ],
        blocks: [],        // empty so the .or() block check returns 0
        trip_members: [],
        content_stamps: [],
      }),
      true,
    );
    const srv = await startServer(makeApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(() => close());

  it("public media, valid non-self caller → 200 with stampCount + isStamped:true", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "media", entityId: MEDIA_PUB }),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok("stampCount" in body, "stampCount field present");
    assert.equal(body.isStamped, true);
  });

  it("self-stamp (caller is author) → 403", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "media", entityId: MEDIA_SELF }),
    });
    assert.equal(r.status, 403);
    const body = await r.json() as any;
    assert.ok(body.error, "error field present");
  });
});

// =============================================================================
// E — POST /stamps: media — blocked and trip_only non-member
// =============================================================================

describe("E — POST /stamps: media — blocked and trip_only non-member", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/contentStamps.js");
    _setTestClient(
      makeClient({
        users: { "alice-tok": { id: ALICE_ID } },
        posts: [
          // Blocked: BOB blocked ALICE — block check fires
          { id: MEDIA_BLK,  author_id: BOB_ID, visibility: "public",    trip_id: null,     status: "active" },
          // trip_only: ALICE is not a member
          { id: MEDIA_TRIP, author_id: BOB_ID, visibility: "trip_only", trip_id: TRIP2_ID, status: "active" },
        ],
        blocks: [
          { blocker_id: BOB_ID, blocked_id: ALICE_ID },
        ],
        trip_members: [], // no memberships
        content_stamps: [],
      }),
      true,
    );
    const srv = await startServer(makeApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(() => close());

  it("blocked media (author blocked viewer) → 404", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "media", entityId: MEDIA_BLK }),
    });
    assert.equal(r.status, 404);
  });

  it("trip_only media, non-member → 404", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "media", entityId: MEDIA_TRIP }),
    });
    assert.equal(r.status, 404);
  });
});

// =============================================================================
// F — POST /stamps: media trip_only — accepted member allowed
// =============================================================================

describe("F — POST /stamps: media trip_only accepted member", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/contentStamps.js");
    _setTestClient(
      makeClient({
        users: { "alice-tok": { id: ALICE_ID } },
        posts: [
          { id: MEDIA_TRIP, author_id: BOB_ID, visibility: "trip_only", trip_id: TRIP2_ID, status: "active" },
        ],
        blocks: [],
        trip_members: [
          { trip_id: TRIP2_ID, user_id: ALICE_ID, role: "member", status: "accepted" },
        ],
        content_stamps: [],
      }),
      true,
    );
    const srv = await startServer(makeApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(() => close());

  it("trip_only media, accepted member → 200", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "media", entityId: MEDIA_TRIP }),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok("stampCount" in body, "stampCount field present");
    assert.equal(body.isStamped, true);
  });
});
