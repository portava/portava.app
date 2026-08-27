/**
 * ageGate.test.ts — Age-gate enforcement on PATCH /me/profile
 *
 * Covers:
 *  1. dateOfBirth that yields age < 18 → 403 "Users under 18 are not permitted"
 *  2. dateOfBirth that yields exactly 18 → 200 (accepted)
 *  3. dateOfBirth that yields age > 18  → 200 (accepted)
 *  4. dateOfBirth = null (clearing DOB) → 200 (allowed)
 *
 * Run: node --import tsx/esm --test src/test/ageGate.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import profileRouter from "../routes/profile.js";

// ── Stable IDs ────────────────────────────────────────────────────────────────

// TZ HYGIENE — pin this test process to UTC (CI's reference timezone). The DOB
// helpers below mix local Date arithmetic with UTC `toISOString()` slicing, and
// the server's calculateUserAge reads LOCAL date components, so the exact ±1-day
// age boundaries flip on a developer machine in a non-UTC zone and the tests
// flake. Pinning makes them deterministic everywhere; prod code is unchanged.
process.env.TZ = "UTC";

const ME     = "aa000000-0000-4000-a000-000000000099";
const ME_TOK = "tok-agegate-me";

// ── Base profile fixture ──────────────────────────────────────────────────────

const baseProfile: Record<string, unknown> = {
  id:                   ME,
  username:             "agegate_user",
  name:                 "Age Gate User",
  handle:               "agegate_user",
  display_name:         "Age Gate User",
  bio:                  null,
  avatar_url:           null,
  cover_photo_url:      null,
  home_city:            null,
  home_country:         null,
  current_city:         null,
  is_private:           false,
  passport_visibility:  "public",
  account_status:       "active",
  created_at:           new Date().toISOString(),
  username_updated_at:  null,
  interests:            [],
  spoken_languages:     [],
  travel_styles:        [],
  verification_status:  "unverified",
  role:                 "user",
  date_of_birth:        null,
  open_to_meet:         true,
};

// ── Fake client factory ───────────────────────────────────────────────────────

type FakeState = { profiles: Record<string, unknown>[] };

function makeFakeClient(state: FakeState) {
  function builder(table: string, rows: Record<string, unknown>[]) {
    let _rows = [...rows];
    const b: any = {
      select:      ()          => b,
      update:      (data: any) => {
        _rows = _rows.map((r) => ({ ...r, ...(data as Record<string, unknown>) }));
        return b;
      },
      upsert:      (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      insert:      ()          => b,
      delete:      ()          => b,
      eq:          ()          => b,
      neq:         ()          => b,
      in:          ()          => b,
      is:          ()          => b,
      lt:          ()          => b,
      gt:          ()          => b,
      gte:         ()          => b,
      lte:         ()          => b,
      or:          ()          => b,
      not:         ()          => b,
      ilike:       ()          => b,
      order:       ()          => b,
      limit:       ()          => b,
      range:       ()          => b,
      nullsFirst:  ()          => b,
      then:        (resolve: (v: any) => any) =>
        Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve),
      maybeSingle: () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles")      return builder(table, state.profiles);
      if (table === "feature_flags") return builder(table, []);
      return builder(table, []);
    },
    auth: {
      getUser: (token?: string) => {
        if (token === ME_TOK) {
          return Promise.resolve({ data: { user: { id: ME } }, error: null });
        }
        return Promise.resolve({ data: { user: null }, error: { message: "invalid token" } });
      },
    },
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload:       async () => ({ error: null }),
        getPublicUrl: ()       => ({ data: { publicUrl: "https://example.com/x.jpg" } }),
        remove:       async () => ({ error: null }),
        list:         async () => ({ data: [], error: null }),
      }),
    },
  } as any;
}

function freshState(): FakeState {
  return { profiles: [{ ...baseProfile }] };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function makeReq(base: string) {
  return function req(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string | null } = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url   = new URL(path, base);
      const token = opts.token === undefined ? ME_TOK : opts.token;
      const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;

      const r = http.request(
        {
          hostname: url.hostname,
          port:     Number(url.port),
          path:     url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            let parsed: any;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { parsed = {}; }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  };
}

/** Returns a YYYY-MM-DD string for a birthday exactly `years` years ago from today. */
function dobYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** Returns a YYYY-MM-DD string for a birthday exactly `years` years + 1 day ago (just over). */
function dobJustOver(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Returns a YYYY-MM-DD string for a birthday `years` years + 1 day in the future (one day short). */
function dobOneDayShort(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/me/profile — age gate (18+)", () => {
  let server: Server;
  let base: string;
  let req: ReturnType<typeof makeReq>;
  let state: FakeState;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", profileRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    req  = makeReq(base);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null, false);
  });

  beforeEach(() => {
    state = freshState();
    const client = makeFakeClient(state);
    _setTestClient(client, true);
  });

  it("rejects a DOB that results in age 17 with 403", async () => {
    const dob = dobOneDayShort(18); // one day away from turning 18
    const res = await req("PATCH", "/api/me/profile", { body: { dateOfBirth: dob } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "forbidden");
    assert.match(res.body.message, /under 18/i);
  });

  it("rejects a DOB that is exactly 17 years ago today with 403", async () => {
    const dob = dobYearsAgo(17);
    const res = await req("PATCH", "/api/me/profile", { body: { dateOfBirth: dob } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "forbidden");
    assert.match(res.body.message, /under 18/i);
  });

  it("accepts a DOB that is exactly 18 years ago (birthday is today) with 200", async () => {
    const dob = dobYearsAgo(18);
    const res = await req("PATCH", "/api/me/profile", { body: { dateOfBirth: dob } });
    assert.equal(res.status, 200);
  });

  it("accepts a DOB that results in age 25 with 200", async () => {
    const dob = dobJustOver(25);
    const res = await req("PATCH", "/api/me/profile", { body: { dateOfBirth: dob } });
    assert.equal(res.status, 200);
  });

  it("accepts dateOfBirth: null (clearing DOB) with 200", async () => {
    // Seed a valid existing DOB so the update is non-empty
    state.profiles[0].date_of_birth = dobJustOver(30);
    const res = await req("PATCH", "/api/me/profile", { body: { dateOfBirth: null } });
    assert.equal(res.status, 200);
  });

  it("error body contains 'Users under 18 are not permitted' message", async () => {
    const dob = dobYearsAgo(16);
    const res = await req("PATCH", "/api/me/profile", { body: { dateOfBirth: dob } });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "Users under 18 are not permitted");
  });
});
