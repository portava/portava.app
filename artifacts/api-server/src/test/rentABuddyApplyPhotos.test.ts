/**
 * Apply-handler photo round-trip — POST /api/rent-a-buddy/apply
 *
 * Guards that `photos` submitted in the wizard body lands in
 * `gallery_urls` on the `rent_buddy_profiles` upsert, and that
 * omitting `photos` does NOT overwrite any pre-existing gallery.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddyApplyPhotos.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";

const TOKEN   = "apply-photos-token";
const USER_ID = "user-apply-photos-1";

// ── Fake state ────────────────────────────────────────────────────────────────

interface FakeState {
  /** Last upsert payload sent to rent_buddy_profiles */
  profileUpsert: any | null;
  /** Last upsert payload sent to rent_buddy_applications */
  applicationUpsert: any | null;
}

let state: FakeState = { profileUpsert: null, applicationUpsert: null };

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeFakeClient() {
  function fakeTable(table: string) {
    const filters: Array<[string, any]> = [];
    let upsertPayload: any = null;

    const b: any = {
      select() { return b; },
      insert() { return b; },
      update() { return b; },
      upsert(data: any) { upsertPayload = data; return b; },
      eq(col: string, val: any) { filters.push([col, val]); return b; },
      ilike() { return b; },
      gte() { return b; },
      lte() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      not() { return b; },
      in() { return b; },
      maybeSingle() {
        return Promise.resolve(resolveQuery());
      },
      single() {
        return Promise.resolve(resolveQuery());
      },
      then(resolve: (v: any) => void) {
        return Promise.resolve(resolveQuery()).then(resolve);
      },
    };

    function resolveQuery(): { data: any; error: any } {
      // Auth / identity
      if (table === "profiles") {
        return { data: { id: USER_ID, account_status: "active", role: "user" }, error: null };
      }

      // Feature flag — enable rent_buddy for all flag lookups
      if (table === "feature_flags") {
        const flag = filters.find(([c]) => c === "flag")?.[1];
        return { data: { flag, enabled: flag === "rent_buddy_enabled" }, error: null };
      }

      // Rollout checks
      if (table === "rent_buddy_global_controls") {
        return { data: null, error: null };
      }
      if (table === "rent_buddy_city_rollouts") {
        // "public_mvp" is the open status that passes all apply-action guards
        return { data: { id: "city-1", city: "Tokyo", status: "public_mvp" }, error: null };
      }
      if (table === "rent_buddy_beta_access") {
        return { data: null, error: null };
      }

      // Policy scanner
      if (table === "rent_buddy_policy_flags") {
        return { data: null, error: null };
      }
      if (table === "rent_buddy_user_limits") {
        return { data: null, error: null };
      }

      // Application upsert
      if (table === "rent_buddy_applications") {
        if (upsertPayload !== null) {
          state.applicationUpsert = upsertPayload;
        }
        return {
          data: {
            id: "app-1",
            user_id: USER_ID,
            city: upsertPayload?.city ?? "Tokyo",
            country: null,
            categories: [],
            languages: [],
            motivation: null,
            social_links: {},
            policy_accepted: true,
            status: "pending",
            id_verification_ref: null,
            review_notes: null,
            reviewed_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          error: null,
        };
      }

      // Profile upsert — capture the payload for assertions
      if (table === "rent_buddy_profiles") {
        if (upsertPayload !== null) {
          state.profileUpsert = upsertPayload;
        }
        return {
          data: {
            display_name: upsertPayload?.display_name ?? null,
            bio: upsertPayload?.bio ?? null,
            hourly_rate_usd: upsertPayload?.hourly_rate_usd ?? null,
            availability_blocks: upsertPayload?.availability_blocks ?? [],
            preferred_meetup_zones: upsertPayload?.preferred_meetup_zones ?? [],
          },
          error: null,
        };
      }

      return { data: null, error: null };
    }

    return b;
  }

  return {
    auth: {
      async getUser(token: string) {
        if (token === TOKEN) return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: fakeTable,
  };
}

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
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

before(async () => {
  const fake = makeFakeClient();
  _setTestClient(fake, true);
  _setTestServiceClient(fake as any);

  const app = express();
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }; next(); });
  app.use(express.json());
  app.use("/api", rentABuddyRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setTestClient(null, true);
  _setTestServiceClient(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state = { profileUpsert: null, applicationUpsert: null };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

const SAMPLE_PHOTOS = [
  "https://example.com/photo1.jpg",
  "https://example.com/photo2.jpg",
];

describe("POST /api/rent-a-buddy/apply — photos → gallery_urls round-trip", () => {
  it("writes photos to gallery_urls in the profile upsert", async () => {
    const res = await post("/api/rent-a-buddy/apply", {
      city: "Tokyo",
      country: "Japan",
      categories: ["sightseeing"],
      languages: ["en"],
      photos: SAMPLE_PHOTOS,
    });

    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(state.profileUpsert, "profile upsert was never called");
    assert.deepEqual(
      state.profileUpsert.gallery_urls,
      SAMPLE_PHOTOS,
      "gallery_urls in the profile upsert should equal the submitted photos array",
    );
  });

  it("does not set gallery_urls in the profile upsert when photos is omitted", async () => {
    const res = await post("/api/rent-a-buddy/apply", {
      city: "Tokyo",
      country: "Japan",
      categories: ["sightseeing"],
      languages: ["en"],
      // no photos field
    });

    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(state.profileUpsert, "profile upsert was never called");
    assert.equal(
      "gallery_urls" in state.profileUpsert,
      false,
      "gallery_urls must NOT be present in the profile upsert when photos is omitted — it would overwrite pre-existing galleries",
    );
  });

  it("does not set gallery_urls in the profile upsert when photos is an empty array", async () => {
    const res = await post("/api/rent-a-buddy/apply", {
      city: "Tokyo",
      country: "Japan",
      categories: ["sightseeing"],
      languages: ["en"],
      photos: [],
    });

    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(state.profileUpsert, "profile upsert was never called");
    assert.equal(
      "gallery_urls" in state.profileUpsert,
      false,
      "gallery_urls must NOT be set for an empty photos array — the handler guards with photos.length > 0",
    );
  });
});
