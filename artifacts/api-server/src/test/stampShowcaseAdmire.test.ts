/**
 * Stamp Wave 2 — showcase + admire route tests.
 *
 * In-memory fake Supabase client (chainable builder), routers mounted in
 * isolation (same pattern as moderation.test.ts). Notification side effects
 * are fire-and-forget in the routes and intentionally not asserted here.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";

import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampShowcaseRouter from "../routes/stampShowcase.js";
import stampAdmireRouter from "../routes/stampAdmire.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const S_PUB = "33333333-3333-4333-8333-333333333333";   // Alice's public stamp
const S_PRIV = "44444444-4444-4444-8444-444444444444";  // Alice's private stamp
const S_REV = "55555555-5555-4555-8555-555555555555";   // Alice's revoked stamp
const S_BOB = "66666666-6666-4666-8666-666666666666";   // Bob's public stamp

type Db = Record<string, any[]>;

function baseDb(): Db {
  return {
    feature_flags: [
      { flag: "stamp_showcase_enabled", enabled: true },
      { flag: "stamp_admire_enabled", enabled: true },
    ],
    profiles: [
      { id: ALICE, username: "alice", display_name: "Alice" },
      { id: BOB, username: "bob", display_name: "Bob" },
    ],
    user_stamps: [
      { id: S_PUB, user_id: ALICE, visibility: "public", is_revoked: false, city: "Cebu", country: "Philippines", title_override: null, earned_at: "2026-07-01T00:00:00Z", stamp_definitions: { slug: "city_cebu", name: "Cebu", rarity: "rare", stamp_type: "city", category: "travel", universal_artwork_url: "https://x/cebu.png" } },
      { id: S_PRIV, user_id: ALICE, visibility: "private", is_revoked: false, city: "Tokyo", country: "Japan", title_override: null, earned_at: "2026-07-02T00:00:00Z", stamp_definitions: { slug: "city_tokyo", name: "Tokyo", rarity: "epic", stamp_type: "city", category: "travel", universal_artwork_url: null } },
      { id: S_REV, user_id: ALICE, visibility: "public", is_revoked: true, city: "Paris", country: "France", title_override: null, earned_at: "2026-07-03T00:00:00Z", stamp_definitions: { slug: "city_paris", name: "Paris", rarity: "common", stamp_type: "city", category: "travel", universal_artwork_url: null } },
      { id: S_BOB, user_id: BOB, visibility: "public", is_revoked: false, city: "Bangkok", country: "Thailand", title_override: null, earned_at: "2026-07-04T00:00:00Z", stamp_definitions: { slug: "city_bkk", name: "Bangkok", rarity: "uncommon", stamp_type: "city", category: "travel", universal_artwork_url: null } },
    ],
    user_stamp_showcase: [],
    stamp_admires: [],
    notifications: [],
  };
}

function makeClient(db: Db, userId: string) {
  function builder(table: string) {
    const filters: Array<[string, any]> = [];
    let inFilter: { key: string; vals: any[] } | null = null;
    let limitN = Infinity;
    let mode: "select" | "delete" = "select";

    const matching = () =>
      (db[table] ?? []).filter(
        (r) =>
          filters.every(([k, v]) => r[k] === v) &&
          (!inFilter || inFilter.vals.includes(r[inFilter.key])),
      );

    const api: any = {
      select: () => api,
      eq: (k: string, v: any) => { filters.push([k, v]); return api; },
      in: (k: string, vals: any[]) => { inFilter = { key: k, vals }; return api; },
      order: () => api,
      limit: (n: number) => { limitN = n; return api; },
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      single: async () => ({ data: matching()[0] ?? null, error: null }),
      delete: () => { mode = "delete"; return api; },
      insert: (vals: any) => {
        const arr = (Array.isArray(vals) ? vals : [vals]).map((v) => ({ id: v.id ?? randomUUID(), created_at: new Date().toISOString(), ...v }));
        db[table] = [...(db[table] ?? []), ...arr];
        const res = { data: arr[0], error: null };
        return {
          select: () => ({ single: async () => res }),
          then: (resolve: any) => resolve({ error: null }),
        };
      },
      then: (resolve: any) => {
        if (mode === "delete") {
          const keep = (db[table] ?? []).filter(
            (r) => !(filters.every(([k, v]) => r[k] === v) && (!inFilter || inFilter.vals.includes(r[inFilter.key]))),
          );
          db[table] = keep;
          resolve({ error: null });
        } else {
          resolve({ data: matching().slice(0, limitN), error: null });
        }
      },
    };
    return api;
  }

  return {
    auth: {
      getUser: async (token: string) =>
        token
          ? { data: { user: { id: userId } }, error: null }
          : { data: { user: null }, error: { message: "no token" } },
    },
    from: (table: string) => builder(table),
  } as any;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = req.log ?? { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", stampShowcaseRouter);
  app.use("/api", stampAdmireRouter);
  return app;
}

function req(server: http.Server, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as any;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const hdrs: Record<string, string> = { "content-type": "application/json", authorization: "Bearer test-token" };
    if (payload) hdrs["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path, method, headers: hdrs }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let server: http.Server;
let db: Db;

function useClient(userId: string) {
  const client = makeClient(db, userId);
  _setTestClient(client, true);
  _setTestServiceClient(client);
}

before(async () => {
  const app = buildApp();
  server = http.createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
});

after(async () => {
  _clearTestClient();
  _setTestServiceClient(null as any);
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(() => {
  db = baseDb();
});

// ── Showcase ─────────────────────────────────────────────────────────────────

describe("Stamp showcase routes", () => {
  it("is flag-gated", async () => {
    db.feature_flags = db.feature_flags.map((f) =>
      f.flag === "stamp_showcase_enabled" ? { ...f, enabled: false } : f,
    );
    useClient(ALICE);
    const { status, body } = await req(server, "GET", "/api/stamps/showcase");
    assert.notEqual(status, 200);
    assert.equal(body.error, "feature_disabled");
  });

  it("PUT saves an ordered set and GET returns it in rank order", async () => {
    useClient(ALICE);
    const put = await req(server, "PUT", "/api/stamps/showcase", { userStampIds: [S_PRIV, S_PUB] });
    assert.equal(put.status, 200);
    assert.equal(put.body.count, 2);

    const get = await req(server, "GET", "/api/stamps/showcase");
    assert.equal(get.status, 200);
    assert.equal(get.body.items.length, 2);
    assert.equal(get.body.items[0].userStampId, S_PRIV); // rank 0 = first in PUT order
    assert.equal(get.body.items[1].userStampId, S_PUB);
    assert.equal(get.body.max, 8);
  });

  it("PUT replaces the previous set (reorder)", async () => {
    useClient(ALICE);
    await req(server, "PUT", "/api/stamps/showcase", { userStampIds: [S_PRIV, S_PUB] });
    await req(server, "PUT", "/api/stamps/showcase", { userStampIds: [S_PUB] });
    const get = await req(server, "GET", "/api/stamps/showcase");
    assert.equal(get.body.items.length, 1);
    assert.equal(get.body.items[0].userStampId, S_PUB);
  });

  it("PUT rejects someone else's stamp, revoked stamps, duplicates, and >8", async () => {
    useClient(ALICE);
    const foreign = await req(server, "PUT", "/api/stamps/showcase", { userStampIds: [S_BOB] });
    assert.equal(foreign.body.error, "invalid_payload");

    const revoked = await req(server, "PUT", "/api/stamps/showcase", { userStampIds: [S_REV] });
    assert.equal(revoked.body.error, "invalid_payload");

    const dup = await req(server, "PUT", "/api/stamps/showcase", { userStampIds: [S_PUB, S_PUB] });
    assert.equal(dup.body.error, "invalid_payload");

    const nine = Array.from({ length: 9 }, () => randomUUID());
    const over = await req(server, "PUT", "/api/stamps/showcase", { userStampIds: nine });
    assert.equal(over.body.error, "invalid_payload");
  });

  it("public view filters private and revoked stamps, preserves order", async () => {
    useClient(ALICE);
    // Alice showcases private + public + revoked
    await req(server, "PUT", "/api/stamps/showcase", { userStampIds: [S_PRIV, S_PUB] });
    db.user_stamp_showcase.push({ id: randomUUID(), user_id: ALICE, user_stamp_id: S_REV, rank: 2 });

    useClient(BOB); // Bob views Alice's public showcase
    const { status, body } = await req(server, "GET", "/api/users/alice/stamp-showcase");
    assert.equal(status, 200);
    assert.equal(body.items.length, 1); // only the public, non-revoked stamp
    assert.equal(body.items[0].userStampId, S_PUB);
  });

  it("public view 404s for unknown usernames", async () => {
    useClient(BOB);
    const { body } = await req(server, "GET", "/api/users/nobody/stamp-showcase");
    assert.equal(body.error, "not_found");
  });
});

// ── Admire ───────────────────────────────────────────────────────────────────

describe("Stamp admire routes", () => {
  it("is flag-gated", async () => {
    db.feature_flags = db.feature_flags.map((f) =>
      f.flag === "stamp_admire_enabled" ? { ...f, enabled: false } : f,
    );
    useClient(BOB);
    const { body } = await req(server, "POST", `/api/stamps/${S_PUB}/admire`);
    assert.equal(body.error, "feature_disabled");
  });

  it("admires a public stamp once; duplicates collapse to 200", async () => {
    useClient(BOB);
    const first = await req(server, "POST", `/api/stamps/${S_PUB}/admire`);
    assert.equal(first.status, 201);
    assert.equal(first.body.admired, true);

    const second = await req(server, "POST", `/api/stamps/${S_PUB}/admire`);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(db.stamp_admires.length, 1);
  });

  it("rejects self-admire", async () => {
    useClient(ALICE);
    const { body } = await req(server, "POST", `/api/stamps/${S_PUB}/admire`);
    assert.equal(body.error, "invalid_payload");
    assert.equal(db.stamp_admires.length, 0);
  });

  it("hides private and revoked stamps from other users (404)", async () => {
    useClient(BOB);
    const priv = await req(server, "POST", `/api/stamps/${S_PRIV}/admire`);
    assert.equal(priv.body.error, "not_found");
    const rev = await req(server, "POST", `/api/stamps/${S_REV}/admire`);
    assert.equal(rev.body.error, "not_found");
  });

  it("unadmire removes the row; admirers reflects count and admiredByMe", async () => {
    useClient(BOB);
    await req(server, "POST", `/api/stamps/${S_PUB}/admire`);
    db.stamp_admires[0].profiles = { id: BOB, username: "bob", display_name: "Bob", avatar_url: null };

    const list = await req(server, "GET", `/api/stamps/${S_PUB}/admirers`);
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);
    assert.equal(list.body.admiredByMe, true);
    assert.equal(list.body.admirers[0].username, "bob");

    const del = await req(server, "DELETE", `/api/stamps/${S_PUB}/admire`);
    assert.equal(del.status, 200);
    assert.equal(db.stamp_admires.length, 0);

    const after2 = await req(server, "GET", `/api/stamps/${S_PUB}/admirers`);
    assert.equal(after2.body.count, 0);
    assert.equal(after2.body.admiredByMe, false);
  });
});
