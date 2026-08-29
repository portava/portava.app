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
    app.use("/api", rentABuddyRouter);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

  // ── PATCH /api/me/profile — clearing bio (null) must be accepted ─────────────

  describe("PATCH /api/me/profile — bio: null (clear)", () => {
    it("returns HTTP 200 when clearing bio to null", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { bio: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });
  });

  // ── PATCH /api/me/profile — clearing travelStyle (null) must be accepted ────

  describe("PATCH /api/me/profile — travelStyle: null (clear)", () => {
    it("returns HTTP 200 when clearing travelStyle to null", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { travelStyle: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });
  });

  // ── PATCH /api/me/profile — clearing avatarUrl / coverUrl must be accepted ──

  describe("PATCH /api/me/profile — clearing media URLs", () => {
    it("returns HTTP 200 when clearing avatarUrl to null", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { avatarUrl: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("returns HTTP 200 when clearing coverUrl to null", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { coverUrl: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("returns HTTP 200 when clearing both avatarUrl and coverUrl to null", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { avatarUrl: null, coverUrl: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("still rejects a non-URL string for avatarUrl", async () => {
      const { status } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { avatarUrl: "not-a-url" },
        USER_TOKEN,
      );
      assert.equal(status, 400);
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

  // ── PATCH /api/me/profile — clearing multiple fields including DOB at once ────
  //
  // A multi-field null-clear exercises a different branch through the
  // update-row-building logic than a single-field clear. This block confirms
  // that mapProfile's DOB strip is not bypassed when additional nullable
  // fields (preferredLanguage) are also cleared in the same request.
  // Both dateOfBirth and preferredLanguage accept null per patchProfileSchema.

  describe("PATCH /api/me/profile — multi-field clear including dateOfBirth: null", () => {
    it("returns HTTP 200 when clearing dateOfBirth and preferredLanguage in the same request", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, preferredLanguage: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("does not include date_of_birth (snake_case) after clearing multiple fields", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, preferredLanguage: null },
        USER_TOKEN,
      );
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in multi-field clear response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) after clearing multiple fields", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, preferredLanguage: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in multi-field clear response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) after clearing multiple fields", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, preferredLanguage: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in multi-field clear response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) after clearing multiple fields", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, preferredLanguage: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in multi-field clear response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });
  });

  // ── PATCH /api/me/profile — clearing homeCity alongside DOB covers a different DB column path ──
  //
  // homeCity maps to home_city (a non-bio column) rather than preferred_language,
  // which exercises yet another branch through the update-row builder and confirms
  // the DOB strip is robust regardless of which other nullable field is co-cleared.

  // ── PATCH /api/me/profile — clearing travelPace/budgetStyle alongside DOB ──
  //
  // travelPace and budgetStyle are enum-typed nullable fields mapped to their
  // own DB columns independently of dateOfBirth. This confirms the DOB strip
  // on the response holds even when those enum fields are cleared in the
  // same request as dateOfBirth — no cross-field leak of DOB data.

  describe("PATCH /api/me/profile — clearing travelPace and budgetStyle alongside dateOfBirth", () => {
    it("returns HTTP 200 when clearing travelPace, budgetStyle, and dateOfBirth together", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { travelPace: null, budgetStyle: null, dateOfBirth: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("does not include date_of_birth (snake_case) when clearing travelPace/budgetStyle/dateOfBirth", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { travelPace: null, budgetStyle: null, dateOfBirth: null },
        USER_TOKEN,
      );
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) when clearing travelPace/budgetStyle/dateOfBirth", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { travelPace: null, budgetStyle: null, dateOfBirth: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) when clearing travelPace/budgetStyle/dateOfBirth", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { travelPace: null, budgetStyle: null, dateOfBirth: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) when clearing travelPace/budgetStyle/dateOfBirth", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { travelPace: null, budgetStyle: null, dateOfBirth: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("clears travel_pace and budget_style themselves (nulled, not just DOB fields)", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { travelPace: null, budgetStyle: null, dateOfBirth: null },
        USER_TOKEN,
      );
      assert.equal(body.travelPace ?? null, null, `travelPace must be null — got ${JSON.stringify(body.travelPace)}`);
      assert.equal(body.budgetStyle ?? null, null, `budgetStyle must be null — got ${JSON.stringify(body.budgetStyle)}`);
    });
  });

  describe("PATCH /api/me/profile — clearing homeCity and dateOfBirth together", () => {
    it("returns HTTP 200 when clearing dateOfBirth and homeCity in the same request", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, homeCity: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("does not include date_of_birth (snake_case) when clearing homeCity and dateOfBirth", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, homeCity: null },
        USER_TOKEN,
      );
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) when clearing homeCity and dateOfBirth", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, homeCity: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) when clearing homeCity and dateOfBirth", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, homeCity: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) when clearing homeCity and dateOfBirth", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, homeCity: null },
        USER_TOKEN,
      );
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });
  });

  // ── PATCH /api/me/profile — avatarUrl update triggering the service-client pre-fetch ──
  //
  // When avatarUrl (or coverUrl) is included, the handler does an extra
  // service-client DB fetch to capture the old URL before writing. That
  // pre-fetch path is distinct from the main update flow; confirm DOB fields
  // stay stripped when it runs alongside a homeCity clear.

  describe("PATCH /api/me/profile — avatarUrl update (pre-fetch branch) with homeCity clear", () => {
    const payload = { homeCity: null, avatarUrl: "https://example.com/pic.jpg" };

    it("returns HTTP 200 when setting avatarUrl while clearing homeCity", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        payload,
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("does not include date_of_birth (snake_case) after avatarUrl pre-fetch update", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        payload,
        USER_TOKEN,
      );
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) after avatarUrl pre-fetch update", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        payload,
        USER_TOKEN,
      );
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) after avatarUrl pre-fetch update", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        payload,
        USER_TOKEN,
      );
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) after avatarUrl pre-fetch update", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        payload,
        USER_TOKEN,
      );
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });
  });

  // ── PATCH /api/me/profile — null DOB with non-null sibling field (mixed update) ──
  //
  // Exercises the row-builder branch where dateOfBirth is cleared (null) while
  // another field (bio) is simultaneously set to a real value. Confirms that
  // mapProfile's DOB strip holds regardless of sibling field values.

  describe("PATCH /api/me/profile — dateOfBirth: null with non-null bio (mixed update)", () => {
    it("returns HTTP 200 when clearing dateOfBirth while setting a non-null bio", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("does not include date_of_birth (snake_case) after clearing DOB with non-null bio", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in mixed-update PATCH response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) after clearing DOB with non-null bio", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in mixed-update PATCH response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) after clearing DOB with non-null bio", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in mixed-update PATCH response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) after clearing DOB with non-null bio", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { dateOfBirth: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in mixed-update PATCH response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });
  });

  // ── PATCH /api/me/profile — all nullable fields cleared simultaneously ────────
  //
  // Exercises the maximum-width null-clear path through the row builder:
  // dateOfBirth, homeCity, preferredLanguage, and defaultLanguage are all sent
  // as null in one request. Confirms that mapProfile's DOB strip holds even
  // when every nullable column is cleared at once — no combination of null
  // assignments must cause the strip to be skipped.

  describe("PATCH /api/me/profile — all nullable fields cleared at once", () => {
    const ALL_NULL_PAYLOAD = {
      dateOfBirth: null,
      homeCity: null,
      preferredLanguage: null,
      defaultLanguage: null,
    };

    it("returns HTTP 200 when all nullable fields are cleared simultaneously", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        ALL_NULL_PAYLOAD,
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("does not include date_of_birth (snake_case) when all nullable fields are cleared", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        ALL_NULL_PAYLOAD,
        USER_TOKEN,
      );
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in all-null-clear response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) when all nullable fields are cleared", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        ALL_NULL_PAYLOAD,
        USER_TOKEN,
      );
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in all-null-clear response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) when all nullable fields are cleared", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        ALL_NULL_PAYLOAD,
        USER_TOKEN,
      );
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in all-null-clear response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) when all nullable fields are cleared", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        ALL_NULL_PAYLOAD,
        USER_TOKEN,
      );
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in all-null-clear response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });
  });

  // ── PATCH /api/me/profile — clearing homeCity with a non-null bio, no DOB in payload ──
  //
  // homeCity maps to home_city, which goes through its own branch in the
  // update-row builder.  This confirms that mapProfile's DOB strip fires even
  // when the PATCH payload contains neither dateOfBirth nor any DOB-adjacent
  // field — the leaked fields can only come from the re-fetched DB row.

  describe("PATCH /api/me/profile — homeCity: null with non-null bio (mixed update)", () => {
    it("returns HTTP 200 when clearing homeCity while setting a non-null bio", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { homeCity: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it("does not include date_of_birth (snake_case) when clearing homeCity with non-null bio", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { homeCity: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.ok(
        !("date_of_birth" in body),
        `date_of_birth must not appear in homeCity-clear/bio-set response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dateOfBirth (camelCase) when clearing homeCity with non-null bio", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { homeCity: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.ok(
        !("dateOfBirth" in body),
        `dateOfBirth must not appear in homeCity-clear/bio-set response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dob_verified (snake_case) when clearing homeCity with non-null bio", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { homeCity: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.ok(
        !("dob_verified" in body),
        `dob_verified must not appear in homeCity-clear/bio-set response — got keys: ${Object.keys(body).join(", ")}`,
      );
    });

    it("does not include dobVerified (camelCase) when clearing homeCity with non-null bio", async () => {
      const { body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { homeCity: null, bio: "hello" },
        USER_TOKEN,
      );
      assert.ok(
        !("dobVerified" in body),
        `dobVerified must not appear in homeCity-clear/bio-set response — got keys: ${Object.keys(body).join(", ")}`,
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

  // ── PATCH /api/me/profile — clearing homeCountry and currentCity to null ──
  //
  // homeCountry and currentCity were previously declared .optional() in
  // patchProfileSchema, which means a PATCH with null would be rejected (400).
  // They are now .nullish() so callers can clear them just like homeCity.

  describe("PATCH /api/me/profile — clearing homeCountry to null", () => {
    it("returns HTTP 200 when homeCountry is null", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { homeCountry: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });
  });

  describe("PATCH /api/me/profile — clearing currentCity to null", () => {
    it("returns HTTP 200 when currentCity is null", async () => {
      const { status, body } = await apiReqWithBody(
        "PATCH",
        "/api/me/profile",
        { currentCity: null },
        USER_TOKEN,
      );
      assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
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
    app.use("/api", rentABuddyRouter);
    app.use("/api", rentABuddyMarketplaceRouter);

    srv = http.createServer(app);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
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

// ── PATCH /api/me/profile — clearing media URLs must delete the old storage file ──
//
// The route captures the previous avatar/cover URLs before the update and
// removes the old storage objects afterwards (fire-and-forget setImmediate).
// This block verifies the cleanup also runs when the new value is null
// (clearing), so orphaned files don't accumulate in the profile-media bucket —
// and that no removal happens when there was no old URL to begin with.

describe("PATCH /api/me/profile — old storage file cleanup on clear", () => {
  const OLD_AVATAR_PATH = `avatars/${USER_ID}/old-avatar.jpg`;
  const OLD_COVER_PATH  = `covers/${USER_ID}/old-cover.jpg`;
  const STORAGE_BASE = "https://example.supabase.co/storage/v1/object/public/profile-media/";

  let srv: http.Server;
  let base: string;
  let removedPaths: string[];
  // Mutable current row so each test can control old avatar/cover state.
  let profileRow: any;
  // When set, the NEXT profiles update fails once with this error (schema-drift
  // simulation); the retry then succeeds. Cleared after being consumed.
  let failFirstUpdate: { code: string; message: string } | null = null;

  function makeStorageClient() {
    function builder(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let isMaybeSingle = false;
      let isUpdate = false;

      const allRows = (): any[] => (table === "profiles" ? [profileRow] : []);

      const b: any = {
        select() { return b; },
        eq(col: string, val: any) { filters.push((r) => String(r[col]) === String(val)); return b; },
        neq()      { return b; },
        order()    { return b; },
        limit()    { return b; },
        insert()   { return b; },
        update()   { isUpdate = true; return b; },
        upsert()   { return b; },
        delete()   { return b; },
        maybeSingle() { isMaybeSingle = true; return b; },
        single()      { isMaybeSingle = true; return b; },

        then(onF: (v: any) => any, onR?: (e: any) => any) {
          if (isUpdate && table === "profiles" && failFirstUpdate) {
            const err = failFirstUpdate;
            failFirstUpdate = null; // fail only the first attempt; the retry succeeds
            return Promise.resolve({ data: null, error: err }).then(onF, onR);
          }
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
      storage: {
        createBucket: async () => ({ error: null }),
        from: (_bucket: string) => ({
          remove: (paths: string[]) => {
            removedPaths.push(...paths);
            return Promise.resolve({ data: paths, error: null });
          },
        }),
      },
    };
    return client;
  }

  /** Flush the fire-and-forget setImmediate cleanup. */
  function flushCleanup(): Promise<void> {
    return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  }

  before(async () => {
    const client = makeStorageClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const app = express();
    app.use(express.json());
    // The fallback path logs via req.log — stub it (pino is not wired in tests).
    app.use((req, _res, next) => { (req as any).log = { warn() {}, error() {}, info() {} }; next(); });
    app.use("/api", profileRouter);

    srv = http.createServer(app);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
  });

  after(async () => {
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  function patchProfile(body: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL("/api/me/profile", base);
      const payload = JSON.stringify(body);
      const r = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload).toString(),
            authorization: `Bearer ${USER_TOKEN}`,
          },
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

  it("removes the old avatar file from storage when avatarUrl is cleared to null", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: STORAGE_BASE + OLD_AVATAR_PATH,
      cover_photo_url: null,
    };

    const { status, body } = await patchProfile({ avatarUrl: null });
    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [OLD_AVATAR_PATH],
      `expected old avatar path to be removed from storage — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  it("removes the old cover file from storage when coverUrl is cleared to null", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: null,
      cover_photo_url: STORAGE_BASE + OLD_COVER_PATH,
    };

    const { status, body } = await patchProfile({ coverUrl: null });
    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [OLD_COVER_PATH],
      `expected old cover path to be removed from storage — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  it("removes both old files when avatarUrl and coverUrl are cleared in one request", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: STORAGE_BASE + OLD_AVATAR_PATH,
      cover_photo_url: STORAGE_BASE + OLD_COVER_PATH,
    };

    const { status } = await patchProfile({ avatarUrl: null, coverUrl: null });
    assert.equal(status, 200);
    await flushCleanup();

    assert.deepEqual(
      removedPaths.sort(),
      [OLD_AVATAR_PATH, OLD_COVER_PATH].sort(),
      `expected both old paths to be removed — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  it("does not call storage removal when the old avatar URL was already null", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: null,
      cover_photo_url: null,
    };

    const { status } = await patchProfile({ avatarUrl: null, coverUrl: null });
    assert.equal(status, 200);
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [],
      `no removal expected when old URLs are null — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  // ── Replacement (new URL while an old one exists) — the far more common path ──

  it("removes the old avatar file from storage when avatarUrl is replaced with a new URL", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: STORAGE_BASE + OLD_AVATAR_PATH,
      cover_photo_url: null,
    };

    const { status, body } = await patchProfile({
      avatarUrl: STORAGE_BASE + `avatars/${USER_ID}/new-avatar.jpg`,
    });
    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [OLD_AVATAR_PATH],
      `expected old avatar path to be removed after replacement — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  it("removes the old cover file from storage when coverUrl is replaced with a new URL", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: null,
      cover_photo_url: STORAGE_BASE + OLD_COVER_PATH,
    };

    const { status, body } = await patchProfile({
      coverUrl: STORAGE_BASE + `covers/${USER_ID}/new-cover.jpg`,
    });
    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [OLD_COVER_PATH],
      `expected old cover path to be removed after replacement — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  it("removes both old files when avatarUrl and coverUrl are replaced in one request", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: STORAGE_BASE + OLD_AVATAR_PATH,
      cover_photo_url: STORAGE_BASE + OLD_COVER_PATH,
    };

    const { status } = await patchProfile({
      avatarUrl: STORAGE_BASE + `avatars/${USER_ID}/new-avatar.jpg`,
      coverUrl:  STORAGE_BASE + `covers/${USER_ID}/new-cover.jpg`,
    });
    assert.equal(status, 200);
    await flushCleanup();

    assert.deepEqual(
      removedPaths.sort(),
      [OLD_AVATAR_PATH, OLD_COVER_PATH].sort(),
      `expected both old paths to be removed after replacement — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  it("does not call storage removal when the new avatarUrl equals the old URL (idempotent re-save)", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: STORAGE_BASE + OLD_AVATAR_PATH,
      cover_photo_url: null,
    };

    const { status } = await patchProfile({ avatarUrl: STORAGE_BASE + OLD_AVATAR_PATH });
    assert.equal(status, 200);
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [],
      `no removal expected when new URL equals old URL — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  it("does not call storage removal when the new coverUrl equals the old URL (idempotent re-save)", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: null,
      cover_photo_url: STORAGE_BASE + OLD_COVER_PATH,
    };

    const { status } = await patchProfile({ coverUrl: STORAGE_BASE + OLD_COVER_PATH });
    assert.equal(status, 200);
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [],
      `no removal expected when new URL equals old URL — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  // ── Schema-drift fallback path (first update fails PGRST204, retry succeeds) ──
  // The fallback early-returns a 200 with `unsavedFields`; the old-file cleanup
  // must still run for fields that were actually persisted (avatar_url is a
  // base column). cover_photo_url is stripped by the fallback, so the old
  // cover must NOT be deleted — it's still live.

  it("still removes the old avatar file when the update takes the schema-drift fallback path", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: STORAGE_BASE + OLD_AVATAR_PATH,
      cover_photo_url: null,
    };
    failFirstUpdate = { code: "PGRST204", message: "column profiles.travel_pace does not exist" };

    const { status, body } = await patchProfile({
      avatarUrl: STORAGE_BASE + `avatars/${USER_ID}/new-avatar.jpg`,
      travelPace: "slow", // stripped by fallback → forces the unsavedFields 200 early return
    });
    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    assert.deepEqual(body.unsavedFields, ["travelPace"], "expected the fallback partial-success response");
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [OLD_AVATAR_PATH],
      `expected old avatar path to be removed on the fallback path — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  it("does NOT remove the old cover file on the fallback path — cover_photo_url is stripped, so the old cover is still live", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: null,
      cover_photo_url: STORAGE_BASE + OLD_COVER_PATH,
    };
    failFirstUpdate = { code: "PGRST204", message: "column profiles.cover_photo_url does not exist" };

    const { status, body } = await patchProfile({
      coverUrl: STORAGE_BASE + `covers/${USER_ID}/new-cover.jpg`,
      bio: "still saved", // base column keeps the fallback write non-empty
    });
    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    assert.deepEqual(body.unsavedFields, ["coverUrl"], "expected coverUrl to be reported unsaved");
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [],
      `old cover must NOT be removed when its column was not persisted — got: ${JSON.stringify(removedPaths)}`,
    );
  });

  it("does not remove a file whose old URL is outside the profile-media public bucket", async () => {
    removedPaths = [];
    profileRow = {
      ...PROFILE_ROW_WITH_SENSITIVE,
      avatar_url: "https://cdn.example.com/external/pic.jpg", // no bucket marker
      cover_photo_url: null,
    };

    const { status } = await patchProfile({ avatarUrl: null });
    assert.equal(status, 200);
    await flushCleanup();

    assert.deepEqual(
      removedPaths,
      [],
      `no removal expected for non-bucket URLs — got: ${JSON.stringify(removedPaths)}`,
    );
  });
});
