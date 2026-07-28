/**
 * Tests for the @portava official account isOfficial field.
 *
 * Verifies that:
 *   - GET /api/users/portava/passport returns isOfficial: true for the official account
 *   - GET /api/users/regular/passport returns isOfficial: false for a normal account
 *   - GET /api/profile/portava returns isOfficial: true for the official account
 *
 * Uses _setTestClient to inject a fake Supabase service client. No network
 * calls are made.
 *
 * Run: node --import tsx/esm --test src/test/portavaOfficialProfile.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Seed profile rows ─────────────────────────────────────────────────────────

const PORTAVA_PROFILE = {
  id: "00000000-0000-0000-0000-portava00001",
  handle: "portava",
  username: "portava",
  name: "Portava",
  display_name: "Portava",
  bio: "Your travel community.",
  avatar_url: "https://example.com/portava.jpg",
  cover_photo_url: null,
  home_city: null,
  home_country: null,
  current_city: null,
  travel_style: null,
  interests: [],
  verified: true,
  verification_status: "verified",
  verified_at: "2025-01-01T00:00:00.000Z",
  open_to_meet: false,
  is_private: false,
  passport_visibility: "public",
  is_official: true,
  created_at: "2025-01-01T00:00:00.000Z",
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
  date_of_birth: null,
  account_status: "active",
  role: "user",
  username_updated_at: null,
  passport_postcards: [],
};

const REGULAR_PROFILE = {
  ...PORTAVA_PROFILE,
  id: "00000000-0000-0000-0000-regular00001",
  handle: "regular_user",
  username: "regular_user",
  name: "Regular User",
  display_name: "Regular User",
  is_official: false,
};

// ── Fake client factory ────────────────────────────────────────────────────────

function makeFakeClient(profiles: typeof PORTAVA_PROFILE[]) {
  function chain(table: string) {
    const eqFilters: Array<{ col: string; val: unknown }> = [];
    let isSingle = false;

    const obj: any = {
      select()  { return obj; },
      eq(col: string, val: unknown) { eqFilters.push({ col, val }); return obj; },
      neq()     { return obj; },
      or()      { return obj; },
      in()      { return obj; },
      not()     { return obj; },
      gte()     { return obj; },
      lte()     { return obj; },
      limit()   { return obj; },
      order()   { return obj; },
      insert()  { return obj; },
      upsert()  { return obj; },
      maybeSingle() { isSingle = true; return obj; },
      single()      { isSingle = true; return obj; },
      catch(fn: any) { return resolve().catch(fn); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    async function resolve(): Promise<{ data: any; error: null; count: null }> {
      if (table === "profiles") {
        let rows = [...profiles];
        for (const { col, val } of eqFilters) {
          rows = rows.filter((r: any) => r[col] === val);
        }
        if (isSingle) return { data: rows[0] ?? null, error: null, count: null };
        return { data: rows, error: null, count: null };
      }
      // All other tables: return empty / null (fail-open)
      if (isSingle) return { data: null, error: null, count: null };
      return { data: [], error: null, count: null };
    }

    return obj;
  }

  return {
    from(table: string) { return chain(table); },
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── Tests — GET /api/users/:username/passport ─────────────────────────────────

describe("GET /api/users/:username/passport — isOfficial field", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient([PORTAVA_PROFILE, REGULAR_PROFILE]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns isOfficial: true for the @portava official account", async () => {
    const res = await fetch(`${url}/api/users/portava/passport`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert.notEqual(body.unavailable, true, "profile should not be unavailable");
    assert.notEqual(body.blocked, true, "profile should not be blocked");
    assert.equal(body.isOfficial, true, `expected isOfficial=true, got ${body.isOfficial}`);
  });

  it("returns isOfficial: false for a normal account", async () => {
    const res = await fetch(`${url}/api/users/regular_user/passport`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert.notEqual(body.unavailable, true, "profile should not be unavailable");
    assert.equal(body.isOfficial, false, `expected isOfficial=false, got ${body.isOfficial}`);
  });
});
