/**
 * POST /api/profile/ensure — new-profile bootstrap
 *
 * Verifies that a freshly-created profile always has BOTH `name` AND
 * `display_name` written to the DB row (the original code omitted
 * `display_name`, leaving it NULL until the user's first profile edit).
 *
 * Run: node --import tsx/esm --test src/test/profileEnsure.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

// ── Stable UUIDs ─────────────────────────────────────────────────────────────

const NEW_USER = "a1000000-0000-4000-a000-000000000001";
const NEW_TOK  = "tok-new-user";

// ── Minimal fake client ───────────────────────────────────────────────────────

function makeClient() {
  const upserted: any[] = [];

  function makeBuilder(table: string) {
    let upsertPayload: any = null;
    const builder: any = {
      select()               { return builder; },
      eq()                   { return builder; },
      upsert(row: any) {
        upsertPayload = Array.isArray(row) ? row[0] : row;
        upserted.push({ table, row: upsertPayload });
        return builder;
      },
      maybeSingle() { return Promise.resolve({ data: upsertPayload ?? null, error: null }); },
      single()      { return Promise.resolve({ data: upsertPayload ?? null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: upsertPayload ? [upsertPayload] : [], error: null }).then(onF, onR);
      },
      catch() { return builder; },
    };
    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (tok: string) => {
        if (tok === NEW_TOK) return { data: { user: { id: NEW_USER } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
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
    __upserted: upserted,
  };
  return client;
}

// ── HTTP test server setup ────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let port: number;
let client: ReturnType<typeof makeClient>;

function post(path: string, body: object, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
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

describe("POST /api/profile/ensure", () => {

  it("201/200: writes display_name equal to name on first upsert (email source)", async () => {
    client.__upserted.length = 0;
    const res = await post("/api/profile/ensure", { email: "alice@example.com" }, NEW_TOK);
    assert.ok([200, 201].includes(res.status), `expected 200/201, got ${res.status}: ${JSON.stringify(res.body)}`);

    // ensure also upserts user_location_preferences defaults; assert the profiles
    // upsert specifically rather than a global count.
    const profileUpserts = client.__upserted.filter((u: any) => u.table === "profiles");
    assert.equal(profileUpserts.length, 1, "should have exactly one profiles upsert");
    const row = profileUpserts[0].row;
    assert.ok(row.name,         "upserted row must have name");
    assert.ok(row.display_name, "upserted row must have display_name");
    assert.equal(row.display_name, row.name, "display_name must equal name on creation");
  });

  it("display_name uses explicit name param when provided", async () => {
    client.__upserted.length = 0;
    const res = await post("/api/profile/ensure", { email: "b@example.com", name: "Beatriz" }, NEW_TOK);
    assert.ok([200, 201].includes(res.status), `got ${res.status}`);

    const row = client.__upserted.filter((u: any) => u.table === "profiles")[0].row;
    assert.equal(row.name, "Beatriz");
    assert.equal(row.display_name, "Beatriz");
  });

  it("falls back to 'Traveler' for both name and display_name when email has no local part", async () => {
    client.__upserted.length = 0;
    const res = await post("/api/profile/ensure", {}, NEW_TOK);
    assert.ok([200, 201].includes(res.status), `got ${res.status}`);

    const row = client.__upserted.filter((u: any) => u.table === "profiles")[0].row;
    assert.equal(row.name, "Traveler");
    assert.equal(row.display_name, "Traveler");
  });

  it("401 when no auth token supplied", async () => {
    const res = await post("/api/profile/ensure", { email: "x@x.com" });
    assert.equal(res.status, 401);
  });

  it("handle is derived from email local-part", async () => {
    client.__upserted.length = 0;
    await post("/api/profile/ensure", { email: "jsmith@example.com" }, NEW_TOK);
    const row = client.__upserted.filter((u: any) => u.table === "profiles")[0]?.row;
    assert.ok(row?.handle?.startsWith("jsmith"), `expected handle starting with 'jsmith', got: ${row?.handle}`);
  });
});
