/**
 * PATCH /api/me/profile — Travel Persona fields
 *
 * Verifies that travelPace, budgetStyle, comfortLevel, planningStyle,
 * lookingFor, openToMeet, and travelGroupStyle are accepted, mapped to the
 * correct snake_case columns, and persisted via the update+select path.
 *
 * Run: node --import tsx/esm --test src/test/profilePersona.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

// ── Stable UUIDs ─────────────────────────────────────────────────────────────

const USER_ID = "a2000000-0000-4000-a000-000000000001";
const USER_TOK = "tok-persona-user";

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeClient() {
  const updates: { table: string; row: any }[] = [];

  function makeBuilder(table: string) {
    let _updatePayload: any = null;
    const builder: any = {
      select() { return builder; },
      eq()     { return builder; },
      neq()    { return builder; },
      limit()  { return builder; },
      order()  { return builder; },
      update(row: any) {
        _updatePayload = { ...row };
        updates.push({ table, row: _updatePayload });
        return builder;
      },
      upsert(row: any) {
        _updatePayload = Array.isArray(row) ? row[0] : row;
        updates.push({ table, row: _updatePayload });
        return builder;
      },
      maybeSingle() {
        const row = _updatePayload ?? {
          id: USER_ID,
          handle: "persona_user",
          name: "Persona User",
          display_name: "Persona User",
          username: null,
          bio: null,
          avatar_url: null,
          home_city: null,
          home_country: null,
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
          created_at: new Date().toISOString(),
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
          public_social_links: null,
          preferred_language: null,
          date_of_birth: null,
          dob_verified: false,
        };
        return Promise.resolve({ data: row, error: null });
      },
      single() {
        return this.maybeSingle();
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: _updatePayload ? [_updatePayload] : [], error: null }).then(onF, onR);
      },
      catch() { return builder; },
    };
    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (tok: string) => {
        if (tok === USER_TOK) return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from: (table: string) => makeBuilder(table),
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
      }),
    },
    __updates: updates,
  };
  return client;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let port: number;
let client: ReturnType<typeof makeClient>;

function patch(path: string, body: object, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: "127.0.0.1",
      port,
      path,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = http.request(opts, (res: any) => {
      let raw = "";
      res.on("data", (c: any) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

before(async () => {
  client = makeClient();
  _setTestClient(client, true);
  _setTestServiceClient(client);

  const app = express();
  app.use(express.json());
  app.use("/api", profileRouter);

  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/me/profile — Travel Persona fields", () => {

  it("saves travelPace → travel_pace column", async () => {
    client.__updates.length = 0;
    const res = await patch("/api/me/profile", { travelPace: "balanced" }, USER_TOK);
    assert.ok([200, 201].includes(res.status), `expected 200/201, got ${res.status}: ${JSON.stringify(res.body)}`);
    const profileUpdate = client.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles table should have been updated");
    assert.equal(profileUpdate.row.travel_pace, "balanced", "travel_pace should be set to 'balanced'");
  });

  it("saves budgetStyle → budget_style column", async () => {
    client.__updates.length = 0;
    const res = await patch("/api/me/profile", { budgetStyle: "mid-range" }, USER_TOK);
    assert.ok([200, 201].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body)}`);
    const profileUpdate = client.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles table should have been updated");
    assert.equal(profileUpdate.row.budget_style, "mid-range");
  });

  it("saves comfortLevel → comfort_level column", async () => {
    client.__updates.length = 0;
    const res = await patch("/api/me/profile", { comfortLevel: "adventurous" }, USER_TOK);
    assert.ok([200, 201].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body)}`);
    const profileUpdate = client.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles table should have been updated");
    assert.equal(profileUpdate.row.comfort_level, "adventurous");
  });

  it("saves planningStyle → planning_style column", async () => {
    client.__updates.length = 0;
    const res = await patch("/api/me/profile", { planningStyle: "spontaneous" }, USER_TOK);
    assert.ok([200, 201].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body)}`);
    const profileUpdate = client.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles table should have been updated");
    assert.equal(profileUpdate.row.planning_style, "spontaneous");
  });

  it("saves lookingFor → looking_for column", async () => {
    client.__updates.length = 0;
    const res = await patch("/api/me/profile", { lookingFor: ["friends", "culture"] }, USER_TOK);
    assert.ok([200, 201].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body)}`);
    const profileUpdate = client.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles table should have been updated");
    assert.deepEqual(profileUpdate.row.looking_for, ["friends", "culture"]);
  });

  it("saves openToMeet → open_to_meet column", async () => {
    client.__updates.length = 0;
    const res = await patch("/api/me/profile", { openToMeet: true }, USER_TOK);
    assert.ok([200, 201].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body)}`);
    const profileUpdate = client.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles table should have been updated");
    assert.equal(profileUpdate.row.open_to_meet, true);
  });

  it("saves travelGroupStyle → travel_group_style column", async () => {
    client.__updates.length = 0;
    const res = await patch("/api/me/profile", { travelGroupStyle: ["solo", "open_to_any"] }, USER_TOK);
    assert.ok([200, 201].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body)}`);
    const profileUpdate = client.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles table should have been updated");
    assert.deepEqual(profileUpdate.row.travel_group_style, ["solo", "open_to_any"]);
  });

  it("rejects invalid travelPace enum value with 400", async () => {
    const res = await patch("/api/me/profile", { travelPace: "relaxed" }, USER_TOK);
    assert.equal(res.status, 400, `expected 400 for invalid travelPace, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  it("returns 401 when no auth token supplied", async () => {
    const res = await patch("/api/me/profile", { travelPace: "slow" });
    assert.equal(res.status, 401);
  });
});
