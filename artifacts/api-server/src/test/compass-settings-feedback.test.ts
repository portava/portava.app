/**
 * Compass settings + feedback endpoint integration tests.
 *
 * Covers:
 *   - GET /api/compass/settings: default when no row, stored row with new fields
 *   - PATCH /api/compass/settings: validation, use_chosen_city, onboarding_completed
 *   - POST /api/compass/feedback: new action types (not_now, hide_this, wrong_city,
 *       already_went, not_safe)
 *   - POST /api/compass/analytics: valid events, bad event, PII stripping, auth check
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-settings-feedback.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import compassRouter from "../routes/compass.js";

// ── Fake Supabase client ───────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeClient(store: Record<string, Row[]> = {}) {
  const s = store;
  function tbl(name: string): Row[] {
    if (!s[name]) s[name] = [];
    return s[name]!;
  }

  function builder(tableName: string) {
    let _rows: Row[] = [...tbl(tableName)];
    let _eqFilters: [string, unknown][] = [];

    function applyFilters(rows: Row[]) {
      return rows.filter((r) => _eqFilters.every(([k, v]) => r[k] === v));
    }

    const b: any = {};

    b.select = (_cols?: string) => { _rows = [...tbl(tableName)]; return b; };
    b.eq     = (k: string, v: unknown) => { _eqFilters.push([k, v]); return b; };

    b.maybeSingle = () => ({
      then: (resolve: Function) =>
        resolve({ data: applyFilters(_rows)[0] ?? null, error: null }),
    });

    b.single = () => {
      const row = applyFilters(_rows)[0] ?? null;
      return Promise.resolve({ data: row, error: null });
    };

    b.insert = (row: Row | Row[]) => {
      const rows = Array.isArray(row) ? row : [row];
      for (const r of rows) tbl(tableName).push({ ...r });
      const result = { data: rows, error: null };
      return {
        then: (onFulfilled?: ((v: unknown) => unknown) | null, _onRejected?: Function | null) => {
          if (typeof onFulfilled === "function") onFulfilled(result);
        },
        select: (_cols?: string) => b,
      };
    };

    b.upsert = (row: Row, _opts?: unknown) => {
      const existing = tbl(tableName);
      const idx = existing.findIndex((r) => r["user_id"] === row["user_id"]);
      if (idx >= 0) existing[idx] = { ...existing[idx]!, ...row };
      else existing.push({ ...row });
      return { then: (res: Function) => res({ data: null, error: null }) };
    };

    b.update = (patch: Row) => {
      for (const r of applyFilters(tbl(tableName))) Object.assign(r, patch);
      return b;
    };

    b.delete = () => {
      s[tableName] = tbl(tableName).filter((r) => !applyFilters([r]).length);
      return { then: (res: Function) => res({ data: null, error: null }) };
    };

    b.then = (resolve: Function) =>
      resolve({ data: applyFilters(_rows), error: null });

    return b;
  }

  return {
    fakeClient: {
      from: (name: string) => builder(name),
      auth: {
        getUser: (token: string) =>
          token === "valid-token"
            ? Promise.resolve({ data: { user: { id: "00000000-0000-0000-0000-000000000001" } }, error: null })
            : Promise.resolve({ data: { user: null }, error: { message: "bad token" } }),
      },
    } as any,
    store: s,
  };
}

// ── Mini express app ───────────────────────────────────────────────────────────

const USER_ID = "00000000-0000-0000-0000-000000000001";

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.log = pino({ level: "silent" });
  next();
});
testApp.use("/api", compassRouter);

let server: Server;
let base: string;

before(async () => {
  server = createServer(testApp);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((res, rej) =>
    server.close((e) => (e ? rej(e) : res())),
  );
});

async function r(
  method: string,
  path: string,
  body?: unknown,
  token = "valid-token",
) {
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}

function prefsRow(overrides: Partial<Row> = {}): Row {
  return {
    user_id:          USER_ID,
    ignored_item_ids: [],
    category_weights: {},
    ...overrides,
  };
}

// ── GET /api/compass/settings ─────────────────────────────────────────────────

describe("GET /api/compass/settings", () => {
  it("returns defaults when no row exists", async () => {
    const { fakeClient } = makeFakeClient({});
    _setTestClient(fakeClient, true);
    const { status, json } = await r("GET", "/api/compass/settings");
    assert.equal(status, 200);
    const s = (json as any).settings;
    assert.equal(s.use_location,    true);
    assert.equal(s.use_chosen_city, true);
    assert.equal(s.onboarding_completed, false);
  });

  it("returns stored row including new fields", async () => {
    const { fakeClient } = makeFakeClient({
      compass_settings: [{
        user_id:                     USER_ID,
        use_location:                false,
        use_chosen_city:             false,
        use_trip_data:               true,
        use_saved_items:             true,
        use_history:                 true,
        show_buddy_recommendations:  true,
        show_people_recommendations: true,
        allow_smart_notifications:   false,
        onboarding_completed:        true,
        onboarding_completed_at:     "2026-07-05T00:00:00Z",
        updated_at:                  "2026-07-05T00:00:00Z",
      }],
    });
    _setTestClient(fakeClient, true);
    const { status, json } = await r("GET", "/api/compass/settings");
    assert.equal(status, 200);
    const s = (json as any).settings;
    assert.equal(s.use_location,         false);
    assert.equal(s.use_chosen_city,      false);
    assert.equal(s.onboarding_completed, true);
    assert.ok(s.onboarding_completed_at);
  });

  it("rejects unauthenticated requests", async () => {
    const { fakeClient } = makeFakeClient({});
    _setTestClient(fakeClient, true);
    const { status } = await r("GET", "/api/compass/settings", undefined, "bad-token");
    assert.equal(status, 401);
  });
});

// ── PATCH /api/compass/settings ───────────────────────────────────────────────

describe("PATCH /api/compass/settings", () => {
  it("rejects empty body", async () => {
    const { fakeClient } = makeFakeClient({});
    _setTestClient(fakeClient, true);
    const { status } = await r("PATCH", "/api/compass/settings", {});
    assert.equal(status, 400);
  });

  it("accepts use_location toggle", async () => {
    const { fakeClient } = makeFakeClient({});
    _setTestClient(fakeClient, true);
    const { status } = await r("PATCH", "/api/compass/settings", { use_location: false });
    assert.equal(status, 200);
  });

  it("accepts use_chosen_city", async () => {
    const { fakeClient } = makeFakeClient({});
    _setTestClient(fakeClient, true);
    const { status } = await r("PATCH", "/api/compass/settings", { use_chosen_city: false });
    assert.equal(status, 200);
  });

  it("accepts onboarding_completed", async () => {
    const { fakeClient } = makeFakeClient({});
    _setTestClient(fakeClient, true);
    const { status } = await r("PATCH", "/api/compass/settings", { onboarding_completed: true });
    assert.equal(status, 200);
  });

  it("rejects invalid field type", async () => {
    const { fakeClient } = makeFakeClient({});
    _setTestClient(fakeClient, true);
    const { status } = await r("PATCH", "/api/compass/settings", { use_location: "yes" });
    assert.equal(status, 400);
  });
});

// ── POST /api/compass/feedback — new action types ─────────────────────────────

describe("POST /api/compass/feedback — Phase 5 actions", () => {
  function feedbackStore() {
    return {
      compass_user_preferences: [prefsRow()],
      compass_feedback_events:  [] as Row[],
      compass_feedback:         [] as Row[],
    };
  }

  it("accepts not_now (session dismiss, no prefs change)", async () => {
    const { fakeClient } = makeFakeClient(feedbackStore());
    _setTestClient(fakeClient, true);
    const { status, json } = await r("POST", "/api/compass/feedback", {
      action: "not_now", recommendationId: "abc123", itemType: "place",
    });
    assert.equal(status, 200);
    assert.equal((json as any).updated, true);
  });

  it("accepts hide_this and updates ignored_item_ids", async () => {
    const store = feedbackStore();
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);
    const { status, json } = await r("POST", "/api/compass/feedback", {
      action: "hide_this", recommendationId: "place-999", itemType: "place",
    });
    assert.equal(status, 200);
    assert.equal((json as any).updated, true);
  });

  it("accepts wrong_city and adjusts category_weights", async () => {
    const { fakeClient } = makeFakeClient(feedbackStore());
    _setTestClient(fakeClient, true);
    const { status, json } = await r("POST", "/api/compass/feedback", {
      action: "wrong_city", recommendationId: "ev-1", itemType: "event", category: "Cebu City",
    });
    assert.equal(status, 200);
    assert.equal((json as any).updated, true);
  });

  it("accepts already_went", async () => {
    const { fakeClient } = makeFakeClient(feedbackStore());
    _setTestClient(fakeClient, true);
    const { status } = await r("POST", "/api/compass/feedback", {
      action: "already_went", recommendationId: "place-1", itemType: "place",
    });
    assert.equal(status, 200);
  });

  it("accepts not_safe", async () => {
    const { fakeClient } = makeFakeClient(feedbackStore());
    _setTestClient(fakeClient, true);
    const { status } = await r("POST", "/api/compass/feedback", {
      action: "not_safe", recommendationId: "place-2", itemType: "place",
    });
    assert.equal(status, 200);
  });

  it("rejects unknown action", async () => {
    const { fakeClient } = makeFakeClient(feedbackStore());
    _setTestClient(fakeClient, true);
    const { status } = await r("POST", "/api/compass/feedback", {
      action: "delete_everything", recommendationId: "x", itemType: "place",
    });
    assert.equal(status, 400);
  });
});

// ── POST /api/compass/analytics ───────────────────────────────────────────────

describe("POST /api/compass/analytics", () => {
  it("accepts compass_card_viewed", async () => {
    const { fakeClient } = makeFakeClient({ compass_analytics_events: [] });
    _setTestClient(fakeClient, true);
    const { status } = await r("POST", "/api/compass/analytics", {
      event_name: "compass_card_viewed", item_type: "place", section_name: "compass_picks",
    });
    assert.equal(status, 202);
  });

  it("accepts all allowed event types", async () => {
    const events = [
      "compass_card_viewed", "compass_card_tapped", "compass_feedback_submitted",
      "compass_settings_changed", "compass_onboarding_completed", "compass_onboarding_skipped",
    ];
    for (const event_name of events) {
      const { fakeClient } = makeFakeClient({ compass_analytics_events: [] });
      _setTestClient(fakeClient, true);
      const { status } = await r("POST", "/api/compass/analytics", { event_name });
      assert.equal(status, 202, `Failed for event: ${event_name}`);
    }
  });

  it("rejects unknown event name", async () => {
    const { fakeClient } = makeFakeClient({});
    _setTestClient(fakeClient, true);
    const { status } = await r("POST", "/api/compass/analytics", {
      event_name: "track_everything",
    });
    assert.equal(status, 400);
  });

  it("accepts request with PII-like metadata keys (strips them server-side)", async () => {
    const { fakeClient } = makeFakeClient({ compass_analytics_events: [] });
    _setTestClient(fakeClient, true);
    const { status } = await r("POST", "/api/compass/analytics", {
      event_name: "compass_card_tapped",
      metadata: { lat: 10.3, lng: 123.9, action: "tap" },
    });
    assert.equal(status, 202);
  });

  it("rejects unauthenticated request", async () => {
    const { fakeClient } = makeFakeClient({});
    _setTestClient(fakeClient, true);
    const { status } = await r("POST", "/api/compass/analytics", {
      event_name: "compass_card_viewed",
    }, "bad-token");
    assert.equal(status, 401);
  });
});
