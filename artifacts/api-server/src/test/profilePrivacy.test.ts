/**
 * Profile privacy tests — serializer + passport route enforcement
 *
 * Covers:
 *   1. toPrivateProfilePreview returns exactly the safe preview fields
 *   2. Bio field is absent (key not present, not null/empty)
 *   3. homeCity, homeCountry, follower/following counts, stamps, plans, posts,
 *      trips are absent from the private preview
 *   4. A pending follow request does not elevate access (still preview)
 *   5. An approved follower receives the full profile view (via toFullProfileView)
 *   6. toFullProfileView includes bio, homeCity, homeCountry, currentCity, etc.
 *   7. Blocked user receives blocked sentinel from GET /users/:username/passport
 *   8. Unauthorized viewer of private profile receives limited_preview from GET /users/:username/passport
 *   9. Viewer with an existing pending friend_request receives friend_request_pending=true in the sentinel
 *
 * Run: node --import tsx/esm --test src/test/profilePrivacy.test.ts
 *
 * NOTE: All suites live inside one outer describe so node:test runs them
 * sequentially (top-level describes run in parallel by default, which would
 * race on the shared _setTestClient global).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import {
  toPrivateProfilePreview,
  toPublicProfilePreview,
  toFullProfileView,
} from "../lib/privacy/profileSerializers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function req(
  method: string,
  path: string,
  token: string,
  server: Server,
): Promise<{ status: number; body: any }> {
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    const r = httpRequest(
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
    r.end();
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VIEWER_ID  = "aaaaaaaa-0001-4000-a000-aaaaaaaaaaaa";
const TARGET_ID  = "bbbbbbbb-0001-4000-b000-bbbbbbbbbbbb";
const BLOCKED_ID = "cccccccc-0001-4000-c000-cccccccccccc";

const VIEWER_TOKEN  = "profile-privacy-viewer-token";
const BLOCKED_TOKEN = "profile-privacy-blocked-token";

/** Full DB row for a private profile target */
const PRIVATE_PROFILE_ROW = {
  id: TARGET_ID,
  username: "travelerj",
  handle: "travelerj",
  name: "Jane Traveler",
  display_name: "Jane Traveler",
  bio: "I love hiking and street food.",
  avatar_url: "https://cdn.example.com/avatar/jane.jpg",
  cover_photo_url: "https://cdn.example.com/cover/jane.jpg",
  home_city: "Portland",
  home_country: "USA",
  current_city: "Lisbon",
  travel_style: "budget",
  interests: ["hiking", "food"],
  verified: false,
  verification_status: "unverified",
  verified_at: null,
  open_to_meet: true,
  is_private: true,
  passport_visibility: "private",
  cover_photo_url_2: null,
  username_updated_at: null,
  created_at: "2024-01-15T10:00:00Z",
  spoken_languages: ["en"],
  default_language: "en",
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
  verification_level: null,
  id_verified_at: null,
  selfie_verified_at: null,
  home_country_verified_at: null,
  safety_flags_count: null,
  host_verified_at: null,
  buddy_verified_at: null,
  passport_section_order: null,
  passport_tab_order: null,
  passport_hidden_sections: null,
  account_status: "active",
  show_profile_picture_publicly: true,
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Profile Privacy — serializer unit tests", () => {
  // ── toPrivateProfilePreview ─────────────────────────────────────────────────

  it("returns exactly the safe preview fields — no extras", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    const allowed = new Set([
      "id", "username", "displayName", "avatarUrl",
      "isPrivate", "isVerified", "visibility",
      "is_friend", "friend_request_pending", "relationshipStatus",
    ]);
    for (const key of Object.keys(result)) {
      assert(allowed.has(key), `unexpected field "${key}" in PrivateProfilePreview`);
    }
  });

  it("bio is absent — key is not present, not null or empty string", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    assert(!("bio" in result), "bio must not be a key in PrivateProfilePreview");
  });

  it("homeCity is absent from private preview", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    assert(!("homeCity" in result), "homeCity must not be in PrivateProfilePreview");
  });

  it("homeCountry is absent from private preview", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    assert(!("homeCountry" in result), "homeCountry must not be in PrivateProfilePreview");
  });

  it("followerCount / followingCount are absent from private preview", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    assert(!("followerCount" in result), "followerCount must not be in PrivateProfilePreview");
    assert(!("followingCount" in result), "followingCount must not be in PrivateProfilePreview");
  });

  it("stamps, plans, posts, trips counts are absent from private preview", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    for (const field of ["stamps", "plans", "posts", "trips", "stampCount", "tripCount", "postCount"]) {
      assert(!(field in result), `"${field}" must not be in PrivateProfilePreview`);
    }
  });

  it("avatarUrl is always null in private preview", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    assert.equal(result.avatarUrl, null, "avatarUrl must be null in PrivateProfilePreview");
  });

  it("visibility sentinel is always 'private'", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    assert.equal(result.visibility, "private");
  });

  it("isPrivate is true", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    assert.equal(result.isPrivate, true);
  });

  it("id and username are included", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW);
    assert.equal(result.id, TARGET_ID);
    assert.equal(result.username, "travelerj");
  });

  it("pending request state — relationshipStatus outgoing_request, no extra fields", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW, {
      relationshipStatus: "outgoing_request",
    });
    assert.equal(result.relationshipStatus, "outgoing_request");
    assert.equal(result.friend_request_pending, true);
    assert(!("bio" in result), "bio must not be in preview for pending request");
    assert(!("homeCity" in result), "homeCity must not be in preview for pending request");
  });

  it("friend state — relationshipStatus friend, still no private fields", () => {
    const result = toPrivateProfilePreview(PRIVATE_PROFILE_ROW, {
      relationshipStatus: "friend",
    });
    assert.equal(result.relationshipStatus, "friend");
    assert.equal(result.is_friend, true);
    assert(!("bio" in result), "bio must not be in preview even for friend (friend uses toFullProfileView, not this serializer)");
  });

  // ── toFullProfileView ───────────────────────────────────────────────────────

  it("approved follower (toFullProfileView) receives bio", () => {
    const result = toFullProfileView(PRIVATE_PROFILE_ROW);
    assert("bio" in result, "bio must be present in FullProfileView");
    assert.equal(result.bio, "I love hiking and street food.");
  });

  it("approved follower receives homeCity and homeCountry", () => {
    const result = toFullProfileView(PRIVATE_PROFILE_ROW);
    assert("homeCity" in result, "homeCity must be in FullProfileView");
    assert("homeCountry" in result, "homeCountry must be in FullProfileView");
    assert.equal(result.homeCity, "Portland");
    assert.equal(result.homeCountry, "USA");
  });

  it("approved follower receives currentCity", () => {
    const result = toFullProfileView(PRIVATE_PROFILE_ROW);
    assert("currentCity" in result, "currentCity must be in FullProfileView");
    assert.equal(result.currentCity, "Lisbon");
  });

  it("approved follower receives avatarUrl (not forced null)", () => {
    const result = toFullProfileView(PRIVATE_PROFILE_ROW);
    assert.equal(result.avatarUrl, "https://cdn.example.com/avatar/jane.jpg");
  });

  // ── toPublicProfilePreview ──────────────────────────────────────────────────

  it("public profile preview includes bio but not currentCity", () => {
    const publicRow = { ...PRIVATE_PROFILE_ROW, is_private: false };
    const result = toPublicProfilePreview(publicRow);
    assert("bio" in result, "bio must be present in PublicProfilePreview");
    assert(!("currentCity" in result), "currentCity should not be in PublicProfilePreview");
  });
});

// ── Route-level tests (HTTP) ──────────────────────────────────────────────────

describe("Profile Privacy — passport route integration", () => {
  let server: Server;

  before(
    () =>
      new Promise<void>((resolve) => {
        server = createServer(app);
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  beforeEach(() => {
    // Default: no block row — viewer is an ordinary stranger.
    _setTestClient(makePassportFakeClient(), true);
  });

  function apiReq(method: string, path: string, token: string) {
    return req(method, path, token, server);
  }

  it("unauthorized viewer of private profile receives limited_preview shape", async () => {
    const { status, body } = await apiReq("GET", "/api/users/travelerj/passport", VIEWER_TOKEN);
    assert.equal(status, 200);
    // limited_preview — sentinel fields
    assert.equal(body.visibility, "private");
    assert.equal(body.isPrivate, true);
    // bio must not be present
    assert(!("bio" in body), "bio must not be in limited_preview response");
    assert(!("homeCity" in body), "homeCity must not be in limited_preview");
    assert(!("homeCountry" in body), "homeCountry must not be in limited_preview");
  });

  it("blocked viewer receives blocked sentinel", async () => {
    // Override: populate blocks table so resolveProfileVisibility returns "blocked".
    _setTestClient(makePassportFakeClient({ withBlock: true }), true);
    const { status, body } = await apiReq("GET", "/api/users/travelerj/passport", BLOCKED_TOKEN);
    assert.equal(status, 200);
    assert.equal(body.blocked, true, "blocked viewer should receive { blocked: true }");
    assert(!("bio" in body), "bio must not leak through blocked sentinel");
  });

  it("viewer with a pending friend request receives friend_request_pending=true in sentinel", async () => {
    // The fix: the passport limited_preview path now queries friend_requests directly
    // instead of relying on resolveInteractionPermissions (which could throw silently).
    // Seed a pending friend_requests row for the viewer→target direction.
    _setTestClient(makePassportFakeClient({ withPendingRequest: true }), true);
    const { status, body } = await apiReq("GET", "/api/users/travelerj/passport", VIEWER_TOKEN);
    assert.equal(status, 200);
    assert.equal(body.visibility, "private", "still limited_preview — pending request grants no access");
    assert.equal(body.friend_request_pending, true, "pending request must be reflected in the sentinel");
    assert.equal(body.relationshipStatus, "outgoing_request");
    assert(!("bio" in body), "bio must not leak even with a pending request");
  });
});

// ── Fake client for passport route ───────────────────────────────────────────

function makePassportFakeClient({
  withBlock = false,
  withPendingRequest = false,
}: { withBlock?: boolean; withPendingRequest?: boolean } = {}) {
  const db: Record<string, any[]> = {
    profiles: [{ ...PRIVATE_PROFILE_ROW }],
    user_follows: [],
    user_friendships: [],
    // Seed a pending friend_requests row when withPendingRequest is true.
    // This exercises the new direct-query path in the passport limited_preview branch.
    friend_requests: withPendingRequest
      ? [{ id: "req-001", requester_id: VIEWER_ID, recipient_id: TARGET_ID, status: "pending" }]
      : [],
    // The .or() helper in the chain below is a no-op (returns all rows) so we
    // must scope the blocks table to only the rows that apply to THIS scenario.
    // An empty table means no block; a populated table means the viewer is blocked.
    blocks: withBlock
      ? [{ blocker_id: BLOCKED_ID, blocked_id: TARGET_ID }]
      : [],
    profile_views: [],
    profile_privacy_settings: [],
    user_account_states: [],
    rent_buddy_profiles: [],
    user_restrictions: [],
    user_interaction_cooldowns: [],
  };

  function tableRows(table: string): any[] {
    return db[table] ?? [];
  }

  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _pending: "select" | "insert" | "update" | "upsert" | null = "select";
    let _update: any = null;
    let _insert: any = null;
    let _maybeSingle = false;
    let _single = false;
    let _count = false;

    const obj: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count) _count = true;
        _pending = "select";
        return obj;
      },
      insert(data: any) { _insert = data; _pending = "insert"; return obj; },
      update(patch: any) { _update = patch; _pending = "update"; return obj; },
      upsert(data: any) { _insert = data; _pending = "upsert"; return obj; },
      delete() { _pending = "select"; return obj; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      is(col: string, val: any) { filters.push((r) => val === null ? r[col] == null : r[col] === val); return obj; },
      or(_f: string) { return obj; },
      not(_col: string, _op: string, _val: any) { return obj; },
      limit(_n: number) { return obj; },
      order() { return obj; },
      range() { return obj; },
      gte() { return obj; },
      lte() { return obj; },
      ilike() { return obj; },
      maybeSingle() {
        _maybeSingle = true;
        const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null, count: _count ? rows.length : null });
      },
      single() {
        _single = true;
        const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        if (_pending === "insert" || _pending === "upsert") {
          const row = Array.isArray(_insert) ? _insert : [_insert ?? {}];
          return Promise.resolve({ data: row, error: null }).then(onF, onR);
        }
        if (_pending === "update") {
          return Promise.resolve({ data: null, error: null }).then(onF, onR);
        }
        const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
        if (_count) {
          return Promise.resolve({ data: rows, error: null, count: rows.length }).then(onF, onR);
        }
        return Promise.resolve({ data: rows, error: null }).then(onF, onR);
      },
    };
    return obj;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === VIEWER_TOKEN) return { data: { user: { id: VIEWER_ID } }, error: null };
        if (token === BLOCKED_TOKEN) return { data: { user: { id: BLOCKED_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from: (table: string) => chain(table),
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
      }),
    },
    rpc: async () => ({ data: null, error: null }),
  };
}
