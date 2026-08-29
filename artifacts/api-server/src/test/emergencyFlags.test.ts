/**
 * Emergency feature-flag gate tests (Phase 7)
 *
 * Proves that when an emergency flag is enabled, the relevant route
 * returns 404 feature_disabled instead of processing the request.
 *
 * Flags under test:
 *   disable_tagging              → POST /tags
 *   disable_new_event_creation   → POST /meetups            (write-path exemplar)
 *   disable_profile_search       → GET  /users/search  (returns empty array)
 *   find_your_circle_disabled    → canViewCirclePresence    (read-path exemplar)
 *   disable_media_uploads        → checked via flag helper unit test
 *
 * Fail-CLOSED contract (2026-08-10): these are emergency stops, read through
 * isKillSwitchEngaged. When the flag query ERRORS the state is unknown and the
 * stop ENGAGES. When the row is simply MISSING (data=null, error=null) no stop
 * has been configured and it must NOT engage — that distinction is what keeps
 * fail-closed from turning every unseeded flag into an outage, so each exemplar
 * asserts both halves.
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
import { canViewCirclePresence } from "../lib/circleAccessGuard.js";

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
 *                      "error" → flag query returns an error (state unknown)
 *                      "missing" → no such row: data=null, error=null
 *
 * "missing" is the state every flag nobody has created is in, including all of
 * them on a freshly restored project. It is NOT an error and must never engage
 * a stop — conflating the two turns each unseeded flag into an outage.
 */
function makeFakeClient(flagEnabled: boolean | "error" | "missing") {
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
          if (flagEnabled === "missing") {
            return Promise.resolve({ data: null, error: null });
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

function setClients(flagEnabled: boolean | "error" | "missing") {
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
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

  // INVERTED 2026-08-10 (Phase 0 #3). This test previously asserted fail-OPEN:
  // that a DB error on the flag query let tagging through. That was the defect,
  // written down as an expectation — for an emergency STOP, false-on-error means
  // "do not stop", so the switch disengaged exactly when the database was
  // unhealthy. disable_tagging is now read through isKillSwitchEngaged, which
  // treats an unreadable state as engaged. The other fail-open assertions in
  // this file are left alone deliberately: their switches have NOT been
  // converted, and a test asserting behaviour the code does not have would be
  // worse than one recording behaviour that should change. See the kill-switch
  // inventory in the Phase 0 notes.
  it("fail-CLOSED: DB error on the flag query STOPS tagging", async () => {
    setClients("error");
    const { status, body } = await req("POST", "/tags", {
      source_type:    "post",
      source_id:      TARGET_ID,
      tagged_user_id: TARGET_ID,
    });
    assert.equal(body.error, "feature_disabled",
      `an unreadable emergency stop must engage, got ${status} ${JSON.stringify(body)}`);
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

  // INVERTED 2026-08-10 (Phase 0 #4, WRITE-PATH exemplar). Previously asserted
  // fail-OPEN: that a DB error let event creation through. Same defect as
  // disable_tagging — an emergency stop that disengages when the database is
  // unhealthy is not stopping anything at the moment you reach for it.
  it("fail-CLOSED: DB error on the flag query STOPS meetup creation", async () => {
    setClients("error");
    const { body } = await req("POST", "/meetups", {
      title: "Test Meetup",
      timeBlock: "morning",
    });
    assert.equal(body.error, "feature_disabled",
      `an unreadable emergency stop must engage, got ${JSON.stringify(body)}`);
  });

  // The other half of the contract, and the one that makes fail-closed safe to
  // ship: an ABSENT row is not an error. No stop has been configured, so no
  // stop engages. If this ever goes red, every flag nobody has seeded has
  // become an outage.
  it("missing flag row (data=null, error=null) does NOT stop meetup creation", async () => {
    setClients("missing");
    const { body } = await req("POST", "/meetups", {
      title: "Test Meetup",
      timeBlock: "morning",
    });
    assert.notEqual(body.error, "feature_disabled",
      `an unconfigured stop must not engage, got ${JSON.stringify(body)}`);
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

  // NOTE: no fail-closed pair here, deliberately. disable_profile_search is a
  // SOFT stop — it returns 200 { users: [] }, which this fake also returns when
  // the stop is off (its one profile row is the caller, whom search excludes).
  // Blocked and unblocked are therefore indistinguishable through this harness,
  // so any assertion here would pass for the wrong reason. The read-path
  // exemplar is find_your_circle_disabled below, whose denial carries a
  // distinguishable reason. The conversion of this call site is covered by the
  // mechanical no-isFlagEnabled-on-a-stop assertion.
});

// ── find_your_circle_disabled (READ-PATH exemplar) ────────────────────────────
//
// A different shape from the route stops above: this switch guards a library
// read guard, not an HTTP write. canViewCirclePresence returns a structured
// denial, so the assertions can key on WHICH rule denied — reason "kill_switch"
// proves the stop engaged, and distinguishes it from the membership checks,
// which already fail closed to "viewer_not_member" on a DB error. Without that
// distinction a fail-closed test would pass for the wrong reason.

describe("find_your_circle_disabled gates canViewCirclePresence", () => {
  /** Minimal client: feature_flags in the given state, everything else empty. */
  function guardClient(flagState: boolean | "error" | "missing") {
    const flagResult = () => {
      if (flagState === "error")   return Promise.resolve({ data: null, error: { message: "DB unavailable", code: "503" } });
      if (flagState === "missing") return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: { flag: "find_your_circle_disabled", enabled: flagState }, error: null });
    };
    const builder = (table: string): any => {
      const b: any = {
        select: () => b, eq: () => b, in: () => b, is: () => b, neq: () => b,
        maybeSingle: () => (table === "feature_flags" ? flagResult() : Promise.resolve({ data: null, error: null })),
        then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return b;
    };
    return { from: (table: string) => builder(table) } as any;
  }

  const VIEWER = "cccccccc-0000-0000-0000-000000000003";
  const TARGET = "dddddddd-0000-0000-0000-000000000004";
  const TRIP   = "eeeeeeee-0000-0000-0000-000000000005";

  it("blocks circle presence when find_your_circle_disabled=true", async () => {
    const r = await canViewCirclePresence(guardClient(true), VIEWER, TARGET, "trip", TRIP);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "kill_switch");
  });

  it("fail-CLOSED: DB error on the flag query engages the stop (reason=kill_switch)", async () => {
    const r = await canViewCirclePresence(guardClient("error"), VIEWER, TARGET, "trip", TRIP);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "kill_switch",
      `an unreadable emergency stop must engage; reason ${r.reason} means a later rule denied, not the stop`);
  });

  it("missing flag row (data=null, error=null) does NOT engage the stop", async () => {
    const r = await canViewCirclePresence(guardClient("missing"), VIEWER, TARGET, "trip", TRIP);
    assert.notEqual(r.reason, "kill_switch",
      `an unconfigured stop must not engage, got reason ${r.reason}`);
  });
});
