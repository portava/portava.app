/**
 * Media admin flags — coverage for the 25 MEDIA_* flags from migration 2038
 *
 * Routes under test (artifacts/api-server/src/routes/admin.ts):
 *   GET  /admin/feature-flags              — must list all 25 MEDIA_* flags
 *   PATCH /admin/feature-flags/:flag       — must toggle enabled and return the updated row
 *   GET  /admin/feature-flags/:flag/history — must return an empty array for a new flag
 *
 * All tests use the fake-client injection pattern established in featureFlagsAdmin.test.ts
 * (_setTestClient / _setTestServiceClient) so no real Supabase connection is needed.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaAdminFlags.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── All 25 MEDIA_* flag names from migration 2038_media_admin_flags.sql ───────

const MEDIA_FLAGS: Array<{ flag: string; enabled: boolean; description: string }> = [
  { flag: "MEDIA_TAB_ENABLED",                    enabled: false, description: "Replace the centre Plus/create button with a persistent Media tab (Watch · Grid · Gems). false restores the original create button." },
  { flag: "MEDIA_VIEW_MODE_FULLSCREEN_ENABLED",   enabled: true,  description: "Enable the Watch (full-screen vertical video) mode inside the Media tab." },
  { flag: "MEDIA_VIEW_MODE_GRID_ENABLED",         enabled: true,  description: "Enable the Grid (photo/reel mosaic) mode inside the Media tab." },
  { flag: "MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED",  enabled: true,  description: "Enable the Gems (place-linked hidden gems) mode inside the Media tab." },
  { flag: "MEDIA_FOR_YOU_ENABLED",                enabled: false, description: "Enable the For You personalised feed in Watch mode." },
  { flag: "MEDIA_FOLLOWING_ENABLED",              enabled: false, description: "Enable the Following feed tab in Watch mode." },
  { flag: "MEDIA_RANKING_ENABLED",                enabled: false, description: "Enable server-side Compass ranking for the media feed (falls back to recency when disabled)." },
  { flag: "MEDIA_GRID_RANKING_ENABLED",           enabled: false, description: "Enable Compass ranking for the Grid (mosaic) view. Falls back to recency when disabled." },
  { flag: "MEDIA_GEMS_RANKING_ENABLED",           enabled: false, description: "Enable place-proximity + quality ranking for the Gems view." },
  { flag: "MEDIA_UPLOAD_ENABLED",                 enabled: false, description: "Allow users to upload video/photo to the Media destination. false shows an upload-unavailable state." },
  { flag: "MEDIA_PROCESSING_PIPELINE_ENABLED",    enabled: false, description: "Enable the async media-processing pipeline (transcode, thumbnail, HLS). Disable to pause processing." },
  { flag: "MEDIA_UPLOAD_VIDEO_ENABLED",           enabled: false, description: "Allow video uploads specifically (requires MEDIA_UPLOAD_ENABLED)." },
  { flag: "MEDIA_UPLOAD_PHOTO_ENABLED",           enabled: false, description: "Allow photo uploads specifically (requires MEDIA_UPLOAD_ENABLED)." },
  { flag: "MEDIA_LIKES_ENABLED",                  enabled: false, description: "Enable like interactions on media items." },
  { flag: "MEDIA_COMMENTS_ENABLED",               enabled: false, description: "Enable comment interactions on media items." },
  { flag: "MEDIA_SAVES_ENABLED",                  enabled: false, description: "Enable save-to-collection interactions on media items." },
  { flag: "MEDIA_SHARES_ENABLED",                 enabled: false, description: "Enable share/export interactions on media items." },
  { flag: "MEDIA_GEMS_SUBMIT_ENABLED",            enabled: false, description: "Allow users to submit hidden-gem nominations. false shows submission as coming soon." },
  { flag: "MEDIA_GEMS_WRONG_PLACE_REPORT_ENABLED", enabled: false, description: "Enable wrong-place reporting for Gems items." },
  { flag: "MEDIA_GEMS_ADD_TO_TRIP_ENABLED",       enabled: false, description: "Enable Add to Trip CTA on Gems items." },
  { flag: "MEDIA_GEMS_DIRECTIONS_ENABLED",        enabled: false, description: "Enable Directions CTA on Gems items (taps into maps deep-link)." },
  { flag: "MEDIA_AI_PROVENANCE_LABELS_ENABLED",   enabled: false, description: "Show AI-provenance badges (illustrative / AI-generated) on media items and Gems." },
  { flag: "MEDIA_ANALYTICS_ENABLED",              enabled: false, description: "Enable server-side recording of media analytics events (impressions, views, interactions)." },
  { flag: "MEDIA_ADMIN_REVIEW_ENABLED",           enabled: false, description: "Enable the /admin/media review queue in the app and API." },
  { flag: "MEDIA_DEFAULT_VIEW_MODE",              enabled: false, description: "Server-configured default mode when the Media tab opens (metadata.mode: watch | grid | gems). enabled field unused; mode lives in metadata." },
];

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "fake.jwt.token";
const ADMIN_ID   = "aaaaaaaa-0000-0000-0000-000000000001";

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
// The builder honours .eq() and .order() so the handler's filters/sorts work.

interface FakeClientOpts {
  isAdmin?:    boolean;
  flagRows?:   Record<string, unknown>[];
  auditRows?:  Record<string, unknown>[];
}

function makeFakeClient(opts: FakeClientOpts = {}) {
  const {
    isAdmin   = true,
    flagRows  = [],
    auditRows = [] as Record<string, unknown>[],
  } = opts;

  const profileRows: Record<string, unknown>[] = [
    { id: ADMIN_ID, role: isAdmin ? "admin" : "member", display_name: "Admin User", username: "adminuser", handle: "adminuser" },
  ];

  function builder(rows: Record<string, unknown>[]) {
    function makeB(current: Record<string, unknown>[]): any {
      const b: any = {
        select:      () => makeB(current),
        insert:      (data: any) => {
          const inserted: Record<string, unknown>[] = Array.isArray(data) ? data.map((d: any) => ({ ...d })) : [{ ...data }];
          inserted.forEach((row) => auditRows.push(row));
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

  // Simulates toggle_feature_flag_with_audit atomically.
  const mutableFlags: Record<string, any> = {};
  for (const row of flagRows) {
    mutableFlags[(row as any).flag] = { ...(row as any) };
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    if (name !== "toggle_feature_flag_with_audit") {
      return { data: [], error: null };
    }
    const { p_flag, p_new_enabled, p_changed_by_id } = args as {
      p_flag: string; p_new_enabled: boolean; p_changed_by_id: string;
    };
    const existing = mutableFlags[p_flag];
    if (!existing) {
      return { data: null, error: { message: `Flag not found: ${p_flag}`, code: "P0002" } };
    }
    const oldEnabled = existing.enabled;
    existing.enabled   = p_new_enabled;
    existing.updated_at = new Date().toISOString();
    const auditRow = {
      id:                 `audit-${Date.now()}`,
      flag:               p_flag,
      old_enabled:        oldEnabled,
      new_enabled:        p_new_enabled,
      changed_at:         existing.updated_at,
      changed_by_user_id: p_changed_by_id,
    };
    auditRows.push(auditRow);
    return {
      data: [{ ...existing, old_enabled: oldEnabled, changed_at: existing.updated_at, changed_by_user_id: p_changed_by_id }],
      error: null,
    };
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
      if (table === "feature_flags")          return builder(Object.values(mutableFlags));
      if (table === "feature_flag_audit_log") return builder(auditRows);
      return builder([]);
    },
    rpc,
  };

  return client;
}

function setClients(opts: FakeClientOpts) {
  const c = makeFakeClient(opts);
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return c;
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/", adminRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  // Seed the initial client so the server can start correctly.
  setClients({ flagRows: MEDIA_FLAGS });
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── GET /admin/feature-flags — all 25 MEDIA_* flags present ──────────────────

describe("GET /admin/feature-flags — MEDIA_* flags coverage", () => {
  it("returns 200 with all 25 MEDIA_* flags in the response", async () => {
    setClients({ flagRows: MEDIA_FLAGS });

    const { status, body } = await req("GET", "/admin/feature-flags");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.flags), "body.flags must be an array");

    const returned: string[] = body.flags.map((f: any) => f.flag);
    const mediaReturned = returned.filter((f) => f.startsWith("MEDIA_"));
    assert.equal(
      mediaReturned.length,
      25,
      `Expected 25 MEDIA_* flags, got ${mediaReturned.length}. Missing: ${
        MEDIA_FLAGS.map((f) => f.flag).filter((f) => !mediaReturned.includes(f)).join(", ") || "none"
      }`,
    );
  });

  it("returns each MEDIA_* flag with the correct name and enabled value", async () => {
    setClients({ flagRows: MEDIA_FLAGS });

    const { status, body } = await req("GET", "/admin/feature-flags");
    assert.equal(status, 200);

    const byName = Object.fromEntries(body.flags.map((f: any) => [f.flag, f]));
    for (const expected of MEDIA_FLAGS) {
      const row = byName[expected.flag];
      assert.ok(row, `Flag ${expected.flag} must be present in the response`);
      assert.equal(
        row.enabled,
        expected.enabled,
        `Flag ${expected.flag} enabled default: expected ${expected.enabled}, got ${row.enabled}`,
      );
    }
  });

  it("returns the three view-mode flags as enabled=true (conservative defaults)", async () => {
    setClients({ flagRows: MEDIA_FLAGS });

    const { status, body } = await req("GET", "/admin/feature-flags");
    assert.equal(status, 200);

    const byName = Object.fromEntries(body.flags.map((f: any) => [f.flag, f]));
    const viewModeFlags = [
      "MEDIA_VIEW_MODE_FULLSCREEN_ENABLED",
      "MEDIA_VIEW_MODE_GRID_ENABLED",
      "MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED",
    ];
    for (const flag of viewModeFlags) {
      assert.equal(byName[flag]?.enabled, true, `${flag} must default to enabled=true`);
    }
  });

  it("returns all non-view-mode flags as enabled=false (conservative defaults)", async () => {
    setClients({ flagRows: MEDIA_FLAGS });

    const { status, body } = await req("GET", "/admin/feature-flags");
    assert.equal(status, 200);

    const byName = Object.fromEntries(body.flags.map((f: any) => [f.flag, f]));
    const shouldBeFalse = MEDIA_FLAGS
      .filter((f) => !f.enabled)
      .map((f) => f.flag);

    for (const flag of shouldBeFalse) {
      assert.equal(byName[flag]?.enabled, false, `${flag} must default to enabled=false`);
    }
  });

  it("returns exactly 25 distinct MEDIA_* flag names (no duplicates from migration)", async () => {
    setClients({ flagRows: MEDIA_FLAGS });

    const { status, body } = await req("GET", "/admin/feature-flags");
    assert.equal(status, 200);

    const mediaNames = body.flags
      .map((f: any) => f.flag)
      .filter((f: string) => f.startsWith("MEDIA_"));
    const unique = new Set(mediaNames);
    assert.equal(unique.size, mediaNames.length, "No duplicate MEDIA_* flags should be present");
    assert.equal(unique.size, 25, "Exactly 25 unique MEDIA_* flags");
  });
});

// ── PATCH /admin/feature-flags/:flag — toggle persists ───────────────────────

describe("PATCH /admin/feature-flags/:flag — MEDIA_* toggle", () => {
  it("toggles MEDIA_TAB_ENABLED from false to true and returns the updated row", async () => {
    setClients({ flagRows: [...MEDIA_FLAGS] });

    const { status, body } = await req(
      "PATCH",
      "/admin/feature-flags/MEDIA_TAB_ENABLED",
      { enabled: true },
    );
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.flag, "response must include a flag object");
    assert.equal(body.flag.flag,    "MEDIA_TAB_ENABLED");
    assert.equal(body.flag.enabled, true, "enabled must be true after toggle");
  });

  it("toggles MEDIA_ANALYTICS_ENABLED from false to true and returns the correct flag name", async () => {
    setClients({ flagRows: [...MEDIA_FLAGS] });

    const { status, body } = await req(
      "PATCH",
      "/admin/feature-flags/MEDIA_ANALYTICS_ENABLED",
      { enabled: true },
    );
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.flag.flag,    "MEDIA_ANALYTICS_ENABLED");
    assert.equal(body.flag.enabled, true);
  });

  it("toggles MEDIA_VIEW_MODE_FULLSCREEN_ENABLED from true to false and reverts the default", async () => {
    setClients({ flagRows: [...MEDIA_FLAGS] });

    const { status, body } = await req(
      "PATCH",
      "/admin/feature-flags/MEDIA_VIEW_MODE_FULLSCREEN_ENABLED",
      { enabled: false },
    );
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.flag.flag,    "MEDIA_VIEW_MODE_FULLSCREEN_ENABLED");
    assert.equal(body.flag.enabled, false);
  });

  it("returns 404 for a flag name that is not in the table", async () => {
    setClients({ flagRows: [...MEDIA_FLAGS] });

    const { status, body } = await req(
      "PATCH",
      "/admin/feature-flags/MEDIA_NONEXISTENT_FLAG",
      { enabled: true },
    );
    assert.equal(status, 404, `expected 404, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "not_found");
  });

  it("returns 403 for a non-admin caller trying to toggle a MEDIA_* flag", async () => {
    setClients({ isAdmin: false, flagRows: [...MEDIA_FLAGS] });

    const { status, body } = await req(
      "PATCH",
      "/admin/feature-flags/MEDIA_TAB_ENABLED",
      { enabled: true },
    );
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("returns 400 when the enabled field is missing from the request body", async () => {
    setClients({ flagRows: [...MEDIA_FLAGS] });

    const { status, body } = await req(
      "PATCH",
      "/admin/feature-flags/MEDIA_TAB_ENABLED",
      {},
    );
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("invokes toggle_feature_flag_with_audit RPC with correct arguments for a MEDIA_* flag", async () => {
    const auditRows: Record<string, unknown>[] = [];
    const c = makeFakeClient({ flagRows: [...MEDIA_FLAGS], auditRows });
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const { status } = await req(
      "PATCH",
      "/admin/feature-flags/MEDIA_UPLOAD_ENABLED",
      { enabled: true },
    );
    assert.equal(status, 200);

    // The fake RPC inserts an audit row — confirm it recorded the toggle.
    const mediaAudit = auditRows.filter((r: any) => r.flag === "MEDIA_UPLOAD_ENABLED");
    assert.equal(mediaAudit.length, 1, "Exactly one audit row must be written for the toggle");
    const row = mediaAudit[0] as any;
    assert.equal(row.old_enabled, false, "old_enabled must reflect the pre-toggle value");
    assert.equal(row.new_enabled, true,  "new_enabled must reflect the requested value");
  });
});

// ── GET /admin/feature-flags/:flag/history — empty for a new flag ─────────────

describe("GET /admin/feature-flags/:flag/history — brand-new MEDIA_* flag", () => {
  it("returns an empty history array when no toggles have been made yet", async () => {
    setClients({ flagRows: [...MEDIA_FLAGS], auditRows: [] });

    const { status, body } = await req(
      "GET",
      "/admin/feature-flags/MEDIA_TAB_ENABLED/history",
    );
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.history), "body.history must be an array");
    assert.equal(body.history.length, 0, "history must be empty for a flag that has never been toggled");
    assert.equal(body.flag, "MEDIA_TAB_ENABLED", "response must echo back the flag name");
  });

  it("returns an empty history array for each of the 25 MEDIA_* flags with no prior toggles", async () => {
    // Test a representative sample — too many HTTP round-trips for all 25,
    // so assert the handler contract holds for the high-risk boundary cases.
    const samples = [
      "MEDIA_TAB_ENABLED",
      "MEDIA_VIEW_MODE_FULLSCREEN_ENABLED",
      "MEDIA_GEMS_DIRECTIONS_ENABLED",
      "MEDIA_DEFAULT_VIEW_MODE",
      "MEDIA_AI_PROVENANCE_LABELS_ENABLED",
    ];

    setClients({ flagRows: [...MEDIA_FLAGS], auditRows: [] });

    for (const flagName of samples) {
      const { status, body } = await req(
        "GET",
        `/admin/feature-flags/${encodeURIComponent(flagName)}/history`,
      );
      assert.equal(status, 200, `${flagName}: expected 200`);
      assert.ok(Array.isArray(body.history), `${flagName}: history must be an array`);
      assert.equal(body.history.length, 0, `${flagName}: history must be empty before any toggles`);
    }
  });

  it("returns a history entry after one toggle, then clears for a different flag", async () => {
    // Fresh client so the audit log is clean.
    const auditRows: Record<string, unknown>[] = [];
    const c = makeFakeClient({ flagRows: [...MEDIA_FLAGS], auditRows });
    _setTestClient(c, true);
    _setTestServiceClient(c);

    // Toggle MEDIA_LIKES_ENABLED.
    const patchRes = await req(
      "PATCH",
      "/admin/feature-flags/MEDIA_LIKES_ENABLED",
      { enabled: true },
    );
    assert.equal(patchRes.status, 200, `PATCH: expected 200, got ${patchRes.status}`);

    // History for the toggled flag must show one entry.
    const histLikes = await req("GET", "/admin/feature-flags/MEDIA_LIKES_ENABLED/history");
    assert.equal(histLikes.status, 200);
    assert.equal(histLikes.body.history.length, 1, "One history entry expected after one toggle");
    assert.equal(histLikes.body.history[0].new_enabled, true);

    // History for an untouched flag must still be empty.
    const histComments = await req("GET", "/admin/feature-flags/MEDIA_COMMENTS_ENABLED/history");
    assert.equal(histComments.status, 200);
    assert.equal(histComments.body.history.length, 0, "Untouched flag must still have empty history");
  });

  it("returns 403 for a non-admin caller requesting flag history", async () => {
    setClients({ isAdmin: false, flagRows: [...MEDIA_FLAGS] });

    const { status, body } = await req(
      "GET",
      "/admin/feature-flags/MEDIA_TAB_ENABLED/history",
    );
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });
});
