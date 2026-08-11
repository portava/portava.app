/**
 * Feature-flag audit log tests
 *
 * Routes under test:
 *   PATCH /admin/feature-flags/:flag         — toggle + atomic audit insert via RPC
 *   GET   /admin/feature-flags/:flag/history — paginated audit log with display-name join
 *
 * Invariants:
 *   - PATCH writes an audit row to feature_flag_audit_log with correct
 *     old_enabled / new_enabled / changed_by_user_id
 *   - PATCH on a non-existent flag returns 404 and writes NO audit row
 *   - GET /history returns rows newest-first (changed_at DESC) with
 *     changed_by_name resolved from profiles
 *   - GET /history respects the `limit` query param (default 20, max 100)
 *
 * Run:
 *   node --import tsx/esm --test src/test/featureFlagAudit.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "fake.jwt.token";
const ADMIN_ID   = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_B_ID  = "bbbbbbbb-0000-0000-0000-000000000002";

// ── HTTP helper ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r       = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": `Bearer ${FAKE_TOKEN}`,
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

// ── Fake client factory ───────────────────────────────────────────────────────

interface FakeClientOpts {
  isAdmin?:         boolean;
  /** Rows pre-seeded in feature_flag_audit_log (mutable — RPC appends to it). */
  auditRows?:       Record<string, unknown>[];
  /** Flags known to the system: flag name → { enabled, description }. */
  knownFlags?:      Record<string, { enabled: boolean; description?: string }>;
  /** Extra profile rows beyond the two built-in ones. */
  extraProfiles?:   Record<string, unknown>[];
}

function makeFakeClient(opts: FakeClientOpts = {}) {
  const {
    isAdmin       = true,
    auditRows     = [],
    knownFlags    = {},
    extraProfiles = [],
  } = opts;

  const adminProfile = {
    id:           ADMIN_ID,
    role:         isAdmin ? "admin" : "member",
    display_name: "Admin User",
    username:     "adminuser",
    handle:       "adminuser",
  };
  const userBProfile = {
    id:           USER_B_ID,
    role:         "member",
    display_name: "User B",
    username:     "userb",
    handle:       "userb",
  };
  const allProfiles: Record<string, unknown>[] = [
    adminProfile,
    userBProfile,
    ...extraProfiles,
  ];

  // ── Builder that supports real ordering and limit ─────────────────────────

  function builder(rows: Record<string, unknown>[]) {
    function makeB(current: Record<string, unknown>[]): any {
      let _orderCol: string | null       = null;
      let _orderAsc: boolean             = true;

      const b: any = {
        select:      () => makeB(current),
        insert:      (data: any) => {
          const inserted: Record<string, unknown>[] = Array.isArray(data)
            ? data.map((d: any) => ({ ...d }))
            : [{ ...data }];
          // Mutate the original rows array so callers can inspect it.
          inserted.forEach((row) => auditRows.push(row));
          return makeB(inserted);
        },
        update:      (data: any) => makeB(current.map((r) => ({ ...r, ...data }))),
        upsert:      (data: any) => {
          const upserted: Record<string, unknown>[] = Array.isArray(data)
            ? data.map((d: any) => ({ ...d }))
            : [{ ...data }];
          return makeB(upserted);
        },
        delete:      () => makeB([]),
        eq:          (col: string, val: any) => makeB(current.filter((r) => (r as any)[col] == val)),
        neq:         (col: string, val: any) => makeB(current.filter((r) => (r as any)[col] != val)),
        is:          (col: string, val: any) => makeB(
          val === null
            ? current.filter((r) => (r as any)[col] == null)
            : current.filter((r) => (r as any)[col] == val),
        ),
        in:          (col: string, vals: any[]) => makeB(current.filter((r) => vals.includes((r as any)[col]))),
        ilike:       (col: string, pat: string) => {
          const lower = pat.replace(/%/g, "").toLowerCase();
          return makeB(current.filter((r) => String((r as any)[col] ?? "").toLowerCase().includes(lower)));
        },
        or:          () => makeB(current),
        not:         () => makeB(current),
        gt:          () => makeB(current),
        lt:          () => makeB(current),
        gte:         () => makeB(current),
        lte:         () => makeB(current),
        like:        () => makeB(current),
        order:       (col: string, opts?: { ascending?: boolean }) => {
          _orderCol = col;
          _orderAsc = opts?.ascending ?? true;
          const sorted = [...current].sort((a, b) => {
            const av = String((a as any)[col] ?? "");
            const bv = String((b as any)[col] ?? "");
            return _orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
          return makeB(sorted);
        },
        limit:       (n: number) => makeB(current.slice(0, n)),
        range:       () => makeB(current),
        then:        (resolve: any) => Promise.resolve({ data: current, error: null, count: current.length }).then(resolve),
        single:      () => ({ data: current[0] ?? null, error: current.length ? null : { message: "no rows" } }),
        maybeSingle: () => ({ data: current[0] ?? null, error: null }),
        get count()  { return current.length; },
      };
      return b;
    }
    return makeB(rows.map((r) => ({ ...r })));
  }

  // ── RPC that simulates toggle_feature_flag_with_audit ────────────────────
  //
  // The real Postgres function atomically updates feature_flags AND inserts
  // an audit row.  Here we replicate that logic in the fake so tests can
  // assert audit-table state after the request.

  async function rpc(name: string, args: Record<string, unknown>) {
    if (name !== "toggle_feature_flag_with_audit") {
      return { data: [], error: null };
    }

    const { p_flag, p_new_enabled, p_changed_by_id } = args as {
      p_flag: string;
      p_new_enabled: boolean;
      p_changed_by_id: string;
    };

    if (!knownFlags[p_flag]) {
      return { data: null, error: { message: "Flag not found", code: "P0002" } };
    }

    const oldEnabled  = knownFlags[p_flag].enabled;
    const description = knownFlags[p_flag].description ?? null;
    const now         = new Date().toISOString();

    // Simulate the atomic audit insert.
    auditRows.push({
      id:                 `audit-${Date.now()}`,
      flag:               p_flag,
      old_enabled:        oldEnabled,
      new_enabled:        p_new_enabled,
      changed_at:         now,
      changed_by_user_id: p_changed_by_id,
    });

    // Mutate the in-memory flag state.
    knownFlags[p_flag].enabled = p_new_enabled;

    const resultRow = {
      flag:        p_flag,
      enabled:     p_new_enabled,
      description,
      updated_at:  now,
      changed_at:  now,
      old_enabled: oldEnabled,
    };
    return { data: [resultRow], error: null };
  }

  // ── Client ────────────────────────────────────────────────────────────────

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (!token || token === "bad") {
          return { data: { user: null }, error: { message: "invalid token" } };
        }
        return { data: { user: { id: ADMIN_ID } }, error: null };
      },
      admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
    },
    storage: {
      from: () => ({
        remove:       async () => ({ error: null }),
        upload:       async () => ({ data: null, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
      }),
    },
    from: (table: string) => {
      if (table === "profiles")               return builder(allProfiles);
      if (table === "feature_flag_audit_log") return builder(auditRows);
      return builder([]);
    },
    rpc,
  };

  return { client, auditRows, knownFlags };
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });

  const { client } = makeFakeClient({});
  _setTestClient(client, true);
  _setTestServiceClient(client);

  app.use("/", adminRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Feature flag audit log", () => {
  // ── PATCH — successful toggle ──────────────────────────────────────────────

  describe("PATCH /admin/feature-flags/:flag — successful toggle", () => {
    it("writes an audit row with correct old_enabled / new_enabled / changed_by_user_id", async () => {
      const auditRows: Record<string, unknown>[] = [];
      const { client } = makeFakeClient({
        knownFlags: { some_flag: { enabled: false, description: "A test flag" } },
        auditRows,
      });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("PATCH", "/admin/feature-flags/some_flag", { enabled: true });
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

      // Audit row must have been written by the RPC simulation.
      assert.equal(auditRows.length, 1, "exactly one audit row written");
      const auditRow = auditRows[0] as any;
      assert.equal(auditRow.flag,               "some_flag", "audit.flag");
      assert.equal(auditRow.old_enabled,        false,       "audit.old_enabled (was false before toggle)");
      assert.equal(auditRow.new_enabled,        true,        "audit.new_enabled (toggled to true)");
      assert.equal(auditRow.changed_by_user_id, ADMIN_ID,   "audit.changed_by_user_id is the admin");
    });

    it("returns the correct response shape with old/new enabled and changed_by_name", async () => {
      const { client } = makeFakeClient({
        knownFlags: { some_flag: { enabled: true, description: "A test flag" } },
      });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("PATCH", "/admin/feature-flags/some_flag", { enabled: false });
      assert.equal(r.status, 200);

      const flag = r.body?.flag;
      assert.ok(flag,                          "response has flag object");
      assert.equal(flag.flag,      "some_flag", "flag.flag");
      assert.equal(flag.enabled,   false,        "flag.enabled reflects new value");
      const lc = flag.last_change;
      assert.ok(lc,                             "last_change block present");
      assert.equal(lc.old_enabled, true,        "old_enabled was true");
      assert.equal(lc.new_enabled, false,       "new_enabled is false");
      assert.ok("changed_by_name" in lc,        "changed_by_name field present");
    });

    it("returns 400 when body is missing the enabled field", async () => {
      const { client } = makeFakeClient({});
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("PATCH", "/admin/feature-flags/some_flag", {});
      assert.equal(r.status, 400);
      assert.equal(r.body?.error, "invalid_payload");
    });

    it("returns 400 when enabled is not a boolean", async () => {
      const { client } = makeFakeClient({});
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("PATCH", "/admin/feature-flags/some_flag", { enabled: "yes" });
      assert.equal(r.status, 400);
      assert.equal(r.body?.error, "invalid_payload");
    });
  });

  // ── PATCH — non-existent flag ──────────────────────────────────────────────

  describe("PATCH /admin/feature-flags/:flag — non-existent flag", () => {
    it("returns 404 and writes NO audit row for an unknown flag", async () => {
      const auditRows: Record<string, unknown>[] = [];
      // knownFlags intentionally empty — flag does not exist.
      const { client } = makeFakeClient({ knownFlags: {}, auditRows });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("PATCH", "/admin/feature-flags/nonexistent_flag", { enabled: true });

      assert.equal(r.status, 404, `expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "not_found");

      // No audit row must be written when the flag doesn't exist.
      assert.equal(auditRows.length, 0, "no audit row written for non-existent flag");
    });

    it("returns 403 when caller is not admin — no RPC, no audit row", async () => {
      const auditRows: Record<string, unknown>[] = [];
      const { client } = makeFakeClient({ isAdmin: false, auditRows });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("PATCH", "/admin/feature-flags/some_flag", { enabled: true });
      assert.equal(r.status, 403);
      assert.equal(auditRows.length, 0, "no audit row written for non-admin caller");
    });
  });

  // ── PATCH — inert freeze_* flags are blocked ────────────────────────────────
  //
  // freeze_city/freeze_event/freeze_circle/freeze_booking have no code reader.
  // Toggling them must be rejected outright (400 not_operational) rather than
  // silently "succeeding" and writing an audit row for a switch that does
  // nothing — that would give an operator false confidence during an incident.

  describe("PATCH /admin/feature-flags/:flag — inert freeze_* flags are blocked", () => {
    for (const flag of ["freeze_city", "freeze_event", "freeze_circle", "freeze_booking"]) {
      it(`returns 400 not_operational for ${flag} and writes no audit row`, async () => {
        const auditRows: Record<string, unknown>[] = [];
        // The row still exists in knownFlags (DB retirement is a separate,
        // out-of-scope migration) — the route itself must still refuse it.
        const { client } = makeFakeClient({
          knownFlags: { [flag]: { enabled: false, description: "Inert freeze switch" } },
          auditRows,
        });
        _setTestClient(client, true);
        _setTestServiceClient(client);

        const r = await req("PATCH", `/admin/feature-flags/${flag}`, { enabled: true });

        assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body?.error, "not_operational");
        assert.equal(auditRows.length, 0, `no audit row written for ${flag}`);
      });
    }
  });

  // ── GET /history ───────────────────────────────────────────────────────────

  describe("GET /admin/feature-flags/:flag/history", () => {
    it("returns rows newest-first (changed_at DESC) with changed_by_name resolved", async () => {
      // Seed rows in a deliberately non-sorted order so the test proves ordering.
      const auditRows: Record<string, unknown>[] = [
        {
          id:                 "r3",
          flag:               "some_flag",
          old_enabled:        false,
          new_enabled:        true,
          changed_at:         "2026-07-06T10:00:00Z", // oldest
          changed_by_user_id: ADMIN_ID,
        },
        {
          id:                 "r1",
          flag:               "some_flag",
          old_enabled:        false,
          new_enabled:        true,
          changed_at:         "2026-07-06T12:00:00Z", // newest
          changed_by_user_id: ADMIN_ID,
        },
        {
          id:                 "r2",
          flag:               "some_flag",
          old_enabled:        true,
          new_enabled:        false,
          changed_at:         "2026-07-06T11:00:00Z", // middle
          changed_by_user_id: USER_B_ID,
        },
      ];
      const { client } = makeFakeClient({ auditRows });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags/some_flag/history");

      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.flag, "some_flag", "flag name echoed");
      assert.ok(Array.isArray(r.body?.history), "history is an array");
      assert.equal(r.body.history.length, 3, "all 3 rows returned");

      // Assert DESC ordering by changed_at.
      const timestamps = r.body.history.map((e: any) => e.changed_at);
      assert.deepEqual(
        timestamps,
        [...timestamps].sort((a, b) => b.localeCompare(a)),
        "rows are in newest-first (DESC) order",
      );

      // The first row should be the newest (r1).
      const first = r.body.history[0];
      assert.equal(first.id, "r1", "first row is the newest entry");
      assert.equal(first.old_enabled, false);
      assert.equal(first.new_enabled, true);

      // changed_by_name resolved: ADMIN_ID → "Admin User"
      assert.equal(first.changed_by_name, "Admin User", "display name resolved for admin");
      assert.equal(first.changed_by_user_id, ADMIN_ID);

      // Second row: USER_B_ID → "User B"
      const second = r.body.history[1];
      assert.equal(second.id, "r2");
      assert.equal(second.changed_by_name, "User B", "display name resolved for user B");
    });

    it("respects the limit query param", async () => {
      const auditRows: Record<string, unknown>[] = [
        { id: "r1", flag: "some_flag", old_enabled: false, new_enabled: true,  changed_at: "2026-07-06T12:00:00Z", changed_by_user_id: ADMIN_ID },
        { id: "r2", flag: "some_flag", old_enabled: true,  new_enabled: false, changed_at: "2026-07-06T11:00:00Z", changed_by_user_id: ADMIN_ID },
        { id: "r3", flag: "some_flag", old_enabled: false, new_enabled: true,  changed_at: "2026-07-06T10:00:00Z", changed_by_user_id: ADMIN_ID },
      ];
      const { client } = makeFakeClient({ auditRows });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags/some_flag/history?limit=2");
      assert.equal(r.status, 200);
      assert.equal(r.body.history.length, 2, "only 2 rows returned when limit=2");
    });

    it("returns empty history for a flag with no audit rows", async () => {
      const { client } = makeFakeClient({ auditRows: [] });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags/some_flag/history");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.history, [], "empty array for flag with no history");
    });

    it("defaults limit to 20 when not supplied", async () => {
      const manyRows: Record<string, unknown>[] = Array.from({ length: 25 }, (_, i) => ({
        id:                 `r${String(i).padStart(3, "0")}`,
        flag:               "some_flag",
        old_enabled:        false,
        new_enabled:        true,
        changed_at:         `2026-07-06T${String(i).padStart(2, "0")}:00:00Z`,
        changed_by_user_id: ADMIN_ID,
      }));
      const { client } = makeFakeClient({ auditRows: manyRows });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags/some_flag/history");
      assert.equal(r.status, 200);
      assert.equal(r.body.history.length, 20, "default limit of 20 applied");
    });

    it("caps limit at 100 even when caller supplies a larger value", async () => {
      const manyRows: Record<string, unknown>[] = Array.from({ length: 150 }, (_, i) => ({
        id:                 `r${String(i).padStart(3, "0")}`,
        flag:               "some_flag",
        old_enabled:        false,
        new_enabled:        true,
        changed_at:         `2026-07-06T${String(i).padStart(2, "0")}:00:00Z`,
        changed_by_user_id: ADMIN_ID,
      }));
      const { client } = makeFakeClient({ auditRows: manyRows });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags/some_flag/history?limit=9999");
      assert.equal(r.status, 200);
      assert.equal(r.body.history.length, 100, "limit capped at 100");
    });

    it("returns 403 when caller is not admin", async () => {
      const { client } = makeFakeClient({ isAdmin: false });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags/some_flag/history");
      assert.equal(r.status, 403);
    });
  });
});
