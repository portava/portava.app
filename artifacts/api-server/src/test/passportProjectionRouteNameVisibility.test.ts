/**
 * GET /api/passport/:userId/projection — the ANONYMOUS-facing consumer of the
 * Passport projection aggregate, tested end-to-end through the real router.
 *
 * This is the most exposed instance of the live `show_real_name` leak: the
 * route resolves the viewer with `getOptionalViewerId`, which returns null for
 * a caller with no Authorization header, and then served that caller the
 * owner's real/display name regardless of
 * `profile_privacy_settings.show_real_name`.
 *
 * Every case carries a POSITIVE CONTROL (a user with `show_real_name: true`
 * whose name IS returned over the same wire, from the same fixture), so a fix
 * that hid every name always would fail here rather than pass vacuously.
 *
 * Run: node --import tsx/esm --test src/test/passportProjectionRouteNameVisibility.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportRouter from "../routes/passport.js";

const HIDDEN = "aa000000-0000-4000-a000-0000000000a1"; // show_real_name = false
const SHOWN = "bb000000-0000-4000-a000-0000000000b1"; // show_real_name = true
const HIDDEN_TOK = "tok-hidden";

const HIDDEN_NAME = "Bob Traveler";
const SHOWN_NAME = "Alice Visible";

// ── HTTP helper ───────────────────────────────────────────────────────────────

function req(
  server: ReturnType<typeof createServer>,
  path: string,
  token?: string | null,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as import("net").AddressInfo;
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method: "GET", headers },
      (res: any) => {
        let raw = "";
        res.on("data", (c: any) => (raw += c));
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

// ── Fake Supabase ─────────────────────────────────────────────────────────────

function profileRow(id: string, handle: string, name: string) {
  return {
    id, handle, username: handle, display_name: name, name,
    avatar_url: "https://cdn.example.com/a.jpg", cover_photo_url: null,
    verified: false, verified_at: null, verification_level: null,
    home_city: "Hanoi", home_country: "Vietnam", current_city: "Hanoi",
    is_official: false, is_private: false, passport_visibility: "public",
    show_profile_picture_publicly: true,
    interests: [], availability_tags: [], spoken_languages: [],
    travel_pace: null, planning_style: null, budget_style: null,
    travel_group_style: [], open_to_meet: false,
    buddy_verified_at: null, created_at: "2023-01-01",
    account_status: "active",
  };
}

/**
 * The two profiles are IDENTICAL apart from id/handle/name — the only thing
 * that can make one name visible and the other not is the privacy row.
 */
function makeState() {
  return {
    profiles: [
      profileRow(HIDDEN, "bobt", HIDDEN_NAME),
      profileRow(SHOWN, "alicev", SHOWN_NAME),
    ],
    profile_privacy_settings: [
      { user_id: HIDDEN, show_real_name: false },
      { user_id: SHOWN, show_real_name: true },
    ],
  } as Record<string, any[]>;
}

function makeClient(state: Record<string, any[]>) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === HIDDEN_TOK
          ? { data: { user: { id: HIDDEN } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let limitN: number | null = null;
      // Column projection for `profiles`: without it, dropping a column from a
      // route's SELECT string would go unnoticed because the mock would keep
      // returning the whole fixture row.
      let cols: string[] | null = null;

      function rows(): any[] {
        let r = (state[table] ?? []).filter((row) => filters.every((f) => f(row)));
        if (table === "profiles" && cols) {
          r = r.map((row) => Object.fromEntries(cols!.filter((c) => c in row).map((c) => [c, row[c]])));
        }
        if (limitN !== null) r = r.slice(0, limitN);
        return r;
      }

      const b: any = {
        select(c?: string) {
          if (table === "profiles" && typeof c === "string" && c !== "*") {
            cols = c.split(",").map((s) => s.trim());
          }
          return b;
        },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
        in(col: string, vals: any[]) { filters.push((r) => Array.isArray(vals) && vals.includes(r[col])); return b; },
        is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
        gt(col: string, val: any) { filters.push((r) => r[col] > val); return b; },
        lt(col: string, val: any) { filters.push((r) => r[col] < val); return b; },
        gte(col: string, val: any) { filters.push((r) => r[col] >= val); return b; },
        lte(col: string, val: any) { filters.push((r) => r[col] <= val); return b; },
        not() { return b; },
        or() { return b; },
        order() { return b; },
        range() { return b; },
        limit(n: number) { limitN = n; return b; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        single: async () => {
          const r = rows();
          return r.length ? { data: r[0], error: null } : { data: null, error: { message: "no rows", code: "PGRST116" } };
        },
        then(onF: any, onR: any) {
          const r = rows();
          return Promise.resolve({ data: r, error: null, count: r.length }).then(onF, onR);
        },
        insert: async () => ({ data: null, error: null }),
        update: async () => ({ data: null, error: null }),
        upsert: async () => ({ data: null, error: null }),
        delete: async () => ({ data: null, error: null }),
      };
      return b;
    },
  };
}

// ── Server ────────────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res, next) => {
    r.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  const client = makeClient(makeState());
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  app.use("/api", passportRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/passport/:userId/projection — anonymous caller", () => {
  it("does not return the real name of a user who opted out", async () => {
    const r = await req(server, `/api/passport/${HIDDEN}/projection`);
    assert.equal(r.status, 200);
    assert.ok(r.body?.projection, "projection returned");
    assert.equal(
      r.body.projection.identity.name,
      null,
      "LIVE LEAK: an anonymous caller must not receive an opted-out real name",
    );
    // The rule is name-only — the rest of the identity block is unaffected.
    assert.equal(r.body.projection.identity.handle, "bobt");
    assert.equal(r.body.projection.identity.userId, HIDDEN);
  });

  it("POSITIVE CONTROL: does return the real name of a user who opted in", async () => {
    const r = await req(server, `/api/passport/${SHOWN}/projection`);
    assert.equal(r.status, 200);
    assert.equal(
      r.body.projection.identity.name,
      SHOWN_NAME,
      "an opted-in name must still be served — the fix is not 'hide every name'",
    );
  });

  it("honors the rule when the user is addressed by @handle too", async () => {
    const hidden = await req(server, `/api/passport/@bobt/projection`);
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.projection.identity.name, null);

    // POSITIVE CONTROL on the same resolution path.
    const shown = await req(server, `/api/passport/@alicev/projection`);
    assert.equal(shown.status, 200);
    assert.equal(shown.body.projection.identity.name, SHOWN_NAME);
  });
});

describe("GET /api/passport/:userId/projection — the owner reading their own passport", () => {
  it("still returns the owner's own name despite show_real_name = false", async () => {
    const r = await req(server, `/api/passport/${HIDDEN}/projection`, HIDDEN_TOK);
    assert.equal(r.status, 200);
    assert.equal(
      r.body.projection.identity.name,
      HIDDEN_NAME,
      "opting out hides the name from OTHERS, never from the owner",
    );
  });
});
