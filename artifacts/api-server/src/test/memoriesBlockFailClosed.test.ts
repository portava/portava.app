/**
 * Tests for MEM·M6 — block-lookup reads in the memories routes must fail CLOSED.
 *
 * The block checks in routes/memories.ts (the isBlocked() helper and the inline
 * discovery-feed filter) previously ignored the Supabase { error } field. Because
 * supabase-js RESOLVES (does not throw) on a DB error, an errored block lookup
 * read as "not blocked" (data null → empty set), so a transient blocks-table
 * failure would leak an owner's memory content to a viewer who may be blocked.
 *
 * These tests inject a fake client that returns an ERROR for every `blocks` query
 * and asserts the routes now fail closed:
 *   - GET /memories/:id  → 404 (treat as blocked) instead of serving the memory
 *   - GET /memories      → 5xx db_error instead of serving an unfiltered feed
 *
 * Mutation-proven: against the pre-fix code both assertions flip (200 / feed served).
 *
 * Run: node --import tsx/esm --test src/test/memoriesBlockFailClosed.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const OWNER = "22222222-2222-2222-2222-222222222222";
const MEMORY_ID = "33333333-3333-3333-3333-333333333333";

const PUBLIC_MEMORY = {
  id: MEMORY_ID,
  owner_id: OWNER,
  title: "Sunset",
  caption: null,
  visibility: "public",
  allowed_user_ids: [],
  hidden_user_ids: [],
  trip_id: null,
  event_id: null,
  place_id: null,
  location_city: null,
  location_country: null,
  location_lat: null,
  location_lng: null,
  canonical_location_id: null,
  starts_at: null,
  ends_at: null,
  state: "published",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

// Fake client: every `blocks` query ERRORS (simulating a transient DB failure);
// `memories` returns the one public memory owned by OWNER; everything else is
// benign/empty so the (buggy) success path can complete.
function makeFakeClient() {
  function chain(table: string) {
    let head = false;
    const obj: any = {
      select(_cols?: string, opts?: any) { if (opts?.head) head = true; return obj; },
      eq() { return obj; },
      neq() { return obj; },
      in() { return obj; },
      lt() { return obj; },
      order() { return obj; },
      limit() { return obj; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(onF: any, onR: any) { return resolve(false).then(onF, onR); },
    };
    // single=true → one-row shape (.maybeSingle/.single); single=false → list (await q).
    async function resolve(single: boolean): Promise<{ data: any; error: any; count: number | null }> {
      if (table === "blocks") {
        // The bug under test: this used to be swallowed as "not blocked".
        return { data: null, error: { message: "blocks lookup failed" }, count: null };
      }
      if (table === "profiles") {
        return { data: { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null }, error: null, count: null };
      }
      if (table === "memories") {
        return { data: single ? PUBLIC_MEMORY : [PUBLIC_MEMORY], error: null, count: head ? 0 : null };
      }
      // memory_items / tags / likes / saves / follows / etc.
      return { data: single ? null : [], error: null, count: head ? 0 : 0 };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    auth: { getUser: async (_t: string) => ({ data: { user: { id: VIEWER } }, error: null }) },
  };
}

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("MEM·M6 — memories block reads fail closed on error", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });
  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("GET /memories/:id returns 404 (not the memory) when the block lookup errors", async () => {
    const res = await fetch(`${url}/api/memories/${MEMORY_ID}`, {
      headers: { authorization: `Bearer t-${VIEWER}` },
    });
    assert.equal(res.status, 404, `expected 404 fail-closed, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.notEqual(body?.memory?.id, MEMORY_ID, "the memory must not be served when block state is unknown");
  });

  it("GET /memories (feed) fails closed with a block-state error when the block lookup errors", async () => {
    const res = await fetch(`${url}/api/memories`, {
      headers: { authorization: `Bearer t-${VIEWER}` },
    });
    assert.notEqual(res.status, 200, `feed must not serve on block-lookup error, got ${res.status}`);
    const body = (await res.json()) as any;
    // The fix's guard turns an errored block lookup into a db_error response.
    // Without the guard the feed either serves (no error code) or crashes with a
    // different code — either way this assertion is RED, so it discriminates.
    assert.equal(
      body?.error,
      "db_error",
      `feed must fail closed with db_error when block state is unknown, got ${JSON.stringify(body)}`,
    );
  });
});
