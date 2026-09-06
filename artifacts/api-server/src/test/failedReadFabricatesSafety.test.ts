/**
 * A failed read must not fabricate a safety verdict.
 *
 * supabase-js RESOLVES `{ data, error }` — it does not throw. Every site below
 * bound only `data`, so an unreadable table arrived as `undefined`, was
 * coalesced to `[]` or `0`, and was then presented in the voice of a clean
 * measurement. These tests inject a read ERROR (not an exception, not an empty
 * table) and assert the surface refuses to speak as if it had measured.
 *
 * Sites covered here:
 *   1. safeReturn  — geo_zones caution lookup (a safety verdict)
 *   2. accountDeletion — moderation_reports (an irreversible hard delete)
 *   3. geofence    — plan_checkins / trip_members (an attendance sheet)
 *   4. geofence    — geofence_admin_settings (an admin-set max radius)
 *
 * Run:
 *   node --import tsx/esm --test src/test/failedReadFabricatesSafety.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import safeReturnRouter from "../routes/safeReturn.js";
import geofenceRouter from "../routes/geofence.js";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";

const USER_ID  = "aaaaaaaa-1111-1111-1111-000000000001";
const TRIP_ID  = "bbbbbbbb-2222-2222-2222-000000000002";
const ITEM_ID  = "cccccccc-3333-3333-3333-000000000003";
const TOKEN    = "fake.jwt.token";

/** The shape supabase-js actually hands back on a failed read. */
const READ_ERROR = { message: "permission denied for relation", code: "42501" };

let server: http.Server;
let base: string;

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(
  method: "GET" | "POST",
  path: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = {
      "content-type":  "application/json",
      "authorization": `Bearer ${TOKEN}`,
    };
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
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

/**
 * A chainable, thenable fake client. `rows` supplies successful reads per table;
 * `failTables` makes those tables resolve `{ data: null, error }` — the exact
 * failure mode the production code used to read as "clean".
 */
function makeClient(opts: {
  rows?: Record<string, any[]>;
  singles?: Record<string, any>;
  failTables?: Set<string>;
  flagEnabled?: boolean;
}) {
  const rows       = opts.rows ?? {};
  const singles    = opts.singles ?? {};
  const failTables = opts.failTables ?? new Set<string>();

  function builder(table: string) {
    const fails = failTables.has(table);
    const result = () =>
      fails
        ? { data: null, error: READ_ERROR, count: null }
        : { data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length };

    const b: any = {
      select: () => b, eq: () => b, neq: () => b, is: () => b, in: () => b,
      not: () => b, or: () => b, gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      order: () => b, limit: () => b, range: () => b, ilike: () => b,
      update: () => b, insert: () => b, upsert: () => b, delete: () => b,
      maybeSingle: async () =>
        fails
          ? { data: null, error: READ_ERROR }
          : { data: singles[table] ?? null, error: null },
      single: async () =>
        fails
          ? { data: null, error: READ_ERROR }
          : { data: singles[table] ?? null, error: null },
      then: (resolve: any) => Promise.resolve(result()).then(resolve),
    };
    return b;
  }

  return {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
    },
    from: (table: string) => builder(table),
    rpc: async () => ({ data: [], error: null }),
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
  } as any;
}

/**
 * Both routers read their gate with `.from("feature_flags").eq("flag", …).maybeSingle()`,
 * so the flag lives in the fake client's SINGLES map, not its rows map.
 */
const FLAG_ON = { enabled: true };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", safeReturnRouter);
  app.use("/", geofenceRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── Site 1 — Safe Return: a safety verdict off an unread geo_zones ────────────

describe("safeReturn: an unreadable geo_zones must not report 'no caution'", () => {
  const singles = {
    trip_plan_items: {
      id: ITEM_ID, category: "dining", starts_at: "2026-09-06T13:00:00Z",
      day_date: "2026-09-06", location_name: "Somewhere", lat: 13.75, lng: 100.5,
      trip_id: TRIP_ID,
    },
    trip_members:          { user_id: USER_ID, role: "member", status: "accepted" },
    profiles:              { home_city: "Bangkok" },
    user_location_state:   { city: "Bangkok" },
    feature_flags:         FLAG_ON,
  };

  it("reports cautionUnknown and does NOT present a clean verdict", async () => {
    const c = makeClient({
      singles,
      failTables: new Set(["geo_zones"]),
    });
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/me/safe-return/suggest/${ITEM_ID}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // THE ASSERTION THAT FAILS ON THE OLD CODE: the verdict claimed the area
    // carried no caution, when the caution table had not been read at all.
    assert.equal(
      r.body.cautionUnknown, true,
      "an unreadable geo_zones must be reported as unknown, never as no-caution",
    );
    assert.ok(
      (r.body.reasons as string[]).includes("location_caution_unknown"),
      `reasons must name the unknown; got ${JSON.stringify(r.body.reasons)}`,
    );
    assert.equal(
      (r.body.reasons as string[]).includes("location_caution_flag"), false,
      "an unknown must not be upgraded into a positive caution finding either",
    );
    // Fail CLOSED: the safety suggestion is raised, not withheld.
    assert.equal(r.body.suggest, true, "an unknown caution must still raise Safe Return");
  });

  it("still reports a genuinely clean read as clean", async () => {
    // The fix must not turn every assessment into an unknown — a successful
    // read of an empty result is a real measurement and stays one.
    const c = makeClient({ singles, rows: { geo_zones: [] } });
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/me/safe-return/suggest/${ITEM_ID}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cautionUnknown, false, "a successful empty read is a measurement");
    assert.equal((r.body.reasons as string[]).includes("location_caution_unknown"), false);
  });

  it("an actual caution/avoid zone still flags", async () => {
    const c = makeClient({
      singles,
      rows: { geo_zones: [{ safety_rating: "avoid" }] },
    });
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/me/safe-return/suggest/${ITEM_ID}`);
    assert.ok((r.body.reasons as string[]).includes("location_caution_flag"));
    assert.equal(r.body.cautionUnknown, false);
  });
});

// ── Site 2 — Account deletion: evidence destroyed on an unread report table ───

describe("accountDeletion: an unreadable moderation_reports must not hard-delete", () => {
  /**
   * Deletion-worker fake. `failTables` makes the named table resolve an error,
   * which is what an RLS change or a statement timeout looks like from here.
   */
  function deletionClient(fx: { posts: string[]; failTables?: Set<string> }) {
    const rpcCalls: Array<{ fn: string; args: any }> = [];
    const deletes:  Array<{ table: string; eq: Record<string, unknown> }> = [];
    const updates:  Array<{ table: string; values: any; eq: Record<string, unknown> }> = [];
    const failTables = fx.failTables ?? new Set<string>();

    function builder(table: string, op: "select" | "delete" | "update", values?: any) {
      const eq: Record<string, unknown> = {};
      const api: any = {
        eq(col: string, val: unknown) { eq[col] = val; return api; },
        neq: () => api, not: () => api, is: () => api, in: () => api, or: () => api,
        gte: () => api, lte: () => api, order: () => api, limit: () => api, select: () => api,
        maybeSingle: async () => ({ data: null, error: null }),
        then(resolve: (v: any) => void) {
          if (op === "delete") deletes.push({ table, eq });
          if (op === "update") updates.push({ table, values, eq });

          if (op === "select" && failTables.has(table)) {
            resolve({ data: null, error: READ_ERROR, count: null });
            return;
          }
          let data: any[] = [];
          if (op === "select" && table === "posts") data = fx.posts.map((id) => ({ id }));
          resolve({ data, error: null, count: data.length });
        },
      };
      return api;
    }

    return {
      _rpcCalls: rpcCalls, _deletes: deletes, _updates: updates,
      from: (table: string) => ({
        select: () => builder(table, "select"),
        delete: () => builder(table, "delete"),
        update: (v: any) => builder(table, "update", v),
        upsert: async () => ({ data: null, error: null }),
      }),
      rpc: async (fn: string, args: any) => { rpcCalls.push({ fn, args }); return { data: null, error: null }; },
      storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
      auth: { admin: { deleteUser: async () => ({ data: null, error: null }) } },
    };
  }

  it("TOMBSTONES rather than hard-deletes when moderation_reports is unreadable", async () => {
    const sc = deletionClient({ posts: ["p-under-report"], failTables: new Set(["moderation_reports"]) });
    const out = await executeAccountDeletion(sc as any, USER_ID, {} as any);

    // On the old code this post was hard-deleted: `data === undefined` → `[]`
    // → "no third-party interest" → DELETE. The moderator's evidence is gone
    // and there is no way to get it back.
    assert.deepEqual(
      sc._rpcCalls.filter((c) => c.fn === "tombstone_post").map((c) => c.args.p_post_id),
      ["p-under-report"],
      "an unreadable report table must be treated as third-party interest present",
    );
    assert.equal(
      sc._deletes.some((d) => d.table === "posts" && d.eq.id === "p-under-report"), false,
      "the post must NOT be hard-deleted — the deletion is irreversible",
    );
    assert.equal(out.tombstonedCounts.posts, 1);
    assert.equal(out.deletedCounts.posts, 0);
    assert.ok(
      out.warnings.some((w) => w.includes("p-under-report") && /moderation-report check failed/.test(w)),
      `the over-preservation must be visible on the receipt; warnings: ${JSON.stringify(out.warnings)}`,
    );
  });

  it("TOMBSTONES rather than hard-deletes when posts_comments is unreadable", async () => {
    const sc = deletionClient({ posts: ["p-maybe-replied"], failTables: new Set(["posts_comments"]) });
    const out = await executeAccountDeletion(sc as any, USER_ID, {} as any);

    assert.deepEqual(
      sc._rpcCalls.filter((c) => c.fn === "tombstone_post").map((c) => c.args.p_post_id),
      ["p-maybe-replied"],
    );
    assert.equal(sc._deletes.some((d) => d.table === "posts"), false);
    assert.equal(out.deletedCounts.posts, 0);
  });

  it("still hard-deletes a post when BOTH checks genuinely read clean", async () => {
    // The fix must not become "never delete anything".
    const sc = deletionClient({ posts: ["p-lonely"] });
    const out = await executeAccountDeletion(sc as any, USER_ID, {} as any);
    assert.equal(sc._deletes.some((d) => d.table === "posts" && d.eq.id === "p-lonely"), true);
    assert.equal(out.deletedCounts.posts, 1);
    assert.equal(out.tombstonedCounts.posts, 0);
  });
});

// ── Site 6 — Geofence attendance: a fabricated "nobody arrived" sheet ─────────

describe("geofence attendance: an unreadable check-in table must not report an empty room", () => {
  const singles = {
    trips:          { owner_id: USER_ID },
    plan_geofences: { id: "gf-1", check_in_radius_m: 150, check_in_window_start: null, check_in_window_end: null },
    feature_flags:  FLAG_ON,
  };

  it("503s instead of rendering every member as not_checked_in", async () => {
    const c = makeClient({
      singles,
      rows: { trip_members: [{ user_id: USER_ID }, { user_id: "member-2" }] },
      failTables: new Set(["plan_checkins"]),
    });
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/trips/${TRIP_ID}/geofence/attendance`);

    // The old code returned 200 with totals.notCheckedIn === 2 — an attendance
    // sheet the host could act on by marking real attendees `no_show`.
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.attendees, undefined, "must not ship a fabricated attendee list");
    assert.equal(r.body?.totals, undefined, "must not ship fabricated totals");
  });

  it("503s when trip_members is unreadable", async () => {
    const c = makeClient({
      singles,
      failTables: new Set(["trip_members"]),
    });
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("GET", `/trips/${TRIP_ID}/geofence/attendance`);
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.totals, undefined);
  });
});

// ── Site 7 — Geofence settings: an admin-set max radius silently widened ──────

describe("geofence create: an unreadable settings table must not restore a 5000 m ceiling", () => {
  it("refuses the write rather than clamping against hardcoded bounds", async () => {
    const c = makeClient({
      singles: { trips: { owner_id: USER_ID }, feature_flags: FLAG_ON },
      failTables: new Set(["geofence_admin_settings"]),
    });
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("POST", `/trips/${TRIP_ID}/geofence`, {
      lat: 13.75, lng: 100.5, checkInRadiusM: 4000,
    });

    // On the old code this saved with check_in_radius_m clamped against a
    // fabricated 5000 m maximum — bypassing whatever the admin had set.
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it("still falls back when the table is genuinely ABSENT (PGRST205)", async () => {
    // An under-migrated environment has no admin intention to honour, so the
    // documented defaults are correct there — only there.
    const absent = { message: "Could not find the table", code: "PGRST205" };
    const c: any = {
      auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
      from: (table: string) => {
        const b: any = {
          select: () => b, eq: () => b, neq: () => b, is: () => b, in: () => b, not: () => b,
          or: () => b, gte: () => b, lte: () => b, order: () => b, limit: () => b, range: () => b,
          update: () => b, insert: () => b, upsert: () => b, delete: () => b,
          maybeSingle: async () => {
            if (table === "geofence_admin_settings") return { data: null, error: absent };
            if (table === "trips")                    return { data: { owner_id: USER_ID }, error: null };
            if (table === "feature_flags")            return { data: { enabled: true }, error: null };
            return { data: null, error: null };
          },
          single: async () => ({ data: null, error: null }),
          then: (resolve: any) =>
            Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
        };
        return b;
      },
      rpc: async () => ({ data: [], error: null }),
    };
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const r = await request("POST", `/trips/${TRIP_ID}/geofence`, {
      lat: 13.75, lng: 100.5, checkInRadiusM: 200,
    });
    assert.notEqual(r.status, 503, `an absent table must still fall back; got ${JSON.stringify(r.body)}`);
  });
});
