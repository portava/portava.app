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

before(async () => {
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
