/**
 * Tests for POST /api/discovery/community/:placeId/save — saved_count integrity.
 *
 * Regression guard for the popularity-rank manipulation finding (FEED-1): the
 * handler used to increment discovery_places.saved_count on EVERY POST while the
 * per-user save row (discovery_place_saves) is idempotent, so one account could
 * POST the same place N times and raise saved_count by N — arbitrarily promoting
 * any place to the top of the popular/discovery feeds. The fix only bumps
 * saved_count on a user's FIRST save (no existing discovery_place_saves row).
 *
 * A stateful fake Supabase client tracks the per-user save set and the place's
 * saved_count so the real route logic is exercised end to end. No network calls.
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunitySaveCount.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

const PLACE_ID = "11111111-1111-1111-1111-111111111111";
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// ── Stateful fake client ────────────────────────────────────────────────────
// Holds one discovery_places row (mutable saved_count) and a set of per-user
// saves keyed "user_id|place_id". Records how many times saved_count was
// written so tests can assert the increment fired exactly once per distinct user.

function makeFakeClient(currentUserId: string, saves: Set<string>, place: { id: string; saved_count: number }, counters: { updates: number }) {
  function chain(table: string) {
    const eq: Record<string, unknown> = {};
    let op: "select" | "update" | "upsert" = "select";
    let upsertRow: any = null;

    const obj: any = {
      select() { op = "select"; return obj; },
      update(row: any) { op = "update"; upsertRow = row; return obj; },
      upsert(row: any) { op = "upsert"; upsertRow = row; return obj; },
      eq(col: string, val: unknown) { eq[col] = val; return obj; },
      maybeSingle() { return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    async function resolve(): Promise<{ data: any; error: null }> {
      if (table === "profiles") {
        return { data: { account_status: "active" }, error: null };
      }
      if (table === "discovery_places") {
        if (op === "update") {
          counters.updates += 1;
          place.saved_count = (upsertRow.saved_count as number);
          return { data: null, error: null };
        }
        // select id, saved_count
        return { data: { id: place.id, saved_count: place.saved_count }, error: null };
      }
      if (table === "discovery_place_saves") {
        const key = `${eq.user_id ?? currentUserId}|${eq.place_id ?? place.id}`;
        if (op === "upsert") {
          saves.add(`${upsertRow.user_id}|${upsertRow.place_id}`);
          return { data: null, error: null };
        }
        // select place_id .eq(user).eq(place).maybeSingle -> existing or null
        return { data: saves.has(key) ? { place_id: place.id } : null, error: null };
      }
      return { data: null, error: null };
    }

    return obj;
  }

  return {
    from(table: string) { return chain(table); },
    auth: {
      getUser: async (_token: string) => ({ data: { user: { id: currentUserId } }, error: null }),
    },
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

async function save(url: string, userId: string) {
  const res = await fetch(`${url}/api/discovery/community/${PLACE_ID}/save`, {
    method: "POST",
    headers: { authorization: `Bearer token-${userId}`, "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as { ok?: boolean };
  return { status: res.status, ok: body.ok === true };
}

describe("POST /discovery/community/:placeId/save — saved_count integrity (FEED-1)", () => {
  let server: Server;
  let url: string;
  let saves: Set<string>;
  let place: { id: string; saved_count: number };
  let counters: { updates: number };

  beforeEach(async () => {
    ({ server, url } = await startServer());
    saves = new Set();
    place = { id: PLACE_ID, saved_count: 0 };
    counters = { updates: 0 };
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("first save by a user increments saved_count to 1", async () => {
    _setTestClient(makeFakeClient(USER_A, saves, place, counters), true);
    const r = await save(url, USER_A);
    assert.equal(r.ok, true, "first save should succeed");
    assert.equal(place.saved_count, 1, `expected saved_count=1, got ${place.saved_count}`);
    assert.equal(counters.updates, 1, "increment should fire exactly once on first save");
  });

  it("repeated saves by the same user do NOT inflate saved_count", async () => {
    _setTestClient(makeFakeClient(USER_A, saves, place, counters), true);
    await save(url, USER_A);
    await save(url, USER_A);
    await save(url, USER_A);
    await save(url, USER_A);
    await save(url, USER_A);
    // Only the first of the five should have bumped the counter.
    assert.equal(place.saved_count, 1, `saved_count must stay 1 after 5 repeat saves, got ${place.saved_count}`);
    assert.equal(counters.updates, 1, `increment must fire once, not per-call — got ${counters.updates}`);
  });

  it("a second distinct user's first save increments to 2", async () => {
    // User A saves once.
    _setTestClient(makeFakeClient(USER_A, saves, place, counters), true);
    await save(url, USER_A);
    // User B saves once (new client with B's identity, shared save-set + place).
    _setTestClient(makeFakeClient(USER_B, saves, place, counters), true);
    await save(url, USER_B);
    assert.equal(place.saved_count, 2, `two distinct savers should yield saved_count=2, got ${place.saved_count}`);
    assert.equal(counters.updates, 2, `each distinct first-save increments once — got ${counters.updates}`);
  });
});
