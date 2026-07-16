/**
 * Weekly availability save — POST /api/rent-a-buddy/dashboard/availability
 *
 * Guards the save half of the availability round-trip: per-row upsert
 * failures must surface as db_error (not a silent ok:true), otherwise the
 * client reloads a grid that doesn't match what the buddy thought they saved.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddyAvailabilitySave.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";

const TOKEN = "avail-save-token";
const USER_ID = "user-avail-1";
const BUDDY_PROFILE_ID = "buddy-profile-avail-1";

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  /** dates whose rent_buddy_availability upsert should fail */
  failDates: Set<string>;
  /** every upsert attempted against rent_buddy_availability */
  upserts: any[];
}

let state: FakeState = { failDates: new Set(), upserts: [] };

function makeFakeClient() {
  function fakeTable(table: string) {
    const filters: Array<[string, any]> = [];
    let upsertData: any = null;

    const b: any = {
      select() { return b; },
      insert() { return b; },
      update() { return b; },
      upsert(data: any) { upsertData = data; return b; },
      eq(col: string, val: any) { filters.push([col, val]); return b; },
      ilike() { return b; },
      maybeSingle() { return b; },
      single() { return b; },
      order() { return b; },
      limit() { return b; },
      then(resolve: (v: any) => void) {
        return Promise.resolve(resolveQuery()).then(resolve);
      },
    };

    function resolveQuery(): { data: any; error: any } {
      if (table === "rent_buddy_availability" && upsertData !== null) {
        state.upserts.push(upsertData);
        if (state.failDates.has(upsertData.date)) {
          return { data: null, error: { message: `simulated upsert failure for ${upsertData.date}` } };
        }
        return { data: null, error: null };
      }
      if (table === "profiles") {
        return { data: { id: USER_ID, account_status: "active", role: "user" }, error: null };
      }
      if (table === "feature_flags") {
        const flag = filters.find(([c]) => c === "flag")?.[1];
        return { data: { flag, enabled: flag === "rent_buddy_enabled" }, error: null };
      }
      if (table === "rent_buddy_global_controls") {
        return { data: null, error: null };
      }
      if (table === "rent_buddy_profiles") {
        return { data: { id: BUDDY_PROFILE_ID, user_id: USER_ID }, error: null };
      }
      return { data: null, error: null };
    }

    return b;
  }

  return {
    auth: {
      async getUser(token: string) {
        if (token === TOKEN) return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: fakeTable,
  };
}

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  const fake = makeFakeClient();
  _setTestClient(fake, true);
  _setTestServiceClient(fake as any);

  const app = express();
  app.use(express.json());
  app.use(rentABuddyRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setTestClient(null, true);
  _setTestServiceClient(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state = { failDates: new Set(), upserts: [] };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

const ENTRIES = [
  { date: "2026-07-20", timeSlots: ["morning"], isAvailable: true },
  { date: "2026-07-21", timeSlots: ["afternoon", "evening"], isAvailable: true },
  { date: "2026-07-22", timeSlots: [], isAvailable: false },
];

describe("POST /api/rent-a-buddy/dashboard/availability", () => {
  it("returns ok:true when every row upserts successfully", async () => {
    const res = await post("/api/rent-a-buddy/dashboard/availability", { entries: ENTRIES });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(state.upserts.length, ENTRIES.length);
    // Rows must be keyed by the buddy PROFILE id, not the user id
    for (const u of state.upserts) assert.equal(u.buddy_id, BUDDY_PROFILE_ID);
    // isAvailable:false rows are still written (they clear stale slots)
    const offRow = state.upserts.find((u) => u.date === "2026-07-22");
    assert.ok(offRow);
    assert.equal(offRow.is_available, false);
    assert.deepEqual(offRow.time_slots, []);
  });

  it("returns db_error when any single row upsert fails", async () => {
    state.failDates.add("2026-07-21");
    const res = await post("/api/rent-a-buddy/dashboard/availability", { entries: ENTRIES });
    assert.equal(res.body.error, "db_error");
    assert.notEqual(res.status, 200);
    assert.match(res.body.message, /Failed to save 1 of 3 availability rows/);
    assert.match(res.body.message, /2026-07-21/);
    assert.match(res.body.message, /simulated upsert failure/);
  });

  it("reports the failure count when multiple rows fail, citing the first error", async () => {
    state.failDates.add("2026-07-20");
    state.failDates.add("2026-07-22");
    const res = await post("/api/rent-a-buddy/dashboard/availability", { entries: ENTRIES });
    assert.equal(res.body.error, "db_error");
    assert.match(res.body.message, /Failed to save 2 of 3 availability rows/);
    assert.match(res.body.message, /2026-07-20/);
  });

  it("returns ok:true for an empty entries list", async () => {
    const res = await post("/api/rent-a-buddy/dashboard/availability", { entries: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(state.upserts.length, 0);
  });
});
