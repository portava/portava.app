/**
 * Regression tests for GET /me/trip-invites/pending
 *
 * Covers:
 *   1. No auth header → 401
 *   2. Invalid token → 401
 *   3. No pending invites → 200 with empty array
 *   4. One seeded pending invite → 200 with invites array containing the row
 *      (verifies cover_media_type is present — trips.cover_media_type column)
 *   5. Multiple pending invites → 200 with all rows
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/tripInvitesPending.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import tripsRouter from "../routes/trips.js";

// ── ID constants (valid UUIDs) ────────────────────────────────────────────────

const ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const TRIP_ID  = "33333333-0000-0000-0000-000000000001";
const TRIP_ID2 = "33333333-0000-0000-0000-000000000002";

// ── Fake state ────────────────────────────────────────────────────────────────

interface TripRow {
  id: string;
  owner_id: string;
  title: string;
  destination_city: string | null;
  destination_country: string | null;
  start_date: string | null;
  end_date: string | null;
  cover_url: string | null;
  cover_media_type: string | null;
  visibility: string;
  trip_type: string | null;
  show_exact_dates: boolean;
  show_destination_city: boolean;
}

interface TM { trip_id: string; user_id: string; role: string }
interface Profile { id: string; handle: string; name: string; avatar_url: string | null }
interface PrivacySetting { user_id: string; show_real_name: boolean }

interface State {
  users:                   Record<string, { id: string } | null>;
  trips:                   TripRow[];
  trip_members:            Array<TM & { created_at?: string }>;
  profiles:                Profile[];
  profile_privacy_settings: PrivacySetting[];
}

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
    },
    trips: [
      {
        id: TRIP_ID,
        owner_id: ALICE_ID,
        title: "Beach Trip",
        destination_city: "Miami",
        destination_country: "US",
        start_date: "2026-09-01",
        end_date: "2026-09-07",
        cover_url: "https://example.com/cover.jpg",
        cover_media_type: "image",
        visibility: "invite",
        trip_type: null,
        show_exact_dates: true,
        show_destination_city: true,
      },
      {
        id: TRIP_ID2,
        owner_id: ALICE_ID,
        title: "Mountain Trek",
        destination_city: "Denver",
        destination_country: "US",
        start_date: "2026-10-15",
        end_date: "2026-10-20",
        cover_url: "https://example.com/cover2.mp4",
        cover_media_type: "video",
        visibility: "private",
        trip_type: null,
        show_exact_dates: true,
        show_destination_city: true,
      },
    ],
    trip_members: [],
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice A.", avatar_url: null },
      { id: BOB_ID,   handle: "bob",   name: "Bob B.",   avatar_url: null },
    ],
    profile_privacy_settings: [],
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "insert" = "select";

    const b: any = {
      select(_cols?: string) { return b; },
      update(patch: any) { _op = "update"; return b; },
      delete() { _op = "delete"; return b; },
      insert(row: any) { _op = "insert"; return b; },
      eq(col: string, val: any) {
        filters.push((r: any) => r[col] === val);
        return b;
      },
      in(col: string, vals: any[]) {
        filters.push((r: any) => vals.includes(r[col]));
        return b;
      },
      maybeSingle() { return resolveOne(); },
      single()      { return resolveOne(); },
      then(onF: any, onR: any) {
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] { return (state as any)[table] ?? []; }
    function matchedRows() { return getSource().filter((r: any) => filters.every((f) => f(r))); }

    async function resolveOne() {
      const m = matchedRows();
      return { data: m[0] ? { ...m[0] } : null, error: null };
    }

    async function resolveList() {
      return { data: matchedRows().map((r) => ({ ...r })), error: null };
    }

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

// ── Server helpers ────────────────────────────────────────────────────────────

function makeApp(state: State) {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", tripsRouter);
  return app;
}

interface TestServer { port: number; state: State; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  const app = makeApp(state);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        port, state,
        close: () => new Promise<void>((res, rej) => {
          srv.closeAllConnections();
          srv.close((e) => e ? rej(e) : res());
        }),
      });
    });
    srv.on("error", reject);
  });
}

async function get(port: number, path: string, token?: string) {
  const headers: Record<string, string> = { connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "GET", headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/me/trip-invites/pending", () => {
  it("1. missing Authorization header returns 401", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await get(port, "/api/me/trip-invites/pending");
    assert.equal(r.status, 401);
    await close();
  });

  it("2. invalid/expired token returns 401", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await get(port, "/api/me/trip-invites/pending", "bad-token");
    assert.equal(r.status, 401);
    await close();
  });

  it("3. no pending invites returns 200 with empty invites array", async () => {
    const s = baseState();
    // Bob has no trip_members rows at all
    const { port, close } = await startServer(s);
    const r = await get(port, "/api/me/trip-invites/pending", "bob-tok");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body?.invites), "invites should be an array");
    assert.equal(r.body.invites.length, 0);
    await close();
  });

  it("4. one seeded pending invite returns 200 with invites array containing the row", async () => {
    const s = baseState();
    // Bob is invited to TRIP_ID (owned by Alice)
    s.trip_members.push({
      trip_id:    TRIP_ID,
      user_id:    BOB_ID,
      role:       "invited",
      created_at: "2026-08-01T12:00:00Z",
    });
    // Alice is the accepted owner member
    s.trip_members.push({
      trip_id:    TRIP_ID,
      user_id:    ALICE_ID,
      role:       "owner",
      created_at: "2026-07-01T10:00:00Z",
    });

    const { port, close } = await startServer(s);
    const r = await get(port, "/api/me/trip-invites/pending", "bob-tok");
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body?.invites), "invites should be an array");
    assert.equal(r.body.invites.length, 1);

    const invite = r.body.invites[0];
    assert.equal(invite.tripId, TRIP_ID);
    assert.equal(invite.tripTitle, "Beach Trip");
    assert.equal(invite.destinationCity, "Miami");
    // Verify cover_media_type is returned — confirms trips.cover_media_type column
    // is present and wired through the endpoint (root cause of the 500 errors).
    assert.equal(invite.coverMediaType, "image", "cover_media_type must be passed through");
    assert.equal(invite.invitedAt, "2026-08-01T12:00:00Z");
    assert.equal(invite.visibility, "invite");
    // memberCount: Alice is the owner → 1 accepted member
    assert.equal(invite.memberCount, 1);

    await close();
  });

  it("5. multiple pending invites returns 200 with all rows", async () => {
    const s = baseState();
    // Bob is invited to both trips
    s.trip_members.push(
      { trip_id: TRIP_ID,  user_id: BOB_ID, role: "invited", created_at: "2026-08-01T12:00:00Z" },
      { trip_id: TRIP_ID2, user_id: BOB_ID, role: "invited", created_at: "2026-08-02T12:00:00Z" },
    );

    const { port, close } = await startServer(s);
    const r = await get(port, "/api/me/trip-invites/pending", "bob-tok");
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body?.invites), "invites should be an array");
    assert.equal(r.body.invites.length, 2);

    const tripIds = r.body.invites.map((inv: any) => inv.tripId);
    assert.ok(tripIds.includes(TRIP_ID),  "should include first trip");
    assert.ok(tripIds.includes(TRIP_ID2), "should include second trip");

    // Both cover_media_types should be present
    const mediaTypes = r.body.invites.map((inv: any) => inv.coverMediaType);
    assert.ok(mediaTypes.includes("image"), "first trip should have image cover_media_type");
    assert.ok(mediaTypes.includes("video"), "second trip should have video cover_media_type");

    await close();
  });
});
