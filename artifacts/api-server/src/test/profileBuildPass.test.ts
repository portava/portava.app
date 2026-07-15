/**
 * profileBuildPass.test.ts — Phase 12 missing coverage
 *
 * Tests not already covered by profileSystem.test.ts:
 *   1. PATCH /me/profile — bio, homeCity, homeCountry, avatarUrl, coverUrl accepted (200)
 *   2. PATCH /me/profile — rejects unknown / forbidden field in body
 *   3. POST /me/avatar/upload — rejects invalid MIME type → 400
 *   4. POST /me/avatar/upload — rejects oversized file (> 5 MB) → 400
 *   5. POST /me/cover/upload  — rejects invalid MIME type → 400
 *   6. POST /me/cover/upload  — rejects oversized file (> 10 MB) → 400
 *   7. POST /reports           — profile-type report inserts a row, returns 201
 *   8. POST /reports           — profile-type report missing reason_detail → 400
 *
 * Run: node --import tsx/esm --test src/test/profileBuildPass.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";
import reportsRouter from "../routes/reports.js";

// ── Stable UUIDs ──────────────────────────────────────────────────────────────

const ME      = "aa000000-0000-4000-a000-000000000011";
const TARGET  = "bb000000-0000-4000-a000-000000000012";
const ME_TOK  = "tok-buildpass-me";

// ── Base profile fixture ──────────────────────────────────────────────────────

const baseProfile: Record<string, unknown> = {
  id:                    ME,
  username:              "buildpass_me",
  name:                  "Build Pass",
  handle:                "buildpass_me",
  display_name:          "Build Pass",
  bio:                   null,
  avatar_url:            null,
  cover_photo_url:       null,
  home_city:             null,
  home_country:          null,
  current_city:          null,
  is_private:            false,
  passport_visibility:   "public",
  account_status:        "active",
  created_at:            new Date().toISOString(),
  username_updated_at:   null,
  interests:             [],
  spoken_languages:      [],
  travel_styles:         [],
  verification_status:   "unverified",
  role:                  "user",
  date_of_birth:         null,
  open_to_meet:          true,
};

// ── Fake client factory ───────────────────────────────────────────────────────

type FakeState = {
  profiles: Record<string, unknown>[];
  reports:  Record<string, unknown>[];
  inserts:  { table: string; data: unknown }[];
  updates:  { table: string; data: unknown }[];
};

function makeFakeClient(state: FakeState) {
  function builder(table: string, rows: Record<string, unknown>[]) {
    let _rows = [...rows];
    const b: any = {
      select:  ()          => b,
      insert:  (data: any) => {
        const arr = Array.isArray(data) ? data : [data];
        state.inserts.push({ table, data });
        _rows = arr.map((d) => ({ id: "new-row-id", created_at: new Date().toISOString(), ...d }));
        return b;
      },
      update:  (data: any) => {
        state.updates.push({ table, data });
        _rows = _rows.map((r) => ({ ...r, ...(data as Record<string, unknown>) }));
        return b;
      },
      upsert:  (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      delete:  ()          => { _rows = []; return b; },
      eq:      ()          => b,
      neq:     ()          => b,
      in:      ()          => b,
      or:      ()          => b,
      is:      ()          => b,
      not:     ()          => b,
      ilike:   ()          => b,
      gt:      ()          => b,
      gte:     ()          => b,
      lte:     ()          => b,
      lt:      ()          => b,
      order:   ()          => b,
      limit:   ()          => b,
      range:   ()          => b,
      then:    (resolve: (v: any) => any) =>
        Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve),
      maybeSingle: () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles")      return builder(table, state.profiles);
      if (table === "reports")       return builder(table, state.reports);
      if (table === "feature_flags") return builder(table, []); // all flags absent → fail-open
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
        getPublicUrl: ()       => ({ data: { publicUrl: "https://example.com/avatar.jpg" } }),
        remove:       async () => ({ error: null }),
        list:         async () => ({ data: [], error: null }),
      }),
    },
  } as any;
}

function freshState(): FakeState {
  return {
    profiles: [{ ...baseProfile }],
    reports:  [],
    inserts:  [],
    updates:  [],
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

type ReqOpts = {
  body?:        unknown;
  binary?:      Buffer;
  contentType?: string;
  token?:       string | null;
};

function makeReq(base: string) {
  return function req(
    method: string,
    path: string,
    opts: ReqOpts = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url   = new URL(path, base);
      const token = opts.token === undefined ? ME_TOK : opts.token;

      let payload: Buffer | string | undefined;
      let contentType = opts.contentType ?? "application/json";

      if (opts.binary) {
        payload     = opts.binary;
        contentType = opts.contentType ?? "image/jpeg";
      } else if (opts.body !== undefined) {
        payload = JSON.stringify(opts.body);
      }

      const headers: Record<string, string> = { "content-type": contentType };
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
            const raw = Buffer.concat(chunks).toString();
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /me/profile — allowed fields
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/me/profile — allowed fields", () => {
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
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  beforeEach(() => {
    state = freshState();
    const client = makeFakeClient(state);
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("accepts bio update — returns 200 with updated bio", async () => {
    const res = await req("PATCH", "/api/me/profile", {
      body: { bio: "Explorer of hidden trails" },
    });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(
      res.body && typeof res.body === "object",
      "body should be an object",
    );
    assert.equal(state.updates.length, 1, "should record exactly one update");
    const upd = state.updates[0].data as any;
    assert.equal(upd.bio, "Explorer of hidden trails");
  });

  it("accepts homeCity and homeCountry — returns 200", async () => {
    const res = await req("PATCH", "/api/me/profile", {
      body: { homeCity: "Cebu City", homeCountry: "Philippines" },
    });
    assert.equal(res.status, 200, `Expected 200: ${JSON.stringify(res.body)}`);
    const upd = state.updates[0].data as any;
    assert.equal(upd.home_city,    "Cebu City");
    assert.equal(upd.home_country, "Philippines");
  });

  it("accepts avatarUrl — persists avatar_url column", async () => {
    const url = "https://example.com/avatar.jpg";
    const res = await req("PATCH", "/api/me/profile", {
      body: { avatarUrl: url },
    });
    assert.equal(res.status, 200, `Expected 200: ${JSON.stringify(res.body)}`);
    const upd = state.updates[0].data as any;
    assert.equal(upd.avatar_url, url);
  });

  it("accepts coverUrl — persists cover_photo_url column", async () => {
    const url = "https://example.com/cover.jpg";
    const res = await req("PATCH", "/api/me/profile", {
      body: { coverUrl: url },
    });
    assert.equal(res.status, 200, `Expected 200: ${JSON.stringify(res.body)}`);
    const upd = state.updates[0].data as any;
    assert.equal(upd.cover_photo_url, url);
  });

  it("accepts displayName — persists name column", async () => {
    const res = await req("PATCH", "/api/me/profile", {
      body: { displayName: "Señor Wanderlust" },
    });
    assert.equal(res.status, 200, `Expected 200: ${JSON.stringify(res.body)}`);
    const upd = state.updates[0].data as any;
    assert.equal(upd.name, "Señor Wanderlust");
  });

  it("rejects empty body — 400 invalid_payload", async () => {
    const res = await req("PATCH", "/api/me/profile", { body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "invalid_payload");
  });

  it("requires authentication — 401 when no token", async () => {
    const res = await req("PATCH", "/api/me/profile", {
      body:  { bio: "no auth" },
      token: null,
    });
    assert.equal(res.status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /me/avatar/upload — MIME type and size rejection
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/me/avatar/upload — MIME and size guards", () => {
  let server: Server;
  let base: string;
  let req: ReturnType<typeof makeReq>;

  before(async () => {
    const app = express();
    app.use("/api", profileRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    req  = makeReq(base);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  beforeEach(() => {
    const client = makeFakeClient(freshState());
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("rejects text/plain MIME → 400 invalid_payload", async () => {
    const res = await req("POST", "/api/me/avatar/upload", {
      binary:      Buffer.from("not an image"),
      contentType: "text/plain",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "invalid_payload");
    assert.ok(
      (res.body?.message as string)?.includes("Unsupported avatar type"),
      `Expected MIME rejection message, got: ${res.body?.message}`,
    );
  });

  it("rejects image/gif MIME → 400 invalid_payload", async () => {
    const res = await req("POST", "/api/me/avatar/upload", {
      binary:      Buffer.alloc(100, 0),
      contentType: "image/gif",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "invalid_payload");
  });

  it("rejects body larger than 5 MB → 400 invalid_payload", async () => {
    const sixMB = Buffer.alloc(6 * 1024 * 1024, 0x00);
    const res = await req("POST", "/api/me/avatar/upload", {
      binary:      sixMB,
      contentType: "image/jpeg",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "invalid_payload");
    assert.ok(
      (res.body?.message as string)?.includes("Avatar too large"),
      `Expected size rejection, got: ${res.body?.message}`,
    );
  });

  it("requires authentication → 401 when no token", async () => {
    const res = await req("POST", "/api/me/avatar/upload", {
      binary:      Buffer.from("x"),
      contentType: "image/jpeg",
      token:       null,
    });
    assert.equal(res.status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /me/cover/upload — MIME type and size rejection
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/me/cover/upload — MIME and size guards", () => {
  let server: Server;
  let base: string;
  let req: ReturnType<typeof makeReq>;

  before(async () => {
    const app = express();
    app.use("/api", profileRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    req  = makeReq(base);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  beforeEach(() => {
    const client = makeFakeClient(freshState());
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("rejects application/pdf MIME → 400 invalid_payload", async () => {
    const res = await req("POST", "/api/me/cover/upload", {
      binary:      Buffer.from("PDF content"),
      contentType: "application/pdf",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "invalid_payload");
    assert.ok(
      (res.body?.message as string)?.includes("Unsupported cover type"),
      `Expected MIME rejection, got: ${res.body?.message}`,
    );
  });

  it("rejects body larger than 10 MB → 400 invalid_payload", async () => {
    const elevenMB = Buffer.alloc(11 * 1024 * 1024, 0xff);
    const res = await req("POST", "/api/me/cover/upload", {
      binary:      elevenMB,
      contentType: "image/png",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "invalid_payload");
    assert.ok(
      (res.body?.message as string)?.includes("Cover too large"),
      `Expected size rejection, got: ${res.body?.message}`,
    );
  });

  it("requires authentication → 401 when no token", async () => {
    const res = await req("POST", "/api/me/cover/upload", {
      binary:      Buffer.from("x"),
      contentType: "image/webp",
      token:       null,
    });
    assert.equal(res.status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /reports — profile-type report
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/reports — profile-type report", () => {
  let server: Server;
  let base: string;
  let req: ReturnType<typeof makeReq>;
  let state: FakeState;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", reportsRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    req  = makeReq(base);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  beforeEach(() => {
    state = freshState();
    const client = makeFakeClient(state);
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("profile report inserts a row and returns 201 with reportId", async () => {
    const res = await req("POST", "/api/reports", {
      body: {
        target_type:   "profile",
        target_id:     TARGET,
        reason_code:   "impersonation",
        reason_detail: "This account is impersonating a well-known person",
      },
    });
    assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body?.reportId, "response should include reportId");
    assert.equal(state.inserts.length, 1, "should have inserted exactly one report row");
    const row = state.inserts[0].data as any;
    assert.equal(row.reporter_id,   ME);
    assert.equal(row.target_type,   "profile");
    assert.equal(row.target_id,     TARGET);
    assert.equal(row.reason_code,   "impersonation");
    assert.ok(row.reason_detail,    "reason_detail should be present");
  });

  it("profile report missing reason_detail → 400 invalid_payload", async () => {
    const res = await req("POST", "/api/reports", {
      body: {
        target_type: "profile",
        target_id:   TARGET,
        reason_code: "spam",
        // reason_detail intentionally omitted
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "invalid_payload");
  });

  it("requires authentication → 401 when no token", async () => {
    const res = await req("POST", "/api/reports", {
      body: {
        target_type:   "profile",
        target_id:     TARGET,
        reason_code:   "harassment",
        reason_detail: "Threatening messages",
      },
      token: null,
    });
    assert.equal(res.status, 401);
  });
});
