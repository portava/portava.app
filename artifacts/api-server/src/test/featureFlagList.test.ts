/**
 * GET /admin/feature-flags — last_change merge tests
 *
 * The handler enriches each flag row with the most-recent entry from
 * feature_flag_audit_log (old_enabled, new_enabled, changed_by_name).
 * These tests verify that the merge is correct and that missing history
 * leaves no last_change block on the response.
 *
 * Invariants:
 *   - A flag with audit history gets a last_change block with the correct
 *     changed_at, old_enabled, new_enabled, and changed_by_name.
 *   - When there are multiple audit rows for the same flag the most-recent
 *     one (highest changed_at) wins — not the first inserted.
 *   - A flag with no audit history returns without a last_change key.
 *   - Display-name resolution works for multiple distinct actor IDs in one
 *     response.
 *   - Non-admin callers still get 403.
 *
 * Run:
 *   node --import tsx/esm --test src/test/featureFlagList.test.ts
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
const ACTOR_B_ID = "bbbbbbbb-0000-0000-0000-000000000002";

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
//
// Supports feature_flags, feature_flag_audit_log, and profiles tables.
// The builder honours .order() so the handler's DESC sort on changed_at works
// correctly — this is critical for the "most-recent wins" invariant.

interface FakeClientOpts {
  isAdmin?:    boolean;
  flagRows?:   Record<string, unknown>[];
  auditRows?:  Record<string, unknown>[];
}

function makeFakeClient(opts: FakeClientOpts = {}) {
  const {
    isAdmin   = true,
    flagRows  = [],
    auditRows = [],
  } = opts;

  const profileRows: Record<string, unknown>[] = [
    { id: ADMIN_ID,   role: isAdmin ? "admin" : "member", display_name: "Admin User", username: "adminuser", handle: "adminuser" },
    { id: ACTOR_B_ID, role: "member", display_name: "Actor B",    username: "actorb",    handle: "actorb"    },
  ];

  function builder(rows: Record<string, unknown>[]) {
    function makeB(current: Record<string, unknown>[]): any {
      const b: any = {
        select: () => makeB(current),
        insert: (data: any) => {
          const inserted = Array.isArray(data) ? data.map((d: any) => ({ ...d })) : [{ ...data }];
          return makeB(inserted);
        },
        update:      (data: any) => makeB(current.map((r) => ({ ...r, ...data }))),
        upsert:      (data: any) => makeB(Array.isArray(data) ? data.map((d: any) => ({ ...d })) : [{ ...data }]),
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
        order: (col: string, opts?: { ascending?: boolean }) => {
          const asc = opts?.ascending ?? true;
          const sorted = [...current].sort((a, b) => {
            const av = String((a as any)[col] ?? "");
            const bv = String((b as any)[col] ?? "");
            return asc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
          return makeB(sorted);
        },
        limit:       (n: number) => makeB(current.slice(0, n)),
        range:       () => makeB(current),
        then:        (resolve: any) => Promise.resolve({ data: current.map((r) => ({ ...r })), error: null, count: current.length }).then(resolve),
        single:      () => ({ data: current[0] ? { ...current[0] } : null, error: current.length ? null : { message: "no rows" } }),
        maybeSingle: () => ({ data: current[0] ? { ...current[0] } : null, error: null }),
        get count()  { return current.length; },
      };
      return b;
    }
    return makeB(rows.map((r) => ({ ...r })));
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (!token || token === "bad") {
          return { data: { user: null }, error: { message: "invalid token" } };
        }
        return { data: { user: { id: ADMIN_ID } }, error: null };
      },
    },
    from: (table: string) => {
      if (table === "profiles")               return builder(profileRows);
      if (table === "feature_flags")          return builder(flagRows);
      if (table === "feature_flag_audit_log") return builder(auditRows);
      return builder([]);
    },
    rpc: async () => ({ data: [], error: null }),
  };

  return client;
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });

  const client = makeFakeClient({});
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

describe("GET /admin/feature-flags — last_change merge", () => {

  // ── last_change is populated from the most-recent audit entry ─────────────

  describe("flag with audit history", () => {
    it("merges last_change block with correct fields", async () => {
      const client = makeFakeClient({
        flagRows: [
          { flag: "stamps_enabled", enabled: true, description: "Stamp earning", updated_at: "2026-07-01T00:00:00Z" },
        ],
        auditRows: [
          {
            flag:               "stamps_enabled",
            old_enabled:        false,
            new_enabled:        true,
            changed_at:         "2026-07-01T12:00:00Z",
            changed_by_user_id: ADMIN_ID,
          },
        ],
      });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags");
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

      const flags = r.body?.flags;
      assert.ok(Array.isArray(flags), "flags must be an array");
      assert.equal(flags.length, 1, "one flag returned");

      const flag = flags[0];
      assert.equal(flag.flag,    "stamps_enabled", "flag name");
      assert.equal(flag.enabled, true,             "enabled value");

      const lc = flag.last_change;
      assert.ok(lc, "last_change block must be present");
      assert.equal(lc.changed_at,      "2026-07-01T12:00:00Z", "last_change.changed_at");
      assert.equal(lc.old_enabled,     false,                   "last_change.old_enabled");
      assert.equal(lc.new_enabled,     true,                    "last_change.new_enabled");
      assert.equal(lc.changed_by_name, "Admin User",            "last_change.changed_by_name resolved from profiles");
    });

    it("picks the most-recent audit entry when multiple exist for the same flag", async () => {
      const client = makeFakeClient({
        flagRows: [
          { flag: "gps_enabled", enabled: false, description: "GPS", updated_at: "2026-07-01T00:00:00Z" },
        ],
        // Rows are intentionally in a non-DESC order to prove sorting matters.
        auditRows: [
          {
            flag:               "gps_enabled",
            old_enabled:        true,
            new_enabled:        false,
            changed_at:         "2026-07-03T08:00:00Z", // most recent
            changed_by_user_id: ACTOR_B_ID,
          },
          {
            flag:               "gps_enabled",
            old_enabled:        false,
            new_enabled:        true,
            changed_at:         "2026-07-01T08:00:00Z", // oldest
            changed_by_user_id: ADMIN_ID,
          },
          {
            flag:               "gps_enabled",
            old_enabled:        true,
            new_enabled:        false,
            changed_at:         "2026-07-02T08:00:00Z", // middle
            changed_by_user_id: ADMIN_ID,
          },
        ],
      });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags");
      assert.equal(r.status, 200);

      const lc = r.body.flags[0].last_change;
      assert.ok(lc, "last_change block must be present");
      assert.equal(lc.changed_at,  "2026-07-03T08:00:00Z", "most-recent entry wins");
      assert.equal(lc.old_enabled, true,                    "old_enabled from most-recent entry");
      assert.equal(lc.new_enabled, false,                   "new_enabled from most-recent entry");
      assert.equal(lc.changed_by_name, "Actor B",           "actor resolved from most-recent entry");
    });
  });

  // ── flag with no audit history ─────────────────────────────────────────────

  describe("flag with no audit history", () => {
    it("returns the flag without a last_change block", async () => {
      const client = makeFakeClient({
        flagRows: [
          { flag: "new_feature", enabled: false, description: "New feature", updated_at: "2026-07-01T00:00:00Z" },
        ],
        auditRows: [],
      });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags");
      assert.equal(r.status, 200);

      const flags = r.body?.flags;
      assert.equal(flags.length, 1, "one flag returned");

      const flag = flags[0];
      assert.equal(flag.flag, "new_feature");
      assert.ok(!("last_change" in flag), "last_change must be absent when no audit history exists");
    });
  });

  // ── mixed: some flags have history, some do not ───────────────────────────

  describe("mixed flags — some with history, some without", () => {
    it("only enriches flags that have a matching audit entry", async () => {
      const client = makeFakeClient({
        flagRows: [
          { flag: "alpha_flag", enabled: true,  description: "Alpha", updated_at: "2026-07-01T00:00:00Z" },
          { flag: "beta_flag",  enabled: false, description: "Beta",  updated_at: "2026-07-01T00:00:00Z" },
        ],
        auditRows: [
          {
            flag:               "alpha_flag",
            old_enabled:        false,
            new_enabled:        true,
            changed_at:         "2026-07-05T09:00:00Z",
            changed_by_user_id: ADMIN_ID,
          },
          // No audit row for beta_flag.
        ],
      });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags");
      assert.equal(r.status, 200);

      const byName = Object.fromEntries(r.body.flags.map((f: any) => [f.flag, f]));

      // alpha_flag has history.
      assert.ok(byName["alpha_flag"].last_change,  "alpha_flag must have last_change");
      assert.equal(byName["alpha_flag"].last_change.changed_at, "2026-07-05T09:00:00Z");

      // beta_flag has no history.
      assert.ok(!("last_change" in byName["beta_flag"]), "beta_flag must not have last_change");
    });
  });

  // ── display-name resolution for multiple distinct actors ──────────────────

  describe("display-name resolution", () => {
    it("resolves distinct actor IDs for different flags independently", async () => {
      const client = makeFakeClient({
        flagRows: [
          { flag: "flag_a", enabled: true,  description: "Flag A", updated_at: "2026-07-01T00:00:00Z" },
          { flag: "flag_b", enabled: false, description: "Flag B", updated_at: "2026-07-01T00:00:00Z" },
        ],
        auditRows: [
          {
            flag:               "flag_a",
            old_enabled:        false,
            new_enabled:        true,
            changed_at:         "2026-07-04T10:00:00Z",
            changed_by_user_id: ADMIN_ID,
          },
          {
            flag:               "flag_b",
            old_enabled:        true,
            new_enabled:        false,
            changed_at:         "2026-07-04T11:00:00Z",
            changed_by_user_id: ACTOR_B_ID,
          },
        ],
      });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags");
      assert.equal(r.status, 200);

      const byName = Object.fromEntries(r.body.flags.map((f: any) => [f.flag, f]));

      assert.equal(byName["flag_a"].last_change.changed_by_name, "Admin User", "ADMIN_ID → Admin User");
      assert.equal(byName["flag_b"].last_change.changed_by_name, "Actor B",    "ACTOR_B_ID → Actor B");
    });

    it("sets changed_by_name to null when changed_by_user_id is null", async () => {
      const client = makeFakeClient({
        flagRows: [
          { flag: "system_flag", enabled: true, description: "System", updated_at: "2026-07-01T00:00:00Z" },
        ],
        auditRows: [
          {
            flag:               "system_flag",
            old_enabled:        false,
            new_enabled:        true,
            changed_at:         "2026-07-04T10:00:00Z",
            changed_by_user_id: null,
          },
        ],
      });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags");
      assert.equal(r.status, 200);

      const lc = r.body.flags[0].last_change;
      assert.ok(lc, "last_change present");
      assert.equal(lc.changed_by_name, null, "changed_by_name is null when no actor id");
    });
  });

  // ── access control ─────────────────────────────────────────────────────────

  describe("access control", () => {
    it("returns 403 for non-admin callers", async () => {
      const client = makeFakeClient({ isAdmin: false });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags");
      assert.equal(r.status, 403);
    });
  });

  // ── inert freeze_* flags are hidden from the admin list ────────────────────
  //
  // freeze_city/freeze_event/freeze_circle/freeze_booking are seeded rows with
  // no code reader anywhere. Showing them lets an operator "turn off" a switch
  // that does nothing and mistake silence for the feature actually stopping.
  // They must never appear in the admin flag list, even if the row still
  // exists live in feature_flags (the DB row itself is out of scope here —
  // a separate migration retires it).

  describe("HIDDEN_INERT_FLAGS — freeze_* flags excluded from the list", () => {
    it("omits freeze_city/freeze_event/freeze_circle/freeze_booking even though the rows exist", async () => {
      const client = makeFakeClient({
        flagRows: [
          { flag: "freeze_city",    enabled: false, description: "Freeze city",    updated_at: "2026-07-01T00:00:00Z" },
          { flag: "freeze_event",   enabled: false, description: "Freeze event",   updated_at: "2026-07-01T00:00:00Z" },
          { flag: "freeze_circle",  enabled: false, description: "Freeze circle",  updated_at: "2026-07-01T00:00:00Z" },
          { flag: "freeze_booking", enabled: false, description: "Freeze booking", updated_at: "2026-07-01T00:00:00Z" },
          { flag: "stamps_enabled", enabled: true,  description: "Stamp earning",  updated_at: "2026-07-01T00:00:00Z" },
        ],
      });
      _setTestClient(client, true);
      _setTestServiceClient(client);

      const r = await req("GET", "/admin/feature-flags");
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

      const names = (r.body?.flags ?? []).map((f: any) => f.flag);
      assert.ok(!names.includes("freeze_city"),    "freeze_city must not appear in the admin list");
      assert.ok(!names.includes("freeze_event"),   "freeze_event must not appear in the admin list");
      assert.ok(!names.includes("freeze_circle"),  "freeze_circle must not appear in the admin list");
      assert.ok(!names.includes("freeze_booking"), "freeze_booking must not appear in the admin list");
      assert.deepEqual(names, ["stamps_enabled"], "only the operational flag remains");
    });
  });
});
