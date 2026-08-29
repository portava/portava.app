/**
 * Admin event moderation — report-resolution and audit tests
 *
 * Route under test: PATCH /admin/events/:eventId/moderate
 * Source:           artifacts/api-server/src/routes/admin.ts (~line 1657)
 *
 * Invariants tested:
 *  1. hide / cancel / remove  → resolve pending reports for THAT event only;
 *                               reports for other events are untouched
 *  2. restore / feature / unfeature / warn_host  → do NOT resolve any reports
 *  3. Every action writes event_activity_log (fail-closed) + moderation_actions
 *  4. Non-admin callers get 403; unknown action gets 400
 *
 * Run: node --import tsx/esm --test src/test/adminEventModeration.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Constants ──────────────────────────────────────────────────────────────────
const ADMIN_USER_ID = "aaaaaaaa-0000-0000-0001-000000000001";
const NON_ADMIN_ID  = "aaaaaaaa-0000-0000-0001-000000000002";
const HOST_USER_ID  = "aaaaaaaa-0000-0000-0001-000000000003";
const EVENT_ID_A    = "00000000-0000-0000-0001-000000000001"; // event being moderated
const EVENT_ID_B    = "00000000-0000-0000-0001-000000000002"; // unrelated event — must stay untouched
const REPORT_A1     = "00000000-0000-0000-0002-000000000001"; // pending report for EVENT_A
const REPORT_A2     = "00000000-0000-0000-0002-000000000002"; // second pending report for EVENT_A
const REPORT_B1     = "00000000-0000-0000-0002-000000000003"; // pending report for EVENT_B

// ── Test server (shared for all tests) ────────────────────────────────────────
let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

// ── Request helper ─────────────────────────────────────────────────────────────
function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": "Bearer fake-admin-token",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client ───────────────────────────────────────────────────────────────
// Uses in-memory rows with real .eq() filtering so report-scoping can be
// verified by inspecting client._db.reports after the request.

function makeModerationClient(opts: {
  actorUserId?: string;
  actorRole?:   string;
  captureActivity?:          any[];
  captureModerationActions?: any[];
  modInsertError?:           boolean;
  activityInsertError?:      boolean;
} = {}) {
  const {
    actorUserId = ADMIN_USER_ID,
    actorRole   = "admin",
    captureActivity          = [],
    captureModerationActions = [],
    modInsertError           = false,
    activityInsertError      = false,
  } = opts;

  const db: Record<string, any[]> = {
    profiles: [
      { id: actorUserId, role: actorRole },
      { id: HOST_USER_ID, role: "user", name: "Host User" },
    ],
    events: [{
      id:         EVENT_ID_A,
      host_id:    HOST_USER_ID,
      title:      "Test Event A",
      state:      "open",
      visibility: "public",
      featured:   false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }],
    reports: [
      { id: REPORT_A1, target_type: "event", target_id: EVENT_ID_A, status: "pending" },
      { id: REPORT_A2, target_type: "event", target_id: EVENT_ID_A, status: "pending" },
      { id: REPORT_B1, target_type: "event", target_id: EVENT_ID_B, status: "pending" },
    ],
    event_activity_log: [],
    moderation_actions: [],
  };

  function chain(tableName: string, rows: any[]) {
    // `rows` is a shallow-copy array whose objects are the SAME references
    // as in db[tableName] — mutations via Object.assign() are visible in _db.
    let filtered = rows;
    let pendingUpdate: Record<string, any> | null = null;

    const b: any = {
      select: () => b,
      insert: (data: any) => {
        const newRows = Array.isArray(data) ? data : [data];
        if (tableName === "event_activity_log") {
          // When activityInsertError is set, do NOT persist the rows and return an error
          // so the route's fail-closed guard fires and aborts without mutating the event.
          if (activityInsertError) {
            return {
              then: (resolve: any) =>
                Promise.resolve({ data: null, error: { message: "event_activity_log insert failed" } }).then(resolve),
            };
          }
          db[tableName] = [...(db[tableName] ?? []), ...newRows];
          captureActivity.push(...newRows);
        } else if (tableName === "moderation_actions") {
          captureModerationActions.push(...newRows);
          db[tableName] = [...(db[tableName] ?? []), ...newRows];
          // When modInsertError is set, return a thenable that resolves with an error
          // so the route's `const { error: modErr } = await sc.from(...).insert(...)` path fires.
          if (modInsertError) {
            return {
              then: (resolve: any) =>
                Promise.resolve({ data: null, error: { message: "moderation_actions insert failed" } }).then(resolve),
            };
          }
        } else {
          db[tableName] = [...(db[tableName] ?? []), ...newRows];
        }
        filtered = newRows;
        return b;
      },
      update: (data: Record<string, any>) => { pendingUpdate = data; return b; },
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r: any) => r[col] === val);
        return b;
      },
      order:   () => b,
      limit:   () => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve(
        filtered[0]
          ? { data: filtered[0], error: null }
          : { data: null, error: { message: "No rows" } },
      ),
      then: (resolve: any, reject: any) => {
        if (pendingUpdate !== null) {
          // Apply update in-place to the actual db row objects
          for (const row of filtered) Object.assign(row, pendingUpdate);
          pendingUpdate = null;
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from:  (tableName: string) => chain(tableName, [...(db[tableName] ?? [])]),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: actorUserId } }, error: null }),
    },
    _db: db,
  };
}

function setClient(client: ReturnType<typeof makeModerationClient>) {
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Report-resolution: hide / cancel / remove ─────────────────────────────────

describe("PATCH /admin/events/:eventId/moderate — hide/cancel/remove resolve reports", () => {
  for (const action of ["hide", "cancel", "remove"] as const) {
    it(`'${action}': resolves pending reports for that event only; other events' reports stay pending`, async () => {
      const captureActivity: any[] = [];
      const captureModerationActions: any[] = [];
      const client = makeModerationClient({ captureActivity, captureModerationActions });
      setClient(client);

      const { status, body } = await req(
        "PATCH",
        `/admin/events/${EVENT_ID_A}/moderate`,
        { action, reason: `Test ${action}` },
      );

      assert.equal(status, 200, `Expected 200 for '${action}', got ${status}: ${JSON.stringify(body)}`);
      assert.equal(body.ok, true);
      assert.equal(body.action, action);
      assert.equal(body.eventId, EVENT_ID_A);

      // Reports for EVENT_A must be resolved
      const evAReports = client._db.reports.filter((r: any) => r.target_id === EVENT_ID_A);
      assert.equal(evAReports.length, 2, "EVENT_A must have exactly 2 seeded reports");
      for (const r of evAReports) {
        assert.equal(
          r.status, "resolved",
          `Report ${r.id} for EVENT_A must be resolved after '${action}'`,
        );
      }

      // Report for EVENT_B must remain pending — scoping is correct
      const evBReports = client._db.reports.filter((r: any) => r.target_id === EVENT_ID_B);
      assert.equal(evBReports.length, 1, "EVENT_B must have exactly 1 seeded report");
      assert.equal(
        evBReports[0].status, "pending",
        `Report for EVENT_B must remain pending after '${action}' on EVENT_A`,
      );

      // Audit: event_activity_log row written
      assert.equal(captureActivity.length, 1, "event_activity_log must have exactly 1 insert");
      assert.equal(captureActivity[0].action, `admin_${action}`);
      assert.equal(captureActivity[0].event_id, EVENT_ID_A);

      // Audit: moderation_actions row written
      assert.equal(captureModerationActions.length, 1, "moderation_actions must have exactly 1 insert");
      assert.equal(captureModerationActions[0].action_type, `event_${action}`);
    });
  }
});

// ── Non-resolving actions: restore / feature / unfeature / warn_host ──────────

describe("PATCH /admin/events/:eventId/moderate — restore/feature/warn_host do NOT resolve reports", () => {
  for (const action of ["restore", "feature", "unfeature", "warn_host"] as const) {
    it(`'${action}': all pending reports remain pending`, async () => {
      const captureActivity: any[] = [];
      const captureModerationActions: any[] = [];
      const client = makeModerationClient({ captureActivity, captureModerationActions });
      setClient(client);

      const { status, body } = await req(
        "PATCH",
        `/admin/events/${EVENT_ID_A}/moderate`,
        { action },
      );

      assert.equal(status, 200, `Expected 200 for '${action}', got ${status}: ${JSON.stringify(body)}`);

      // All reports (both events) must still be pending
      for (const report of client._db.reports) {
        assert.equal(
          report.status, "pending",
          `Report ${report.id} must remain pending after '${action}'`,
        );
      }

      // Audit rows are still written
      assert.equal(captureActivity.length, 1, `event_activity_log must have 1 row for '${action}'`);
      assert.equal(captureModerationActions.length, 1, `moderation_actions must have 1 row for '${action}'`);
    });
  }
});

// ── Audit trail: every action writes both audit tables ─────────────────────────

describe("PATCH /admin/events/:eventId/moderate — audit trail is always written", () => {
  const ALL_ACTIONS = [
    "hide", "cancel", "remove", "restore", "feature", "unfeature", "warn_host",
  ] as const;

  for (const action of ALL_ACTIONS) {
    it(`'${action}': event_activity_log has action=admin_${action}, moderation_actions has action_type=event_${action}`, async () => {
      const captureActivity: any[] = [];
      const captureModerationActions: any[] = [];
      const client = makeModerationClient({ captureActivity, captureModerationActions });
      setClient(client);

      const { status } = await req(
        "PATCH",
        `/admin/events/${EVENT_ID_A}/moderate`,
        { action, reason: "audit test" },
      );
      assert.equal(status, 200, `Expected 200 for '${action}'`);

      // event_activity_log
      assert.equal(captureActivity.length, 1);
      assert.equal(captureActivity[0].action,    `admin_${action}`);
      assert.equal(captureActivity[0].event_id,  EVENT_ID_A);
      assert.equal(captureActivity[0].actor_id,  ADMIN_USER_ID);

      // moderation_actions
      assert.equal(captureModerationActions.length, 1);
      assert.equal(captureModerationActions[0].action_type,  `event_${action}`);
      assert.equal(captureModerationActions[0].performed_by, ADMIN_USER_ID);
      assert.equal(
        (captureModerationActions[0].metadata as any)?.event_id,
        EVENT_ID_A,
        "metadata.event_id must match",
      );
    });
  }
});

// ── Access control ─────────────────────────────────────────────────────────────

describe("PATCH /admin/events/:eventId/moderate — access control", () => {
  it("non-admin user gets 403", async () => {
    const client = makeModerationClient({ actorUserId: NON_ADMIN_ID, actorRole: "user" });
    setClient(client);

    const { status, body } = await req(
      "PATCH",
      `/admin/events/${EVENT_ID_A}/moderate`,
      { action: "hide" },
    );
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("unknown action returns 400", async () => {
    const client = makeModerationClient();
    setClient(client);

    const { status, body } = await req(
      "PATCH",
      `/admin/events/${EVENT_ID_A}/moderate`,
      { action: "nuke_event" },
    );
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("invalid eventId UUID returns 400", async () => {
    const client = makeModerationClient();
    setClient(client);

    const { status, body } = await req(
      "PATCH",
      "/admin/events/not-a-uuid/moderate",
      { action: "hide" },
    );
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});

// ── Audit fail-closed: event_activity_log insert failure must abort the action ──

describe("PATCH /admin/events/:eventId/moderate — event_activity_log insert failure aborts the action", () => {
  const ACTIONS_WITH_MUTATION = ["hide", "cancel", "remove", "restore", "feature", "unfeature"] as const;
  const ACTIONS_NO_MUTATION   = ["warn_host"] as const;

  for (const action of ACTIONS_WITH_MUTATION) {
    it(`'${action}': returns non-200 error, event row is NOT mutated, no moderation_actions row written`, async () => {
      const captureActivity: any[] = [];
      const captureModerationActions: any[] = [];
      const client = makeModerationClient({
        captureActivity,
        captureModerationActions,
        activityInsertError: true,
      });
      setClient(client);

      // Snapshot the event state BEFORE the request
      const eventBefore = { ...client._db.events[0] };

      const { status, body } = await req(
        "PATCH",
        `/admin/events/${EVENT_ID_A}/moderate`,
        { action, reason: "activity-log-fail test" },
      );

      // Must be 500 db_error — the route must abort with the specific sendError code
      assert.equal(
        status, 500,
        `Expected status 500 when event_activity_log insert fails for '${action}', got ${status}`,
      );
      assert.equal(
        body.error, "db_error",
        `Expected body.error === "db_error" for '${action}', got: ${JSON.stringify(body.error)}`,
      );

      // Event row must NOT have been mutated
      const eventAfter = client._db.events[0];
      assert.equal(
        eventAfter.state, eventBefore.state,
        `event.state must be unchanged after failed audit log for '${action}'`,
      );
      assert.equal(
        eventAfter.visibility, eventBefore.visibility,
        `event.visibility must be unchanged after failed audit log for '${action}'`,
      );
      assert.equal(
        eventAfter.featured, eventBefore.featured,
        `event.featured must be unchanged after failed audit log for '${action}'`,
      );

      // event_activity_log insert was attempted but failed — nothing persisted
      assert.equal(
        captureActivity.length, 0,
        `event_activity_log must have 0 persisted rows when insert fails for '${action}'`,
      );

      // moderation_actions must NOT have been written — the abort happened first
      assert.equal(
        captureModerationActions.length, 0,
        `moderation_actions must have 0 rows when event_activity_log insert fails for '${action}'`,
      );

      // Pending reports for EVENT_ID_A must remain unresolved — particularly
      // important for hide/cancel/remove, which resolve reports on success.
      // If the route ever moves report-resolution before the audit write, this
      // catches the regression.
      const evAReports = client._db.reports.filter(
        (r: any) => r.target_id === EVENT_ID_A,
      );
      assert.ok(
        evAReports.length > 0,
        `Expected seeded pending reports for EVENT_ID_A to be present for '${action}'`,
      );
      for (const report of evAReports) {
        assert.equal(
          report.status, "pending",
          `Report ${report.id} for EVENT_ID_A must still be pending after failed event_activity_log insert for '${action}'`,
        );
      }

      // Pending reports for EVENT_ID_B must also remain untouched — a WHERE
      // clause missing the event-ID filter would resolve all pending reports
      // across all events, and checking only EVENT_A wouldn't catch it.
      const evBReports = client._db.reports.filter(
        (r: any) => r.target_id === EVENT_ID_B,
      );
      assert.equal(
        evBReports.length, 1,
        `EVENT_B must have exactly 1 seeded report for '${action}'`,
      );
      assert.equal(
        evBReports[0].status, "pending",
        `Report for EVENT_B must remain pending after '${action}' targets EVENT_A (scoping check)`,
      );
    });
  }

  for (const action of ACTIONS_NO_MUTATION) {
    it(`'${action}': returns non-200 error, no moderation_actions row written (no event mutation expected)`, async () => {
      const captureActivity: any[] = [];
      const captureModerationActions: any[] = [];
      const client = makeModerationClient({
        captureActivity,
        captureModerationActions,
        activityInsertError: true,
      });
      setClient(client);

      const { status, body } = await req(
        "PATCH",
        `/admin/events/${EVENT_ID_A}/moderate`,
        { action, reason: "activity-log-fail test" },
      );

      assert.equal(
        status, 500,
        `Expected status 500 when event_activity_log insert fails for '${action}', got ${status}`,
      );
      assert.equal(
        body.error, "db_error",
        `Expected body.error === "db_error" for '${action}', got: ${JSON.stringify(body.error)}`,
      );

      assert.equal(captureActivity.length, 0, `event_activity_log must have 0 persisted rows for '${action}'`);
      assert.equal(captureModerationActions.length, 0, `moderation_actions must have 0 rows for '${action}'`);

      // Pending reports for EVENT_ID_A must remain unresolved after a failed
      // activity log insert — warn_host does not resolve reports on success, but
      // this guards against a future regression where report-resolution is moved
      // before the audit write.
      const evAReports = client._db.reports.filter(
        (r: any) => r.target_id === EVENT_ID_A,
      );
      assert.ok(
        evAReports.length > 0,
        `Expected seeded pending reports for EVENT_ID_A to be present for '${action}'`,
      );
      for (const report of evAReports) {
        assert.equal(
          report.status, "pending",
          `Report ${report.id} for EVENT_ID_A must still be pending after failed event_activity_log insert for '${action}'`,
        );
      }
    });
  }
});

// ── Audit fail-open: moderation_actions insert failure must not surface as 500 ──

describe("PATCH /admin/events/:eventId/moderate — moderation_actions insert failure is fail-open", () => {
  it("still returns 200 with ok:true when the moderation_actions insert fails", async () => {
    const captureActivity: any[] = [];
    const captureModerationActions: any[] = [];
    const client = makeModerationClient({
      captureActivity,
      captureModerationActions,
      modInsertError: true,
    });
    setClient(client);

    const { status, body } = await req(
      "PATCH",
      `/admin/events/${EVENT_ID_A}/moderate`,
      { action: "hide", reason: "audit-fail-open test" },
    );

    assert.equal(
      status, 200,
      `moderation_actions insert failure must not surface as a 500 — got ${status}: ${JSON.stringify(body)}`,
    );
    assert.equal(body.ok, true, "response body should still have ok: true");
    assert.equal(
      body.error, undefined,
      `fail-open response must not carry an error field — got: ${JSON.stringify(body.error)}`,
    );
    assert.equal(body.action, "hide");
    assert.equal(body.eventId, EVENT_ID_A);

    // The insert was still attempted — the route must not have skipped it.
    assert.equal(
      captureModerationActions.length, 1,
      "the moderation_actions insert must have been attempted even though it failed",
    );
    assert.equal(captureModerationActions[0].action_type, "event_hide");
    assert.equal(captureModerationActions[0].performed_by, ADMIN_USER_ID);
  });
});
