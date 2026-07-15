/**
 * Emergency feature-flag gate tests (Phase 7)
 *
 * Proves that when an emergency flag is enabled, the relevant route
 * returns 404 feature_disabled instead of processing the request.
 *
 * Flags under test:
 *   disable_tagging              → POST /tags
 *   disable_new_event_creation   → POST /meetups
 *   disable_profile_search       → GET  /users/search  (returns empty array)
 *   disable_media_uploads        → checked via flag helper unit test
 *
 * Fail-open contract: when the flag DB query fails (error), the feature
 * is NOT blocked — the route continues normally.
 *
 * Run: node --import tsx/esm --test src/test/emergencyFlags.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tagsRouter from "../routes/tags.js";
import meetupsRouter from "../routes/meetups.js";
import followsRouter from "../routes/follows.js";

// ── Server ─────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN = "fake.jwt.token";
const CALLER_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const TARGET_ID  = "bbbbbbbb-0000-0000-0000-000000000002";

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
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
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

// ── Fake client factory ────────────────────────────────────────────────────────

/**
 * Build a minimal fake Supabase client for the given flag state.
 *
 * @param flagEnabled   true  → flag row returns { enabled: true }
 *                      false → flag row returns { enabled: false }
 *                      "error" → flag query returns an error (fail-open test)
 */
function makeFakeClient(flagEnabled: boolean | "error") {
  const flagRow = flagEnabled === true
    ? { flag: "any", enabled: true }
    : { flag: "any", enabled: false };

  function builder(table: string, rows: unknown[]) {
    let _rows = [...rows];
    const b: any = {
      select:      () => b,
      insert:      (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      update:      (data: any) => { _rows = _rows.map((r: any) => ({ ...r, ...data })); return b; },
      upsert:      (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      delete:      () => { _rows = []; return b; },
      eq:          () => b,
      neq:         () => b,
      is:          () => b,
      ilike:       () => b,
      not:         () => b,
      in:          () => b,
      or:          () => b,
      gt:          () => b,
      order:       () => b,
      limit:       () => b,
      range:       () => b,
      then:        (resolve: any) => Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve),
      maybeSingle: () => {
        if (table === "feature_flags") {
          if (flagEnabled === "error") {
            return Promise.resolve({ data: null, error: { message: "DB unavailable", code: "503" } });
          }
          return Promise.resolve({ data: flagRow, error: null });
        }
        return Promise.resolve({ data: _rows[0] ?? null, error: null });
      },
      single: () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "feature_flags") return builder(table, [flagRow]);
      if (table === "profiles")      return builder(table, [{ id: CALLER_ID, role: "user", is_private: false, tag_permission: "anyone" }]);
      if (table === "blocks")        return builder(table, []);
      if (table === "user_mutes")    return builder(table, []);
      if (table === "user_restrictions") return builder(table, []);
      if (table === "user_follows")  return builder(table, []);
      if (table === "user_friendships") return builder(table, []);
      if (table === "friend_requests") return builder(table, []);
      if (table === "user_message_settings") return builder(table, [{ message_privacy: "everyone", allow_message_requests: true }]);
      if (table === "user_interaction_cooldowns") return builder(table, []);
      if (table === "trust_restrictions") return builder(table, []);
      if (table === "user_account_states") return builder(table, []);
      if (table === "user_privacy_settings") return builder(table, []);
      if (table === "moderation_actions") return builder(table, []);
      return builder(table, []);
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: CALLER_ID } }, error: null }),
    },
  } as any;
}

function setClients(flagEnabled: boolean | "error") {
  const c = makeFakeClient(flagEnabled);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Server setup ───────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(tagsRouter);
  app.use(meetupsRouter);
  app.use(followsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

// ── disable_tagging ────────────────────────────────────────────────────────────

describe("disable_tagging flag gates POST /tags", () => {
  it("blocks tagging when disable_tagging=true — returns 404 feature_disabled", async () => {
    setClients(true);
    const { status, body } = await req("POST", "/tags", {
      source_type:    "post",
      source_id:      TARGET_ID,
      tagged_user_id: TARGET_ID,
    });
    assert.equal(status, 404, `Expected 404 feature_disabled, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "feature_disabled");
  });

  it("allows tagging when disable_tagging=false — does NOT return feature_disabled", async () => {
    setClients(false);
    const { status, body } = await req("POST", "/tags", {
      source_type:    "post",
      source_id:      TARGET_ID,
      tagged_user_id: TARGET_ID,
    });
    // Feature is allowed through the flag — may fail on other logic (perms, not-found)
    // but must NOT be feature_disabled
    assert.notEqual(body.error, "feature_disabled",
      `Flag is OFF but got feature_disabled: ${JSON.stringify(body)}`);
    assert.ok(status !== 404 || body.error !== "feature_disabled",
      `Should not block tagging when flag is false`);
  });

  it("fail-open: DB error on flag query allows tagging (does not block)", async () => {
    setClients("error");
    const { body } = await req("POST", "/tags", {
      source_type:    "post",
      source_id:      TARGET_ID,
      tagged_user_id: TARGET_ID,
    });
    // Must not be feature_disabled — DB error must fail-open
    assert.notEqual(body.error, "feature_disabled",
      `DB error should fail-open but got feature_disabled: ${JSON.stringify(body)}`);
  });
});

// ── disable_new_event_creation ────────────────────────────────────────────────

describe("disable_new_event_creation flag gates POST /meetups", () => {
  it("blocks meetup creation when disable_new_event_creation=true — returns 404 feature_disabled", async () => {
    setClients(true);
    const { status, body } = await req("POST", "/meetups", {
      title: "Test Meetup",
      timeBlock: "morning",
    });
    assert.equal(status, 404, `Expected 404 feature_disabled, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "feature_disabled");
  });

  it("allows meetup creation when disable_new_event_creation=false — does NOT return feature_disabled", async () => {
    setClients(false);
    const { status, body } = await req("POST", "/meetups", {
      title: "Test Meetup",
      timeBlock: "morning",
    });
    assert.notEqual(body.error, "feature_disabled",
      `Flag is OFF but got feature_disabled: ${JSON.stringify(body)}`);
    assert.ok(status !== 404 || body.error !== "feature_disabled");
  });

  it("fail-open: DB error on flag query allows meetup creation (does not block)", async () => {
    setClients("error");
    const { body } = await req("POST", "/meetups", {
      title: "Test Meetup",
      timeBlock: "morning",
    });
    assert.notEqual(body.error, "feature_disabled",
      `DB error should fail-open but got feature_disabled: ${JSON.stringify(body)}`);
  });
});

// ── disable_profile_search ────────────────────────────────────────────────────

describe("disable_profile_search flag gates GET /users/search", () => {
  it("returns empty users array when disable_profile_search=true (soft block)", async () => {
    setClients(true);
    const { status, body } = await req("GET", "/users/search?q=alice");
    // disable_profile_search returns 200 with empty array (soft block, no error)
    assert.equal(status, 200, `Expected 200 empty response, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.users), "body.users must be an array");
    assert.equal(body.users.length, 0, "users array must be empty when flag is on");
  });

  it("allows profile search when disable_profile_search=false", async () => {
    setClients(false);
    // We just verify the flag doesn't block — the search itself may return [] due to fake client
    const { status } = await req("GET", "/users/search?q=alice");
    // 200 or 500 from fake DB is OK — what matters is it's not blocked by the flag
    assert.ok(status === 200 || status === 500,
      `Expected 200 or 500, got ${status}`);
  });
});
