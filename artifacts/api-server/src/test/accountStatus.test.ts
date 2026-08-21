/**
 * GET /api/me/account-status — account status gate tests
 *
 * Covers:
 *   1. Active account → returns { accountStatus: "active", deletionScheduledAt: null }
 *   2. Deactivated account (no deletion request) → returns { accountStatus: "deactivated" }
 *   3. Deactivated account WITH a pending deletion request → returns { accountStatus: "pending_deletion", deletionScheduledAt }
 *   4. POST /me/reactivate for a pending_deletion account → cancels the deletion request row
 *   5. Unauthenticated request → 401
 *
 * Run: node --import tsx/esm --test src/test/accountStatus.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

// ── Stable UUIDs ──────────────────────────────────────────────────────────────

const ME = "aa000000-0000-4000-a000-000000000001";
const ME_TOK = "tok-me";

const DELETION_DATE = "2026-08-05T00:00:00.000Z";

// ── Minimal fake client ────────────────────────────────────────────────────────

type FakeState = {
  users: Record<string, { id: string }>;
  profiles: any[];
  user_deletion_requests?: any[];
  user_account_states?: any[];
  profile_privacy_settings?: any[];
};

function makeClient(state: FakeState) {
  // Track updates for assertion
  const updates: Array<{ table: string; patch: any; filters: Record<string, string> }> = [];

  function tableRows(table: string): any[] {
    return (state as any)[table] ?? [];
  }

  function makeBuilder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const filterMap: Record<string, string> = {};
    let pendingUpdate: any = null;
    let upsertRow: any = null;
    let isUpsert = false;

    const builder: any = {
      select()                    { return builder; },
      eq(col: string, val: any)   {
        filters.push((r) => String(r[col]) === String(val));
        filterMap[col] = String(val);
        return builder;
      },
      neq(col: string, val: any)  { filters.push((r) => r[col] !== val); return builder; },
      limit()                     { return builder; },
      order()                     { return builder; },
      update(patch: any) {
        pendingUpdate = patch;
        return builder;
      },
      upsert(row: any) {
        isUpsert = true;
        upsertRow = row;
        return builder;
      },
      maybeSingle() {
        if (pendingUpdate) {
          const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
          if (rows[0]) Object.assign(rows[0], pendingUpdate);
          return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
        }
        const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        if (isUpsert) {
          return Promise.resolve({ data: [upsertRow], error: null }).then(onF, onR);
        }
        if (pendingUpdate) {
          const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
          updates.push({ table, patch: pendingUpdate, filters: filterMap });
          // Mutate in-place for assertion helpers
          rows.forEach((r) => Object.assign(r, pendingUpdate));
          return Promise.resolve({ data: rows, error: null }).then(onF, onR);
        }
        const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows, error: null }).then(onF, onR);
      },
      catch() { return builder; },
    };
    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (tok: string) => {
        const u = state.users[tok] ?? null;
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: u }, error: null };
      },
    },
    from: (table: string) => makeBuilder(table),
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
      }),
    },
    __updates: updates,
  };
  return client;
}

function setup(state: FakeState) {
  const client = makeClient(state);
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return client;
}

function baseState(extra: Partial<FakeState> = {}): FakeState {
  return {
    users: { [ME_TOK]: { id: ME } },
    profiles: [{ id: ME, account_status: "active" }],
    user_deletion_requests: [],
    user_account_states: [],
    profile_privacy_settings: [],
    ...extra,
  };
}

// ── Server setup ──────────────────────────────────────────────────────────────

let base: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", profileRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());

function req(path: string, opts: { tok?: string | null; method?: string; body?: any } = {}) {
  const { tok = ME_TOK, method = "GET", body } = opts;
  const headers: Record<string, string> = {};
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/me/account-status", () => {
  it("returns active for a normal account", async () => {
    setup(baseState());
    const res = await req("/me/account-status");
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.accountStatus, "active");
    assert.equal(body.deletionScheduledAt, null);
  });

  it("returns deactivated when profile is deactivated with no pending deletion", async () => {
    setup(baseState({
      profiles: [{ id: ME, account_status: "deactivated" }],
    }));
    const res = await req("/me/account-status");
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.accountStatus, "deactivated");
    assert.equal(body.deletionScheduledAt, null);
  });

  it("returns pending_deletion with scheduled date when deletion request exists", async () => {
    setup(baseState({
      profiles: [{ id: ME, account_status: "deactivated" }],
      user_deletion_requests: [
        { user_id: ME, status: "pending", scheduled_at: DELETION_DATE },
      ],
    }));
    const res = await req("/me/account-status");
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.accountStatus, "pending_deletion");
    assert.equal(body.deletionScheduledAt, DELETION_DATE);
  });

  it("returns deactivated (not pending_deletion) when deletion request is cancelled", async () => {
    setup(baseState({
      profiles: [{ id: ME, account_status: "deactivated" }],
      user_deletion_requests: [
        { user_id: ME, status: "cancelled", scheduled_at: DELETION_DATE },
      ],
    }));
    const res = await req("/me/account-status");
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.accountStatus, "deactivated");
    assert.equal(body.deletionScheduledAt, null);
  });

  it("returns 401 when unauthenticated", async () => {
    setup(baseState());
    const res = await req("/me/account-status", { tok: null });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/me/reactivate", () => {
  it("marks account active and cancels a pending deletion request", async () => {
    const deletionRow = { user_id: ME, status: "pending", scheduled_at: DELETION_DATE };
    const client = setup(baseState({
      profiles: [{ id: ME, account_status: "deactivated" }],
      user_deletion_requests: [deletionRow],
    }));

    const res = await req("/me/reactivate", { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.reactivated, true);

    // Wait briefly for fire-and-forget secondary writes
    await new Promise((r) => setTimeout(r, 50));

    // Deletion request should be cancelled
    assert.equal(
      deletionRow.status,
      "cancelled",
      "deletion request row should be updated to cancelled",
    );
  });

  it("reactivates a plain deactivated account (no deletion request)", async () => {
    const profileRow = { id: ME, account_status: "deactivated" };
    setup(baseState({
      profiles: [profileRow],
    }));
    const res = await req("/me/reactivate", { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.reactivated, true);
    assert.equal(profileRow.account_status, "active");
  });

  it("refuses reactivation once a deletion execution owns the request", async () => {
    const profileRow = { id: ME, account_status: "deactivated" };
    const deletionRow = {
      user_id: ME,
      status: "executing",
      execution_token: "22222222-2222-2222-2222-222222222222",
      execution_started_at: "2026-08-21T10:00:00.000Z",
      execution_lease_expires_at: "2026-08-21T11:00:00.000Z",
      scheduled_at: DELETION_DATE,
    };
    setup(baseState({
      profiles: [profileRow],
      user_deletion_requests: [deletionRow],
    }));

    const res = await req("/me/reactivate", { method: "POST" });
    assert.equal(res.status, 403);
    assert.equal(profileRow.account_status, "deactivated");
    assert.equal(deletionRow.status, "executing");
  });
});

describe("DELETE /api/me/delete-request", () => {
  it("atomically cancels a still-pending request before restoring the profile", async () => {
    const profileRow = { id: ME, account_status: "deactivated" };
    const deletionRow = { user_id: ME, status: "pending", scheduled_at: DELETION_DATE };
    setup(baseState({
      profiles: [profileRow],
      user_deletion_requests: [deletionRow],
    }));

    const res = await req("/me/delete-request", { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal(deletionRow.status, "cancelled");
    assert.equal(profileRow.account_status, "active");
  });

  it("cannot cancel or restore a profile after the execution claim", async () => {
    const profileRow = { id: ME, account_status: "deactivated" };
    const deletionRow = {
      user_id: ME,
      status: "executing",
      execution_token: "22222222-2222-2222-2222-222222222222",
      execution_started_at: "2026-08-21T10:00:00.000Z",
      execution_lease_expires_at: "2026-08-21T11:00:00.000Z",
      scheduled_at: DELETION_DATE,
    };
    setup(baseState({
      profiles: [profileRow],
      user_deletion_requests: [deletionRow],
    }));

    const res = await req("/me/delete-request", { method: "DELETE" });
    assert.equal(res.status, 404);
    assert.equal(deletionRow.status, "executing");
    assert.equal(profileRow.account_status, "deactivated");
  });
});
