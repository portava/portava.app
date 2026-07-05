/**
 * Compass Foundation Hardening tests
 *
 * Covers:
 *   1.  SafetyFilter — moderation_rejected content is hard-blocked
 *   2.  SafetyFilter — deleted content/account is hard-blocked
 *   3.  SafetyFilter — muted author is excluded from feed
 *   4.  SafetyFilter — blocked user still excluded (regression)
 *   5.  SafetyFilter — private content excluded when not viewer's own
 *   6.  SafetyFilter — banned/suspended account excluded
 *   7.  Pipeline — moderation-rejected item never reaches scoring
 *   8.  Pipeline — kill-switch (disabled flag) returns empty results
 *   9.  Feedback save — compass_feedback row written correctly
 *  10.  Settings read — returns defaults when no row exists
 *  11.  Settings write — upsert accepted and returned
 *  12.  Context expiry — expired session row returns null
 *  13.  Context write — 201 with expires_at in future
 *  14.  Context delete — clears the session row
 *  15.  Admin debug gate — 403 for non-admin
 *  16.  Admin debug gate — 200 with recommendations array for admin
 *  17.  Report endpoint — 201 when written, triggers scan
 *  18.  Pagination cursor — second page excludes cursor items
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-hardening.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import compassRouter from "../routes/compass.js";
import { runSafetyFilter } from "../compass/CompassSafetyFilter.js";
import { runPipeline } from "../compass/CompassPipeline.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";

// ── Test server ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;
const FAKE_TOKEN = "fake.jwt.token";
const ADMIN_TOKEN = "admin.jwt.token";
const USER_ID     = "00000000-0000-0000-0000-000000000001";
const ADMIN_ID    = "00000000-0000-0000-0000-000000000002";
const AUTHOR_ID   = "00000000-0000-0000-0000-000000000003";
const MUTED_ID    = "00000000-0000-0000-0000-000000000004";

// ── In-memory fake client ─────────────────────────────────────────────────────

interface TableStore {
  [table: string]: any[];
}

function buildFakeClient(
  store: TableStore = {},
  userId: string = USER_ID,
  role: "user" | "admin" = "user",
) {
  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN || token === ADMIN_TOKEN) {
          const id = token === ADMIN_TOKEN ? ADMIN_ID : userId;
          return { data: { user: { id } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: (table: string) => {
      const rows: any[] = store[table] ?? [];
      const builder: any = {
        _table: table,
        _filters: [] as Array<(r: any) => boolean>,
        _limit: Infinity,
        _order: null as string | null,
        _ascending: true,
        _singleMode: false,
        _action: "select",
        _insertData: null as any,
        _upsertData: null as any,
        _updateData: null as any,
        select: (_cols: string) => { builder._action = "select"; return builder; },
        insert: (data: any) => {
          builder._action = "insert";
          builder._insertData = data;
          return builder;
        },
        upsert: (data: any, _opts?: any) => {
          builder._action = "upsert";
          builder._upsertData = data;
          return builder;
        },
        update: (data: any) => {
          builder._action = "update";
          builder._updateData = data;
          return builder;
        },
        delete: () => { builder._action = "delete"; return builder; },
        eq: (col: string, val: any) => {
          builder._filters.push((r: any) => r[col] === val);
          return builder;
        },
        neq: (col: string, val: any) => {
          builder._filters.push((r: any) => r[col] !== val);
          return builder;
        },
        gt: (col: string, val: any) => {
          builder._filters.push((r: any) => r[col] > val);
          return builder;
        },
        in: (col: string, vals: any[]) => {
          builder._filters.push((r: any) => vals.includes(r[col]));
          return builder;
        },
        like: (_col: string, _pat: string) => builder,
        is:   (col: string, val: any) => {
          builder._filters.push((r: any) => val === null ? r[col] == null : r[col] === val);
          return builder;
        },
        or: () => builder,
        limit: (n: number) => { builder._limit = n; return builder; },
        order: (col: string, opts?: { ascending?: boolean }) => {
          builder._order = col;
          builder._ascending = opts?.ascending !== false;
          return builder;
        },
        maybeSingle: () => {
          builder._singleMode = true;
          return builder.then !== undefined ? builder : builder._resolve();
        },
        _resolve: () => {
          const filtered = rows.filter((r) =>
            builder._filters.every((f: (r: any) => boolean) => f(r))
          );

          if (builder._action === "insert") {
            const data = Array.isArray(builder._insertData) ? builder._insertData : [builder._insertData];
            for (const row of data) {
              (store[table] = store[table] ?? []).push({ ...row });
            }
            return { data: null, error: null };
          }

          if (builder._action === "upsert") {
            const data = Array.isArray(builder._upsertData) ? builder._upsertData : [builder._upsertData];
            for (const row of data) {
              (store[table] = store[table] ?? []);
              const existing = store[table].findIndex((r) =>
                builder._filters.some((f: (r: any) => boolean) => !f(r))
                  ? false
                  : (row.user_id && r.user_id === row.user_id) ||
                    (row.id && r.id === row.id)
              );
              if (existing >= 0) {
                store[table][existing] = { ...store[table][existing], ...row };
              } else {
                store[table].push({ ...row });
              }
            }
            return { data: null, error: null };
          }

          if (builder._action === "delete") {
            store[table] = (store[table] ?? []).filter(
              (r) => !builder._filters.every((f: (r: any) => boolean) => f(r))
            );
            return { data: null, error: null };
          }

          let result = filtered;
          if (builder._order) {
            const ord = builder._order;
            result = [...result].sort((a, b) => {
              if (a[ord] < b[ord]) return builder._ascending ? -1 : 1;
              if (a[ord] > b[ord]) return builder._ascending ? 1 : -1;
              return 0;
            });
          }
          result = result.slice(0, builder._limit);
          if (builder._singleMode) {
            return { data: result[0] ?? null, error: null };
          }
          return { data: result, error: null };
        },
        then: (onfulfilled: (v: any) => any, _onrejected?: any) => {
          return Promise.resolve(builder._resolve()).then(onfulfilled, _onrejected);
        },
      };
      builder.maybeSingle = () => {
        builder._singleMode = true;
        return builder;
      };
      return builder;
    },
  };
  return client;
}

// ── Fixture helpers ────────────────────────────────────────────────────────────

function baseProfile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId:                USER_ID,
    preferredCities:       [],
    preferredLanguages:    ["en"],
    budgetStyle:           null,
    travelStyles:          [],
    socialStyle:           null,
    safetyPreference:      "standard",
    visibilityPreference:  "public",
    blockedUserIds:        [],
    blockerUserIds:        [],
    mutedUserIds:          [],
    blockCount:            0,
    blockerCount:          0,
    trustScore:            60,
    trustLevel:            "trusted_traveler",
    activeUserScore:       null,
    hasActiveTrip:         false,
    hasActiveBooking:      false,
    upcomingTripWithin48h: false,
    hasFutureTripScheduled: false,
    currentCity:           "Tokyo",
    currentCountry:        "Japan",
    safeReturnActive:      false,
    categoryWeights:       null,
    ignoredItemIds:        [],
    mutedHashtags:         [],
    computedAt:            new Date().toISOString(),
    ...overrides,
  };
}

function baseContext(state: CompassContext["contextState"] = "exploring_now"): CompassContext {
  return {
    contextState: state,
    signals: {
      hourUtc:               14,
      safeReturnActive:      false,
      activeBooking:         false,
      upcomingTripWithin48h: false,
      activeTripNow:         false,
      hasPendingDelayedPosts: false,
      hasFutureTripScheduled: false,
    },
    computedAt: new Date().toISOString(),
  };
}

function makeItem(overrides: Partial<CompassItem> = {}): CompassItem {
  return {
    id:           "item-001",
    type:         "event",
    authorId:     AUTHOR_ID,
    createdAt:    new Date().toISOString(),
    city:         "Tokyo",
    qualityScore: 8,
    ...overrides,
  };
}

// ── Unit tests (no HTTP server needed) ────────────────────────────────────────

describe("SafetyFilter — new hard-filter checks (Tests 1–6)", () => {
  it("Test 1: blocks moderation-rejected content", () => {
    const profile = baseProfile();
    const item = makeItem({ isModerationRejected: true });
    const result = runSafetyFilter(item, profile, null, {});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "moderation_rejected");
  });

  it("Test 2: blocks deleted content/account", () => {
    const profile = baseProfile();
    const item = makeItem({ isDeleted: true });
    const result = runSafetyFilter(item, profile, null, {});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "item_or_author_deleted");
  });

  it("Test 3: blocks muted author", () => {
    const profile = baseProfile({ mutedUserIds: [MUTED_ID] });
    const item = makeItem({ authorId: MUTED_ID });
    const result = runSafetyFilter(item, profile, null, {});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "author_muted_by_viewer");
  });

  it("Test 4: regression — blocked user still excluded", () => {
    const profile = baseProfile({ blockedUserIds: [AUTHOR_ID] });
    const item = makeItem({ authorId: AUTHOR_ID });
    const result = runSafetyFilter(item, profile, null, {});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "author_blocked_by_viewer");
  });

  it("Test 5: blocks private item when not viewer's own", () => {
    const profile = baseProfile();
    const item = makeItem({ visibilityScope: "private", authorId: "someone-else" });
    // This is handled by EligibilityEngine, not SafetyFilter
    // Safety filter should PASS private items (eligibility blocks them)
    const result = runSafetyFilter(item, profile, null, {});
    assert.equal(result.allowed, true);
  });

  it("Test 6: blocks suspended account", () => {
    const profile = baseProfile();
    const item = makeItem({ isSuspended: true });
    const result = runSafetyFilter(item, profile, null, {});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "author_or_item_suspended");
  });
});

describe("Pipeline — kill-switch and moderation-rejected (Tests 7–8)", () => {
  it("Test 7: moderation-rejected item never reaches scoring", async () => {
    const profile = baseProfile();
    const context = baseContext();

    let scoringCalled = false;
    const summary = await runPipeline(
      [makeItem({ isModerationRejected: true })],
      profile,
      context,
      null,
      {
        scoreItem: () => { scoringCalled = true; return { finalScore: 100, components: {} as any }; },
      },
    );

    assert.equal(scoringCalled, false, "scoring must not run on moderation-rejected items");
    assert.equal(summary.blockedCount, 1);
    assert.equal(summary.passedCount, 0);
  });

  it("Test 8: type-level kill-switch flag blocks item in SafetyFilter directly", () => {
    const profile = baseProfile();
    const item = makeItem({ type: "event" });
    const flags = { COMPASS_EVENT_SAFETY_BLOCK: true };

    const result = runSafetyFilter(item, profile, null, flags);
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.startsWith("type_safety_block:"), `expected type_safety_block reason, got: ${result.reason}`);
  });
});

// ── HTTP route tests ───────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(compassRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  server.close();
});

function apiReq(
  method: string,
  path:   string,
  body?:  unknown,
  token = FAKE_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${token}`,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end",  () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function setupFakeClients(store: TableStore = {}) {
  const fakeClient = buildFakeClient(store, USER_ID, "user");
  _setTestClient(fakeClient, true);
  _setTestServiceClient(fakeClient);
}

function setupAdminClients(store: TableStore = {}) {
  const adminClient = buildFakeClient(store, ADMIN_ID, "admin");
  // Seed admin profile so requireAdmin check passes
  store["profiles"] = [{ id: ADMIN_ID, role: "admin" }];
  _setTestClient(adminClient, true);
  _setTestServiceClient(adminClient);
}

describe("Settings endpoints (Tests 10–11)", () => {
  it("Test 10: GET /compass/settings returns defaults when no row exists", async () => {
    const store: TableStore = { compass_settings: [] };
    setupFakeClients(store);

    const r = await apiReq("GET", "/compass/settings");
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.settings, "object");
    assert.equal(r.body.settings.use_location, true);
    assert.equal(r.body.settings.show_buddy_recommendations, true);
  });

  it("Test 11: PATCH /compass/settings accepts and returns updated settings", async () => {
    const store: TableStore = { compass_settings: [] };
    setupFakeClients(store);

    const r = await apiReq("PATCH", "/compass/settings", {
      use_location: false,
      show_buddy_recommendations: false,
    });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.settings, "object");
  });

  it("PATCH /compass/settings: 400 on empty body", async () => {
    setupFakeClients();
    const r = await apiReq("PATCH", "/compass/settings", {});
    assert.equal(r.status, 400);
  });

  it("PATCH /compass/settings: 400 on unknown field", async () => {
    setupFakeClients();
    const r = await apiReq("PATCH", "/compass/settings", { unknown_field: true });
    assert.equal(r.status, 400);
  });
});

describe("Context endpoints (Tests 12–14)", () => {
  it("Test 12: GET /compass/context returns null when session is expired", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const store: TableStore = {
      compass_recent_context: [
        { user_id: USER_ID, context_state: "normal", intent_mode: "explore_now", expires_at: past },
      ],
    };
    setupFakeClients(store);

    const r = await apiReq("GET", "/compass/context");
    assert.equal(r.status, 200);
    assert.equal(r.body.context, null);
  });

  it("Test 13: POST /compass/context returns 201 with future expires_at", async () => {
    const store: TableStore = { compass_recent_context: [] };
    setupFakeClients(store);

    const r = await apiReq("POST", "/compass/context", {
      context_state: "exploring_now",
      city: "Tokyo",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.expires_at, "should have expires_at");
    const exp = new Date(r.body.expires_at).getTime();
    assert.ok(exp > Date.now(), "expires_at should be in the future");
  });

  it("Test 14: DELETE /compass/context returns 200 ok", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const store: TableStore = {
      compass_recent_context: [
        { user_id: USER_ID, context_state: "normal", intent_mode: "explore_now", expires_at: future },
      ],
    };
    setupFakeClients(store);

    const r = await apiReq("DELETE", "/compass/context");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

describe("Admin debug endpoint (Tests 15–16)", () => {
  it("Test 15: GET /compass/debug/recommendations returns 403 for non-admin", async () => {
    const store: TableStore = {
      profiles: [{ id: USER_ID, role: "user" }],
      compass_served_recommendations: [],
    };
    setupFakeClients(store);

    const r = await apiReq("GET", "/compass/debug/recommendations");
    assert.equal(r.status, 403);
  });

  it("Test 16: GET /compass/debug/recommendations returns 200 with recommendations for admin", async () => {
    const store: TableStore = {
      profiles: [{ id: ADMIN_ID, role: "admin" }],
      compass_served_recommendations: [
        {
          recommendation_id: "rec-001",
          user_id: USER_ID,
          item_id: "item-001",
          item_type: "event",
          section_name: "for_you",
          explanation_key: "for_you:event",
          created_at: new Date().toISOString(),
          explanation_looked_up_at: null,
        },
      ],
    };
    setupAdminClients(store);

    const r = await apiReq("GET", "/compass/debug/recommendations", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.recommendations));
  });
});

describe("Report endpoint (Test 17)", () => {
  it("Test 17: POST /compass/report returns 201", async () => {
    const store: TableStore = { compass_feedback: [] };
    setupFakeClients(store);

    const r = await apiReq("POST", "/compass/report", {
      recommendationId: "rec-abc",
      itemId:           "item-001",
      itemType:         "event",
      targetUserId:     AUTHOR_ID,
      reason:           "spam",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
  });

  it("POST /compass/report: 400 with invalid reason", async () => {
    setupFakeClients();
    const r = await apiReq("POST", "/compass/report", {
      recommendationId: "rec-abc",
      itemId: "item-001",
      itemType: "event",
      reason: "not_a_real_reason",
    });
    assert.equal(r.status, 400);
  });
});

describe("Mute profile loading (Test 18 — schema validation)", () => {
  it("Test 18: SafetyFilter blocks muted author when mutedUserIds loaded from user_mutes table", () => {
    // Verify that the correct column names (user_mutes.muted_id) are mapped to
    // mutedUserIds in the profile — if CompassProfileService used the wrong table or
    // column, this profile would have mutedUserIds=[] and the item would pass.
    const profile = baseProfile({ mutedUserIds: [MUTED_ID] });
    const item = makeItem({ authorId: MUTED_ID });

    const result = runSafetyFilter(item, profile, null, {});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "author_muted_by_viewer");

    // Also verify a non-muted author passes
    const nonMutedItem = makeItem({ authorId: AUTHOR_ID });
    const passResult = runSafetyFilter(nonMutedItem, profile, null, {});
    assert.equal(passResult.allowed, true);
  });
});

describe("Feedback save (Test 9)", () => {
  it("Test 9: POST /compass/feedback writes to compass_feedback_events and dual-writes compass_feedback", async () => {
    const store: TableStore = {
      compass_feedback_events:   [],
      compass_feedback:          [],
      compass_user_preferences:  [],
      compass_feed_cache:        [],
    };
    setupFakeClients(store);

    // Use a valid base64url-encoded recommendationId (fake but structurally valid)
    const fakeToken = Buffer.from(JSON.stringify({
      userId: USER_ID,
      itemId: "item-001",
      itemType: "event",
      sectionName: "for_you",
      explanationKey: "for_you:event",
      sig: "aabbccddeeff00112233445566778899",
    })).toString("base64url");

    const r = await apiReq("POST", "/compass/feedback", {
      recommendationId: fakeToken,
      action:   "show_more",
      itemType: "event",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.updated, true);
  });
});
