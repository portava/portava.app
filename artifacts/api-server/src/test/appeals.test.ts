/**
 * Appeals — backend route tests
 *
 * Tests cover:
 * - POST /api/appeals: successful submission, duplicate (23505), validation error
 * - GET /api/appeals/me: returns own appeals only, pagination params respected
 * - PATCH /api/appeals/:id: submitted→under_review, invalid state transition,
 *   under_review→approved (notification inserted), under_review→denied (notification
 *   inserted), 403 for non-admin
 *
 * Pattern: node:test + _setTestClient(client, true)
 * Reference: src/test/collections.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

type Row = Record<string, any>;
interface FakeTable {
  rows: Row[];
  nextInsertError?: { code?: string; message: string };
}

const APPELLANT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_ID     = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ADMIN_ID     = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TARGET_ID    = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const APPEAL_ID    = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    appeals:       tables.appeals       ?? { rows: [] },
    profiles:      tables.profiles      ?? { rows: [] },
    notifications: tables.notifications ?? { rows: [] },
    ...tables,
  };

  let idCounter = 0;
  function newId() {
    const n = String(++idCounter).padStart(8, "0");
    return `${n}-0000-0000-0000-000000000000`;
  }

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _upsert: { data: Row | Row[]; opts: any } | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _limitN: number | null = null;
    let _rangeFrom: number | null = null;
    let _rangeTo: number | null = null;
    let _orderCol: string | null = null;
    let _orderAsc = true;
    let _single = false;
    let _maybeSingle = false;

    const obj: any = {
      select()          { return obj; },
      insert(data: Row | Row[]) { _insert = data; return obj; },
      upsert(data: Row | Row[], opts?: any) {
        _upsert = { data, opts: opts ?? {} };
        _insert = Array.isArray(data) ? data[0] : data;
        return obj;
      },
      update(patch: Row) { _update = patch; return obj; },
      delete()          { _delete = true; return obj; },
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return obj;
      },
      not(col: string, op: string, val: any) {
        if (op === "is") filters.push((r) => r[col] !== val);
        return obj;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.includes(r[col]));
        return obj;
      },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return obj; },
      lt(col: string, val: any)  { filters.push((r) => r[col] < val); return obj; },
      limit(n: number)           { _limitN = n; return obj; },
      range(from: number, to: number) {
        _rangeFrom = from;
        _rangeTo   = to;
        return obj;
      },
      order(col: string, opts?: any) {
        _orderCol = col;
        _orderAsc = opts?.ascending !== false;
        return obj;
      },
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single      = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function getTable(): FakeTable {
      if (!db[tableName]) db[tableName] = { rows: [] };
      return db[tableName];
    }

    function filteredRows(): Row[] {
      return getTable().rows.filter((r) => filters.every((f) => f(r)));
    }

    async function resolve(): Promise<{ data: any; error: any }> {
      const table = getTable();

      if (_delete) {
        table.rows = table.rows.filter((r) => !filters.every((f) => f(r)));
        return { data: null, error: null };
      }

      if (_insert !== null) {
        if (table.nextInsertError) {
          const err = table.nextInsertError;
          delete table.nextInsertError;
          return { data: null, error: err };
        }
        const rows = Array.isArray(_insert) ? _insert : [_insert];
        const inserted: Row[] = [];
        for (const row of rows) {
          if (_upsert?.opts?.onConflict) {
            const conflictCols = (_upsert.opts.onConflict as string).split(",").map((s: string) => s.trim());
            const existing = table.rows.find((r) =>
              conflictCols.every((col: string) => r[col] === row[col]),
            );
            if (existing) {
              if (_upsert.opts.ignoreDuplicates) { inserted.push(existing); continue; }
              Object.assign(existing, row);
              inserted.push(existing);
              continue;
            }
          }
          const newRow = { id: newId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
          table.rows.push(newRow);
          inserted.push(newRow);
        }
        const result = _single || _maybeSingle ? (inserted[0] ?? null) : inserted;
        return { data: result, error: null };
      }

      if (_update !== null) {
        const matched = filteredRows();
        for (const r of matched) Object.assign(r, _update);
        const result = _single || _maybeSingle ? (matched[0] ?? null) : matched;
        return { data: result, error: null };
      }

      // SELECT
      let rows = filteredRows();
      if (_orderCol) {
        rows = [...rows].sort((a, b) => {
          if (a[_orderCol!] < b[_orderCol!]) return _orderAsc ? -1 : 1;
          if (a[_orderCol!] > b[_orderCol!]) return _orderAsc ? 1 : -1;
          return 0;
        });
      }
      if (_limitN !== null) rows = rows.slice(0, _limitN);
      if (_rangeFrom !== null && _rangeTo !== null) {
        rows = rows.slice(_rangeFrom, _rangeTo + 1);
      }
      if (_single)      return { data: rows[0] ?? null, error: null };
      if (_maybeSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    return obj;
  }

  const client: any = {
    from(table: string) { return chain(table); },
    auth: {
      getUser: async (token: string) => {
        if (token === "appellant-token") return { data: { user: { id: APPELLANT_ID } }, error: null };
        if (token === "other-token")     return { data: { user: { id: OTHER_ID } }, error: null };
        if (token === "admin-token")     return { data: { user: { id: ADMIN_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
  return client;
}

function startServer(tables: Record<string, FakeTable> = {}): Promise<{
  url: string; close: () => Promise<void>;
}> {
  const client = makeFakeClient(tables);
  _setTestClient(client, true);

  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) => {
            srv.closeAllConnections?.();
            srv.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
    srv.on("error", reject);
  });
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function post(url: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(url: string, path: string, token: string) {
  const res = await fetch(`${url}${path}`, { headers: auth(token) });
  return { status: res.status, body: await res.json() };
}

async function patch(url: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: "PATCH",
    headers: auth(token),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/appeals", () => {
  let server: { url: string; close: () => Promise<void> };

  afterEach(async () => { await server?.close(); });

  it("201 on valid submission", async () => {
    server = await startServer();
    const { status, body } = await post(server.url, "/api/appeals", "appellant-token", {
      targetType:  "account_warning",
      targetId:    TARGET_ID,
      reason:      "I believe this warning was issued in error because I was not online.",
    });
    assert.equal(status, 201);
    assert.ok(body.id);
    assert.equal(body.targetType, "account_warning");
    assert.equal(body.targetId, TARGET_ID);
    assert.equal(body.state, "submitted");
  });

  it("409 appeal_already_active on duplicate (23505)", async () => {
    const tables = {
      appeals: {
        rows: [],
        nextInsertError: { code: "23505", message: "unique violation" },
      },
    };
    server = await startServer(tables);
    const { status, body } = await post(server.url, "/api/appeals", "appellant-token", {
      targetType: "account_warning",
      targetId:   TARGET_ID,
      reason:     "I believe this warning was issued in error because of a misunderstanding.",
    });
    assert.equal(status, 409);
    assert.equal(body.error, "appeal_already_active");
  });

  it("400 invalid_payload when reason is too short", async () => {
    server = await startServer();
    const { status, body } = await post(server.url, "/api/appeals", "appellant-token", {
      targetType: "account_warning",
      targetId:   TARGET_ID,
      reason:     "too short",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("400 invalid_payload when targetId is not a UUID", async () => {
    server = await startServer();
    const { status, body } = await post(server.url, "/api/appeals", "appellant-token", {
      targetType: "account_warning",
      targetId:   "not-a-uuid",
      reason:     "I believe this warning was issued in error because of a misunderstanding.",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("401 when unauthenticated", async () => {
    server = await startServer();
    const { status } = await post(server.url, "/api/appeals", "bad-token", {
      targetType: "account_warning",
      targetId:   TARGET_ID,
      reason:     "I believe this warning was issued in error because of a misunderstanding.",
    });
    assert.equal(status, 401);
  });
});

describe("GET /api/appeals/me", () => {
  let server: { url: string; close: () => Promise<void> };

  afterEach(async () => { await server?.close(); });

  it("returns own appeals only, excludes other users", async () => {
    const tables = {
      appeals: {
        rows: [
          { id: "ap-1", appellant_id: APPELLANT_ID, target_type: "account_warning", target_id: TARGET_ID, reason: "First appeal", state: "submitted",    evidence_url: null, resolution_note: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
          { id: "ap-2", appellant_id: APPELLANT_ID, target_type: "no_show",         target_id: TARGET_ID, reason: "Second appeal", state: "under_review", evidence_url: null, resolution_note: null, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
          { id: "ap-3", appellant_id: OTHER_ID,     target_type: "post",            target_id: TARGET_ID, reason: "Other user",    state: "submitted",    evidence_url: null, resolution_note: null, created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
        ],
      },
    };
    server = await startServer(tables);
    const { status, body } = await get(server.url, "/api/appeals/me", "appellant-token");
    assert.equal(status, 200);
    assert.equal(body.appeals.length, 2, "should only return appellant's own appeals");
    assert.ok(body.appeals.every((a: any) => a.targetType !== undefined));
    assert.equal(body.page, 1);
    assert.equal(body.limit, 20);
  });

  it("respects limit and page query params", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `ap-${i}`,
      appellant_id: APPELLANT_ID,
      target_type: "account_warning",
      target_id: TARGET_ID,
      reason: `Appeal ${i}`,
      state: "submitted",
      evidence_url: null,
      resolution_note: null,
      created_at: `2026-01-0${i + 1}T00:00:00Z`,
      updated_at: `2026-01-0${i + 1}T00:00:00Z`,
    }));
    server = await startServer({ appeals: { rows } });
    const { status, body } = await get(server.url, "/api/appeals/me?limit=2&page=1", "appellant-token");
    assert.equal(status, 200);
    assert.equal(body.limit, 2);
    assert.equal(body.appeals.length, 2);
    assert.equal(body.page, 1);
  });

  it("camelCases all appeal fields in response", async () => {
    const tables = {
      appeals: {
        rows: [{
          id: "ap-1",
          appellant_id: APPELLANT_ID,
          target_type: "account_warning",
          target_id: TARGET_ID,
          reason: "I believe this is wrong due to a technical error on the platform.",
          state: "approved",
          evidence_url: "https://example.com/evidence",
          resolution_note: "Appeal upheld",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        }],
      },
    };
    server = await startServer(tables);
    const { status, body } = await get(server.url, "/api/appeals/me", "appellant-token");
    assert.equal(status, 200);
    const a = body.appeals[0];
    assert.equal(a.targetType, "account_warning");
    assert.equal(a.targetId, TARGET_ID);
    assert.equal(a.evidenceUrl, "https://example.com/evidence");
    assert.equal(a.resolutionNote, "Appeal upheld");
    assert.equal(a.state, "approved");
  });
});

describe("PATCH /api/appeals/:id", () => {
  let server: { url: string; close: () => Promise<void> };

  afterEach(async () => { await server?.close(); });

  function adminTables(appealState: string, extraTables?: Record<string, FakeTable>) {
    return {
      profiles: {
        rows: [
          { id: ADMIN_ID,     role: "admin" },
          { id: APPELLANT_ID, role: "user"  },
        ],
      },
      appeals: {
        rows: [{
          id: APPEAL_ID,
          appellant_id: APPELLANT_ID,
          target_type: "account_warning",
          target_id: TARGET_ID,
          reason: "I believe this warning was issued in error due to a technical glitch.",
          state: appealState,
          evidence_url: null,
          resolution_note: null,
          moderator_id: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        }],
      },
      notifications: { rows: [] },
      ...extraTables,
    };
  }

  it("submitted → under_review succeeds", async () => {
    const tables = adminTables("submitted");
    server = await startServer(tables);
    const { status, body } = await patch(
      server.url, `/api/appeals/${APPEAL_ID}`, "admin-token",
      { state: "under_review" },
    );
    assert.equal(status, 200);
    assert.equal(body.state, "under_review");
    assert.ok(body.updatedAt);
  });

  it("submitted → denied is rejected (invalid state transition)", async () => {
    const tables = adminTables("submitted");
    server = await startServer(tables);
    const { status, body } = await patch(
      server.url, `/api/appeals/${APPEAL_ID}`, "admin-token",
      { state: "denied" },
    );
    assert.equal(status, 409);
    assert.equal(body.error, "invalid_state_transition");
  });

  it("approved → denied is rejected (terminal state)", async () => {
    const tables = adminTables("approved");
    server = await startServer(tables);
    const { status, body } = await patch(
      server.url, `/api/appeals/${APPEAL_ID}`, "admin-token",
      { state: "denied" },
    );
    assert.equal(status, 409);
    assert.equal(body.error, "invalid_state_transition");
  });

  it("under_review → approved inserts appeal_approved notification", async () => {
    const tables = adminTables("under_review");
    server = await startServer(tables);
    const { status, body } = await patch(
      server.url, `/api/appeals/${APPEAL_ID}`, "admin-token",
      { state: "approved", resolutionNote: "Your warning was removed." },
    );
    assert.equal(status, 200);
    assert.equal(body.state, "approved");
    assert.equal(body.resolutionNote, "Your warning was removed.");
    // Give fire-and-forget notification insert a tick to complete
    await new Promise((r) => setTimeout(r, 20));
    const notifs = tables.notifications.rows;
    assert.ok(notifs.length > 0, "notification should be inserted");
    const notif = notifs.find((n) => n.event_type === "appeal.approved");
    assert.ok(notif, "appeal_approved notification should exist");
    assert.equal(notif.user_id, APPELLANT_ID);
    assert.equal(notif.category, "admin");
    assert.equal(notif.action_url, "/appeals");
  });

  it("approval is HELD (not committed) and NOT notified when the reversal fails", async () => {
    // resolveAppeal returns { ok:false, action:'noop' } for an unknown/unhandled
    // target_type. The handler must run the reversal BEFORE writing 'approved'
    // (a terminal, non-re-drivable state) and, on failure, leave the appeal in
    // under_review without telling the appellant the action was reversed.
    const tables = adminTables("under_review");
    // Force a reversal failure: a target_type resolveAppeal cannot handle.
    tables.appeals.rows[0].target_type = "widget_that_does_not_exist";
    server = await startServer(tables);
    const { status, body } = await patch(
      server.url, `/api/appeals/${APPEAL_ID}`, "admin-token",
      { state: "approved", resolutionNote: "Restore it." },
    );

    assert.equal(status, 422, "a failed reversal must surface an error, not a 200");
    assert.equal(body.error, "reversal_failed");

    // The appeal row must NOT have been flipped to the terminal 'approved' state.
    assert.equal(tables.appeals.rows[0].state, "under_review",
      "appeal must be held in under_review so a moderator can retry");

    // No 'approved' notification may have been sent for a reversal that failed.
    await new Promise((r) => setTimeout(r, 20));
    const approvedNotif = tables.notifications.rows.find((n) => n.event_type === "appeal.approved");
    assert.equal(approvedNotif, undefined,
      "must not tell the appellant the action was reversed when it was not");
  });

  it("under_review → denied inserts appeal_denied notification", async () => {
    const tables = adminTables("under_review");
    server = await startServer(tables);
    const { status, body } = await patch(
      server.url, `/api/appeals/${APPEAL_ID}`, "admin-token",
      { state: "denied", resolutionNote: "Decision upheld after review." },
    );
    assert.equal(status, 200);
    assert.equal(body.state, "denied");
    await new Promise((r) => setTimeout(r, 20));
    const notifs = tables.notifications.rows;
    const notif = notifs.find((n) => n.event_type === "appeal.denied");
    assert.ok(notif, "appeal_denied notification should exist");
    assert.equal(notif.user_id, APPELLANT_ID);
    assert.equal(notif.action_url, "/appeals");
  });

  it("403 for non-admin user", async () => {
    const tables = adminTables("submitted");
    server = await startServer(tables);
    const { status, body } = await patch(
      server.url, `/api/appeals/${APPEAL_ID}`, "appellant-token",
      { state: "under_review" },
    );
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("404 for unknown appeal id", async () => {
    const tables = adminTables("submitted");
    server = await startServer(tables);
    const unknownId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const { status } = await patch(
      server.url, `/api/appeals/${unknownId}`, "admin-token",
      { state: "under_review" },
    );
    assert.equal(status, 404, "unknown appeal id returns 404");
  });
});
