/**
 * Profile edit round-trip integration test
 *
 * Confirms that PATCH /me/profile persists values that are immediately
 * visible on the subsequent GET /me/profile call — no stale data.
 *
 * Specifically guards the display_name column fix: the PATCH must write
 * `display_name` (not just `name`) and the GET must return it as `displayName`.
 *
 * Run: node --import tsx/esm --test src/test/profileRoundTrip.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import sharp from "sharp";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

// ── Stable IDs ────────────────────────────────────────────────────────────────

const ME    = "aa000000-0000-4000-a000-000000000001";
const ME_TOK = "tok-me";

// ── Fake client that persists updates to in-memory state ──────────────────────

type ProfileRow = Record<string, unknown>;

function makeClient(profiles: ProfileRow[]) {
  function makeBuilder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    let _singleMode = false;

    const builder: any = {
      select()                      { return builder; },
      eq(col: string, val: any)     { filters.push((r) => String(r[col]) === String(val)); return builder; },
      neq(col: string, val: any)    { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[])  { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
      is(col: string, val: any)     { filters.push((r) => val === null ? r[col] == null : r[col] === val); return builder; },
      lt(col: string, val: any)     { filters.push((r) => r[col] < val); return builder; },
      gte(col: string, val: any)    { filters.push((r) => r[col] >= val); return builder; },
      order()                       { return builder; },
      limit()                       { return builder; },
      nullsFirst()                  { return builder; },
      update(patch: Record<string, unknown>) {
        pendingUpdate = patch;
        return builder;
      },
      insert(row: any) { return builder; },
      upsert(row: any) { return builder; },
      maybeSingle() {
        if (table === "profiles" && pendingUpdate) {
          const rows = profiles.filter((r) => filters.every((f) => f(r)));
          if (rows[0]) {
            Object.assign(rows[0], pendingUpdate);
            return Promise.resolve({ data: { ...rows[0] }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (table === "profiles") {
          const rows = profiles.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        if (table === "profiles" && pendingUpdate) {
          const rows = profiles.filter((r) => filters.every((f) => f(r)));
          if (rows[0]) {
            Object.assign(rows[0], pendingUpdate);
            return Promise.resolve({ data: { ...rows[0] }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (table === "profiles") {
          const rows = profiles.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        if (table === "profiles" && pendingUpdate) {
          const rows = profiles.filter((r) => filters.every((f) => f(r)));
          rows.forEach((r) => Object.assign(r, pendingUpdate));
          return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(onF, onR);
        }
        const rows = table === "profiles"
          ? profiles.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }))
          : [];
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(onF, onR);
      },
      catch() { return builder; },
    };
    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (tok: string) => {
        if (tok === ME_TOK) return { data: { user: { id: ME } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: (table: string) => makeBuilder(table),
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
      }),
    },
  };
  return client;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

let base: string;
let server: ReturnType<typeof createServer>;
// Real minimal JPEG that passes sharp preprocessing — used for storage-rejection tests.
let realJpeg: Buffer;

before(async () => {
  realJpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#abc" } })
    .jpeg().toBuffer();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", profileRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());

function api(path: string, opts: { method?: string; body?: any } = {}) {
  const { method = "GET", body } = opts;
  const headers: Record<string, string> = { Authorization: `Bearer ${ME_TOK}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH → GET /api/me/profile round-trip", () => {

  it("displayName update is reflected in the subsequent GET", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Old Name", display_name: "Old Name", username: "me_user",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: { displayName: "New Name" },
    });
    const patchBody = await patchRes.json() as any;
    assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(patchBody)}`);
    assert.equal(patchBody.displayName, "New Name", "PATCH response must return updated displayName");

    const getRes = await api("/me/profile");
    const getBody = await getRes.json() as any;
    assert.equal(getRes.status, 200, `GET failed: ${JSON.stringify(getBody)}`);
    assert.equal(getBody.displayName, "New Name",
      "GET after PATCH must return the updated displayName, not stale data");
  });

  it("display_name column is written (not just name) so mapProfile returns it correctly", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Alice", display_name: "Alice", username: "alice_rt",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    await api("/me/profile", { method: "PATCH", body: { displayName: "Alice Updated" } });

    // Inspect the in-memory row directly: both columns must be set
    assert.equal(profiles[0].display_name, "Alice Updated",
      "display_name column must be written on PATCH");
    assert.equal(profiles[0].name, "Alice Updated",
      "name column must also be written on PATCH");
  });

  it("other profile fields also survive the round-trip", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Traveler", display_name: "Traveler", username: "trvlr",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: {
        displayName: "Round Tripper",
        bio: "Loves to explore",
        homeCity: "Manila",
        homeCountry: "Philippines",
      },
    });
    const patchBody2 = await patchRes.json() as any;
    assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(patchBody2)}`);

    const getRes = await api("/me/profile");
    assert.equal(getRes.status, 200);
    const body = await getRes.json() as any;

    assert.equal(body.displayName, "Round Tripper");
    assert.equal(body.bio, "Loves to explore");
    assert.equal(body.homeCity, "Manila");
    assert.equal(body.homeCountry, "Philippines");
  });

  it("bio, homeCity, and homeCountry survive a round-trip without being wiped", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Wanderer", display_name: "Wanderer", username: "wanderer",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: {
        bio: "Digital nomad at heart",
        homeCity: "Cebu City",
        homeCountry: "Philippines",
      },
    });
    assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(await patchRes.clone().json())}`);

    const getRes = await api("/me/profile");
    assert.equal(getRes.status, 200);
    const body = await getRes.json() as any;

    assert.equal(body.bio, "Digital nomad at heart", "bio must survive PATCH round-trip");
    assert.equal(body.homeCity, "Cebu City", "homeCity must survive PATCH round-trip");
    assert.equal(body.homeCountry, "Philippines", "homeCountry must survive PATCH round-trip");

    // Verify in-memory columns are written with the correct DB column names
    assert.equal(profiles[0].bio, "Digital nomad at heart", "bio column must be written");
    assert.equal(profiles[0].home_city, "Cebu City", "home_city column must be written");
    assert.equal(profiles[0].home_country, "Philippines", "home_country column must be written");
  });

  it("spokenLanguages and travelStyles survive a round-trip without being wiped", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Polyglot", display_name: "Polyglot", username: "polyglot",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: {
        spokenLanguages: ["en", "tl", "es"],
        travelStyles: ["backpacker", "slow-travel"],
      },
    });
    assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(await patchRes.clone().json())}`);

    const getRes = await api("/me/profile");
    assert.equal(getRes.status, 200);
    const body = await getRes.json() as any;

    assert.deepEqual(body.spokenLanguages, ["en", "tl", "es"],
      "spokenLanguages must survive PATCH round-trip");
    assert.deepEqual(body.travelStyles, ["backpacker", "slow-travel"],
      "travelStyles must survive PATCH round-trip");

    // Verify correct DB column names are written
    assert.deepEqual(profiles[0].spoken_languages, ["en", "tl", "es"],
      "spoken_languages column must be written");
    assert.deepEqual(profiles[0].travel_styles, ["backpacker", "slow-travel"],
      "travel_styles column must be written");
  });

  it("publicSocialLinks survive a round-trip without being wiped", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Linked", display_name: "Linked", username: "linked_up",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const links = {
      instagram: "https://instagram.com/linked_up",
      twitter: "https://twitter.com/linked_up",
    };

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: { publicSocialLinks: links },
    });
    assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(await patchRes.clone().json())}`);

    const getRes = await api("/me/profile");
    assert.equal(getRes.status, 200);
    const body = await getRes.json() as any;

    assert.deepEqual(body.publicSocialLinks, links,
      "publicSocialLinks must survive PATCH round-trip");

    // Verify correct DB column name is written
    assert.deepEqual(profiles[0].public_social_links, links,
      "public_social_links column must be written");
  });

  it("avatarUrl survives a round-trip and is written as avatar_url in the DB", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Snapster", display_name: "Snapster", username: "snapster",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const avatarUrl = "https://example.com/avatar.jpg";

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: { avatarUrl },
    });
    const patchBody = await patchRes.json() as any;
    assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(patchBody)}`);
    assert.equal(patchBody.avatarUrl, avatarUrl,
      "PATCH response must return updated avatarUrl");

    const getRes = await api("/me/profile");
    const getBody = await getRes.json() as any;
    assert.equal(getRes.status, 200, `GET failed: ${JSON.stringify(getBody)}`);
    assert.equal(getBody.avatarUrl, avatarUrl,
      "GET after PATCH must return the updated avatarUrl");

    assert.equal(profiles[0].avatar_url, avatarUrl,
      "avatar_url column must be written with the correct DB column name");
  });

  it("coverUrl survives a round-trip and is written as cover_photo_url in the DB", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Coverer", display_name: "Coverer", username: "coverer",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const coverUrl = "https://example.com/cover.jpg";

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: { coverUrl },
    });
    const patchBody = await patchRes.json() as any;
    assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(patchBody)}`);
    assert.equal(patchBody.coverPhotoUrl, coverUrl,
      "PATCH response must return updated coverPhotoUrl");

    const getRes = await api("/me/profile");
    const getBody = await getRes.json() as any;
    assert.equal(getRes.status, 200, `GET failed: ${JSON.stringify(getBody)}`);
    assert.equal(getBody.coverPhotoUrl, coverUrl,
      "GET after PATCH must return the updated coverPhotoUrl");

    assert.equal(profiles[0].cover_photo_url, coverUrl,
      "cover_photo_url column must be written with the correct DB column name");
  });

  it("PATCH with no fields returns 400 invalid_payload", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "No-Op", display_name: "No-Op", username: "noop",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await api("/me/profile", { method: "PATCH", body: {} });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.match(body.error ?? body.message ?? "", /field|payload/i);
  });

  it("DB write failure returns 500 db_error and leaves the profile row unchanged", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Stable", display_name: "Stable", username: "stable_user",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    // Client that returns a DB error on every update attempt (both full and
    // fallback paths) without mutating the in-memory row.
    function makeFailingUpdateClient() {
      function makeBuilder(table: string) {
        const filters: Array<(r: any) => boolean> = [];
        let isUpdate = false;

        const builder: any = {
          select()                      { return builder; },
          eq(col: string, val: any)     { filters.push((r) => String(r[col]) === String(val)); return builder; },
          neq(col: string, val: any)    { filters.push((r) => r[col] !== val); return builder; },
          in(col: string, vals: any[])  { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
          is(col: string, val: any)     { filters.push((r) => val === null ? r[col] == null : r[col] === val); return builder; },
          lt(col: string, val: any)     { filters.push((r) => r[col] < val); return builder; },
          gte(col: string, val: any)    { filters.push((r) => r[col] >= val); return builder; },
          order()                       { return builder; },
          limit()                       { return builder; },
          nullsFirst()                  { return builder; },
          update(_patch: Record<string, unknown>) {
            isUpdate = true;
            return builder;
          },
          insert(_row: any) { return builder; },
          upsert(_row: any) { return builder; },
          maybeSingle() {
            if (isUpdate) {
              return Promise.resolve({ data: null, error: { message: "simulated write failure", code: "42P01" } });
            }
            if (table === "profiles") {
              const rows = profiles.filter((r) => filters.every((f) => f(r)));
              return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          single() {
            if (isUpdate) {
              return Promise.resolve({ data: null, error: { message: "simulated write failure", code: "42P01" } });
            }
            if (table === "profiles") {
              const rows = profiles.filter((r) => filters.every((f) => f(r)));
              return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then(onF: any, onR: any) {
            if (isUpdate) {
              return Promise.resolve({ data: [], error: { message: "simulated write failure", code: "42P01" } }).then(onF, onR);
            }
            const rows = table === "profiles"
              ? profiles.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }))
              : [];
            return Promise.resolve({ data: rows, error: null, count: rows.length }).then(onF, onR);
          },
          catch() { return builder; },
        };
        return builder;
      }

      const client: any = {
        auth: {
          getUser: async (tok: string) => {
            if (tok === ME_TOK) return { data: { user: { id: ME } }, error: null };
            return { data: { user: null }, error: { message: "invalid token" } };
          },
        },
        from: (table: string) => makeBuilder(table),
        storage: {
          createBucket: async () => ({ error: null }),
          from: () => ({
            upload: async () => ({ error: null }),
            getPublicUrl: () => ({ data: { publicUrl: "" } }),
          }),
        },
      };
      return client;
    }

    const client = makeFailingUpdateClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: { displayName: "Should Not Stick" },
    });

    assert.equal(patchRes.status, 500, "DB write failure must return 500");
    const patchBody = await patchRes.json() as any;
    assert.equal(patchBody.error, "db_error",
      "error code must be db_error when the database rejects the write");

    // The in-memory row must be unchanged — no partial mutation on DB failure
    assert.equal(profiles[0].display_name, "Stable",
      "profile row must not be mutated when the DB write fails");
    assert.equal(profiles[0].name, "Stable",
      "name column must not be mutated when the DB write fails");
  });

  it("isPrivate survives a round-trip and is written as is_private in the DB", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Private User", display_name: "Private User", username: "priv_user",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: { isPrivate: true },
    });
    const patchBody = await patchRes.json() as any;
    assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(patchBody)}`);
    assert.equal(patchBody.isPrivate, true,
      "PATCH response must return updated isPrivate");

    const getRes = await api("/me/profile");
    const getBody = await getRes.json() as any;
    assert.equal(getRes.status, 200, `GET failed: ${JSON.stringify(getBody)}`);
    assert.equal(getBody.isPrivate, true,
      "GET after PATCH must return isPrivate: true, not the stale false");

    assert.equal(profiles[0].is_private, true,
      "is_private column must be written with the correct DB column name");
  });

  it("passportVisibility survives a round-trip and is written as passport_visibility in the DB", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Passport User", display_name: "Passport User", username: "passport_user",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: { passportVisibility: "private" },
    });
    const patchBody = await patchRes.json() as any;
    assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(patchBody)}`);
    assert.equal(patchBody.passportVisibility, "private",
      "PATCH response must return updated passportVisibility");

    const getRes = await api("/me/profile");
    const getBody = await getRes.json() as any;
    assert.equal(getRes.status, 200, `GET failed: ${JSON.stringify(getBody)}`);
    assert.equal(getBody.passportVisibility, "private",
      "GET after PATCH must return passportVisibility: private, not the stale public");

    assert.equal(profiles[0].passport_visibility, "private",
      "passport_visibility column must be written with the correct DB column name");
  });

  it("storage rejection on avatar upload returns 500 and leaves avatar_url unchanged", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Uploader", display_name: "Uploader", username: "uploader",
        bio: null, avatar_url: "https://old.example.com/avatar.jpg", home_city: null,
        home_country: null, current_city: null, travel_style: null, interests: [],
        verified: false, verification_status: "unverified", verified_at: null,
        open_to_meet: false, is_private: false, passport_visibility: "public",
        cover_photo_url: null, username_updated_at: null, created_at: null,
        spoken_languages: [], default_language: null, travel_styles: [],
        travel_pace: null, budget_style: null, travel_group_style: [],
        looking_for: [], comfort_level: null, availability_tags: [],
        planning_style: null, public_social_links: {}, preferred_language: null,
        date_of_birth: null, dob_verified: false, handle: null },
    ];

    // Client whose storage upload always returns an error
    const filters: Array<(r: any) => boolean> = [];
    const failClient: any = {
      auth: {
        getUser: async (tok: string) => {
          if (tok === ME_TOK) return { data: { user: { id: ME } }, error: null };
          return { data: { user: null }, error: { message: "invalid token" } };
        },
      },
      from: (table: string) => {
        const localFilters: Array<(r: any) => boolean> = [];
        const b: any = {
          select()                     { return b; },
          eq(col: string, val: any)    { localFilters.push((r) => String(r[col]) === String(val)); return b; },
          neq()                        { return b; },
          in()                         { return b; },
          is()                         { return b; },
          lt()                         { return b; },
          gte()                        { return b; },
          order()                      { return b; },
          limit()                      { return b; },
          nullsFirst()                 { return b; },
          update()                     { return b; },
          insert()                     { return b; },
          upsert()                     { return b; },
          maybeSingle() {
            if (table === "profiles") {
              const rows = profiles.filter((r) => localFilters.every((f) => f(r)));
              return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          single() { return Promise.resolve({ data: null, error: null }); },
          then(onF: any, onR: any) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR);
          },
          catch() { return b; },
        };
        return b;
      },
      storage: {
        createBucket: async () => ({ error: null }),
        from: () => ({
          upload: async () => ({ error: { message: "Bucket policy violation: quota exceeded" } }),
          getPublicUrl: () => ({ data: { publicUrl: "" } }),
          remove: async () => ({ error: null }),
        }),
      },
    };
    void filters; // unused but kept for symmetry with other tests

    _setTestClient(failClient, true);
    _setTestServiceClient(failClient);

    // Use a real sharp-generated JPEG so the route passes image preprocessing
    // and reaches the storage upload step (where the injected error fires → 500).
    const uploadRes = await fetch(`${base}/me/avatar/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ME_TOK}`,
        "Content-Type": "image/jpeg",
      },
      body: realJpeg,
    });

    assert.equal(uploadRes.status, 500,
      `storage rejection must return 500, not ${uploadRes.status}`);
    const uploadBody = await uploadRes.json() as any;
    assert.ok(
      uploadBody.error === "db_error" || uploadBody.error === "upload_failed",
      `error code must indicate upload failure, got: ${JSON.stringify(uploadBody)}`,
    );

    // The in-memory profile row must not have been mutated
    assert.equal(profiles[0].avatar_url, "https://old.example.com/avatar.jpg",
      "avatar_url must remain unchanged when storage upload fails");
  });

  it("storage rejection on cover upload returns 500 and leaves cover_photo_url unchanged", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Cover Test", display_name: "Cover Test", username: "cover_tester",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public",
        cover_photo_url: "https://old.example.com/cover.jpg",
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    // Client whose storage upload always returns an error for the cover path.
    // The from("feature_flags") path must return null so isFlagEnabled
    // fails-open and doesn't block the upload with "feature_disabled".
    const coverFailClient: any = {
      auth: {
        getUser: async (tok: string) => {
          if (tok === ME_TOK) return { data: { user: { id: ME } }, error: null };
          return { data: { user: null }, error: { message: "invalid token" } };
        },
      },
      from: (table: string) => {
        const localFilters: Array<(r: any) => boolean> = [];
        const b: any = {
          select()                     { return b; },
          eq(col: string, val: any)    { localFilters.push((r) => String(r[col]) === String(val)); return b; },
          neq()                        { return b; },
          in()                         { return b; },
          is()                         { return b; },
          lt()                         { return b; },
          gte()                        { return b; },
          order()                      { return b; },
          limit()                      { return b; },
          nullsFirst()                 { return b; },
          update()                     { return b; },
          insert()                     { return b; },
          upsert()                     { return b; },
          maybeSingle() {
            if (table === "profiles") {
              const rows = profiles.filter((r) => localFilters.every((f) => f(r)));
              return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
            }
            // feature_flags → return null so isFlagEnabled fails-open (not disabled)
            return Promise.resolve({ data: null, error: null });
          },
          single() { return Promise.resolve({ data: null, error: null }); },
          then(onF: any, onR: any) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR);
          },
          catch() { return b; },
        };
        return b;
      },
      storage: {
        createBucket: async () => ({ error: null }),
        from: () => ({
          upload: async () => ({ error: { message: "Bucket policy violation: quota exceeded" } }),
          getPublicUrl: () => ({ data: { publicUrl: "" } }),
          remove: async () => ({ error: null }),
        }),
      },
    };

    _setTestClient(coverFailClient, true);
    _setTestServiceClient(coverFailClient);

    // Use a real sharp-generated JPEG so the route passes image preprocessing
    // and reaches the storage upload step (where the injected error fires → 500).
    const uploadRes = await fetch(`${base}/me/cover/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ME_TOK}`,
        "Content-Type": "image/jpeg",
      },
      body: realJpeg,
    });

    assert.equal(uploadRes.status, 500,
      `cover storage rejection must return 500, not ${uploadRes.status}`);
    const uploadBody = await uploadRes.json() as any;
    assert.ok(
      uploadBody.error === "db_error" || uploadBody.error === "upload_failed",
      `error code must indicate upload failure, got: ${JSON.stringify(uploadBody)}`,
    );

    // The in-memory profile row must not have been mutated
    assert.equal(profiles[0].cover_photo_url, "https://old.example.com/cover.jpg",
      "cover_photo_url must remain unchanged when storage upload fails");
  });

  it("unique-constraint violation on username write returns 409 conflict and leaves username unchanged", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Racer", display_name: "Racer", username: "original_handle",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    // Fake client: availability check says the name is free (no takenBy row),
    // but the final .update().single() returns a 23505 unique-constraint error
    // without mutating the in-memory row — simulating a race where another
    // concurrent request claimed the handle between the check and the write.
    function makeRaceClient() {
      function makeBuilder(table: string) {
        const filters: Array<(r: any) => boolean> = [];
        let pendingUpdate: Record<string, unknown> | null = null;
        let hasNeq = false;

        const builder: any = {
          select()                      { return builder; },
          eq(col: string, val: any)     { filters.push((r) => String(r[col]) === String(val)); return builder; },
          neq(col: string, val: any)    { hasNeq = true; filters.push((r) => r[col] !== val); return builder; },
          in(col: string, vals: any[])  { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
          is(col: string, val: any)     { filters.push((r) => val === null ? r[col] == null : r[col] === val); return builder; },
          lt(col: string, val: any)     { filters.push((r) => r[col] < val); return builder; },
          gte(col: string, val: any)    { filters.push((r) => r[col] >= val); return builder; },
          order()                       { return builder; },
          limit()                       { return builder; },
          nullsFirst()                  { return builder; },
          update(_patch: Record<string, unknown>) {
            pendingUpdate = _patch;
            return builder;
          },
          insert(_row: any) { return builder; },
          upsert(_row: any) { return builder; },
          maybeSingle() {
            if (table === "profiles" && !pendingUpdate) {
              // Availability check (has a neq filter) → return null (appears free)
              if (hasNeq) return Promise.resolve({ data: null, error: null });
              // Cooldown / current-profile read → return row so cooldown passes
              const rows = profiles.filter((r) => filters.every((f) => f(r)));
              return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          single() {
            if (pendingUpdate) {
              // The race: DB rejects the write with a unique-constraint violation
              return Promise.resolve({
                data: null,
                error: { message: "duplicate key value violates unique constraint \"profiles_username_key\"", code: "23505" },
              });
            }
            if (table === "profiles") {
              const rows = profiles.filter((r) => filters.every((f) => f(r)));
              return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then(onF: any, onR: any) {
            if (pendingUpdate) {
              return Promise.resolve({
                data: [],
                error: { message: "duplicate key value violates unique constraint \"profiles_username_key\"", code: "23505" },
              }).then(onF, onR);
            }
            const rows = table === "profiles"
              ? profiles.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }))
              : [];
            return Promise.resolve({ data: rows, error: null, count: rows.length }).then(onF, onR);
          },
          catch() { return builder; },
        };
        return builder;
      }

      const client: any = {
        auth: {
          getUser: async (tok: string) => {
            if (tok === ME_TOK) return { data: { user: { id: ME } }, error: null };
            return { data: { user: null }, error: { message: "invalid token" } };
          },
        },
        from: (table: string) => makeBuilder(table),
        storage: {
          createBucket: async () => ({ error: null }),
          from: () => ({
            upload: async () => ({ error: null }),
            getPublicUrl: () => ({ data: { publicUrl: "" } }),
          }),
        },
      };
      return client;
    }

    const client = makeRaceClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const patchRes = await api("/me/profile", {
      method: "PATCH",
      body: { username: "new_handle" },
    });

    // Must NOT silently succeed — the DB rejected the write
    assert.notEqual(patchRes.status, 200,
      "username constraint violation must not return 200");
    // Expected: 409 conflict (or at minimum a 4xx/5xx error)
    assert.ok(
      patchRes.status === 409 || (patchRes.status >= 400 && patchRes.status < 600),
      `expected a non-200 error status, got ${patchRes.status}`,
    );
    const body = await patchRes.json() as any;
    assert.ok(
      body.error === "conflict" || body.error === "db_error",
      `error code must be conflict or db_error, got: ${JSON.stringify(body)}`,
    );

    // The in-memory row must be unchanged — constraint error must not partially apply
    assert.equal(profiles[0].username, "original_handle",
      "username must remain unchanged when the DB write fails with a constraint violation");
  });

  it("displayName exceeding 60 chars is rejected before any DB write", async () => {
    const profiles: ProfileRow[] = [
      { id: ME, name: "Short", display_name: "Short", username: "short",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at: null, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null },
    ];

    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await api("/me/profile", {
      method: "PATCH",
      body: { displayName: "x".repeat(61) },
    });
    assert.equal(r.status, 400);
    // Profile must be unchanged
    assert.equal(profiles[0].display_name, "Short", "DB row must not be mutated on validation failure");
  });
});

// ── Single-field guard regression ─────────────────────────────────────────────
//
// Regression for the bug where `Object.keys(row).length <= 1` rejected any
// patch that mapped to exactly one DB column.  Every patchable field must
// return 200 when sent alone; none should ever return 400 "At least one field".
//
// Run: node --import tsx/esm --test src/test/profileRoundTrip.test.ts

describe("PATCH /me/profile — single-field guard: each patchable field accepted alone", () => {
  const BASE_ROW: ProfileRow = {
    id: ME, name: "Solo Tester", display_name: "Solo Tester",
    username: "solo_tester",
    bio: null, avatar_url: null, home_city: null, home_country: null,
    current_city: null, travel_style: null, interests: [], verified: false,
    verification_status: "unverified", verified_at: null, open_to_meet: false,
    is_private: false, passport_visibility: "public", cover_photo_url: null,
    username_updated_at: null, created_at: null, spoken_languages: [],
    default_language: null, travel_styles: [], travel_pace: null,
    budget_style: null, travel_group_style: [], looking_for: [],
    comfort_level: null, availability_tags: [], planning_style: null,
    public_social_links: {}, preferred_language: null, date_of_birth: null,
    dob_verified: false, handle: null,
  };

  function freshState() {
    const profiles: ProfileRow[] = [{ ...BASE_ROW }];
    const client = makeClient(profiles);
    _setTestClient(client, true);
    _setTestServiceClient(client);
    return { profiles, client };
  }

  const cases: Array<[string, Record<string, unknown>]> = [
    ["displayName",        { displayName: "Updated Name" }],
    ["bio",                { bio: "Loves to explore" }],
    ["homeCity",           { homeCity: "Cebu" }],
    ["homeCountry",        { homeCountry: "Philippines" }],
    ["currentCity",        { currentCity: "Manila" }],
    ["interests",          { interests: ["food", "hiking"] }],
    ["passportVisibility", { passportVisibility: "followers_only" }],
    ["avatarUrl",          { avatarUrl: "https://example.com/avatar.jpg" }],
    ["coverUrl",           { coverUrl: "https://example.com/cover.jpg" }],
    ["travelStyle",        { travelStyle: "backpacker" }],
    ["openToMeet",         { openToMeet: true }],
    ["spokenLanguages",    { spokenLanguages: ["en", "tl"] }],
    ["defaultLanguage",    { defaultLanguage: "en" }],
    ["travelStyles",       { travelStyles: ["slow-travel", "cultural"] }],
    ["travelPace",         { travelPace: "balanced" }],
    ["budgetStyle",        { budgetStyle: "mid-range" }],
    ["travelGroupStyle",   { travelGroupStyle: ["solo", "couples"] }],
    ["lookingFor",         { lookingFor: ["adventure", "culture"] }],
    ["comfortLevel",       { comfortLevel: "comfort" }],
    ["availabilityTags",   { availabilityTags: ["weekends"] }],
    ["planningStyle",      { planningStyle: "flexible" }],
    ["publicSocialLinks",  { publicSocialLinks: { instagram: "https://instagram.com/x" } }],
    ["preferredLanguage",  { preferredLanguage: "en" }],
    ["dateOfBirth",        { dateOfBirth: "1990-06-15" }],
    ["tagPermission",      { tagPermission: "friends_only" }],
    ["isPrivate",          { isPrivate: true }],
  ];

  for (const [field, body] of cases) {
    it(`single-field PATCH with only "${field}" returns 200`, async () => {
      freshState();
      const res = await api("/me/profile", { method: "PATCH", body });
      const json = await res.json() as any;
      assert.equal(
        res.status,
        200,
        `single-field PATCH with only "${field}" must return 200 (not 400 / not rejected by the single-field guard), ` +
        `got ${res.status}: ${JSON.stringify(json)}`,
      );
    });
  }
});

// ── Username cooldown ──────────────────────────────────────────────────────────

describe("PATCH /me/profile — username 30-day cooldown", () => {
  function cooldownProfile(username_updated_at: string | null): ProfileRow[] {
    return [
      {
        id: ME, name: "Traveler", display_name: "Traveler", username: "old_handle",
        bio: null, avatar_url: null, home_city: null, home_country: null,
        current_city: null, travel_style: null, interests: [], verified: false,
        verification_status: "unverified", verified_at: null, open_to_meet: false,
        is_private: false, passport_visibility: "public", cover_photo_url: null,
        username_updated_at, created_at: null, spoken_languages: [],
        default_language: null, travel_styles: [], travel_pace: null,
        budget_style: null, travel_group_style: [], looking_for: [],
        comfort_level: null, availability_tags: [], planning_style: null,
        public_social_links: {}, preferred_language: null, date_of_birth: null,
        dob_verified: false, handle: null,
      },
    ];
  }

  it("rejects username change when cooldown window is still open (15 days since last change)", async () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const client = makeClient(cooldownProfile(fifteenDaysAgo));
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const res = await api("/me/profile", { method: "PATCH", body: { username: "new_handle" } });
    const body = await res.json() as any;

    assert.equal(res.status, 429,
      `Expected 429 when cooldown is active, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "rate_limited",
      `Expected error code "rate_limited", got: ${JSON.stringify(body)}`);
    assert.match(String(body.message), /30 days/,
      `Error message should mention "30 days", got: ${body.message}`);
  });

  it("allows username change when cooldown window has passed (31 days since last change)", async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const client = makeClient(cooldownProfile(thirtyOneDaysAgo));
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const res = await api("/me/profile", { method: "PATCH", body: { username: "new_handle" } });
    const body = await res.json() as any;

    assert.equal(res.status, 200,
      `Expected 200 when cooldown has passed, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.username, "new_handle",
      `Expected updated username in response, got: ${JSON.stringify(body)}`);
  });
});
