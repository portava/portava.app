/**
 * Profile data-leak prevention tests
 *
 * These tests verify that sensitive fields present in the database row NEVER
 * reach the API response — even when the underlying DB row contains them.
 *
 * Covered endpoints:
 *   GET /api/me/profile              — date_of_birth, dob_verified must be absent
 *   GET /api/users/:userId           — date_of_birth, dob_verified must be absent
 *   GET /api/buddies                 — admin_status, risk_hold and private contact
 *                                      fields must be absent
 *   GET /api/rent-a-buddy/buddies/:id — same assertions on buddy detail
 *   GET /api/rent-a-buddy/buddies/:id — completedBookings reads completed_count, not completed_bookings
 *   GET /api/rent-a-buddy/sections    — same completedBookings source-of-truth check
 *
 * Run: node --import tsx/esm --test src/test/profileSelect.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import rentABuddyMarketplaceRouter from "../routes/rentABuddyMarketplace.js";
import followsRouter from "../routes/follows.js";

// ── Fixed identifiers ─────────────────────────────────────────────────────────

const USER_ID    = "aa111111-1111-4111-a111-111111111111";
const USER_TOKEN = "tok-profile-select-test";
const BUDDY_ID   = "bb222222-2222-4222-a222-222222222222";
const BUDDY_ID_DIVERGENT = "ee555555-5555-4555-a555-555555555555";

// ── Raw DB rows WITH sensitive fields — these must be stripped before the response ──

const PROFILE_ROW_WITH_SENSITIVE = {
  id: USER_ID,
  handle: null,
  name: "Select Test User",
  display_name: "Select Test User",
  username: "selecttestuser",
  bio: "Test bio",
  avatar_url: null,
  home_city: "Manila",
  home_country: "PH",
  current_city: null,
  travel_style: null,
  interests: [],
  verified: false,
  verification_status: "unverified",
  verified_at: null,
  open_to_meet: false,
  is_private: false,
  passport_visibility: "public",
  cover_photo_url: null,
  username_updated_at: null,
  created_at: "2024-01-01T00:00:00Z",
  spoken_languages: [],
  default_language: null,
  travel_styles: [],
  travel_pace: null,
  budget_style: null,
  travel_group_style: [],
  looking_for: [],
  comfort_level: null,
  availability_tags: [],
  planning_style: null,
  public_social_links: {},
  preferred_language: null,
  account_status: "active",
  // ↓ SENSITIVE — must never appear in the API response
  date_of_birth: "1990-03-15",
  dob_verified: true,
};

const BUDDY_ROW_WITH_SENSITIVE = {
  id: BUDDY_ID,
  user_id: "cc333333-3333-4333-a333-333333333333",
  display_name: "Select Test Buddy",
  tagline: "Explorer",
  bio: "I love guiding travelers",
  intro_video_url: null,
  languages: ["en"],
  city: "Cebu",
  country: "PH",
  categories: ["city_tour"],
  hourly_rate_usd: 20,
  status: "active",
  verified: true,
  verified_at: "2024-01-01T00:00:00Z",
  verification_status: "verified",
  average_rating: 4.9,
  review_count: 12,
  completed_bookings: 10,
  completed_count: 10,
  response_time_h: 0.5,
  cover_photo_url: null,
  gallery_urls: [],
  vibe_tags: [],
  safety_badges: [],
  buddy_level: "silver",
  category_approvals: {},
  new_buddy_public_only: false,
  new_buddy_daytime_only: false,
  new_buddy_max_hours: null,
  max_group_size: 4,
  preferred_meetup_zones: [],
  featured: false,
  available_now: true,
  cancel_count: 0,
  no_show_count: 0,
  favorites_count: 3,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  // ↓ SENSITIVE — must never appear in the API response
  admin_status: "active",
  risk_hold: false,
  id_verification_ref: "ref-secret-789",
  legal_name: "Real Name Here",
  exact_address: "123 Private Street",
  home_address: "456 Home Ave",
  phone_number: "+63-999-1234567",
};

/**
 * Buddy row where completed_bookings and completed_count deliberately differ.
 * The API must always surface completed_count (7), never completed_bookings (3).
 */
const BUDDY_ROW_DIVERGENT_COUNTS = {
  ...BUDDY_ROW_WITH_SENSITIVE,
  id: BUDDY_ID_DIVERGENT,
  completed_bookings: 3,   // legacy column — must NOT drive the response
  completed_count: 7,      // canonical column — MUST appear in completedBookings
};

// ── Fake client ───────────────────────────────────────────────────────────────

function makeClient() {
  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let isMaybeSingle = false;
    let isHead = false;

    const allRows = (): any[] => {
      if (table === "profiles")         return [PROFILE_ROW_WITH_SENSITIVE];
      if (table === "feature_flags")    return [{ flag: "rent_buddy_enabled", enabled: true }];
      if (table === "rent_buddy_profiles") return [BUDDY_ROW_WITH_SENSITIVE];
      return [];
    };

    const b: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.head) isHead = true;
        return b;
      },
      eq(col: string, val: any) {
        filters.push((r) => String(r[col]) === String(val));
        return b;
      },
      neq(col: string, val: any)  { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).map(String).includes(String(r[col]))); return b; },
      is(col: string, val: any)   { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      gte(col: string, val: any)  { filters.push((r) => Number(r[col]) >= Number(val)); return b; },
      lte(col: string, val: any)  { filters.push((r) => Number(r[col]) <= Number(val)); return b; },
      ilike()    { return b; },
      contains() { return b; },
      like()     { return b; },
      or()       { return b; },
      order()    { return b; },
      limit()    { return b; },
      range()    { return b; },
      insert()   { return b; },
      update()   { return b; },
      upsert()   { return b; },
      delete()   { return b; },
      maybeSingle() { isMaybeSingle = true; return b; },
      single()      { isMaybeSingle = true; return b; },
      catch()    { return b; },

      then(onF: (v: any) => any, onR?: (e: any) => any) {
        const rows = allRows().filter((r) => filters.every((f) => f(r)));
        let result: any;
        if (isHead) {
          result = { data: null, count: rows.length, error: null };
        } else if (isMaybeSingle) {
          result = { data: rows[0] ?? null, error: null };
        } else {
          result = { data: rows, count: rows.length, error: null };
        }
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return b;
  }

  const client: any = {
    auth: {
      getUser: async (tok: string) => {
        if (tok === USER_TOKEN) {
          return { data: { user: { id: USER_ID, email: "test@example.com" } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: (table: string) => builder(table),
  };
  return client;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function apiReq(
  method: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

function apiReqWithBody(
  method: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload).toString(),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("profile data-leak prevention", () => {
  before(async () => {
    const client = makeClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const app = express();
    app.use(express.json());
    app.use("/api", profileRouter);
    app.use("/api", followsRouter);
    app.use(rentABuddyRouter);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  after(async () => {
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── GET /api/me/profile — date_of_birth and dob_verified must be absent ──────

  describe("GET /api/me/profile", () => {
    it("returns HTTP 200 with profile data", async () => {
      const { status, body } = await apiReq("GET", "/api/me/profile", USER_TOKEN);
      assert.equal(status, 200);
      assert.equal(body.id, USER_ID);
    });

    it("does not include date_of_birth (snake_case) in response", async () => {
      const { body } = await apiReq("GET", "/api/me/profile", USER_TOKEN);
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) in response", async () => {
      const { body } = await apiReq("GET", "/api/me/profile", USER_TOKEN);
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) in response", async () => {
      const { body } = await apiReq("GET", "/api/me/profile", USER_TOKEN);
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) in response", async () => {
      const { body } = await apiReq("GET", "/api/me/profile", USER_TOKEN);
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });
  });

  // ── GET /api/users/:userId — public Passport view must not expose DOB ─────────
  // No auth token needed — the route supports optional authentication.

  describe("GET /api/users/:userId", () => {
    it("returns HTTP 200 with profile data", async () => {
      const { status, body } = await apiReq("GET", `/api/users/${USER_ID}`);
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
      assert.ok(body.id === USER_ID || body.handle != null || body.name != null,
        "profile data should be present");
    });

    it("does not include date_of_birth (snake_case) in public profile response", async () => {
      const { body } = await apiReq("GET", `/api/users/${USER_ID}`);
      assert.ok(!("date_of_birth" in body), "date_of_birth must not appear in public profile");
    });

    it("does not include dateOfBirth (camelCase) in public profile response", async () => {
      const { body } = await apiReq("GET", `/api/users/${USER_ID}`);
      assert.ok(!("dateOfBirth" in body), "dateOfBirth must not appear in public profile");
    });

    it("does not include dob_verified (snake_case) in public profile response", async () => {
      const { body } = await apiReq("GET", `/api/users/${USER_ID}`);
      assert.ok(!("dob_verified" in body), "dob_verified must not appear in public profile");
    });

    it("does not include dobVerified (camelCase) in public profile response", async () => {
      const { body } = await apiReq("GET", `/api/users/${USER_ID}`);
      assert.ok(!("dobVerified" in body), "dobVerified must not appear in public profile");
    });
  });

  // ── PATCH /api/me/profile — response must not leak DOB after an update ────────

  describe("PATCH /api/me/profile — date of birth leak prevention", () => {
    it("returns HTTP 200 after patching dateOfBirth", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: "1990-03-15" },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("does not include date_of_birth (snake_case) in PATCH response", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: "1990-03-15" },
        USER_TOKEN,
      );
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in PATCH response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) in PATCH response", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: "1990-03-15" },
        USER_TOKEN,
      );
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in PATCH response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) in PATCH response", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: "1990-03-15" },
        USER_TOKEN,
      );
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in PATCH response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) in PATCH response", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: "1990-03-15" },
        USER_TOKEN,
      );
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in PATCH response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });
  });

  // ── PATCH /api/me/profile — clearing dateOfBirth (null) must not echo DOB fields ──

  describe("PATCH /api/me/profile — dateOfBirth: null (clear)", () => {
    it("returns HTTP 200 when clearing dateOfBirth to null", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("does not include date_of_birth (snake_case) in response after clearing DOB", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null },
        USER_TOKEN,
      );
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in PATCH null response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) in response after clearing DOB", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in PATCH null response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) in response after clearing DOB", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in PATCH null response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) in response after clearing DOB", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in PATCH null response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });
  });

  // ── GET /api/buddies — admin and private fields must be absent ────────────────

  describe("GET /api/buddies", () => {
    it("returns HTTP 200 with buddies array", async () => {
      const { status, body } = await apiReq("GET", "/api/buddies");
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.buddies), "response must have buddies array");
      assert.ok(body.buddies.length > 0, "at least one buddy must be returned");
    });

    it("does not include admin_status in any buddy in the list", async () => {
      const { body } = await apiReq("GET", "/api/buddies");
      for (const buddy of body.buddies ?? []) {
        assert.ok(!("admin_status" in buddy), "admin_status must not appear in buddy listing");
        assert.ok(!("adminStatus" in buddy), "adminStatus must not appear in buddy listing");
      }
    });

    it("does not include risk_hold in any buddy in the list", async () => {
      const { body } = await apiReq("GET", "/api/buddies");
      for (const buddy of body.buddies ?? []) {
        assert.ok(!("risk_hold" in buddy), "risk_hold must not appear in buddy listing");
        assert.ok(!("riskHold" in buddy), "riskHold must not appear in buddy listing");
      }
    });

    it("does not include private contact fields in any buddy in the list", async () => {
      const { body } = await apiReq("GET", "/api/buddies");
      const privateFields = [
        "id_verification_ref",
        "legal_name",
        "exact_address",
        "home_address",
        "phone_number",
      ] as const;
      for (const buddy of body.buddies ?? []) {
        for (const field of privateFields) {
          assert.ok(!(field in buddy), `${field} must not appear in buddy listing`);
        }
      }
    });
  });

  // ── GET /api/rent-a-buddy/buddies/:id — admin and private fields must be absent ──
  // The route requires authentication; all requests include the test user token.

  describe("GET /api/rent-a-buddy/buddies/:id", () => {
    it("returns HTTP 200 with buddy object", async () => {
      const { status, body } = await apiReq("GET", `/api/rent-a-buddy/buddies/${BUDDY_ID}`, USER_TOKEN);
      assert.equal(status, 200);
      assert.ok(body.buddy !== null, "buddy must be returned");
      assert.equal(body.buddy?.id, BUDDY_ID);
    });

    it("does not include admin_status in buddy detail response", async () => {
      const { body } = await apiReq("GET", `/api/rent-a-buddy/buddies/${BUDDY_ID}`, USER_TOKEN);
      const buddy = body.buddy ?? {};
      assert.ok(!("admin_status" in buddy), "admin_status must not appear in buddy detail");
      assert.ok(!("adminStatus" in buddy), "adminStatus must not appear in buddy detail");
    });

    it("does not include risk_hold in buddy detail response", async () => {
      const { body } = await apiReq("GET", `/api/rent-a-buddy/buddies/${BUDDY_ID}`, USER_TOKEN);
      const buddy = body.buddy ?? {};
      assert.ok(!("risk_hold" in buddy), "risk_hold must not appear in buddy detail");
      assert.ok(!("riskHold" in buddy), "riskHold must not appear in buddy detail");
    });

    it("does not include private contact fields in buddy detail response", async () => {
      const { body } = await apiReq("GET", `/api/rent-a-buddy/buddies/${BUDDY_ID}`, USER_TOKEN);
      const buddy = body.buddy ?? {};
      const privateFields = [
        "id_verification_ref",
        "legal_name",
        "exact_address",
        "home_address",
        "phone_number",
      ] as const;
      for (const field of privateFields) {
        assert.ok(!(field in buddy), `${field} must not appear in buddy detail`);
      }
    });
  });
});

// ── completedBookings source-of-truth: completed_count wins when counters differ ──
//
// Regression guard for Task #92 which consolidated completedBookings to read
// from completed_count (canonical) instead of completed_bookings (legacy).
// These tests use a buddy row where the two columns intentionally diverge
// (completed_bookings=3, completed_count=7) and assert the response carries 7.

describe("completedBookings counter source-of-truth", () => {
  let srv: http.Server;
  let base: string;

  function makeDivergentClient() {
    function builder(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let isMaybeSingle = false;

      const allRows = (): any[] => {
        if (table === "profiles")            return [PROFILE_ROW_WITH_SENSITIVE];
        if (table === "feature_flags")       return [{ flag: "rent_buddy_enabled", enabled: true }];
        if (table === "rent_buddy_profiles") return [BUDDY_ROW_DIVERGENT_COUNTS];
        return [];
      };

      const b: any = {
        select(_cols?: string) { return b; },
        eq(col: string, val: any) {
          filters.push((r) => String(r[col]) === String(val));
          return b;
        },
        neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
        in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).map(String).includes(String(r[col]))); return b; },
        is(col: string, val: any)    { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
        gte()      { return b; },
        lte()      { return b; },
        ilike()    { return b; },
        contains() { return b; },
        like()     { return b; },
        or()       { return b; },
        order()    { return b; },
        limit()    { return b; },
        range()    { return b; },
        insert()   { return b; },
        update()   { return b; },
        upsert()   { return b; },
        delete()   { return b; },
        maybeSingle() { isMaybeSingle = true; return b; },
        single()      { isMaybeSingle = true; return b; },
        catch()    { return b; },

        then(onF: (v: any) => any, onR?: (e: any) => any) {
          const rows = allRows().filter((r) => filters.every((f) => f(r)));
          const result: any = isMaybeSingle
            ? { data: rows[0] ?? null, error: null }
            : { data: rows, count: rows.length, error: null };
          return Promise.resolve(result).then(onF, onR);
        },
      };
      return b;
    }

    const client: any = {
      auth: {
        getUser: async (tok: string) => {
          if (tok === USER_TOKEN) {
            return { data: { user: { id: USER_ID, email: "test@example.com" } }, error: null };
          }
          return { data: { user: null }, error: { message: "invalid token" } };
        },
      },
      from: (table: string) => builder(table),
    };
    return client;
  }

  before(async () => {
    const client = makeDivergentClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const app = express();
    app.use(express.json());
    app.use("/api", followsRouter);
    app.use(rentABuddyRouter);
    app.use(rentABuddyMarketplaceRouter);

    srv = http.createServer(app);
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
  });

  after(async () => {
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  function srvReq(
    method: string,
    path: string,
    token?: string,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, base);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const r = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname + url.search,
          method,
          headers,
        },
        (inRes) => {
          let raw = "";
          inRes.on("data", (c) => (raw += c));
          inRes.on("end", () => {
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({ status: inRes.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on("error", reject);
      r.end();
    });
  }

  // ── GET /api/rent-a-buddy/buddies/:id ────────────────────────────────────────

  describe("GET /api/rent-a-buddy/buddies/:id — divergent counters", () => {
    it("returns completedBookings equal to completed_count (7), not completed_bookings (3)", async () => {
      const { status, body } = await srvReq(
        "GET",
        `/api/rent-a-buddy/buddies/${BUDDY_ID_DIVERGENT}`,
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
      const buddy = body.buddy ?? {};
      assert.equal(
        buddy.completedBookings,
        7,
        `completedBookings should be completed_count (7) but got ${buddy.completedBookings}`,
      );
    });

    it("does not surface the legacy completed_bookings value (3) as completedBookings", async () => {
      const { body } = await srvReq(
        "GET",
        `/api/rent-a-buddy/buddies/${BUDDY_ID_DIVERGENT}`,
        USER_TOKEN,
      );
      const buddy = body.buddy ?? {};
      assert.notEqual(
        buddy.completedBookings,
        3,
        "completedBookings must not equal the legacy completed_bookings column value",
      );
    });
  });

  // ── GET /api/rent-a-buddy/sections ───────────────────────────────────────────

  describe("GET /api/rent-a-buddy/sections — divergent counters", () => {
    it("returns completedBookings equal to completed_count (7) in each section that includes the buddy", async () => {
      const { status, body } = await srvReq(
        "GET",
        "/api/rent-a-buddy/sections",
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
      const sections: Array<{ key: string; buddies: any[] }> = body.sections ?? [];
      // At least one section must contain buddies for this test to be meaningful
      const allBuddies = sections.flatMap((s) => s.buddies ?? []);
      assert.ok(allBuddies.length > 0, "sections response must include at least one buddy");
      for (const buddy of allBuddies) {
        assert.equal(
          buddy.completedBookings,
          7,
          `sections: completedBookings should be completed_count (7) but got ${buddy.completedBookings} for buddy ${buddy.id}`,
        );
        assert.notEqual(
          buddy.completedBookings,
          3,
          "sections: completedBookings must not equal the legacy completed_bookings value (3)",
        );
      }
    });
  });
});
